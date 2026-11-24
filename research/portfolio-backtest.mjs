import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  createPortfolioSessionAgent,
  createSessionSelector,
  marketRowFromCandles,
  portfolioPhase,
  simulatePortfolioTrade,
  summarizePortfolio,
} from "../dist/index.js";

const BAR = 900_000;
const DAY = 86_400_000;
const start = Date.parse("2024-11-18");
const end = Date.parse("2026-11-18");
const sessionFrames = () =>
  Array.from({ length: (end - start) / DAY }, (_, i) => {
    const day = start + i * DAY;
    const newYork = day + 13.5 * 3_600_000;
    const nyOpen =
      portfolioPhase(newYork)?.phase === 0 ? newYork : newYork + 3_600_000;
    return [day, nyOpen].flatMap((opening) =>
      [0, 1, 2].map((phase) => ({
        timestamp: opening + phase * BAR,
        rows: [],
      })),
    );
  }).flat();

const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const loadGzip = async (path) =>
  gunzipSync(await readFile(path)).toString("utf8");
const [input, fundingRoot, output] = process.argv.slice(2);
if (!input || !fundingRoot || !output) {
  throw new Error(
    "Usage: node research/portfolio-backtest.mjs INPUT_DIR FUNDING_DIR OUTPUT_JSON",
  );
}

const calibration = await json(
  new URL("../calibration/bybit-m15.json", import.meta.url),
);
const rules = await json(join(input, "lot-rules.json"));
const symbols = await json(join(input, "universe.json"));
const archivedSymbols = await json(
  new URL("../calibration/bybit-universe.json", import.meta.url),
);
assert.deepEqual(symbols, archivedSymbols);
const frames = sessionFrames();
const barsPath = (symbol) => join(input, "bars", `${symbol}.gz`);

async function candles(symbol, accept) {
  const rows = new Map();
  for (const line of (await loadGzip(barsPath(symbol))).split("\n")) {
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const timestamp = Number(line.slice(0, comma));
    if (!accept(timestamp)) continue;
    const [open, high, low, close, , turnover] = line
      .slice(comma + 1)
      .split(",", 6)
      .map(Number);
    rows.set(timestamp, { timestamp, open, high, low, close, turnover });
  }
  return rows;
}

for (const [i, symbol] of symbols.entries()) {
  const history = await candles(
    symbol,
    (timestamp) => timestamp >= start - DAY && timestamp < end,
  );
  for (const frame of frames) {
    const closed = [];
    for (let n = 96; n > 0; n--) {
      const bar = history.get(frame.timestamp - n * BAR);
      if (!bar) break;
      closed.push(bar);
    }
    const row = marketRowFromCandles(symbol, frame.timestamp, closed);
    if (row) frame.rows.push(row);
  }
  if ((i + 1) % 100 === 0)
    console.log("Scored history", i + 1, "/", symbols.length);
}

const draft = createSessionSelector(calibration, rules);
const requests = new Map();
for (const frame of frames) {
  const order = draft(frame);
  if (!order) continue;
  const items = requests.get(order.symbol) ?? [];
  items.push(order);
  requests.set(order.symbol, items);
}
const outcomes = new Map();
for (const [symbol, orders] of requests) {
  const wanted = new Set();
  for (const order of orders) {
    for (let time = order.timestamp; time < order.closesAt; time += BAR)
      wanted.add(time);
  }
  const history = await candles(symbol, (timestamp) => wanted.has(timestamp));
  const execution = new Map(
    [...history].map(([t, bar]) => [
      t,
      [bar.open, bar.high, bar.low, bar.close],
    ]),
  );
  const points = JSON.parse(
    await loadGzip(join(fundingRoot, `${symbol}.json.gz`)),
  ).rates.map(([t, rate]) => [Number(t), Number(rate)]);
  for (const order of orders) {
    const result = simulatePortfolioTrade(order, execution, points);
    assert.ok(
      result,
      `Unresolved ${symbol} at ${new Date(order.timestamp).toISOString()}`,
    );
    outcomes.set(order.timestamp, result);
  }
}

const agent = createPortfolioSessionAgent(calibration, rules);
const trades = [];
let settlement;
for (const frame of frames) {
  if (settlement && settlement.exit <= frame.timestamp) {
    agent.settle(settlement.result);
    settlement = undefined;
  }
  const route = agent.onFrame(frame);
  if (!route) continue;
  const outcome = outcomes.get(route.order.timestamp);
  assert.equal(outcome?.symbol, route.order.symbol);
  const actualPnl = outcome.pnl * route.risk;
  if (route.order.session === "tokyo") {
    assert.equal(settlement, undefined);
    settlement = {
      exit: outcome.exit,
      result: {
        session: route.settlementId,
        shadowPnl: outcome.pnl,
        actualPnl: route.risk === 0 ? null : actualPnl,
      },
    };
  }
  if (route.risk !== 0) trades.push({ ...outcome, pnl: actualPnl });
}
if (settlement) agent.settle(settlement.result);
trades.sort((a, b) => a.exit - b.exit);
let pnl = 0;
const equity = trades.map((trade) => {
  pnl += trade.pnl;
  return [trade.exit, pnl];
});
const metrics = summarizePortfolio(trades, start, end);
const expected = await json(
  new URL("./expected-portfolio.json", import.meta.url),
);
for (const key of Object.keys(expected.metrics)) {
  assert.ok(
    Math.abs(metrics[key] - expected.metrics[key]) < 1e-7,
    `Portfolio parity failed for ${key}: ${metrics[key]} vs ${expected.metrics[key]}`,
  );
}

const equitySha256 = createHash("sha256")
  .update(
    JSON.stringify(
      equity.map(([timestamp, pnl]) => [timestamp, pnl.toFixed(4)]),
    ),
  )
  .digest("hex");
assert.equal(
  equitySha256,
  expected.equitySha256,
  "The realized trade path does not match",
);
await writeFile(
  output,
  JSON.stringify({ metrics, equitySha256, equity }, null, 2) + "\n",
);
console.log(metrics);
