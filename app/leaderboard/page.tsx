import { unstable_cache } from "next/cache";
import { hyperliquid } from "@/lib/hyperliquid";
import { mainDexShare, rankCandidates, type LeaderboardRow } from "@/lib/leaderboard";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // first load fetches ~40 MB and checks 30 wallets

const CHECKED = 30;
const MIN_MAIN_SHARE = 0.8;

// Recomputed at most hourly: each fill check costs ~40 of Hyperliquid's 1200 weight/min per IP.
const load = unstable_cache(async () => {
  const res = await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard", { cache: "no-store" });
  if (!res.ok) throw new Error(`leaderboard ${res.status}`);
  const { leaderboardRows } = (await res.json()) as { leaderboardRows: LeaderboardRow[] };
  const since = Date.now() - 7 * 864e5;
  const rows = [];
  for (const c of rankCandidates(leaderboardRows, CHECKED)) {
    const fills = await hyperliquid<{ coin: string }[]>({ type: "userFillsByTime", user: c.address, startTime: since, aggregateByTime: true })
      .catch(() => null); // rate-limited or down: shown as unknown
    rows.push({ ...c, fills7d: fills?.length ?? null, mainShare: fills && mainDexShare(fills) });
  }
  return { rows, updatedAt: new Date().toISOString() };
}, ["leaderboard-v1"], { revalidate: 3600 });

const compact = (n: number) => "$" + Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const signed = (n: number) => (n >= 0 ? "+" : "-") + compact(Math.abs(n));
const color = (n: number) => (n >= 0 ? "text-emerald-400" : "text-red-400");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default async function Leaderboard() {
  const [{ rows, updatedAt }, { data: traders }] = await Promise.all([
    load(),
    db().from("traders").select("wallet_address").throwOnError(),
  ]);
  const tracked = new Set(traders.map((t) => t.wallet_address.toLowerCase()));

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-4 font-mono text-sm sm:p-8">
      <section>
        <h1 className="text-xs tracking-widest text-zinc-500">LEADERBOARD · TOP {CHECKED}</h1>
        <p className="mt-2 max-w-3xl text-zinc-400">
          Hyperliquid-Leaderboard, gefiltert: Konto ≥ $50k, im Monat und gesamt im Plus, Monatsumsatz 2–100× Konto.
          Sortiert nach Monats-PnL / Kontowert. Kopierbar nur, wer in den letzten 7 Tagen ≥ {MIN_MAIN_SHARE * 100}% auf
          der Hauptbörse gehandelt hat (Nebenbörsen wie xyz: und Spot sieht der Worker nicht).
        </p>
        <p className="mt-1 text-zinc-600">Stand {new Date(updatedAt).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}, stündlich neu</p>
      </section>

      <div className="overflow-x-auto">
        <table className="w-full text-left [&_td]:py-1 [&_td]:pr-4 [&_td]:align-top [&_th]:pr-4 [&_th]:font-normal [&_th]:text-zinc-500">
          <thead>
            <tr>{["Wallet", "Monat", "Status", "Hauptbörse", "Woche", "Gesamt", "Konto"].map((h) => <th key={h}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const copyable = r.mainShare !== null && r.mainShare >= MIN_MAIN_SHARE;
              return (
                <tr key={r.address} className={copyable ? "" : "text-zinc-600"}>
                  <td title={r.address}>{r.name ?? short(r.address)}</td>
                  <td className={copyable ? color(r.monthPnl) : ""}>
                    {signed(r.monthPnl)} ({Math.round(r.monthReturn * 100)}%)
                  </td>
                  <td>
                    {tracked.has(r.address.toLowerCase()) ? (
                      <span className="text-emerald-400">✓ dabei</span>
                    ) : copyable ? (
                      <details>
                        <summary className="cursor-pointer text-zinc-300">übernehmen</summary>
                        <code className="block select-all whitespace-pre-wrap break-all py-1 text-xs text-zinc-400">
                          {`insert into traders (name, wallet_address) values ('${short(r.address)}', '${r.address}');`}
                        </code>
                      </details>
                    ) : (
                      "nicht kopierbar"
                    )}
                  </td>
                  <td>{r.mainShare === null ? (r.fills7d === 0 ? "keine Trades" : "?") : `${Math.round(r.mainShare * 100)}%`}</td>
                  <td className={copyable ? color(r.weekPnl) : ""}>{signed(r.weekPnl)}</td>
                  <td>{signed(r.allTimePnl)}</td>
                  <td>{compact(r.accountValue)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
