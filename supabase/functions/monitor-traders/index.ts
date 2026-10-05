// Called by Supabase Cron every 30s. Mirrors each enabled trader's positions as paper trades:
// Hyperliquid wallets directly, Invo (paper) portfolios through Invo's unofficial app API.
import { withSupabase, type SupabaseContext } from "@supabase/server";
import { closePnl, closingVwap, diffPositions, fillPrice, resizeTrade, type HlFill, type Position, type Side } from "./engine.ts";

type Db = SupabaseContext["supabaseAdmin"];
type Settings = { position_size: number; fee_bps: number; slippage_bps: number };
type Trader = { id: number; name: string; platform: string; wallet_address: string; synced_at: string | null };
type HlPosition = { coin: string; szi: string; entryPx: string; leverage?: { value: number } };
type InvoPosition = { ticker: string; directionLong: boolean; entryPrice: number; entrySim: number; leverage: number };
type InvoClosed = { ticker: string; directionLong: boolean; isOpen: boolean; closingPrice: number | null; closedAt: string };
type OpenRow = { id: number; coin: string; side: Side; size: number; opened_at: string; resizes: number };
type PaperRow = { id: number; side: Side; size_usd: number; entry_price: number; realized_pnl: number; fees: number };

// Adds grow a copy to at most this multiple of position_size ($300 at $100).
const MAX_SIZE_FACTOR = 3;

async function hyperliquid(body: object) {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`hyperliquid ${res.status}: ${await res.text()}`);
  return res.json();
}

// Invo: headers as sent by app.invoapp.com (web app 0.0.85). Access tokens live ~10 min and are minted from
// a long-lived refresh token (INVO_REFRESH_TOKEN secret, set by hand). Cached while the function instance is warm.
const INVO = "https://api.invoapp.com";
const INVO_HEADERS = { "x-app-version": "0.0.85", "x-platform": "web" };
let invoToken: { value: string; expires: number } | null = null;
let minting: Promise<{ value: string; expires: number }> | null = null;

async function mintInvoToken() {
  const refresh = Deno.env.get("INVO_REFRESH_TOKEN");
  if (!refresh) throw new Error("INVO_REFRESH_TOKEN secret not set");
  const res = await fetch(`${INVO}/v1_0/auth/refresh_token`, { headers: { Authorization: `Bearer ${refresh}`, ...INVO_HEADERS } });
  if (!res.ok) throw new Error(`invo refresh ${res.status}: ${await res.text()}`);
  const { accessToken } = await res.json();
  const payload = JSON.parse(atob(accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  return { value: accessToken as string, expires: Number(payload.expires) }; // NaN -> refreshed every run
}

async function invoAccessToken() {
  if (invoToken && invoToken.expires - Date.now() / 1000 > 30) return invoToken.value;
  // One refresh shared by all traders of a run; a failed one is forgotten so the next run retries.
  minting ??= mintInvoToken().finally(() => { minting = null; });
  invoToken = await minting;
  return invoToken.value;
}

async function invo(path: string, body: object) {
  const res = await fetch(`${INVO}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await invoAccessToken()}`, "Content-Type": "application/json", ...INVO_HEADERS },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`invo ${res.status}: ${text}`);
  const data = JSON.parse(text.trimStart().startsWith("{") ? text : atob(text)); // some Invo responses are base64 JSON
  if (!data.success) throw new Error(`invo: ${text}`);
  return data;
}

async function invoPositions(portfolioId: string): Promise<Position[]> {
  const data = await invo("/v1_0/investments/get_investments_sims", { portfolioId });
  // entrySim = sim capital put into the position; assumed to grow on adds and shrink on partial closes.
  return (data.investments as InvoPosition[]).map((i) => ({
    coin: i.ticker,
    side: i.directionLong ? "long" : "short",
    entryPrice: i.entryPrice,
    size: i.entrySim,
    leverage: i.leverage,
  }));
}

async function hyperliquidPositions(wallet: string): Promise<Position[]> {
  const state = await hyperliquid({ type: "clearinghouseState", user: wallet });
  return state.assetPositions.map(({ position: p }: { position: HlPosition }) => ({
    coin: p.coin,
    side: Number(p.szi) > 0 ? "long" : "short",
    entryPrice: Number(p.entryPx),
    size: Math.abs(Number(p.szi)),
    leverage: p.leverage?.value ?? null,
  }));
}

// The trader's own exit price for a position we saw open since `opened_at`.
async function traderExitPrice(t: Trader, o: OpenRow): Promise<number | null> {
  const since = Date.parse(o.opened_at);
  if (t.platform === "invo") {
    // Closed trades of the portfolio, newest first as the app lists them; filtered here, so the isOpen flag is a hint only.
    const data = await invo("/v1_0/investments/get_investments", { portfolioId: t.wallet_address, isOpen: false, params: { page: 1, size: 20 } });
    const hit = ((data.investmentsTicker ?? []) as InvoClosed[]).find((i) =>
      !i.isOpen && i.ticker === o.coin && i.directionLong === (o.side === "long") && Date.parse(i.closedAt) >= since
    );
    return hit?.closingPrice ?? null;
  }
  // ponytail: userFillsByTime returns the oldest 2000 fills after `since`; a very busy trader's last closes can fall off.
  const fills: (HlFill & { coin: string })[] = await hyperliquid({ type: "userFillsByTime", user: t.wallet_address, startTime: since, aggregateByTime: true });
  return closingVwap(fills.filter((f) => f.coin === o.coin), o.side);
}

async function syncTrader(db: Db, t: Trader, s: Settings, mids: Record<string, string>) {
  const current = t.platform === "invo" ? await invoPositions(t.wallet_address) : await hyperliquidPositions(t.wallet_address);
  const { data: open } = await db.from("source_trades").select("id, coin, side, size, opened_at, resizes")
    .eq("trader_id", t.id).is("closed_at", null).throwOnError();
  const { closed, opened, resized } = diffPositions(current, open as OpenRow[]);
  const now = new Date().toISOString();
  const skipped: string[] = [];
  // Open copies of a source position: the real one and its random-direction control twin (none if never copied).
  const openCopies = async (sourceId: number) =>
    (await db.from("paper_trades").select("id, side, size_usd, entry_price, realized_pnl, fees")
      .eq("source_trade_id", sourceId).eq("status", "open").throwOnError()).data as PaperRow[];

  for (const o of closed) {
    const mid = Number(mids[o.coin]);
    if (!mid) { skipped.push(o.coin); continue; } // no price: retry next run
    // Paper trades first: if the source update below fails, the next run retries it and finds no open paper trade.
    for (const pt of await openCopies(o.id)) {
      const exit = fillPrice(mid, pt.side, s.slippage_bps, false);
      const last = closePnl(pt.side, pt.size_usd, pt.entry_price, exit, s.fee_bps);
      await db.from("paper_trades")
        .update({ exit_price: exit, fees: pt.fees + last.fees, pnl: pt.realized_pnl + last.pnl, status: "closed", closed_at: now })
        .eq("id", pt.id).eq("status", "open").throwOnError();
    }
    // Only feeds the fidelity metrics, so it never blocks the close.
    const traderExit = await traderExitPrice(t, o).catch((e) => (console.error(t.name, o.coin, "trader exit", e), null));
    await db.from("source_trades").update({ exit_price: mid, trader_exit_price: traderExit, closed_at: now }).eq("id", o.id).throwOnError();
  }

  for (const { source, position } of resized) {
    const mid = Number(mids[source.coin]);
    if (!mid) { skipped.push(source.coin); continue; }
    // Source first: if the paper update below fails we miss one resize instead of applying it twice next run.
    // ponytail: two overlapping runs could still both apply it; add a compare-and-set on size if that ever shows up.
    await db.from("source_trades").update({ size: position.size, entry_price: position.entryPrice, resizes: source.resizes + 1 })
      .eq("id", source.id).throwOnError();
    const ratio = position.size / source.size;
    for (const pt of await openCopies(source.id)) {
      const fill = fillPrice(mid, pt.side, s.slippage_bps, ratio > 1);
      const r = resizeTrade(pt.side, pt.size_usd, pt.entry_price, ratio, fill, s.fee_bps, s.position_size * MAX_SIZE_FACTOR);
      await db.from("paper_trades")
        .update({ size_usd: r.sizeUsd, entry_price: r.entry, realized_pnl: pt.realized_pnl + r.realized, fees: pt.fees + r.fees })
        .eq("id", pt.id).eq("status", "open").throwOnError();
    }
  }

  for (const p of opened) {
    const mid = Number(mids[p.coin]);
    if (!mid) { skipped.push(p.coin); continue; }
    const { data: st, error } = await db.from("source_trades")
      .insert({ trader_id: t.id, coin: p.coin, side: p.side, entry_price: p.entryPrice, size: p.size, leverage: p.leverage })
      .select("id").single();
    if (error?.code === "23505") continue; // already tracked (overlapping run, or a close above was skipped)
    if (error) throw error;
    if (!t.synced_at) continue; // first poll: position predates tracking, copying it now would be a stale entry
    const copy = (side: Side, control: boolean) => ({
      source_trade_id: st.id,
      coin: p.coin,
      side,
      control,
      entry_price: fillPrice(mid, side, s.slippage_bps, true),
      size_usd: s.position_size,
    });
    await db.from("paper_trades")
      .insert([copy(p.side, false), copy(Math.random() < 0.5 ? "long" : "short", true)]).throwOnError();
  }

  await db.from("traders").update({ synced_at: now }).eq("id", t.id).throwOnError();
  return { trader: t.name, closed: closed.length, opened: opened.length, resized: resized.length, skipped };
}

export default {
  fetch: withSupabase({ auth: "secret" }, async (_req, ctx) => {
    const db = ctx.supabaseAdmin;
    const { data: settings } = await db.from("settings").select().single().throwOnError();
    const { data: traders } = await db.from("traders").select().eq("enabled", true).throwOnError();
    const mids = await hyperliquid({ type: "allMids" });
    // Traders are independent; sequential took ~0.5 s each and hit pg_net's timeout at 10 traders.
    // ponytail: all at once, batch if the list grows past Hyperliquid's rate limit (1200 weight/min per IP)
    const results = await Promise.all((traders as Trader[]).map((t) =>
      syncTrader(db, t, settings, mids).catch(async (e) => {
        console.error(t.name, e);
        // Shown on the dashboard while newer than synced_at.
        await db.from("traders").update({ last_error: String(e).slice(0, 500), last_error_at: new Date().toISOString() }).eq("id", t.id);
        return { trader: t.name, error: String(e) };
      })
    ));
    return Response.json(results);
  }),
};
