import { NextRequest } from "next/server";
import { chromium } from "playwright-core";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const FORM_URL =
  "https://star-hangar.com/marketplace/product/add/set/11/type/product_type_star_citizen/";

interface ListingPayload {
  fromShip: string;
  toShip: string;
  price: number;
  quantity: number;
  insurance: string;
}

// Map CSV insurance strings to Star Hangar dropdown labels
function mapInsurance(raw: string): string {
  const s = (raw ?? "").toLowerCase().trim();
  if (s.includes("lifetime") || s.includes("lti")) return "LTI";
  if (s.includes("120") || s.includes("10 year")) return "120-month";
  if (s.includes("warbond") || s.includes("wb")) return "Warbond";
  if (s.includes("6")) return "6-month";
  if (s.includes("12") || s.includes("1 year")) return "12-month";
  return "no ins.";
}

async function postOneListing(
  cdpUrl: string,
  listing: ListingPayload,
  thumbnailBase: string
): Promise<void> {
  const browser = await chromium.connectOverCDP(cdpUrl);

  // Use the existing browser context so the user's session/cookies are active
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();

  try {
    await page.goto(FORM_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    // The create form lives inside an iframe
    await page.waitForSelector("iframe", { timeout: 15000 });
    const frame = page.frameLocator("iframe").first();

    // ── Product Name ──────────────────────────────────────────────────────────
    const productName = `${listing.fromShip} to ${listing.toShip} CCU`;
    await frame.getByLabel("Product Name").fill(productName);

    // ── Description (WYSIWYG / contenteditable) ───────────────────────────────
    const description =
      `Cross-Chassis Upgrade from ${listing.fromShip} to ${listing.toShip}.\n\n` +
      `Insurance: ${listing.insurance || "Standard"}\n\n` +
      `This CCU lets you upgrade your ${listing.fromShip} pledge to the ${listing.toShip}.`;
    const editor = frame.locator("[contenteditable='true']").first();
    await editor.click();
    await editor.fill(description);

    // ── Short Description ─────────────────────────────────────────────────────
    await frame.getByLabel("Short Description").fill(
      `${listing.fromShip} → ${listing.toShip} CCU`
    );

    // ── Price ─────────────────────────────────────────────────────────────────
    await frame.getByLabel(/Final buyer price/i).fill(String(listing.price));

    // ── Stock ─────────────────────────────────────────────────────────────────
    await frame.getByLabel("Stock").fill(String(listing.quantity));

    // ── Insurance ─────────────────────────────────────────────────────────────
    const insuranceLabel = mapInsurance(listing.insurance);
    await frame.getByLabel(/Insurance Included/i).selectOption({ label: insuranceLabel });

    // ── Upgrade Source ────────────────────────────────────────────────────────
    const upgradeSource =
      listing.insurance?.toLowerCase().includes("warbond") ? "warbond" : "regular";
    await frame.getByLabel("Upgrade Source").selectOption({ label: upgradeSource });

    // ── Upgrade Target ────────────────────────────────────────────────────────
    // Select by visible text — will throw if the ship isn't in the dropdown
    await frame.getByLabel("Upgrade Target").selectOption({ label: listing.toShip });

    // ── Product Image ─────────────────────────────────────────────────────────
    const imageUrl = `${thumbnailBase}/api/thumbnail?from=${encodeURIComponent(
      listing.fromShip
    )}&to=${encodeURIComponent(listing.toShip)}&t=${Date.now()}`;
    const imageRes = await fetch(imageUrl);
    if (imageRes.ok) {
      const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
      const fileInput = frame.locator("input[type='file']").first();
      await fileInput.setInputFiles({
        name: `${listing.fromShip}-to-${listing.toShip}.png`.replace(/\s+/g, "-"),
        mimeType: "image/png",
        buffer: imageBuffer,
      });
      // Give the uploader time to process the file
      await page.waitForTimeout(3000);
    }

    // ── Save ──────────────────────────────────────────────────────────────────
    await frame.getByRole("button", { name: "Save" }).click();
    await page.waitForURL(/marketplace\/product\/(list|edit)/, { timeout: 30000 });

    // Leave the page open briefly so the user can see the result, then close
    await page.waitForTimeout(1500);
  } finally {
    await page.close();
    // Don't close the browser — we reuse it across listings to keep the session
  }
}

export async function POST(req: NextRequest) {
  const { listings } = (await req.json()) as { listings: ListingPayload[] };

  const cdpUrl = process.env.CHROME_CDP_URL ?? "http://localhost:9222";
  const thumbnailBase =
    process.env.NEXT_PUBLIC_URL ??
    req.headers.get("origin") ??
    "http://localhost:3000";

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      try {
        send({ type: "start", total: listings.length });

        for (let i = 0; i < listings.length; i++) {
          const listing = listings[i];
          send({
            type: "posting",
            index: i,
            fromShip: listing.fromShip,
            toShip: listing.toShip,
          });

          try {
            await postOneListing(cdpUrl, listing, thumbnailBase);
            send({
              type: "posted",
              index: i,
              fromShip: listing.fromShip,
              toShip: listing.toShip,
            });
          } catch (err) {
            send({
              type: "failed",
              index: i,
              fromShip: listing.fromShip,
              toShip: listing.toShip,
              error: String(err),
            });
          }

          await new Promise((r) => setTimeout(r, 1000));
        }

        send({ type: "done" });
      } catch (err) {
        send({ type: "fatal", message: String(err) });
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
