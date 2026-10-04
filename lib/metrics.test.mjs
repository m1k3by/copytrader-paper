import { test } from "node:test";
import assert from "node:assert/strict";
import { copyMetrics, liveGateMisses } from "./metrics.ts";

const H = 36e5;
const trade = (pnl, closedH, o = {}) => ({
  pnl, sizeUsd: 100, side: "long", entry: 101, exit: 110, traderEntry: 100, traderExit: 111,
  openedAt: (closedH - 2) * H, closedAt: closedH * H, resizes: 0, ...o,
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("copyMetrics: PnL stats, drawdown, time under water, luck share", () => {
  // cumulative: 10, 4, 1, 21 -> peak 10 at 10h, trough 1, new high at 40h
  const m = copyMetrics([trade(10, 10), trade(-6, 20), trade(-3, 30), trade(20, 40)], 50 * H);
  assert.equal(m.n, 4);
  near(m.perTrade, 21 / 4);
  near(m.profitFactor, 30 / 9);
  near(m.maxDrawdown, 9);
  near(m.underwaterMs, 20 * H); // from the 10h high to the last close below it at 30h
  near(m.luckShare, 20 / 21);
  near(m.medianHoldMs, 2 * H);
  assert.ok(m.ci[0] < m.perTrade && m.perTrade < m.ci[1]);
});

test("copyMetrics: still under water counts until now", () => {
  const m = copyMetrics([trade(10, 10), trade(-5, 20)], 100 * H);
  near(m.underwaterMs, 90 * H);
});

test("copyMetrics: fidelity vs. the trader (capture, entry and exit gaps), long and short", () => {
  // long: trader 100 -> 111 = +11%, we +9% of size; entry 1% worse, exit 110 vs 111 = 0.9% worse
  const long = copyMetrics([trade(9, 10)], 20 * H);
  near(long.capture, 0.09 / 0.11);
  near(long.entryGapBps, 100);
  near(long.exitGapBps, (1 / 111) * 1e4);
  // short: trader 100 -> 90 = +10%; our entry 99.5 (worse: sold lower), exit 90.5 (worse: bought back higher)
  const short = copyMetrics([trade(8, 10, { side: "short", entry: 99.5, exit: 90.5, traderEntry: 100, traderExit: 90 })], 20 * H);
  near(short.capture, 0.08 / 0.1);
  near(short.entryGapBps, 50);
  near(short.exitGapBps, (0.5 / 90) * 1e4);
  // trader exit unknown -> no capture
  assert.equal(copyMetrics([trade(9, 10, { traderExit: null })], 20 * H).capture, null);
});

test("liveGateMisses: names every unmet criterion, passes a solid record", () => {
  const few = copyMetrics([trade(5, 1), trade(-1, 2)], 3 * H);
  const misses = liveGateMisses(few, copyMetrics([trade(10, 1)], 3 * H));
  assert.ok(misses.includes("2/100 Trades"));
  assert.ok(misses.includes("schlägt Zufall nicht"));
  // 120 trades alternating +$3 / -$1 (avg +1% of $100), trader +1% each -> capture 100%, PF 3; control averages $0
  const solid = Array.from({ length: 120 }, (_, i) => trade(i % 2 ? -1 : 3, i + 1, { traderExit: 101 }));
  const control = copyMetrics(Array.from({ length: 120 }, (_, i) => trade(i % 2 ? -2 : 2, i + 1)), 200 * H);
  assert.deepEqual(liveGateMisses(copyMetrics(solid, 200 * H), control), []);
});
