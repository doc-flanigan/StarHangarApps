import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

let cache: string[] | null = null;
let expiry = 0;

export async function GET(_req: NextRequest) {
  if (cache && Date.now() < expiry) {
    return Response.json({ ships: cache });
  }

  const res = await fetch("https://robertsspaceindustries.com/ship-matrix/index", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; CCU-Pricer/1.0)" },
  });

  if (!res.ok) return Response.json({ ships: [] });

  const data = await res.json();
  cache = ((data.data ?? []) as Record<string, unknown>[])
    .map((s) => s["name"] as string)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  expiry = Date.now() + 3_600_000;
  return Response.json({ ships: cache });
}
