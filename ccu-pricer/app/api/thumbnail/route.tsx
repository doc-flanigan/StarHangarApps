import { NextRequest } from "next/server";
import { ImageResponse } from "next/og";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const W = 1200;
const H = 630;
const SHIP_W = 500;
const SHIP_H = 340;
const SHIP_TOP = 80;

// ── Fonts ─────────────────────────────────────────────────────────────────────

function readFont(name: string): ArrayBuffer {
  const buf = fs.readFileSync(path.join(process.cwd(), "public", "fonts", name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

let fonts: { name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" }[] | null = null;
function getFontConfig() {
  if (!fonts) {
    fonts = [
      { name: "Inter", data: readFont("inter-400.woff"), weight: 400, style: "normal" },
      { name: "Inter", data: readFont("inter-700.woff"), weight: 700, style: "normal" },
    ];
  }
  return fonts;
}

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
  });
  if (!res.ok) {
    console.error(`[thumbnail] ship matrix fetch failed: ${res.status}`);
    return [];
  }

  const data = await res.json();
  const all = ((data.data ?? []) as Record<string, unknown>[]).map((ship) => {
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
  });

  console.log(`[thumbnail] matrix loaded: ${all.length} ships, ${all.filter(s => s.imageUrl).length} with images`);
  // Log Aurora entries so we can see the exact names
  const aurora = all.filter(s => s.name?.toLowerCase().includes("aurora"));
  if (aurora.length) console.log(`[thumbnail] aurora ships:`, JSON.stringify(aurora.map(s => s.name)));

  matrixCache = all.filter((s) => s.name && s.imageUrl);
  matrixExpiry = Date.now() + 3_600_000;
  return matrixCache!;
}

// Strip common SC manufacturer prefixes so "Aurora MR" matches "RSI Aurora MR"
const PREFIXES = ["roberts space industries", "rsi", "origin", "aegis dynamics", "aegis",
  "drake interplanetary", "drake", "misc", "anvil aerospace", "anvil", "argo astronautics",
  "argo", "crusader industries", "crusader", "esperia", "gatac", "banu", "aopoa",
  "consolidated outland", "tumbril", "greycat", "cnou", "kyatok", "xian"];

function normalize(s: string): string {
  let n = s.toLowerCase().trim();
  for (const p of PREFIXES) {
    if (n.startsWith(p + " ")) { n = n.slice(p.length + 1).trim(); break; }
  }
  return n;
}

function findShip(matrix: ShipEntry[], query: string): ShipEntry | null {
  const q = normalize(query);
  const norm = matrix.map((s) => ({ ...s, _n: normalize(s.name) }));
  const result =
    norm.find((s) => s._n === q) ??
    norm.find((s) => s.name.toLowerCase() === query.toLowerCase().trim()) ??
    norm.find((s) => s._n.includes(q)) ??
    norm.find((s) => q.includes(s._n)) ??
    null;
  console.log(`[thumbnail] findShip("${query}") → norm="${q}" → ${result ? result.name : "NOT FOUND"}`);
  return result;
}

// ── Image fetch → data URI ────────────────────────────────────────────────────

async function toDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get("content-type") ?? "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const fromShip = searchParams.get("from")?.trim();
  const toShip = searchParams.get("to")?.trim();
  if (!fromShip || !toShip)
    return new Response("Missing ?from= and ?to= params", { status: 400 });

  const matrix = await getShipMatrix();
  const fromEntry = findShip(matrix, fromShip);
  const toEntry = findShip(matrix, toShip);

  const [fromDataUri, toDataUri_] = await Promise.all([
    fromEntry ? toDataUri(fromEntry.imageUrl) : null,
    toEntry ? toDataUri(toEntry.imageUrl) : null,
  ]);

  const ShipSlot = ({ src, label }: { src: string | null; label: string }) =>
    src ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        width={SHIP_W}
        height={SHIP_H}
        alt={label}
        style={{ objectFit: "cover" }}
      />
    ) : (
      <div
        style={{
          display: "flex",
          width: SHIP_W,
          height: SHIP_H,
          background: "#1e2640",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ color: "#6b7280", fontSize: 20, fontFamily: "Inter" }}>{label}</span>
      </div>
    );

  const element = (
    <div
      style={{
        display: "flex",
        width: W,
        height: H,
        background: "#080c18",
        position: "relative",
        fontFamily: "Inter",
      }}
    >
      {/* Ship images */}
      <div style={{ display: "flex", position: "absolute", left: 40, top: SHIP_TOP }}>
        <ShipSlot src={fromDataUri} label={fromShip} />
      </div>
      <div style={{ display: "flex", position: "absolute", right: 40, top: SHIP_TOP }}>
        <ShipSlot src={toDataUri_} label={toShip} />
      </div>

      {/* Top header bar */}
      <div
        style={{
          display: "flex",
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 80,
          background: "rgba(8,8,15,0.75)",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ color: "#f59e0b", fontSize: 48, fontWeight: 700, letterSpacing: 8 }}>
          CROSS-CHASSIS UPGRADE
        </span>
      </div>

      {/* Bottom gradient scrim */}
      <div
        style={{
          display: "flex",
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 200,
          background: "linear-gradient(to bottom, rgba(8,12,24,0) 0%, rgba(8,12,24,0.93) 100%)",
        }}
      />

      {/* Center arrow */}
      <div
        style={{
          display: "flex",
          position: "absolute",
          left: W / 2 - 80,
          top: H / 2 - 80,
          width: 160,
          height: 160,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ color: "#f59e0b", fontSize: 140, fontWeight: 700, lineHeight: 1 }}>→</span>
      </div>

      {/* Left ship label */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          position: "absolute",
          left: 40,
          bottom: 50,
          width: SHIP_W,
        }}
      >
        <span style={{ color: "white", fontSize: 90, fontWeight: 700 }}>{fromShip}</span>
        <span style={{ color: "#9ca3af", fontSize: 36, letterSpacing: 6, marginTop: 8 }}>FROM</span>
      </div>

      {/* Right ship label */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          position: "absolute",
          right: 40,
          bottom: 50,
          width: SHIP_W,
        }}
      >
        <span style={{ color: "white", fontSize: 90, fontWeight: 700 }}>{toShip}</span>
        <span style={{ color: "#9ca3af", fontSize: 36, letterSpacing: 6, marginTop: 8 }}>TO</span>
      </div>

      {/* Watermark */}
      <div
        style={{
          display: "flex",
          position: "absolute",
          bottom: 14,
          left: 0,
          right: 0,
          justifyContent: "center",
        }}
      >
        <span style={{ color: "#4b5563", fontSize: 24 }}>star-hangar.com</span>
      </div>
    </div>
  );

  return new ImageResponse(element, {
    width: W,
    height: H,
    fonts: getFontConfig(),
  });
}
