import test from "node:test";
import assert from "node:assert/strict";
import { createCore, parseConfig, strategyEntries } from "../dist/index.js";
import { sessionAt, features, BAR, side } from "../src/policy.ts";
const ms = Date.parse;
test("New York uses local time across both clock changes", () => {
  for (const [date, utc] of [
    ["2026-03-07", "14:30"],
    ["2026-03-08", "13:30"],
    ["2026-10-31", "13:30"],
    ["2026-11-01", "14:30"],
  ]) {
    const t = ms(date + "T" + utc + "Z");
    assert.deepEqual(sessionAt(t), { name: "newYork", opening: true });
    assert.equal(sessionAt(t + 26 * BAR), null);
  }
});
test("rejects unknown keys and unsupported intervals", () => {
  assert.equal(strategyEntries.length, 1);
  assert.throws(() => parseConfig({ BAD: 1 }));
  assert.throws(() => parseConfig({ INTERVAL: "60" }));
  assert.throws(() => parseConfig({ MAX_LOSS_VALUE: 0 }));
});
test("missing or future bars and marginal forecasts cannot trigger entries", () => {
  const rows = Array.from({ length: 96 }, (_, i) => ({
    timestamp: i * BAR,
    open: 2,
    close: 2,
    high: 3,
    low: 1,
    volume: 1,
  }));
  assert.ok(features(rows, 96 * BAR));
  assert.equal(features(rows.slice(1), 96 * BAR), null);
  assert.equal(features(rows, 95 * BAR), null);
  assert.deepEqual([-17, -16, 0, 16, 17].map(side), [
    "SHORT",
    null,
    null,
    null,
    "LONG",
  ]);
});
test("flat account waits between openings, open positions exit at both deadlines", async () => {
  let position = null;
  const runner = await createCore({
    config: parseConfig({}),
    strategyApi: {
      getCurrentPosition: async () => position,
      skip: (code) => code,
      exit: async (p) => p.code,
      getClosedCandles: async () => ({ complete: false }),
    },
  });
  const decide = (clock) =>
    runner({ timestamp: ms("2026-11-08T" + clock + "Z") - BAR });
  assert.equal(await decide("00:00"), "INCOMPLETE_CONTEXT");
  assert.equal(await decide("00:15"), "WAIT_FOR_SESSION");
  position = { direction: "SHORT", qty: 1 };
  assert.equal(await decide("00:15"), "SESSION_POSITION_OPEN");
  assert.equal(await decide("06:30"), "SESSION_END");
  assert.equal(await decide("21:00"), "SESSION_END");
});
