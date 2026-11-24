export type DirectionSign = 1 | -1;

export interface MarketRow {
  symbol: string;
  price: number;
  turnover: number;
  fourHour: number;
  rms: number;
  activity: number;
}

export interface AnalogModel {
  scales: number[];
  history: { context: number[]; netR: (number | null)[] }[];
}

export interface GateModel {
  mean: number[];
  scale: number[];
  beta: number[];
  intercept: number;
}

export interface SessionAgentCalibration {
  bySession: {
    newYork: Record<string, Record<string, AnalogModel>>;
    tokyo: Record<string, Record<string, AnalogModel>>;
  };
  newYorkGate: Record<string, GateModel>;
}

const compareSymbol = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const avg = (a: number[]) => a.reduce((sum, n) => sum + n, 0) / a.length;
const variance = (a: number[], sample: boolean) => {
  const mean = avg(a);
  return (
    a.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (a.length - Number(sample))
  );
};
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function rankMarket(rows: readonly MarketRow[]) {
  return rows
    .filter(
      (row) =>
        row.symbol.endsWith("USDT") &&
        row.turnover >= 10_000_000 &&
        row.price > 0 &&
        row.rms >= 0 &&
        row.activity >= 0 &&
        [row.price, row.turnover, row.fourHour, row.rms, row.activity].every(
          Number.isFinite,
        ),
    )
    .sort(
      (a, b) => b.turnover - a.turnover || compareSymbol(a.symbol, b.symbol),
    );
}

export function snapshot(rows: MarketRow[]) {
  if (rows.length < 12) return null;
  const marketReturn = median(rows.map((row) => row.fourHour));
  const relative = (row: MarketRow) =>
    (row.fourHour - marketReturn) / Math.max(0.0001, 4 * row.rms);
  const momentum = median(
    rows.map((row) => row.fourHour / Math.max(0.0001, 4 * row.rms)),
  );
  const ordered = [...rows].sort(
    (a, b) => relative(a) - relative(b) || compareSymbol(a.symbol, b.symbol),
  );
  return {
    leader: ordered[ordered.length - 1],
    laggard: ordered[0],
    context: [
      momentum,
      rows.filter((row) => row.fourHour > 0).length / rows.length,
      Math.sqrt(variance(rows.map(relative), false)),
      median(rows.map((row) => row.activity)),
      median(rows.map((row) => row.rms)),
    ],
  };
}

export function findAnalogCandidate(
  market: NonNullable<ReturnType<typeof snapshot>>,
  model: AnalogModel,
) {
  const actions = [
    [market.leader, 1],
    [market.leader, -1],
    [market.laggard, 1],
    [market.laggard, -1],
  ] as const;
  const nearest = model.history
    .map((row) => ({
      netR: row.netR,
      distance: row.context.reduce(
        (sum, value, i) =>
          sum + ((market.context[i] - value) / model.scales[i]) ** 2,
        0,
      ),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 48);
  let best: { row: MarketRow; side: DirectionSign; score: number } | undefined;
  actions.forEach(([row, side], action) => {
    const net = nearest
      .map((past) => past.netR[action])
      .filter((v) => v !== null);
    if (net.length < 32) return;
    const score =
      (avg(net) * net.length) / (net.length + 16) -
      Math.sqrt(variance(net, true) / net.length);
    if (score > (best?.score ?? 0)) best = { row, side, score };
  });
  return best;
}

export function gateScore(
  model: GateModel,
  row: MarketRow,
  side: DirectionSign,
  phase: number,
  [momentum, breadth, dispersion, marketActivity, marketVol]: number[],
) {
  const normalized = row.fourHour / Math.max(0.0001, 4 * row.rms);
  const log = (value: number) => Math.log(Math.max(1e-8, value));
  const features = [
    side,
    phase,
    side * momentum,
    side * (2 * breadth - 1),
    dispersion,
    log(marketActivity),
    log(marketVol),
    side * normalized,
    side * normalized - side * momentum,
    log(row.rms),
    log(row.activity),
    Math.log(row.turnover),
  ];
  return (
    model.intercept +
    features.reduce((sum, value, i) => {
      const x = (value - model.mean[i]) / model.scale[i];
      return sum + Math.max(-4, Math.min(4, x)) * model.beta[i];
    }, 0)
  );
}

export function calibratedAt<T>(models: Record<string, T>, timestamp: number) {
  const key = Object.keys(models)
    .map(Number)
    .filter((t) => t <= timestamp)
    .sort((a, b) => b - a)[0];
  return models[key];
}
