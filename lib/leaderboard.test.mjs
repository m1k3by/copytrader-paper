import { test } from "node:test";
import assert from "node:assert/strict";
import { mainDexShare, rankCandidates } from "./leaderboard.ts";

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

test("mainDexShare: builder dex and spot fills don't count", () => {
  assert.equal(mainDexShare([{ coin: "BTC" }, { coin: "xyz:INTC" }, { coin: "@107" }, { coin: "ETH" }]), 0.5);
  assert.equal(mainDexShare([]), null);
});
