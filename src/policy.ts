export const BAR = 900_000;
export type Session = "tokyo" | "newYork";
const newYorkClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function sessionAt(time: number) {
  const utcMinute =
    new Date(time).getUTCHours() * 60 + new Date(time).getUTCMinutes();
  if (utcMinute < 390)
    return { name: "tokyo" as const, opening: utcMinute === 0 };
  const [hour, minute] = newYorkClock.format(time).split(":").map(Number);
  const localMinute = hour * 60 + minute;
  return localMinute >= 570 && localMinute < 960
    ? { name: "newYork" as const, opening: localMinute === 570 }
    : null;
}

interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export function features(rows: readonly Bar[], asOf: number) {
  if (
    rows.length !== 96 ||
    rows.some(
      (b, i) =>
        b.timestamp !== asOf - (96 - i) * BAR ||
        ![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) ||
        b.low <= 0 ||
        b.low > Math.min(b.open, b.close) ||
        b.high < Math.max(b.open, b.close) ||
        b.volume < 0,
    )
  )
    return null;
  const last = rows[95].close;
  const high = Math.max(...rows.map((b) => b.high)),
    low = Math.min(...rows.map((b) => b.low));
  const volume = rows.reduce((s, b) => s + b.volume, 0);
  if (volume === 0 || high === low) return null;
  const hour = rows.slice(-4);
  return [
    ...[4, 16, 96].map((n) => Math.log(last / rows[96 - n].open)),
    (last - low) / (high - low) - 0.5,
    Math.log(high / low),
    (hour.reduce((s, b) => s + b.volume, 0) * 24) / volume - 1,
  ];
}

export interface Fit {
  mean: number[];
  scale: number[];
  weights: number[];
  intercept: number;
}
export function predict(x: number[], model: Fit) {
  return x.reduce(
    (sum, v, i) =>
      sum + model.weights[i] * ((v - model.mean[i]) / model.scale[i]),
    model.intercept,
  );
}
export const admissionBps = 16;
export const stopFraction = 0.02;
export const targetFraction = 0.04;
export function side(score: number) {
  return score > admissionBps ? "LONG" : score < -admissionBps ? "SHORT" : null;
}
