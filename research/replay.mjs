// Node 24. Run from the Project with the CSV, output model and report paths.
import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  BAR,
  features,
  predict,
  sessionAt,
  side,
  stopFraction,
  targetFraction,
} from "../src/policy.ts";
const [csv, modelFile, reportFile] = process.argv.slice(2);
const input = fs.readFileSync(csv, "utf8");
const rows = input
  .trim()
  .split("\n")
  .map((line) => {
    const [timestamp, open, high, low, close, volume] = line
      .split(",")
      .map(Number);
    return { timestamp, open, high, low, close, volume };
  });
const split = Date.parse("2025-04-12T00:00Z"),
  start = Date.parse("2022-11-18T00:00Z"),
  end = Date.parse("2026-11-18T00:00Z");
const models = {},
  trades = [],
  coverage = {};
function fit(samples) {
  const n = samples.length;
  const mean = samples[0].x.map(
    (_, i) => samples.reduce((s, r) => s + r.x[i], 0) / n,
  );
  const scale = mean.map(
    (m, i) =>
      Math.sqrt(samples.reduce((s, r) => s + (r.x[i] - m) ** 2, 0) / n) || 1,
  );
  const intercept = samples.reduce((s, r) => s + r.y, 0) / n;
  const z = samples.map((r) => r.x.map((v, i) => (v - mean[i]) / scale[i]));
  const weights = mean.map(() => 0);
  // Full batch ridge, standardized inputs, fixed L2=1. No test-set tuning.
  for (let k = 0; k < 160; k++) {
    const grad = [...weights];
    z.forEach((x, j) => {
      const err = x.reduce(
        (s, v, i) => s + v * weights[i],
        intercept - samples[j].y,
      );
      x.forEach((v, i) => (grad[i] += (v * err) / n));
    });
    grad.forEach((v, i) => (weights[i] -= 0.1 * v));
  }
  return { mean, scale, intercept, weights };
}
for (const name of ["tokyo", "newYork"]) {
  const samples = [];
  rows.forEach((bar, i) => {
    const t = bar.timestamp;
    if (t < start || t >= end || t % 1800000 !== 0) return;
    const session = sessionAt(t);
    if (!session?.opening || session.name !== name) return;
    const x = features(rows.slice(i - 96, i), t);
    const path = rows.slice(i, i + 26);
    if (
      !x ||
      path.length !== 26 ||
      path.some((b, j) => b.timestamp !== t + j * BAR)
    )
      return;
    samples.push({ x, t, path, y: 10000 * (path.at(-1).close / bar.open - 1) });
  });
  const train = samples.filter((s) => s.t + 26 * BAR <= split),
    test = samples.filter((s) => s.t >= split);
  coverage[name] = { train: train.length, test: test.length };
  if (
    test.length !== (end - split) / 86400000 ||
    train.length !== (split - start) / 86400000
  )
    throw Error("Incomplete sessions " + JSON.stringify(coverage));
  const model = (models[name] = fit(train));
  for (const { x, t, path } of test) {
    const direction = side(predict(x, model));
    if (!direction) continue;
    const sign = direction === "LONG" ? 1 : -1,
      entry = path[0].open;
    let exit = path.at(-1).close,
      reason = "close",
      exitAt = t + 26 * BAR;
    for (const b of path) {
      const stop = entry * (1 - sign * stopFraction),
        target = entry * (1 + sign * targetFraction);
      if (sign === 1 ? b.low <= stop : b.high >= stop) {
        exit = sign === 1 ? Math.min(stop, b.open) : Math.max(stop, b.open);
        reason = "stop";
      } else if (sign === 1 ? b.high >= target : b.low <= target) {
        exit = target;
        reason = "target";
      } else continue;
      exitAt = b.timestamp + BAR;
      break;
    }
    const qty = 10 / (entry * stopFraction);
    trades.push({
      t,
      exitAt,
      name,
      direction,
      reason,
      pnl: qty * (sign * (exit - entry) - (entry + exit) * 0.0008),
    });
  }
}
function metrics(group) {
  let total = 0,
    peak = 0,
    dd = 0,
    win = 0,
    loss = 0,
    winners = 0;
  for (const { pnl } of group) {
    total += pnl;
    peak = Math.max(peak, total);
    dd = Math.max(dd, peak - total);
    if (pnl > 0) {
      win += pnl;
      winners++;
    } else loss -= pnl;
  }
  const n = group.length;
  return {
    n,
    pnl: total,
    mean: n ? total / n : null,
    pf: loss ? win / loss : null,
    wr: n ? winners / n : null,
    maxDD: dd,
    cadence: n / ((end - split) / 86400000),
  };
}
trades.sort((a, b) => a.exitAt - b.exitAt);
const results = {};
for (const cohort of ["ALL", "LONG", "SHORT", "tokyo", "newYork"])
  results[cohort] = metrics(
    trades.filter(
      (r) => cohort === "ALL" || r.direction === cohort || r.name === cohort,
    ),
  );
fs.writeFileSync(
  modelFile,
  "export const models = " + JSON.stringify(models, null, 2) + ";\n",
);
fs.writeFileSync(
  reportFile,
  JSON.stringify(
    {
      start,
      split,
      end,
      csvSha256: createHash("sha256").update(input).digest("hex"),
      coverage,
      results,
      exits: Object.fromEntries(
        ["stop", "target", "close"].map((k) => [
          k,
          trades.filter((r) => r.reason === k).length,
        ]),
      ),
    },
    null,
    2,
  ) + "\n",
);
