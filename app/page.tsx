import { hyperliquid } from "@/lib/hyperliquid";
import { db as connect } from "@/lib/supabase";
import { closePnl, fillPrice, type Side } from "@/supabase/functions/monitor-traders/engine";

export const dynamic = "force-dynamic";

type Trade = {
  id: number;
  coin: string;
  side: Side;
  entry_price: number;
  exit_price: number | null;
  size_usd: number;
  pnl: number | null;
  opened_at: string;
  closed_at: string | null;
  source_trades: { traders: { name: string } };
};

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const signed = (n: number) => (n >= 0 ? "+" : "") + usd(n);
const color = (n: number) => (n >= 0 ? "text-emerald-400" : "text-red-400");
const price = (n: number) => n.toLocaleString("en-US", { maximumSignificantDigits: 6 });

export default async function Home() {
  const db = connect();
  const trades = "id, coin, side, entry_price, exit_price, size_usd, pnl, opened_at, closed_at, source_trades(traders(name))";
  const [settings, stats, open, closed, mids] = await Promise.all([
    db.from("settings").select().single().throwOnError(),
    db.from("trader_stats").select().order("realized_pnl", { ascending: false }).throwOnError(),
    db.from("paper_trades").select(trades).eq("status", "open").order("opened_at", { ascending: false }).throwOnError(),
    db.from("paper_trades").select(trades).eq("status", "closed").order("closed_at", { ascending: false }).limit(50).throwOnError(),
    hyperliquid<Record<string, string>>({ type: "allMids" }),
  ]);
  const s = settings.data;
  const openTrades = open.data as unknown as Trade[];

  // Unrealized = what closing right now would book, incl. exit slippage and both fees.
  const live = openTrades.map((t) => {
    const mid = Number(mids[t.coin]);
    const pnl = mid ? closePnl(t.side, t.size_usd, t.entry_price, fillPrice(mid, t.side, s.slippage_bps, false), s.fee_bps).pnl : 0;
    return { ...t, mid, pnl };
  });
  const realized = stats.data.reduce((sum, t) => sum + t.realized_pnl, 0);
  const unrealized = live.reduce((sum, t) => sum + t.pnl, 0);
  const equity = s.starting_balance + realized + unrealized;

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
      </section>

      <Table title="Trader" head={["Trader", "PnL", "Winrate", "Closed", "Open"]}>
        {stats.data.map((t) => (
          <tr key={t.id} className={t.enabled ? "" : "text-zinc-600"}>
            <td title={t.wallet_address}>{t.name}</td>
            <td className={color(t.realized_pnl)}>{signed(t.realized_pnl)}</td>
            <td>{t.winrate === null ? "–" : `${Math.round(t.winrate * 100)}%`}</td>
            <td>{t.closed_trades}</td>
            <td>{t.open_trades}</td>
          </tr>
        ))}
      </Table>

      <Table title="Live Paper Trades" head={["Coin", "PnL", "Trader", "Entry", "Current"]}>
        {live.map((t) => (
          <tr key={t.id}>
            <td>{t.coin} {t.side.toUpperCase()}</td>
            <td className={color(t.pnl)}>{signed(t.pnl)} ({((t.pnl / t.size_usd) * 100).toFixed(2)}%)</td>
            <td>{t.source_trades.traders.name}</td>
            <td>{price(t.entry_price)}</td>
            <td>{t.mid ? price(t.mid) : "–"}</td>
          </tr>
        ))}
      </Table>

      <Table title="Closed (last 50)" head={["Coin", "PnL", "Trader", "Entry", "Exit", "Closed"]}>
        {(closed.data as unknown as Trade[]).map((t) => (
          <tr key={t.id}>
            <td>{t.coin} {t.side.toUpperCase()}</td>
            <td className={color(t.pnl!)}>{signed(t.pnl!)}</td>
            <td>{t.source_trades.traders.name}</td>
            <td>{price(t.entry_price)}</td>
            <td>{price(t.exit_price!)}</td>
            <td className="text-zinc-500">{new Date(t.closed_at!).toLocaleString("de-DE")}</td>
          </tr>
        ))}
      </Table>
    </main>
  );
}

function Table({ title, head, children }: { title: string; head: string[]; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-xs tracking-widest text-zinc-500">{title.toUpperCase()}</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-left [&_td]:py-1 [&_td]:pr-4 [&_th]:pr-4 [&_th]:font-normal [&_th]:text-zinc-500">
          <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </section>
  );
}
