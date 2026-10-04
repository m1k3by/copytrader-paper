import { unstable_cache } from "next/cache";
import { hyperliquid } from "@/lib/hyperliquid";
import { activity, blocker, rankCandidates, RULES, type Candidate, type Fill, type LeaderboardRow } from "@/lib/leaderboard";
import { dur } from "@/lib/format";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Hobby maximum; a cold run fetches ~40 MB + 30 × ~0.8 MB of fills

const CHECKED = 30;

// Recomputed at most hourly: each fill check costs ~40 of Hyperliquid's 1200 weight/min per IP.
const load = unstable_cache(async () => {
  const res = await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard", { cache: "no-store" });
  if (!res.ok) throw new Error(`leaderboard ${res.status}`);
  const { leaderboardRows } = (await res.json()) as { leaderboardRows: LeaderboardRow[] };
  const now = Date.now();
  const check = async (c: Candidate) => {
    // userFills = most recent fills; userFillsByTime would return the oldest 2000 of the window
    const fills = await hyperliquid<Fill[]>({ type: "userFills", user: c.address, aggregateByTime: true })
      .catch((e) => (console.error(c.address, e), null)); // rate-limited or down: shown as unknown
    const a = fills && activity(fills, now);
    return { ...c, activity: a, blocker: a ? blocker(a, now, c.pnlPerVolume) : "? (API)" };
  };
  const top = rankCandidates(leaderboardRows, CHECKED);
  const rows = [];
  // ponytail: 5 at a time (~2 s per call). Up to ~120 weight per busy wallet can exceed 1200/min on paper;
  // hasn't been rejected so far, and if it is, the row shows "? (API)". Pace the batches if that shows up.
  for (let i = 0; i < top.length; i += 5) rows.push(...(await Promise.all(top.slice(i, i + 5).map(check))));
  return { rows, updatedAt: now };
}, ["leaderboard-v3"], { revalidate: 3600 });

const compact = (n: number) => "$" + Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const signed = (n: number) => (n >= 0 ? "+" : "-") + compact(Math.abs(n));
const color = (n: number) => (n >= 0 ? "text-emerald-400" : "text-red-400");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ago = (t: number | null, now: number) => {
  if (t === null) return "–";
  const h = (now - t) / 36e5;
  return h < 48 ? `vor ${Math.round(h)} h` : `vor ${Math.round(h / 24)} T.`;
};

export default async function Leaderboard() {
  const [{ rows, updatedAt }, { data: traders }] = await Promise.all([
    load(),
    db().from("traders").select("wallet_address, enabled").throwOnError(),
  ]);
  const tracked = new Map(traders.map((t) => [t.wallet_address.toLowerCase(), t.enabled as boolean]));

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-4 font-mono text-sm sm:p-8">
      <section>
        <h1 className="text-xs tracking-widest text-zinc-500">LEADERBOARD · TOP {CHECKED}</h1>
        <p className="mt-2 max-w-3xl text-zinc-400">
          Hyperliquid-Leaderboard, gefiltert: Konto ≥ $50k, im Monat und gesamt im Plus, Monatsumsatz 2–100× Konto.
          Sortiert nach Monats-PnL / Kontowert. Kopierbar nur, wer in den letzten 7 Tagen ≥ {RULES.minMainShare * 100}% auf
          der Hauptbörse gehandelt hat (Nebenbörsen wie xyz: und Spot sieht der Worker nicht), in den letzten{" "}
          {RULES.maxHoursSinceOpen} h eine Position eröffnet hat, an ≥ {RULES.minActiveDays} der letzten 7 Tage aktiv war,
          Positionen im Median ≥ {RULES.minMedianHoldMinutes} min hält und ≥ {RULES.minPnlPerVolume * 100}% Gewinn pro
          Umsatz macht (sonst fressen unsere Gebühren und Slippage den Vorteil).
        </p>
        <p className="mt-1 text-zinc-600">Stand {new Date(updatedAt).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}, stündlich neu</p>
      </section>

      <div className="overflow-x-auto">
        <table className="w-full text-left [&_td]:py-1 [&_td]:pr-4 [&_td]:align-top [&_th]:pr-4 [&_th]:font-normal [&_th]:text-zinc-500">
          <thead>
            <tr>{["Wallet", "Monat", "Status", "Letzter Trade", "Aktive Tage", "Haltedauer", "Gewinn/Umsatz", "Hauptbörse", "Woche", "Gesamt", "Konto"].map((h) => <th key={h}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const copyable = r.blocker === null;
              const a = r.activity;
              return (
                <tr key={r.address} className={copyable ? "" : "text-zinc-600"}>
                  <td title={r.address}>{r.name ?? short(r.address)}</td>
                  <td className={copyable ? color(r.monthPnl) : ""}>
                    {signed(r.monthPnl)} ({Math.round(r.monthReturn * 100)}%)
                  </td>
                  <td>
                    {tracked.has(r.address.toLowerCase()) ? (
                      tracked.get(r.address.toLowerCase()) ? <span className="text-emerald-400">✓ dabei</span> : "deaktiviert"
                    ) : copyable ? (
                      <details>
                        <summary className="cursor-pointer text-zinc-300">übernehmen</summary>
                        <code className="block select-all whitespace-pre-wrap break-all py-1 text-xs text-zinc-400">
                          {`insert into traders (name, wallet_address) values ('${short(r.address)}', '${r.address}');`}
                        </code>
                      </details>
                    ) : (
                      r.blocker
                    )}
                  </td>
                  <td>{a ? ago(a.lastTrade, updatedAt) : "?"}</td>
                  <td>{a ? `${a.activeDays}/7` : "?"}</td>
                  <td>{a ? dur(a.medianHoldMs) : "?"}</td>
                  <td>{(r.pnlPerVolume * 100).toFixed(2)}%</td>
                  <td>{a?.mainShare == null ? "–" : `${Math.round(a.mainShare * 100)}%`}</td>
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
