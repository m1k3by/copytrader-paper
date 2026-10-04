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
  pnlPerVolume: number; // month PnL / month volume
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
        pnlPerVolume: Number(w.month.pnl) / Number(w.month.vlm),
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
export const RULES = {
  minMainShare: 0.8,
  maxHoursSinceOpen: 48,
  minActiveDays: 4,
  minMedianHoldMinutes: 30, // minute-flippers can't be copied with a 30 s poll
  // Our round trip costs ~19 bps of notional (2 x 4.5 fee + 2 x 5 slippage) = ~0.1% of the volume it creates.
  minPnlPerVolume: 0.001,
};
export type Fill = { coin: string; dir: string; time: number; side?: "A" | "B"; sz?: string; startPosition?: string };
export type Activity = {
  mainShare: number | null;
  lastTrade: number | null;
  lastOpen: number | null;
  activeDays: number;
  medianHoldMs: number | null;
};

function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Median time from opening a position (from flat) to being flat again or flipping, per coin.
// Positions already open at the start of the fill window aren't counted, their open is unseen.
export function medianHoldMs(fills: Fill[]): number | null {
  const opened = new Map<string, number>();
  const holds: number[] = [];
  for (const f of [...fills].sort((a, b) => a.time - b.time)) {
    if (f.side === undefined || f.sz === undefined || f.startPosition === undefined) continue;
    const start = Number(f.startPosition);
    const end = start + (f.side === "B" ? 1 : -1) * Number(f.sz);
    const flat = (x: number) => Math.abs(x) <= 1e-9 * Math.max(1, Math.abs(start), Number(f.sz));
    if (flat(start)) {
      if (!flat(end)) opened.set(f.coin, f.time);
    } else if (flat(end) || Math.sign(end) !== Math.sign(start)) {
      const t0 = opened.get(f.coin);
      if (t0 !== undefined) holds.push(f.time - t0);
      if (flat(end)) opened.delete(f.coin);
      else opened.set(f.coin, f.time); // flip: a new position starts now
    }
  }
  return median(holds);
}

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
    medianHoldMs: medianHoldMs(fills.filter((f) => isMainDex(f.coin))),
  };
}

// Why a trader can't be copied right now, or null if they can.
export function blocker(a: Activity, now: number, pnlPerVolume: number | null = null): string | null {
  if (a.mainShare === null) return "keine Trades (7 T.)";
  if (a.mainShare < RULES.minMainShare) return "Nebenbörse/Spot";
  if (a.lastOpen === null || now - a.lastOpen > RULES.maxHoursSinceOpen * 36e5) return `keine neue Position (${RULES.maxHoursSinceOpen} h)`;
  if (a.activeDays < RULES.minActiveDays) return "selten aktiv";
  // unknown hold time (no complete round trip in the window) usually means long holds, so it doesn't block
  if (a.medianHoldMs !== null && a.medianHoldMs < RULES.minMedianHoldMinutes * 6e4) return "Minuten-Trader";
  if (pnlPerVolume !== null && pnlPerVolume < RULES.minPnlPerVolume) return "Gewinn/Volumen zu klein";
  return null;
}
