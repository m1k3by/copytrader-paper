// Picks copy candidates from Hyperliquid's public leaderboard (stats-data.hyperliquid.xyz/Mainnet/leaderboard).

type Window = { pnl: string; roi: string; vlm: string };
export type LeaderboardRow = {
  ethAddress: string;
  displayName: string | null;
  accountValue: string;
  windowPerformances: [string, Window][];
};
export type Candidate = {
  address: string;
  name: string | null;
  accountValue: number;
  monthPnl: number;
  monthReturn: number; // month PnL / current account value
  weekPnl: number;
  allTimePnl: number;
  turnover: number; // month volume / account value
};

// Hyperliquid's own ROI explodes for tiny starting balances (millions of % on zero volume),
// so rank by month PnL over today's account value. Turnover 2-100x/month: actually trades, but isn't a market maker / HFT bot.
export function rankCandidates(rows: LeaderboardRow[], limit: number): Candidate[] {
  return rows
    .map((r) => {
      const w = Object.fromEntries(r.windowPerformances);
      const accountValue = Number(r.accountValue);
      return {
        address: r.ethAddress,
        name: r.displayName,
        accountValue,
        monthPnl: Number(w.month.pnl),
        monthReturn: Number(w.month.pnl) / accountValue,
        weekPnl: Number(w.week.pnl),
        allTimePnl: Number(w.allTime.pnl),
        turnover: Number(w.month.vlm) / accountValue,
      };
    })
    .filter((c) => c.accountValue >= 50_000 && c.turnover >= 2 && c.turnover < 100 && c.monthPnl > 0 && c.allTimePnl > 0)
    .sort((a, b) => b.monthReturn - a.monthReturn)
    .slice(0, limit);
}

// Share of fills on the main perp dex. The worker only reads that dex, so trades on builder dexes ("xyz:INTC")
// or spot ("@107") would never be copied. null = no fills to judge by.
export function mainDexShare(fills: { coin: string }[]): number | null {
  if (!fills.length) return null;
  return fills.filter((f) => !f.coin.includes(":") && !f.coin.startsWith("@")).length / fills.length;
}
