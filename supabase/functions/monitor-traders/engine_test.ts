import assert from "node:assert/strict";
import { closePnl, diffPositions, fillPrice, type Position } from "./engine.ts";

const pos = (coin: string, side: "long" | "short"): Position => ({ coin, side, entryPrice: 1, size: 1, leverage: null });

Deno.test("diffPositions: close, flip, new, unchanged", () => {
  const open = [
    { id: 1, coin: "BTC", side: "long" as const }, // still open
    { id: 2, coin: "ETH", side: "long" as const }, // closed
    { id: 3, coin: "SOL", side: "long" as const }, // flipped to short
  ];
  const { closed, opened } = diffPositions([pos("BTC", "long"), pos("SOL", "short"), pos("HYPE", "short")], open);
  assert.deepEqual(closed.map((c) => c.id), [2, 3]);
  assert.deepEqual(opened.map((p) => p.coin), ["SOL", "HYPE"]);
});

Deno.test("fillPrice: slippage always works against us", () => {
  assert.equal(fillPrice(100, "long", 10, true), 100.1);
  assert.equal(fillPrice(100, "long", 10, false), 99.9);
  assert.equal(fillPrice(100, "short", 10, true), 99.9);
  assert.equal(fillPrice(100, "short", 10, false), 100.1);
});

Deno.test("closePnl: long and short, fees on both legs", () => {
  // $100 long, 100 -> 110: +$10 gross, fees 4.5bps on $100 + $110
  const long = closePnl("long", 100, 100, 110, 4.5);
  assert.ok(Math.abs(long.fees - 0.0945) < 1e-9);
  assert.ok(Math.abs(long.pnl - (10 - 0.0945)) < 1e-9);
  // $100 short, 100 -> 110: -$10 gross
  const short = closePnl("short", 100, 100, 110, 4.5);
  assert.ok(Math.abs(short.pnl - (-10 - 0.0945)) < 1e-9);
});
