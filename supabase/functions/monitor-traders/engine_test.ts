import assert from "node:assert/strict";
import { closePnl, diffPositions, fillPrice, resizeTrade, type Position } from "./engine.ts";

const pos = (coin: string, side: "long" | "short", size = 1): Position => ({ coin, side, entryPrice: 1, size, leverage: null });

Deno.test("diffPositions: close, flip, new, unchanged", () => {
  const open = [
    { id: 1, coin: "BTC", side: "long" as const, size: 1 }, // still open
    { id: 2, coin: "ETH", side: "long" as const, size: 1 }, // closed
    { id: 3, coin: "SOL", side: "long" as const, size: 1 }, // flipped to short
  ];
  const { closed, opened, resized } = diffPositions([pos("BTC", "long"), pos("SOL", "short"), pos("HYPE", "short")], open);
  assert.deepEqual(closed.map((c) => c.id), [2, 3]);
  assert.deepEqual(opened.map((p) => p.coin), ["SOL", "HYPE"]);
  assert.deepEqual(resized, []);
});

Deno.test("diffPositions: adds and partial closes beyond 1% are resizes, noise is not", () => {
  const open = [
    { id: 1, coin: "BTC", side: "long" as const, size: 2 },
    { id: 2, coin: "ETH", side: "short" as const, size: 10 },
    { id: 3, coin: "SOL", side: "long" as const, size: 100 },
  ];
  const { closed, opened, resized } = diffPositions([pos("BTC", "long", 3), pos("ETH", "short", 4), pos("SOL", "long", 100.5)], open);
  assert.deepEqual(closed, []);
  assert.deepEqual(opened, []);
  assert.deepEqual(resized.map((r) => [r.source.id, r.position.size]), [[1, 3], [2, 4]]);
});

Deno.test("resizeTrade: add averages the entry, partial close books its share", () => {
  // $100 long at 100, trader doubles at 120: +$100 at 120 -> qty 1 + 0.8333, avg entry 200 / 1.8333 = 109.09
  const add = resizeTrade("long", 100, 100, 2, 120, 4.5);
  assert.equal(add.sizeUsd, 200);
  assert.ok(Math.abs(add.entry - 200 / (1 + 100 / 120)) < 1e-9);
  assert.equal(add.realized, 0);
  // $100 long at 100, trader closes 25% at 110: books $25 of it -> +$2.50 gross minus fees on $25 + $27.50
  const cut = resizeTrade("long", 100, 100, 0.75, 110, 4.5);
  assert.equal(cut.sizeUsd, 75);
  assert.equal(cut.entry, 100);
  assert.ok(Math.abs(cut.fees - (25 + 27.5) * 4.5e-4) < 1e-9);
  assert.ok(Math.abs(cut.realized - (2.5 - cut.fees)) < 1e-9);
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
