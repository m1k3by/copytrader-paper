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

// The worker only reads the main perp dex; trades on builder dexes ("xyz:INTC") or spot ("@107") are never copied.
const isMainDex = (coin: string) => !coin.includes(":") && !coin.startsWith("@");

// Share of fills on the main perp dex. null = no fills to judge by.
export function mainDexShare(fills: { coin: string }[]): number | null {
  if (!fills.length) return null;
  return fills.filter((f) => isMainDex(f.coin)).length / fills.length;
}

const DAY = 864e5;
export const RULES = { minMainShare: 0.8, maxHoursSinceOpen: 48, minActiveDays: 4 };
export type Fill = { coin: string; dir: string; time: number };
export type Activity = { mainShare: number | null; lastTrade: number | null; lastOpen: number | null; activeDays: number };

// From userFills, i.e. the most recent fills (at most 2000).
export function activity(fills: Fill[], now: number): Activity {
  const week = fills.filter((f) => now - f.time < 7 * DAY);
  const opens = week.filter((f) => isMainDex(f.coin) && f.dir.startsWith("Open")).map((f) => f.time);
  // 2000 fills all inside the week: older days are cut off, so a trader that busy counts as active every day.
  const truncated = fills.length >= 2000 && week.length === fills.length;
  return {
    mainShare: mainDexShare(week),
    lastTrade: fills.length ? Math.max(...fills.map((f) => f.time)) : null,
    lastOpen: opens.length ? Math.max(...opens) : null,
    activeDays: truncated ? 7 : new Set(week.map((f) => Math.floor((now - f.time) / DAY))).size,
  };
}

// Why a trader can't be copied right now, or null if they can.
export function blocker(a: Activity, now: number): string | null {
  if (a.mainShare === null) return "keine Trades (7 T.)";
  if (a.mainShare < RULES.minMainShare) return "Nebenbörse/Spot";
  if (a.lastOpen === null || now - a.lastOpen > RULES.maxHoursSinceOpen * 36e5) return `keine neue Position (${RULES.maxHoursSinceOpen} h)`;
  if (a.activeDays < RULES.minActiveDays) return "selten aktiv";
  return null;
}
