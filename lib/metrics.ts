// Per-trader copy metrics from closed paper trades. Pure, used by the dashboard.

export type ClosedCopy = {
  pnl: number;
  sizeUsd: number;
  side: "long" | "short";
  entry: number; // our fill
  exit: number; // our fill
  traderEntry: number; // trader's average entry
  traderExit: number | null; // trader's own exit, null when it couldn't be fetched
  openedAt: number; // ms
  closedAt: number; // ms
  resizes: number;
};

// Proposed bar for considering a trader with real money; tune here.
export const LIVE_GATE = { minTrades: 100, minProfitFactor: 1.3, maxLuckShare: 0.3, minCapture: 0.5 };

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);
function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export type CopyMetrics = ReturnType<typeof copyMetrics>;

export function copyMetrics(trades: ClosedCopy[], now: number) {
  const n = trades.length;
  const pnls = trades.map((t) => t.pnl);
  const total = sum(pnls);
  const perTrade = mean(pnls);
  // ponytail: normal-approximation 95% interval; switch to a bootstrap if fat tails make it misleading at small n
  const sd = n > 1 ? Math.sqrt(sum(pnls.map((p) => (p - perTrade!) ** 2)) / (n - 1)) : null;
  const ci = sd === null ? null : ([perTrade! - (1.96 * sd) / Math.sqrt(n), perTrade! + (1.96 * sd) / Math.sqrt(n)] as const);
  const wins = sum(pnls.filter((p) => p > 0));
  const losses = -sum(pnls.filter((p) => p < 0));

  // Drawdown and longest stretch below a previous high of the cumulative PnL, in close order.
  const byClose = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  let cum = 0, peak = 0, peakAt = byClose[0]?.openedAt ?? now, maxDrawdown = 0, underwaterMs = 0;
  for (const t of byClose) {
    cum += t.pnl;
    if (cum >= peak) [peak, peakAt] = [cum, t.closedAt];
    else [maxDrawdown, underwaterMs] = [Math.max(maxDrawdown, peak - cum), Math.max(underwaterMs, t.closedAt - peakAt)];
  }
  if (n && cum < peak) underwaterMs = Math.max(underwaterMs, now - peakAt); // still under water

  const dir = (t: ClosedCopy) => (t.side === "long" ? 1 : -1);
  const withExit = trades.filter((t) => t.traderExit !== null);
  const traderRet = sum(withExit.map((t) => dir(t) * (t.traderExit! / t.traderEntry - 1)));
  const ourRet = sum(withExit.map((t) => t.pnl / t.sizeUsd));

  return {
    n,
    total,
    perTrade,
    ci,
    winrate: n ? pnls.filter((p) => p > 0).length / n : null,
    profitFactor: losses > 0 ? wins / losses : wins > 0 ? Infinity : null,
    maxDrawdown,
    underwaterMs,
    medianHoldMs: median(trades.map((t) => t.closedAt - t.openedAt)),
    luckShare: total > 0 ? Math.max(...pnls) / total : null, // share of the profit from the single best trade
    avgResizes: mean(trades.map((t) => t.resizes)),
    // Our return vs. the trader's on the same positions (ours after fees and slippage). Only meaningful if theirs is positive.
    capture: withExit.length && traderRet > 0 ? ourRet / traderRet : null,
    // How much worse our fills were than the trader's, in basis points (positive = worse for us).
    entryGapBps: mean(trades.map((t) => (dir(t) * (t.entry - t.traderEntry) / t.traderEntry) * 1e4)),
    exitGapBps: mean(withExit.map((t) => (dir(t) * (t.traderExit! - t.exit) / t.traderExit!) * 1e4)),
  };
}

// What still keeps a trader from the real-money bar; empty = passes. `control` = metrics of their random-direction twins.
export function liveGateMisses(m: CopyMetrics, control: CopyMetrics): string[] {
  const g = LIVE_GATE;
  const misses: string[] = [];
  if (m.n < g.minTrades) misses.push(`${m.n}/${g.minTrades} Trades`);
  if (!m.ci || m.ci[0] <= 0) misses.push("$/Trade nicht sicher über 0");
  if (m.profitFactor === null || m.profitFactor < g.minProfitFactor) misses.push(`Profit Factor < ${g.minProfitFactor}`);
  if (m.luckShare !== null && m.luckShare > g.maxLuckShare) misses.push("zu viel aus einem Trade");
  if (m.capture === null || m.capture < g.minCapture) misses.push(`Capture < ${g.minCapture * 100} %`);
  if (m.perTrade === null || control.perTrade === null || m.perTrade <= control.perTrade) misses.push("schlägt Zufall nicht");
  return misses;
}
