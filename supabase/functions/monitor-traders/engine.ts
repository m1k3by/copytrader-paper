// Pure paper-trading math, shared by the worker and the dashboard.

export type Side = "long" | "short";
export type Position = { coin: string; side: Side; entryPrice: number; size: number; leverage: number | null };
export type OpenSource = { id: number; coin: string; side: Side; size: number };

// Size changes below this are noise, not a deliberate add or partial close.
const RESIZE_TOLERANCE = 0.01;

// Tracked positions the trader closed or flipped, positions we don't track yet,
// and tracked positions the trader added to or partially closed (same side, size changed).
export function diffPositions<S extends OpenSource>(current: Position[], open: S[]) {
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
// Adding buys at `fill` and averages the entry, but never past `maxUsd`: a trader building a position in many
// small fills would otherwise grow our copy by the whole build-up (seen: 60x on ZRO).
// Reducing books the closed part, fees of both its legs included.
export function resizeTrade(side: Side, sizeUsd: number, entry: number, ratio: number, fill: number, feeBps: number, maxUsd: number) {
  if (ratio >= 1) {
    const added = Math.min(sizeUsd * (ratio - 1), Math.max(0, maxUsd - sizeUsd));
    const qty = sizeUsd / entry + added / fill;
    return { sizeUsd: sizeUsd + added, entry: (sizeUsd + added) / qty, realized: 0, fees: 0 };
  }
  const part = closePnl(side, sizeUsd * (1 - ratio), entry, fill, feeBps);
  return { sizeUsd: sizeUsd * ratio, entry, realized: part.pnl, fees: part.fees };
}

// The trader's volume-weighted exit for a position of `side`, from their Hyperliquid fills on that coin.
// Only the reducing part of a fill counts, so a flip contributes just the size that closed the old position.
export type HlFill = { px: string; sz: string; side: "B" | "A"; startPosition: string };
export function closingVwap(fills: HlFill[], side: Side): number | null {
  let qty = 0;
  let notional = 0;
  for (const f of fills) {
    const start = Number(f.startPosition);
    const reduces = side === "long" ? f.side === "A" && start > 0 : f.side === "B" && start < 0;
    if (!reduces) continue;
    const closed = Math.min(Number(f.sz), Math.abs(start));
    qty += closed;
    notional += closed * Number(f.px);
  }
  return qty ? notional / qty : null;
}

// ponytail: funding payments are ignored, add them from userFunding if positions are held for days.
export function closePnl(side: Side, sizeUsd: number, entry: number, exit: number, feeBps: number) {
  const qty = sizeUsd / entry;
  const gross = (side === "long" ? 1 : -1) * qty * (exit - entry);
  const fees = ((sizeUsd + qty * exit) * feeBps) / 1e4;
  return { pnl: gross - fees, fees };
}
