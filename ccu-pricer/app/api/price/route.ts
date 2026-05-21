import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright-core";

export const maxDuration = 300; // 5 min — requires Vercel Pro/Fluid compute
export const dynamic = "force-dynamic";

// ── types ────────────────────────────────────────────────────────────────────

interface CCURow {
  from: string;
  to: string;
  count: string;
  fromMsrp: string;
  toMsrp: string;
  pledge: string;
  saving: string;
  insurance: string;
  title: string;
}

interface CCUItem {
  fromShip: string;
  toShip: string;
  countOwned: number;
  fromMsrp: number;
  toMsrp: number;
  msrpDiff: number;
  pledge: number;
  saving: number;
  insurance: string;
  listings: { price: number; insurance?: string; note?: string }[];
}

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCSV(text: string): CCURow[] {
  const lines = text.trim().split("\n");
  const headers = lines[0].replace(/"/g, "").split(",");
  return lines.slice(1).map((line) => {
    const vals = line.match(/(".*?"|[^",]+|(?<=,)(?=,)|^(?=,)|(?<=,)$)/g) ?? [];
    const clean = vals.map((v) => v.replace(/^"|"$/g, "").trim());
    return Object.fromEntries(headers.map((h, i) => [h, clean[i] ?? ""])) as unknown as CCURow;
  });
}

function aggregateInventory(rows: CCURow[]): CCUItem[] {
  const map = new Map<string, CCUItem>();
  for (const row of rows) {
    const key = `${row.from}|||${row.to}`;
    if (!map.has(key)) {
      map.set(key, {
        fromShip: row.from,
        toShip: row.to,
        countOwned: 0,
        fromMsrp: parseFloat(row.fromMsrp) || 0,
        toMsrp: parseFloat(row.toMsrp) || 0,
        msrpDiff: (parseFloat(row.toMsrp) || 0) - (parseFloat(row.fromMsrp) || 0),
        pledge: parseFloat(row.pledge) || 0,
        saving: parseFloat(row.saving) || 0,
        insurance: row.insurance || "",
        listings: [],
      });
    }
    map.get(key)!.countOwned += parseInt(row.count) || 1;
  }
  return Array.from(map.values());
}

// ── StarHangar scraper via Browserless ───────────────────────────────────────

async function scrapeListings(
  browserlessKey: string,
  fromShip: string,
  toShip: string
): Promise<{ price: number; insurance?: string; note?: string }[]> {
  const wsEndpoint = `wss://production-sfo.browserless.io?token=${browserlessKey}`;

  const browser = await chromium.connectOverCDP(wsEndpoint);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Search StarHangar for this CCU
    const searchTerm = encodeURIComponent(`${fromShip} to ${toShip}`);
    await page.goto(
      `https://www.starhangar.com/?s=${searchTerm}&post_type=product`,
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );
    await page.waitForTimeout(2000);

    // Extract all product listings
    const listings = await page.evaluate(() => {
      const results: { price: number; title: string }[] = [];
      const products = document.querySelectorAll(
        ".product, li.product, .woocommerce-loop-product, [class*='product-item']"
      );

      products.forEach((el) => {
        const priceEl = el.querySelector(
          ".price .woocommerce-Price-amount, .woocommerce-Price-amount, .price"
        );
        const titleEl = el.querySelector(
          ".woocommerce-loop-product__title, h2, h3, .product-title"
        );
        if (!priceEl) return;

        const priceText = priceEl.textContent ?? "";
        const match = priceText.match(/[\d,]+\.?\d*/);
        if (!match) return;

        const price = parseFloat(match[0].replace(/,/g, ""));
        if (price > 0) {
          results.push({ price, title: titleEl?.textContent?.trim() ?? "" });
        }
      });

      return results;
    });

    await context.close();

    return listings.map(({ price, title }) => ({
      price,
      note: title,
    }));
  } finally {
    await browser.close();
  }
}

// ── Pricing analysis ──────────────────────────────────────────────────────────

async function analyzeWithClaude(
  client: Anthropic,
  items: CCUItem[]
): Promise<string> {
  const payload = items.map((d) => {
    const prices = d.listings.map((l) => l.price);
    return {
      from_ship: d.fromShip,
      to_ship: d.toShip,
      count_owned: d.countOwned,
      msrp_difference_usd: d.msrpDiff,
      pledge_cost_usd: d.pledge,
      saving_usd: d.saving,
      insurance: d.insurance || "standard",
      market_listing_count: prices.length,
      market_min: prices.length ? Math.min(...prices) : null,
      market_max: prices.length ? Math.max(...prices) : null,
      market_avg: prices.length
        ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100
        : null,
      all_prices: prices,
    };
  });

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8096,
    system: `You are a Star Citizen marketplace pricing expert helping a seller price CCUs on StarHangar.com.
CCUs let players upgrade from one ship to another. Recommend competitive prices based on:
- Active market listings (price at or just below the lowest to sell quickly)
- MSRP difference (cost floor)
- Insurance type (Warbond/120-month = more valuable)
- If no market data: estimate MSRP diff × 1.1–1.3 for popular paths`,
    messages: [
      {
        role: "user",
        content: `Here is my CCU inventory with StarHangar market data. Produce a pricing report as a Markdown table with columns:
| CCU (From → To) | Qty | MSRP Diff | Insurance | Market Listings | Mkt Min | Mkt Avg | Recommended Price | Notes |

After the table add a short bullet-point summary of key pricing observations.

Data:
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``,
      },
    ],
  });

  return (response.content[0] as { text: string }).text;
}

// ── Streaming route handler ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("csv") as File | null;
  const browserlessKey = formData.get("browserlessKey") as string | null;
  const anthropicKey = formData.get("anthropicKey") as string | null;

  if (!file) return new Response("No CSV file", { status: 400 });
  if (!browserlessKey) return new Response("No Browserless API key", { status: 400 });
  if (!anthropicKey) return new Response("No Anthropic API key", { status: 400 });

  const csvText = await file.text();
  const rows = parseCSV(csvText);
  const items = aggregateInventory(rows);

  const client = new Anthropic({ apiKey: anthropicKey });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        send({ type: "start", total: items.length });

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          send({
            type: "searching",
            index: i,
            fromShip: item.fromShip,
            toShip: item.toShip,
          });

          try {
            const listings = await scrapeListings(
              browserlessKey,
              item.fromShip,
              item.toShip
            );
            item.listings = listings;

            const prices = listings.map((l) => l.price);
            send({
              type: "result",
              index: i,
              fromShip: item.fromShip,
              toShip: item.toShip,
              listingCount: listings.length,
              minPrice: prices.length ? Math.min(...prices) : null,
              maxPrice: prices.length ? Math.max(...prices) : null,
            });
          } catch (err) {
            send({
              type: "result",
              index: i,
              fromShip: item.fromShip,
              toShip: item.toShip,
              listingCount: 0,
              error: String(err),
            });
          }

          // Small delay between scrapes
          await new Promise((r) => setTimeout(r, 1500));
        }

        send({ type: "analyzing" });
        const report = await analyzeWithClaude(client, items);
        send({ type: "done", report });
      } catch (err) {
        send({ type: "error", message: String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
