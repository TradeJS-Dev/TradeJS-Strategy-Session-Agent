import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import assert from "node:assert/strict";
const [studyDir, ...requested] = process.argv.slice(2);
assert.ok(
  studyDir && requested.length,
  "Run from the Project: scan-session-market.mjs STUDY_DIR SYMBOL...",
);
const req = createRequire(path.resolve("package.json")),
  dir = path.resolve(studyDir) + path.sep;
const { createStrategyRuntime, registerStrategyEntries } = req(
  "@tradejs/node/strategies",
);
const { createTestConnector } = req("@tradejs/node/backtest");
const { closeTimescalePool } = req("@tradejs/infra/timescale/client");
const { closeRedisConnection } = req("@tradejs/infra/redis");
const j = (f) => JSON.parse(readFileSync(dir + f));
const spec = j("declaration.json"),
  symbols = j("universe.json");
const entries = new Map(
  Object.keys(spec).map((n) => [
    n,
    req(
      "@tradejs/strategy-" +
        n.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase(),
    ).strategyEntries.find((s) => s.manifest.name === n),
  ]),
);
registerStrategyEntries([...entries.values()]);
const protocol = j("protocol.json");
const M = 900000,
  start = Date.parse(protocol.from + "T00:00Z"),
  end = Date.parse(protocol.endExclusive + "T00:00Z");
const ny = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
});
const sessions = [];
for (let t = start; t < end; t += M)
  if (t % 86400000 === 0 || ny.format(t) === "09:30") sessions.push(t);
assert.equal(sessions.length, (2 * (end - start)) / 86400000);
function load(s) {
  const rows = new Map(),
    hours = new Map();
  if (!existsSync(dir + "bars/" + s + ".gz")) return [rows, hours];
  for (const line of gunzipSync(readFileSync(dir + "bars/" + s + ".gz"))
    .toString()
    .trim()
    .split("\n")) {
    const [
      timestamp,
      open,
      high,
      low,
      close,
      volume,
      turnover,
      takerBuyBaseVolume,
      takerBuyQuoteVolume,
      takerSellBaseVolume,
      takerSellQuoteVolume,
    ] = line.split(",").map((v) => (v === "" ? undefined : Number(v)));
    const b = {
      timestamp,
      open,
      high,
      low,
      close,
      volume,
      turnover,
      takerBuyBaseVolume,
      takerBuyQuoteVolume,
      takerSellBaseVolume,
      takerSellQuoteVolume,
    };
    rows.set(timestamp, b);
    if (timestamp % (4 * M) !== 3 * M) continue;
    const a = [3, 2, 1, 0].map((i) => rows.get(timestamp - i * M));
    if (a.some((x) => !x)) continue;
    const h = {
      ...a[0],
      high: Math.max(...a.map((x) => x.high)),
      low: Math.min(...a.map((x) => x.low)),
      close: b.close,
    };
    for (const k of [
      "volume",
      "turnover",
      "takerBuyBaseVolume",
      "takerBuyQuoteVolume",
      "takerSellBaseVolume",
      "takerSellQuoteVolume",
    ])
      h[k] = a.every((x) => Number.isFinite(x[k]))
        ? a.reduce((v, x) => v + x[k], 0)
        : undefined;
    hours.set(h.timestamp, h);
  }
  return [rows, hours];
}
const btc = load("BTCUSDT"),
  eth = load("ETHUSDT");
const candles = (map, t, step) =>
  Array.from({ length: 321 }, (_, i) => map.get(t - (321 - i) * step));
async function scan(symbol) {
  const byInterval = load(symbol),
    offers = [],
    coverage = [],
    raw = {};
  for (const t of sessions) coverage.push([]);
  for (const [n, e] of entries) {
    const declaration = spec[n];
    if (
      !declaration.enabled ||
      (declaration.selection && !declaration.selection.tickers.includes(symbol))
    )
      continue;
    const cfg = e.parseConfig({
      ...declaration.config,
      ENV: "PARITY",
      MAKE_ORDERS: true,
    });
    const ratio = Number(cfg.INTERVAL) / 15,
      idx = ratio === 1 ? 0 : 1,
      step = M * ratio;
    const clock = new Map(
      sessions.map((time, i) => [Math.floor(time / step) * step, { time, i }]),
    );
    let run = null,
      asOf = 0,
      t = 0;
    const test = createTestConnector(
      {
        universe: "crypto",
        capabilities: {},
        listInstruments: async () => [],
        kline: async (q) => {
          assert.equal(q.symbol, symbol);
          assert.equal(String(q.interval), "15");
          assert.ok(q.end < asOf);
          const result = [];
          for (let time = q.start; time <= q.end; time += M) {
            const bar = byInterval[0].get(time);
            if (bar) result.push(bar);
          }
          return result;
        },
      },
      { fastMode: true, aiEnabled: true },
    );
    const old = e.manifest.hooks?.beforeEntryGate;
    const make = createStrategyRuntime({
      strategyName: n,
      defaults: e.defaults,
      createCore: async (params) => {
        const core = await e.createCore(params);
        return async (...args) => {
          const decision = await core(...args);
          return decision.kind === "entry" && !clock.has(asOf)
            ? params.strategyApi.skip("OUTSIDE_SESSION_OPEN")
            : decision;
        };
      },
      manifest: {
        ...e.manifest,
        hooks: {
          ...e.manifest.hooks,
          beforeEntryGate: async (p) => {
            const v = await old?.(p);
            if (v?.allow === false) return v;
            const { decision } = p;
            const plan = decision.orderPlan;
            offers.push({
              t,
              symbol,
              strategy: n,
              direction: decision.entryContext.direction,
              quality:
                p.ai?.quality ?? decision.signal?.aiAnalysis?.quality ?? null,
              stop: plan.stopLossPrice,
              targets: plan.takeProfits,
              price: decision.entryContext.prices.currentPrice,
              asOf,
              minRR: cfg[decision.entryContext.direction]?.minRiskRatio ?? 0,
            });
            return { allow: false, reason: "SESSION_SCAN" };
          },
        },
      },
    });

    for (let cursor = start - 32 * step; cursor < end; cursor += step) {
      asOf = cursor + step;
      const slot = clock.get(asOf);
      t = slot?.time;
      const [a, b, c] = [byInterval, btc, eth].map((pair) =>
        pair[idx].get(cursor),
      );
      if (!a || !b || !c) {
        run = null;
        continue;
      }
      if (!run) {
        const warm = [byInterval, btc, eth].map((pair) =>
          candles(pair[idx], asOf, step).slice(0, -1),
        );
        if (warm.some((arr) => arr.some((v) => !v))) continue;
        run = await make({
          userName: "offline-session",
          connectorName: "bybit",
          symbol,
          universe: "crypto",
          assetClass: "crypto_perpetual",
          config: cfg,
          runtimeConfigSnapshot: { userConfig: {} },
          data: warm[0],
          btcData: warm[1],
          ethData: warm[2],
          connector: test,
        });
      }
      const result = await run(a, b, c);

      if (!slot) continue;
      coverage[slot.i].push(n);
      if (result && typeof result === "object") {
        if (result.orderFailureReason)
          throw Error(n + ": " + result.orderFailureReason);
        raw[n] = (raw[n] ?? 0) + 1;
      }
    }
  }
  writeFileSync(
    dir + "continuous/" + symbol + ".json",
    JSON.stringify({ symbol, offers, coverage, raw }),
  );
}
try {
  for (const s of requested) {
    assert.ok(symbols.includes(s));
    await scan(s);
  }
} finally {
  await closeTimescalePool();
  await closeRedisConnection();
}
