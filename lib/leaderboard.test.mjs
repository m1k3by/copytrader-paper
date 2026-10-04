import { test } from "node:test";
import assert from "node:assert/strict";
import { activity, blocker, mainDexShare, medianHoldMs, rankCandidates } from "./leaderboard.ts";

const row = (ethAddress, accountValue, month, allTimePnl = 1) => ({
  ethAddress,
  displayName: null,
  accountValue: String(accountValue),
  windowPerformances: [
    ["week", { pnl: "0", roi: "0", vlm: "0" }],
    ["month", { pnl: String(month.pnl), roi: String(month.roi ?? 0), vlm: String(month.vlm) }],
    ["allTime", { pnl: String(allTimePnl), roi: "0", vlm: "0" }],
  ],
});

test("rankCandidates: ranks by month PnL / account value, drops idle, HFT, small and losing accounts", () => {
  const rows = [
    row("0xmid", 100_000, { pnl: 50_000, vlm: 1_000_000 }),
    row("0xbest", 100_000, { pnl: 90_000, vlm: 1_000_000 }),
    row("0xroi-artifact", 4_000_000, { pnl: 4_000_000, roi: 41_861, vlm: 0 }), // huge ROI, no trading
    row("0xhft", 100_000, { pnl: 99_000, vlm: 50_000_000 }),
    row("0xsmall", 10_000, { pnl: 9_000, vlm: 100_000 }),
    row("0xalltime-loser", 100_000, { pnl: 80_000, vlm: 1_000_000 }, -1),
  ];
  assert.deepEqual(rankCandidates(rows, 10).map((c) => c.address), ["0xbest", "0xmid"]);
  assert.equal(rankCandidates(rows, 1).length, 1);
});

const H = 36e5;
const now = Date.parse("2026-10-04T20:00:00Z");
const fill = (hoursAgo, dir = "Open Long", coin = "BTC") => ({ coin, dir, time: now - hoursAgo * H });

test("activity + blocker: active trader is copyable", () => {
  const a = activity([fill(1), fill(30, "Close Long"), fill(50), fill(80), fill(200, "Close Short"), fill(400)], now);
  assert.equal(a.activeDays, 4); // day buckets 0, 1, 2, 3; the 400 h fill is outside the week
  assert.equal(a.lastOpen, now - 1 * H);
  assert.equal(blocker(a, now), null);
});

test("blocker: no recent main-dex open, too few days, side dexes, idle", () => {
  // opened only on a builder dex lately -> no main-dex open within 48 h
  const xyzOpen = activity([fill(1, "Open Long", "xyz:INTC"), fill(60), fill(80), fill(100), fill(120), fill(140), fill(150)], now);
  assert.equal(blocker(xyzOpen, now), "keine neue Position (48 h)");
  assert.equal(blocker(activity([fill(1), fill(2), fill(3)], now), now), "selten aktiv");
  assert.equal(blocker(activity([fill(1, "Open Long", "xyz:INTC"), fill(2, "Open Long", "@107")], now), now), "Nebenbörse/Spot");
  assert.equal(blocker(activity([fill(400)], now), now), "keine Trades (7 T.)");
});

test("activity: 2000 fills inside the week means history is cut off -> counted as active all week", () => {
  const busy = Array.from({ length: 2000 }, (_, i) => fill(i / 1000)); // all within the last 2 h
  assert.equal(activity(busy, now).activeDays, 7);
  assert.equal(blocker(activity(busy, now), now), null);
});

test("mainDexShare: builder dex and spot fills don't count", () => {
  assert.equal(mainDexShare([{ coin: "BTC" }, { coin: "xyz:INTC" }, { coin: "@107" }, { coin: "ETH" }]), 0.5);
  assert.equal(mainDexShare([]), null);
});

test("medianHoldMs: open from flat to flat, flips start a new hold, unseen opens ignored", () => {
  const f = (min, side, start, sz, coin = "BTC") => ({ coin, dir: "", time: min * 6e4, side, startPosition: String(start), sz: String(sz) });
  const fills = [
    f(0, "A", 5, 5),   // closes a position opened before the window: ignored
    f(10, "B", 0, 2),  // open long 2
    f(20, "B", 2, 1),  // add
    f(70, "A", 3, 3),  // flat: held 60 min
    f(100, "A", 0, 1), // open short 1
    f(110, "B", -1, 3), // flip to long 2: short held 10 min
    f(200, "A", 2, 2), // flat: long held 90 min
    f(5, "B", 0, 1, "ETH"), // ETH opened, never closed: no hold
  ];
  assert.equal(medianHoldMs(fills), 60 * 6e4);
  assert.equal(medianHoldMs([]), null);
});

test("blocker: minute-flippers and thin PnL per volume are blocked", () => {
  const now = Date.parse("2026-10-04T20:00:00Z");
  const ok = { mainShare: 1, lastTrade: now, lastOpen: now - 36e5, activeDays: 5, medianHoldMs: 3 * 36e5 };
  assert.equal(blocker(ok, now, 0.005), null);
  assert.equal(blocker({ ...ok, medianHoldMs: 5 * 6e4 }, now, 0.005), "Minuten-Trader");
  assert.equal(blocker({ ...ok, medianHoldMs: null }, now, 0.005), null);
  assert.equal(blocker(ok, now, 0.0004), "Gewinn/Volumen zu klein");
});
