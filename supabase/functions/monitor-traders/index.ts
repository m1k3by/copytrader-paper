// Called by Supabase Cron every 30s. Mirrors each enabled trader's Hyperliquid positions as paper trades.
import { withSupabase, type SupabaseContext } from "@supabase/server";
import { closePnl, diffPositions, fillPrice, type Position, type Side } from "./engine.ts";

type Db = SupabaseContext["supabaseAdmin"];
type Settings = { position_size: number; fee_bps: number; slippage_bps: number };
type Trader = { id: number; name: string; wallet_address: string; synced_at: string | null };
type HlPosition = { coin: string; szi: string; entryPx: string; leverage?: { value: number } };

async function hyperliquid(body: object) {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`hyperliquid ${res.status}: ${await res.text()}`);
  return res.json();
}

async function syncTrader(db: Db, t: Trader, s: Settings, mids: Record<string, string>) {
  const state = await hyperliquid({ type: "clearinghouseState", user: t.wallet_address });
  const current: Position[] = state.assetPositions.map(({ position: p }: { position: HlPosition }) => ({
    coin: p.coin,
    side: Number(p.szi) > 0 ? "long" : "short",
    entryPrice: Number(p.entryPx),
    size: Math.abs(Number(p.szi)),
    leverage: p.leverage?.value ?? null,
  }));
  const { data: open } = await db.from("source_trades").select("id, coin, side")
    .eq("trader_id", t.id).is("closed_at", null).throwOnError();
  const { closed, opened } = diffPositions(current, open);
  const now = new Date().toISOString();
  const skipped: string[] = [];

  for (const o of closed) {
    const mid = Number(mids[o.coin]);
    if (!mid) { skipped.push(o.coin); continue; } // no price: retry next run
    // Paper trade first: if the source update below fails, the next run retries it and finds no open paper trade.
    const { data: pt } = await db.from("paper_trades").select("id, side, size_usd, entry_price")
      .eq("source_trade_id", o.id).eq("status", "open").maybeSingle().throwOnError();
    if (pt) {
      const exit = fillPrice(mid, pt.side as Side, s.slippage_bps, false);
      const { pnl, fees } = closePnl(pt.side as Side, pt.size_usd, pt.entry_price, exit, s.fee_bps);
      await db.from("paper_trades").update({ exit_price: exit, fees, pnl, status: "closed", closed_at: now })
        .eq("id", pt.id).eq("status", "open").throwOnError();
    }
    await db.from("source_trades").update({ exit_price: mid, closed_at: now }).eq("id", o.id).throwOnError();
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
    await db.from("paper_trades").insert({
      source_trade_id: st.id,
      coin: p.coin,
      side: p.side,
      entry_price: fillPrice(mid, p.side, s.slippage_bps, true),
      size_usd: s.position_size,
    }).throwOnError();
  }

  await db.from("traders").update({ synced_at: now }).eq("id", t.id).throwOnError();
  return { trader: t.name, closed: closed.length, opened: opened.length, skipped };
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
      syncTrader(db, t, settings, mids).catch((e) => {
        console.error(t.name, e);
        return { trader: t.name, error: String(e) };
      })
    ));
    return Response.json(results);
  }),
};
