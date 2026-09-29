import { NextRequest } from "next/server";
import sharp, { type OverlayOptions } from "sharp";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

// Load fonts once at module init — bundled in public/fonts/ so always present
function loadFont(name: string): string {
  const p = path.join(process.cwd(), "public", "fonts", name);
  return fs.readFileSync(p).toString("base64");
}

let fontRegularB64: string | null = null;
let fontBoldB64: string | null = null;
function getFonts() {
  if (!fontRegularB64) fontRegularB64 = loadFont("inter-400.woff");
  if (!fontBoldB64) fontBoldB64 = loadFont("inter-700.woff");
  return { reg: fontRegularB64, bold: fontBoldB64 };
}

const W = 1200;
const H = 630;
const SHIP_W = 500;
const SHIP_H = 340;
const BG = { r: 8, g: 12, b: 24, alpha: 1 } as const;

// ── RSI ship matrix ───────────────────────────────────────────────────────────

interface ShipEntry {
  name: string;
  imageUrl: string;
}

let matrixCache: ShipEntry[] | null = null;
let matrixExpiry = 0;

async function getShipMatrix(): Promise<ShipEntry[]> {
  if (matrixCache && Date.now() < matrixExpiry) return matrixCache;

  const res = await fetch("https://robertsspaceindustries.com/ship-matrix/index", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; CCU-Pricer/1.0)" },
    next: { revalidate: 3600 },
  });
  if (!res.ok) return [];

  const data = await res.json();
  matrixCache = ((data.data ?? []) as Record<string, unknown>[])
    .map((ship) => {
      const media = (ship.media as Record<string, unknown>[] | undefined)?.[0];
      const images = media?.["images"] as Record<string, string> | undefined;
      const rawUrl =
        images?.["store_hub_large"] ??
        images?.["store_large"] ??
        images?.["store_small"] ??
        null;
      return {
        name: ship["name"] as string,
        imageUrl: rawUrl ? (rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl) : "",
      };
    })
    .filter((s) => s.name && s.imageUrl);

  matrixExpiry = Date.now() + 3_600_000;
  return matrixCache!;
}

function findShip(matrix: ShipEntry[], query: string): ShipEntry | null {
  const q = query.toLowerCase().trim();
  return (
    matrix.find((s) => s.name.toLowerCase() === q) ??
    matrix.find((s) => s.name.toLowerCase().includes(q)) ??
    matrix.find((s) => q.includes(s.name.toLowerCase())) ??
    null
  );
}

// ── Image helpers ─────────────────────────────────────────────────────────────

async function fetchResized(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return await sharp(buf)
      .resize(SHIP_W, SHIP_H, { fit: "cover", position: "centre" })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

function placeholderShip(label: string): Buffer {
  const svg = `
    <svg width="${SHIP_W}" height="${SHIP_H}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${SHIP_W}" height="${SHIP_H}" fill="#1e2640"/>
      <text x="${SHIP_W / 2}" y="${SHIP_H / 2}" font-family="Arial, sans-serif"
            font-size="20" fill="#6b7280" text-anchor="middle" dominant-baseline="middle">
        ${escapeXml(label)}
      </text>
    </svg>`;
  return Buffer.from(svg);
}

function escapeXml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── SVG overlay ───────────────────────────────────────────────────────────────

function buildOverlay(fromName: string, toName: string): Buffer {
  const cx = W / 2;
  const fromSafe = escapeXml(fromName);
  const toSafe = escapeXml(toName);
  const { reg, bold } = getFonts();

  const svg = `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <style>
        @font-face {
          font-family: 'Inter';
          font-weight: 400;
          src: url('data:font/woff;base64,${reg}') format('woff');
        }
        @font-face {
          font-family: 'Inter';
          font-weight: 700;
          src: url('data:font/woff;base64,${bold}') format('woff');
        }
      </style>
      <!-- Vignette on left ship -->
      <linearGradient id="lv" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0%" stop-color="#08080f" stop-opacity="0.55"/>
        <stop offset="100%" stop-color="#08080f" stop-opacity="0"/>
      </linearGradient>
      <!-- Vignette on right ship -->
      <linearGradient id="rv" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0%" stop-color="#08080f" stop-opacity="0"/>
        <stop offset="100%" stop-color="#08080f" stop-opacity="0.55"/>
      </linearGradient>
      <!-- Bottom scrim for text -->
      <linearGradient id="bv" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="#08080f" stop-opacity="0"/>
        <stop offset="100%" stop-color="#08080f" stop-opacity="0.92"/>
      </linearGradient>
      <!-- Center glow behind arrow -->
      <radialGradient id="glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.12"/>
        <stop offset="100%" stop-color="#f59e0b" stop-opacity="0"/>
      </radialGradient>
    </defs>

    <!-- Side vignettes -->
    <rect x="0" y="0" width="200" height="${H}" fill="url(#lv)"/>
    <rect x="${W - 200}" y="0" width="200" height="${H}" fill="url(#rv)"/>

    <!-- Bottom scrim -->
    <rect x="0" y="${H - 200}" width="${W}" height="200" fill="url(#bv)"/>

    <!-- Top label bar -->
    <rect x="0" y="0" width="${W}" height="52" fill="#08080f" fill-opacity="0.7"/>
    <text x="${cx}" y="34" font-family="Inter" font-size="14"
          font-weight="700" letter-spacing="4" fill="#f59e0b"
          text-anchor="middle">CROSS-CHASSIS UPGRADE</text>

    <!-- Center glow -->
    <ellipse cx="${cx}" cy="${H / 2}" rx="120" ry="120" fill="url(#glow)"/>

    <!-- Arrow -->
    <text x="${cx}" y="${H / 2 + 26}" font-family="Inter" font-size="72"
          font-weight="700" fill="#f59e0b" text-anchor="middle">&#8594;</text>

    <!-- Ship name labels -->
    <text x="280" y="${H - 80}" font-family="Inter" font-size="26"
          font-weight="700" fill="white" text-anchor="middle">${fromSafe}</text>
    <text x="280" y="${H - 50}" font-family="Inter" font-size="13"
          font-weight="400" fill="#9ca3af" text-anchor="middle" letter-spacing="1">FROM</text>

    <text x="${W - 280}" y="${H - 80}" font-family="Inter" font-size="26"
          font-weight="700" fill="white" text-anchor="middle">${toSafe}</text>
    <text x="${W - 280}" y="${H - 50}" font-family="Inter" font-size="13"
          font-weight="400" fill="#9ca3af" text-anchor="middle" letter-spacing="1">TO</text>

    <!-- Watermark -->
    <text x="${cx}" y="${H - 14}" font-family="Inter" font-size="12"
          font-weight="400" fill="#4b5563" text-anchor="middle">star-hangar.com</text>
  </svg>`;

  return Buffer.from(svg);
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const fromShip = searchParams.get("from")?.trim();
  const toShip = searchParams.get("to")?.trim();

  if (!fromShip || !toShip) {
    return new Response("Missing ?from= and ?to= params", { status: 400 });
  }

  const matrix = await getShipMatrix();
  const fromEntry = findShip(matrix, fromShip);
  const toEntry = findShip(matrix, toShip);

  const [fromImg, toImg] = await Promise.all([
    fromEntry ? fetchResized(fromEntry.imageUrl) : null,
    toEntry ? fetchResized(toEntry.imageUrl) : null,
  ]);

  const bg = await sharp({
    create: { width: W, height: H, channels: 4, background: BG },
  })
    .png()
    .toBuffer();

  const shipY = Math.round((H - SHIP_H) / 2);
  const rightX = W - SHIP_W - 40;

  const composites: OverlayOptions[] = [
    {
      input: fromImg ?? (await sharp(placeholderShip(fromShip)).png().toBuffer()),
      left: 40,
      top: shipY,
    },
    {
      input: toImg ?? (await sharp(placeholderShip(toShip)).png().toBuffer()),
      left: rightX,
      top: shipY,
    },
    { input: buildOverlay(fromShip, toShip), left: 0, top: 0 },
  ];

  const output = await sharp(bg)
    .composite(composites)
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();

  return new Response(output, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=3600",
      "Content-Disposition": `inline; filename="${fromShip}-to-${toShip}.jpg"`,
    },
  });
}
