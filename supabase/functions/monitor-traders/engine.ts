// Pure paper-trading math, shared by the worker and the dashboard.

export type Side = "long" | "short";
export type Position = { coin: string; side: Side; entryPrice: number; size: number; leverage: number | null };
export type OpenSource = { id: number; coin: string; side: Side };

// Tracked positions the trader closed or flipped, and positions we don't track yet.
// ponytail: size changes (adding to / partially closing a position) are ignored, mirror them if the data says they matter.
export function diffPositions(current: Position[], open: OpenSource[]) {
  const now = new Map(current.map((p) => [p.coin, p]));
  const closed = open.filter((o) => now.get(o.coin)?.side !== o.side);
  const stillOpen = new Set(open.filter((o) => !closed.includes(o)).map((o) => o.coin));
  const opened = current.filter((p) => !stillOpen.has(p.coin));
  return { closed, opened };
}

// Our simulated fill: entering a long or exiting a short buys above mid, the opposite sells below.
export function fillPrice(mid: number, side: Side, slippageBps: number, entering: boolean) {
  const buying = (side === "long") === entering;
  return mid * (1 + ((buying ? 1 : -1) * slippageBps) / 1e4);
}

// ponytail: funding payments are ignored, add them from userFunding if positions are held for days.
export function closePnl(side: Side, sizeUsd: number, entry: number, exit: number, feeBps: number) {
  const qty = sizeUsd / entry;
  const gross = (side === "long" ? 1 : -1) * qty * (exit - entry);
  const fees = ((sizeUsd + qty * exit) * feeBps) / 1e4;
  return { pnl: gross - fees, fees };
}
