import { BAR } from "./policy.js";
import type { MarketRow } from "./portfolio-model.js";

export interface PortfolioCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  turnover: number;
}

export function marketRowFromCandles(
  symbol: string,
  at: number,
  bars: readonly PortfolioCandle[],
): MarketRow | undefined {
  if (
    bars.length !== 96 ||
    bars.some(
      (bar, i) =>
        bar.timestamp !== at - (96 - i) * BAR ||
        !Number.isFinite(bar.open) ||
        bar.open <= 0 ||
        !Number.isFinite(bar.close) ||
        bar.close <= 0 ||
        !Number.isFinite(bar.turnover) ||
        bar.turnover < 0,
    )
  )
    return;
  const turnover = bars.reduce((total, bar) => total + bar.turnover, 0);
  if (turnover < 10_000_000) return;
  let previous = bars[0].open;
  let squares = 0;
  for (const bar of bars) {
    squares += Math.log(bar.close / previous) ** 2;
    previous = bar.close;
  }
  return {
    symbol,
    price: previous,
    turnover,
    fourHour: Math.log(previous / bars[80].open),
    rms: Math.sqrt(squares / 96),
    activity:
      (bars.slice(-4).reduce((sum, bar) => sum + bar.turnover, 0) * 24) /
      turnover,
  };
}
