"use client";

import { useState, useRef } from "react";

interface StreamEvent {
  type: "start" | "searching" | "result" | "analyzing" | "done" | "error";
  total?: number;
  index?: number;
  fromShip?: string;
  toShip?: string;
  listingCount?: number;
  minPrice?: number | null;
  maxPrice?: number | null;
  error?: string;
  report?: string;
  message?: string;
}

interface CCUResult {
  fromShip: string;
  toShip: string;
  listingCount: number;
  minPrice: number | null;
  maxPrice: number | null;
  error?: string;
}

export default function Home() {
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [results, setResults] = useState<CCUResult[]>([]);
  const [report, setReport] = useState("");
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  async function run() {
    if (!csvFile) return;

    setRunning(true);
    setResults([]);
    setReport("");
    setError("");
    setProgress(0);
    setStatus("Starting…");

    const formData = new FormData();
    formData.append("csv", csvFile);

    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/price", {
        method: "POST",
        body: formData,
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        setError(await res.text());
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event: StreamEvent = JSON.parse(line.slice(6));

          if (event.type === "start") {
            setTotal(event.total ?? 0);
            setStatus(`Searching StarHangar for ${event.total} CCU types…`);
          } else if (event.type === "searching") {
            setStatus(`Searching: ${event.fromShip} → ${event.toShip}`);
          } else if (event.type === "result") {
            setProgress((p) => p + 1);
            setResults((prev) => [
              ...prev,
              {
                fromShip: event.fromShip!,
                toShip: event.toShip!,
                listingCount: event.listingCount ?? 0,
                minPrice: event.minPrice ?? null,
                maxPrice: event.maxPrice ?? null,
                error: event.error,
              },
            ]);
          } else if (event.type === "analyzing") {
            setStatus("Analyzing market data with Claude…");
          } else if (event.type === "done") {
            setReport(event.report ?? "");
            setStatus("Done!");
          } else if (event.type === "error") {
            setError(event.message ?? "Unknown error");
          }
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name !== "AbortError") {
        setError(String(err));
      }
    } finally {
      setRunning(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
    setRunning(false);
    setStatus("Stopped.");
  }

  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-4xl mx-auto space-y-8">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-amber-400">
            StarHangar CCU Pricing Agent
          </h1>
          <p className="text-gray-400 mt-1 text-sm">
            Upload your CCU inventory, check live StarHangar listings, get
            Claude&apos;s recommended prices.
          </p>
        </div>

        {/* Config */}
        <div className="bg-gray-900 rounded-xl p-6 space-y-4 border border-gray-800">
          <label className="block">
            <span className="text-xs text-gray-400 uppercase tracking-wide">
              CCU Inventory CSV
            </span>
            <input
              type="file"
              accept=".csv"
              onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)}
              className="mt-1 w-full text-sm text-gray-300 file:mr-3 file:py-1.5 file:px-4 file:rounded-lg file:border-0 file:text-sm file:bg-amber-600 file:text-white hover:file:bg-amber-500 cursor-pointer"
            />
            {csvFile && (
              <span className="text-xs text-gray-500">{csvFile.name}</span>
            )}
          </label>

          <div className="flex gap-3 pt-2">
            <button
              onClick={run}
              disabled={running || !csvFile}
              className="px-5 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-gray-950 font-semibold rounded-lg text-sm transition-colors"
            >
              {running ? "Running…" : "Run Pricing Agent"}
            </button>
            {running && (
              <button
                onClick={stop}
                className="px-5 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg text-sm transition-colors"
              >
                Stop
              </button>
            )}
          </div>
        </div>

        {/* Progress */}
        {(running || progress > 0) && (
          <div className="space-y-3">
            <div className="flex justify-between text-sm text-gray-400">
              <span>{status}</span>
              {total > 0 && (
                <span>
                  {progress}/{total}
                </span>
              )}
            </div>
            {total > 0 && (
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-500 transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-950 border border-red-800 text-red-300 rounded-xl p-4 text-sm">
            <strong>Error:</strong> {error}
          </div>
        )}

        {/* Live results table */}
        {results.length > 0 && (
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800">
              <h2 className="font-semibold text-gray-200">
                Market Data — Live Results
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 uppercase bg-gray-800/50">
                    <th className="px-4 py-2 text-left">From</th>
                    <th className="px-4 py-2 text-left">To</th>
                    <th className="px-4 py-2 text-right">Listings</th>
                    <th className="px-4 py-2 text-right">Min</th>
                    <th className="px-4 py-2 text-right">Max</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {results.map((r, i) => (
                    <tr key={i} className="hover:bg-gray-800/30">
                      <td className="px-4 py-2 text-gray-300">{r.fromShip}</td>
                      <td className="px-4 py-2 text-gray-300">{r.toShip}</td>
                      <td className="px-4 py-2 text-right">
                        {r.error ? (
                          <span className="text-red-400 text-xs">error</span>
                        ) : (
                          <span
                            className={
                              r.listingCount === 0
                                ? "text-gray-500"
                                : "text-green-400"
                            }
                          >
                            {r.listingCount}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-300">
                        {r.minPrice != null ? `$${r.minPrice}` : "—"}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-300">
                        {r.maxPrice != null ? `$${r.maxPrice}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Pricing Report */}
        {report && (
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <h2 className="font-semibold text-gray-200">
                Claude&apos;s Pricing Recommendations
              </h2>
              <button
                onClick={() => {
                  const blob = new Blob([report], { type: "text/markdown" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "pricing_report.md";
                  a.click();
                }}
                className="text-xs px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded-lg text-gray-300 transition-colors"
              >
                Download .md
              </button>
            </div>
            <div className="p-6 overflow-x-auto">
              <ReportRenderer markdown={report} />
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function ReportRenderer({ markdown }: { markdown: string }) {
  const lines = markdown.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("|") && lines[i + 1]?.match(/^\|[-| :]+\|/)) {
      const headers = line.split("|").filter(Boolean).map((h) => h.trim());
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].startsWith("|")) {
        rows.push(lines[i].split("|").filter(Boolean).map((c) => c.trim()));
        i++;
      }
      elements.push(
        <div key={i} className="overflow-x-auto my-4">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-gray-800">
                {headers.map((h, j) => (
                  <th key={j} className="px-3 py-2 text-left text-xs text-gray-400 uppercase border border-gray-700 whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="border-b border-gray-800 hover:bg-gray-800/30">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-1.5 border border-gray-800 text-gray-300 whitespace-nowrap">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    } else if (line.startsWith("## ")) {
      elements.push(<h2 key={i} className="text-lg font-semibold text-gray-200 mt-4 mb-2">{line.slice(3)}</h2>);
      i++;
    } else if (line.startsWith("# ")) {
      elements.push(<h1 key={i} className="text-xl font-bold text-amber-400 mt-4 mb-2">{line.slice(2)}</h1>);
      i++;
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      const items: string[] = [];
      while (i < lines.length && (lines[i].startsWith("- ") || lines[i].startsWith("* "))) {
        items.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <ul key={i} className="list-disc list-inside space-y-1 my-2 text-gray-300 text-sm">
          {items.map((item, j) => <li key={j}>{item}</li>)}
        </ul>
      );
    } else if (line.trim()) {
      elements.push(<p key={i} className="text-gray-300 my-1 text-sm">{line}</p>);
      i++;
    } else {
      i++;
    }
  }

  return <div>{elements}</div>;
}
