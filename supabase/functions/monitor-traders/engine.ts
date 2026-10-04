// Pure paper-trading math, shared by the worker and the dashboard.

export type Side = "long" | "short";
export type Position = { coin: string; side: Side; entryPrice: number; size: number; leverage: number | null };
export type OpenSource = { id: number; coin: string; side: Side; size: number };

// Size changes below this are noise, not a deliberate add or partial close.
const RESIZE_TOLERANCE = 0.01;

// Tracked positions the trader closed or flipped, positions we don't track yet,
// and tracked positions the trader added to or partially closed (same side, size changed).
export function diffPositions(current: Position[], open: OpenSource[]) {
  const now = new Map(current.map((p) => [p.coin, p]));
  const closed = open.filter((o) => now.get(o.coin)?.side !== o.side);
  const stillOpen = open.filter((o) => !closed.includes(o));
  const opened = current.filter((p) => !stillOpen.some((o) => o.coin === p.coin));
  const resized = stillOpen
    .map((source) => ({ source, position: now.get(source.coin)! }))
    .filter(({ source, position }) => Math.abs(position.size / source.size - 1) > RESIZE_TOLERANCE);
  return { closed, opened, resized };
}

// Our simulated fill: entering a long or exiting a short buys above mid, the opposite sells below.
export function fillPrice(mid: number, side: Side, slippageBps: number, entering: boolean) {
  const buying = (side === "long") === entering;
  return mid * (1 + ((buying ? 1 : -1) * slippageBps) / 1e4);
}

// Scale our copy by the trader's size ratio (new / old size). size_usd is the total entry notional.
// Adding buys at `fill` and averages the entry; reducing books the closed part, fees of both its legs included.
export function resizeTrade(side: Side, sizeUsd: number, entry: number, ratio: number, fill: number, feeBps: number) {
  if (ratio >= 1) {
    const added = sizeUsd * (ratio - 1);
    const qty = sizeUsd / entry + added / fill;
    return { sizeUsd: sizeUsd + added, entry: (sizeUsd + added) / qty, realized: 0, fees: 0 };
  }
  const part = closePnl(side, sizeUsd * (1 - ratio), entry, fill, feeBps);
  return { sizeUsd: sizeUsd * ratio, entry, realized: part.pnl, fees: part.fees };
}

// ponytail: funding payments are ignored, add them from userFunding if positions are held for days.
export function closePnl(side: Side, sizeUsd: number, entry: number, exit: number, feeBps: number) {
  const qty = sizeUsd / entry;
  const gross = (side === "long" ? 1 : -1) * qty * (exit - entry);
  const fees = ((sizeUsd + qty * exit) * feeBps) / 1e4;
  return { pnl: gross - fees, fees };
}
