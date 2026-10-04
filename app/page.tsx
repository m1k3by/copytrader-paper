import { dur } from "@/lib/format";
import { hyperliquid } from "@/lib/hyperliquid";
import { copyMetrics, LIVE_GATE, liveGateMisses, type ClosedCopy } from "@/lib/metrics";
import { db as connect } from "@/lib/supabase";
import { closePnl, fillPrice, type Side } from "@/supabase/functions/monitor-traders/engine";

export const dynamic = "force-dynamic";

type Trader = {
  id: number;
  name: string;
  enabled: boolean;
  wallet_address: string;
  synced_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
};
type Trade = {
  id: number;
  coin: string;
  side: Side;
  control: boolean; // random-direction twin of a real copy
  entry_price: number;
  exit_price: number | null;
  size_usd: number;
  realized_pnl: number; // booked from partial closes while still open
  pnl: number | null;
  opened_at: string;
  closed_at: string | null;
  source_trades: { trader_id: number; entry_price: number; trader_exit_price: number | null; resizes: number; traders: { name: string } };
};

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const signed = (n: number) => (n >= 0 ? "+" : "") + usd(n);
const color = (n: number) => (n >= 0 ? "text-emerald-400" : "text-red-400");
const price = (n: number) => n.toLocaleString("en-US", { maximumSignificantDigits: 6 });
const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const bps = (x: number | null) => (x === null ? "–" : `${Math.round(x)} bps`);

const COLS = "id, coin, side, control, entry_price, exit_price, size_usd, realized_pnl, pnl, opened_at, closed_at, " +
  "source_trades(trader_id, entry_price, trader_exit_price, resizes, traders(name))";

const toCopy = (t: Trade): ClosedCopy => ({
  pnl: t.pnl!,
  sizeUsd: t.size_usd,
  side: t.side,
  entry: t.entry_price,
  exit: t.exit_price!,
  traderEntry: t.source_trades.entry_price,
  traderExit: t.source_trades.trader_exit_price,
  openedAt: Date.parse(t.opened_at),
  closedAt: Date.parse(t.closed_at!),
  resizes: t.source_trades.resizes,
});

export default async function Home() {
  const db = connect();
  // All closed trades for the metrics, in pages: the API returns at most 1000 rows per request.
  const allClosed = async () => {
    const rows: Trade[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from("paper_trades").select(COLS).eq("status", "closed").order("id").range(from, from + 999).throwOnError();
      rows.push(...(data as unknown as Trade[]));
      if (data.length < 1000) return rows;
    }
  };
  const [settings, traderRows, open, closed, mids] = await Promise.all([
    db.from("settings").select().single().throwOnError(),
    db.from("traders").select("id, name, enabled, wallet_address, synced_at, last_error, last_error_at")
      .order("enabled", { ascending: false }).order("id").throwOnError(),
    db.from("paper_trades").select(COLS).eq("status", "open").order("opened_at", { ascending: false }).throwOnError(),
    allClosed(),
    hyperliquid<Record<string, string>>({ type: "allMids" }),
  ]);
  const s = settings.data;
  const traders = traderRows.data as Trader[];
  // eslint-disable-next-line react-hooks/purity -- server component, rendered once per request (force-dynamic)
  const now = Date.now();

  // Unrealized = what closing right now would book, incl. exit slippage and both fees.
  const live = (open.data as unknown as Trade[]).map((t) => {
    const mid = Number(mids[t.coin]);
    const pnl = t.realized_pnl + (mid ? closePnl(t.side, t.size_usd, t.entry_price, fillPrice(mid, t.side, s.slippage_bps, false), s.fee_bps).pnl : 0);
    return { ...t, mid, pnl };
  });
  const real = <T extends { control: boolean }>(xs: T[]) => xs.filter((t) => !t.control);
  const total = (xs: { pnl: number | null }[]) => xs.reduce((sum, t) => sum + t.pnl!, 0);
  const realized = total(real(closed));
  const unrealized = total(real(live));
  const controlPnl = total(closed.filter((t) => t.control)) + total(live.filter((t) => t.control));
  const equity = s.starting_balance + realized + unrealized;

  // Health: a run that stops syncing or a trader that keeps failing should be visible without digging into logs.
  const enabled = traders.filter((t) => t.enabled);
  const lastRun = Math.max(...enabled.map((t) => (t.synced_at ? Date.parse(t.synced_at) : 0)));
  const failing = (t: Trader) => !!t.last_error_at && (!t.synced_at || Date.parse(t.last_error_at) > Date.parse(t.synced_at));
  const stale = (t: Trader) => !t.synced_at || now - Date.parse(t.synced_at) > 120e3;
  const lastCopy = Math.max(0, ...[...real(closed), ...real(live)].map((t) => Date.parse(t.opened_at)));

  const rows = traders.map((t) => {
    const mine = closed.filter((c) => c.source_trades.trader_id === t.id);
    const m = copyMetrics(real(mine).map(toCopy), now);
    const control = copyMetrics(mine.filter((c) => c.control).map(toCopy), now);
    return { t, m, control, misses: liveGateMisses(m, control), open: real(live).filter((l) => l.source_trades.trader_id === t.id).length };
  });

  return (
    <main className="mx-auto w-full max-w-5xl space-y-10 p-4 font-mono text-sm sm:p-8">
      <section>
        <h1 className="text-xs tracking-widest text-zinc-500">COPYTRADER · PAPER</h1>
        <p className="mt-2 text-4xl font-semibold">{usd(equity)}</p>
        <p className={color(equity - s.starting_balance)}>
          {signed(equity - s.starting_balance)} ({((equity / s.starting_balance - 1) * 100).toFixed(2)}%)
        </p>
        <p className="mt-1 text-zinc-500">
          realized {signed(realized)} · unrealized {signed(unrealized)} · {usd(s.position_size)} per trade
        </p>
        <p className="text-zinc-500">
          Zufalls-Kontrolle (gleiche Trades, Richtung per Münzwurf): <span className={color(controlPnl)}>{signed(controlPnl)}</span>
        </p>
        <p className={now - lastRun > 120e3 ? "mt-1 text-red-400" : "mt-1 text-zinc-600"}>
          Worker: letzter Lauf vor {dur(now - lastRun)} · letzter kopierter Trade {lastCopy ? `vor ${dur(now - lastCopy)}` : "noch keiner"}
          {enabled.some(failing) && <span className="text-red-400"> · {enabled.filter(failing).length} Trader mit Fehler</span>}
        </p>
      </section>

      <Table
        title="Trader"
        head={["Trader", "Status", "Trades", "Offen", "$/Trade (95%-KI)", "Zufall $/Trade", "Winrate", "Profit F.", "Max DD",
          "Unter Wasser", "Haltedauer", "Glück", "Capture", "Einstieg", "Ausstieg", "Nachkäufe", "Echtgeld"]}
      >
        {rows.map(({ t, m, control, misses, open }) => (
          <tr key={t.id} className={t.enabled ? "" : "text-zinc-600"}>
            <td title={t.wallet_address}>{t.name}</td>
            <td>
              {!t.enabled ? "aus" : failing(t) ? (
                <span className="text-red-400" title={t.last_error ?? ""}>Fehler</span>
              ) : stale(t) ? (
                <span className="text-amber-400">veraltet</span>
              ) : (
                <span className="text-emerald-400">ok</span>
              )}
            </td>
            <td>{m.n}</td>
            <td>{open}</td>
            <td className={m.perTrade === null ? "" : color(m.perTrade)}>
              {m.perTrade === null ? "–" : signed(m.perTrade)}
              {m.ci && <span className="text-zinc-500"> [{signed(m.ci[0])}; {signed(m.ci[1])}]</span>}
            </td>
            <td>{control.perTrade === null ? "–" : signed(control.perTrade)}</td>
            <td>{pct(m.winrate)}</td>
            <td>{m.profitFactor === null ? "–" : m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)}</td>
            <td>{m.n ? usd(-m.maxDrawdown) : "–"}</td>
            <td>{m.n ? dur(m.underwaterMs) : "–"}</td>
            <td>{dur(m.medianHoldMs)}</td>
            <td>{pct(m.luckShare)}</td>
            <td>{pct(m.capture)}</td>
            <td>{bps(m.entryGapBps)}</td>
            <td>{bps(m.exitGapBps)}</td>
            <td>{m.avgResizes === null ? "–" : m.avgResizes.toFixed(1)}</td>
            <td>
              {misses.length === 0 ? (
                <span className="text-emerald-400">✓</span>
              ) : (
                <details>
                  <summary className="cursor-pointer">{misses.length} offen</summary>
                  <ul className="text-xs text-zinc-500">{misses.map((x) => <li key={x}>{x}</li>)}</ul>
                </details>
              )}
            </td>
          </tr>
        ))}
      </Table>

      <Table title="Live Paper Trades" head={["Coin", "PnL", "Trader", "Entry", "Current"]}>
        {real(live).map((t) => (
          <tr key={t.id}>
            <td>{t.coin} {t.side.toUpperCase()}</td>
            <td className={color(t.pnl)}>{signed(t.pnl)} ({((t.pnl / t.size_usd) * 100).toFixed(2)}%)</td>
            <td>{t.source_trades.traders.name}</td>
            <td>{price(t.entry_price)}</td>
            <td>{t.mid ? price(t.mid) : "–"}</td>
          </tr>
        ))}
      </Table>

      <Table title="Closed (last 50)" head={["Coin", "PnL", "Trader", "Entry", "Exit", "Trader-Exit", "Closed"]}>
        {real(closed).sort((a, b) => Date.parse(b.closed_at!) - Date.parse(a.closed_at!)).slice(0, 50).map((t) => (
          <tr key={t.id}>
            <td>{t.coin} {t.side.toUpperCase()}</td>
            <td className={color(t.pnl!)}>{signed(t.pnl!)}</td>
            <td>{t.source_trades.traders.name}</td>
            <td>{price(t.entry_price)}</td>
            <td>{price(t.exit_price!)}</td>
            <td>{t.source_trades.trader_exit_price === null ? "–" : price(t.source_trades.trader_exit_price)}</td>
            <td className="text-zinc-500">{new Date(t.closed_at!).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}</td>
          </tr>
        ))}
      </Table>

      <p className="text-xs text-zinc-600">
        Capture = unsere Rendite / die des Traders auf denselben Positionen. Einstieg/Ausstieg = wie viel schlechter unsere Fills waren
        (bps, positiv = schlechter). Glück = Anteil des besten Trades am Gewinn. Echtgeld erst ab {LIVE_GATE.minTrades} Trades, Gewinn
        pro Trade sicher über 0, Profit Factor ≥ {LIVE_GATE.minProfitFactor}, Glück ≤ {LIVE_GATE.maxLuckShare * 100} %, Capture ≥{" "}
        {LIVE_GATE.minCapture * 100} % und besser als die Zufalls-Kontrolle.
      </p>
    </main>
  );
}

function Table({ title, head, children }: { title: string; head: string[]; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-xs tracking-widest text-zinc-500">{title.toUpperCase()}</h2>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-left [&_td]:py-1 [&_td]:pr-4 [&_td]:align-top [&_th]:pr-4 [&_th]:font-normal [&_th]:text-zinc-500">
          <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </section>
  );
}
