import assert from "node:assert/strict";
import test from "node:test";
import {
  closePortfolioOrder,
  createPortfolioSessionAgent,
  createSessionAgentPortfolioPlugin,
  createSessionSelector,
  enterPortfolioOrder,
  marketRowFromCandles,
  nextTokyoRisk,
  settleTokyo,
  simulatePortfolioTrade,
  summarizePortfolio,
} from "../dist/index.js";

const BAR = 900_000;
const open = Date.parse("2025-01-02T14:30:00Z");
const tokyo = Date.parse("2025-01-02T00:00:00Z");
const row = (i) => ({
  symbol: `T${i}USDT`,
  price: 100,
  turnover: (40 - i) * 1_000_000,
  fourHour: 0.01 * i,
  rms: 0.002,
  activity: 1,
});
const rows = Array.from({ length: 24 }, (_, i) => row(i));
const rule = {
  qtyStep: 0.01,
  maxMktOrderQty: 100,
  minOrderQty: 0.01,
  minNotionalValue: 1,
};
const rules = Object.fromEntries(rows.map(({ symbol }) => [symbol, rule]));
const analogy = (side) => ({
  scales: [1, 1, 1, 1, 1],
  history: Array.from({ length: 48 }, () => ({
    context: [0, 0, 0, 0, 0],
    netR: side === 1 ? [4, -4, -4, -4] : [-4, 4, -4, -4],
  })),
});
function calibration(side = 1) {
  const phases = { 0: analogy(side), 1: analogy(1), 2: analogy(1) };
  return {
    bySession: { newYork: { 0: phases }, tokyo: { 0: phases } },
    newYorkGate: {
      0: {
        mean: Array(12).fill(0),
        scale: Array(12).fill(1),
        beta: Array(12).fill(0),
        intercept: 1,
      },
    },
  };
}

test("New York picks from top 12 and holds the same symbol until the first candle closes", () => {
  const select = createSessionSelector(calibration(), rules);
  assert.equal(select({ timestamp: open, rows }), undefined);
  const second = rows.map((r) =>
    r.symbol === "T0USDT" ? { ...r, fourHour: 5 } : r,
  );
  const order = select({ timestamp: open + BAR, rows: second });
  assert.equal(order.symbol, "T11USDT");
  assert.equal(order.side, 1);
  assert.equal(order.closesAt, open + 26 * BAR);
  assert.equal(select({ timestamp: open + 2 * BAR, rows }), undefined);
});

test("dropping out of the liquidity list or a renewed veto means skipping the session", () => {
  for (const cause of ["rank", "gate"]) {
    const model = calibration();
    if (cause === "gate") {
      model.newYorkGate[open + BAR] = {
        ...model.newYorkGate[0],
        intercept: -1,
      };
    }
    const select = createSessionSelector(model, rules);
    assert.equal(select({ timestamp: open, rows }), undefined);
    const next =
      cause === "rank" ? rows.filter((r) => r.symbol !== "T11USDT") : rows;
    assert.equal(select({ timestamp: open + BAR, rows: next }), undefined);
    assert.equal(select({ timestamp: open + 2 * BAR, rows }), undefined);
  }
});

test("Tokyo skips an original short without searching for a replacement", () => {
  const select = createSessionSelector(calibration(-1), rules);
  assert.equal(select({ timestamp: tokyo, rows }), undefined);
  assert.equal(select({ timestamp: tokyo + BAR, rows }), undefined);
});

test("one routed Tokyo long at warm-up risk and no duplicate phase or settlement", () => {
  const agent = createPortfolioSessionAgent(calibration(), rules);
  const route = agent.onFrame({ timestamp: tokyo, rows });
  assert.equal(route.order.symbol, "T23USDT");
  assert.equal(route.risk, 0.125);
  assert.throws(() => agent.onFrame({ timestamp: tokyo, rows }));
  const result = { session: route.settlementId, shadowPnl: 4, actualPnl: 0.5 };
  agent.settle(result);
  assert.deepEqual(agent.snapshot().shadow, [4]);
  assert.throws(() => agent.settle(result));
});

test("risk activates on a positive 20-settlement window and pauses after three executed losses", () => {
  let state = { shadow: Array(19).fill(10), lossStreak: 0 };
  assert.equal(nextTokyoRisk(state), 0.125);
  for (let i = 1; i <= 3; i++) {
    state = settleTokyo(state, { session: i, shadowPnl: -10, actualPnl: -1 });
    assert.equal(nextTokyoRisk(state), i === 3 ? 0 : 0.25);
  }
  assert.throws(() =>
    settleTokyo(state, { session: 4, shadowPnl: 1, actualPnl: -1 }),
  );
  state = settleTokyo(state, { session: 4, shadowPnl: 20, actualPnl: null });
  assert.equal(state.lossStreak, 0);
  assert.equal(state.shadow.at(-1), 20);
  assert.equal(nextTokyoRisk(state), 0.25);
  assert.equal(nextTokyoRisk({ ...state, shadow: Array(20).fill(-1) }), 0.125);
});

test("market features require 96 closed contiguous M15 bars and use quote turnover", () => {
  const candles = Array.from({ length: 96 }, (_, i) => ({
    timestamp: i * BAR,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    turnover: 150_000,
  }));
  assert.equal(
    marketRowFromCandles("BTCUSDT", 96 * BAR, candles).turnover,
    14_400_000,
  );
  assert.equal(marketRowFromCandles("BTCUSDT", 95 * BAR, candles), undefined);
  assert.equal(
    marketRowFromCandles("BTCUSDT", 96 * BAR, candles.slice(1)),
    undefined,
  );
});

test("closing simulation accounts for funding and removes only the best Tokyo trade", () => {
  const select = createSessionSelector(calibration(), rules);
  const order = select({ timestamp: tokyo, rows });
  const candles = new Map([[tokyo, [100, 101, 95, 100]]]);
  assert.equal(simulatePortfolioTrade(order, candles, []), undefined);
  const trade = simulatePortfolioTrade(order, candles, [
    [tokyo, 0],
    [tokyo + BAR, 0],
  ]);
  assert.equal(trade.exit, tokyo + BAR);
  assert.ok(trade.pnl < 0);
  const pair = [
    { ...trade, pnl: 13 },
    { ...trade, session: "newYork", pnl: 40, exit: trade.exit + BAR },
  ];
  assert.equal(
    summarizePortfolio(pair, tokyo, tokyo + 3 * BAR).pnlWithoutBestTokyo,
    40,
  );
});

test("execution adapter only enters the routed symbol and exits at the session deadline", async () => {
  const select = createSessionSelector(calibration(), rules);
  const order = select({ timestamp: tokyo, rows });
  let position = null;
  const api = {
    skip: (code) => ({ code }),
    entry: async (p) => p,
    exit: async (p) => p,
    getCurrentPosition: async () => position,
    getDecisionPriceContext: async () => ({ currentPrice: 100 }),
  };
  assert.equal(
    (await enterPortfolioOrder(api, "OTHER", tokyo, order, 0.25, rule)).code,
    "SESSION_ROUTE_UNAVAILABLE",
  );
  const sent = await enterPortfolioOrder(
    api,
    order.symbol,
    tokyo,
    order,
    0.25,
    rule,
  );
  assert.equal(sent.direction, "LONG");
  assert.deepEqual(sent.orderPlan.takeProfits, []);
  assert.ok(sent.orderPlan.qty <= order.qty / 4);
  position = { direction: "LONG", qty: 1 };
  assert.equal(
    (await closePortfolioOrder(api, order.symbol, order.closesAt - BAR, order))
      .code,
    "WAIT_FOR_SESSION_END",
  );
  assert.equal(
    (await closePortfolioOrder(api, order.symbol, order.closesAt, order)).code,
    "SESSION_END",
  );
});

test("the portfolio TradeJS plugin routes through a host-owned strategy API", async () => {
  const select = createSessionSelector(calibration(), rules);
  const order = select({ timestamp: tokyo, rows });
  const strategyApi = {
    skip: (code) => ({ code }),
    entry: async (details) => details,
    getCurrentPosition: async () => null,
    getDecisionPriceContext: async () => ({ currentPrice: 100 }),
  };
  const plugin = createSessionAgentPortfolioPlugin({
    getOrderView: async (context, timestamp) => {
      assert.equal(context.strategyApi, strategyApi);
      if (timestamp !== tokyo) return undefined;
      return { kind: "entry", symbol: order.symbol, order, risk: 0.125, rule };
    },
  });
  const entry = plugin.strategyEntries[0];
  assert.equal(entry.manifest.name, "SessionAgent");
  const run = await entry.createCore({ strategyApi, config: entry.defaults });
  assert.equal(
    (await run({ timestamp: tokyo - BAR })).code,
    "SESSION_PORTFOLIO_OPEN",
  );
  assert.equal((await run({ timestamp: tokyo })).code, "SESSION_NO_ROUTE");
});
