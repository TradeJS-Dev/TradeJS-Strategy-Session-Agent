import { BAR } from "./policy.js";
import { FEE, SLIPPAGE } from "./portfolio.js";
import type { SessionOrder } from "./portfolio.js";

export type ExecutionCandle = readonly [
  open: number,
  high: number,
  low: number,
  close: number,
];
export type FundingPoint = readonly [timestamp: number, rate: number];
export interface PortfolioTrade {
  symbol: string;
  session: "tokyo" | "newYork";
  timestamp: number;
  exit: number;
  pnl: number;
}

export function simulatePortfolioTrade(
  order: SessionOrder,
  bars: ReadonlyMap<number, ExecutionCandle>,
  fundingPoints: readonly FundingPoint[],
): PortfolioTrade | undefined {
  const first = bars.get(order.timestamp);
  if (!first) return;
  const { side, qty, stop } = order;
  const entry = first[0] * (1 + side * SLIPPAGE);
  const rates = new Map(fundingPoints);
  let funding = 0;
  for (let now = order.timestamp; now < order.closesAt; now += BAR) {
    const bar = bars.get(now);
    if (!bar) return;
    const [open, high, low, close] = bar;
    if (now !== order.timestamp)
      funding -= side * qty * open * (rates.get(now) ?? 0);
    const hit = side === 1 ? low <= stop : high >= stop;
    const exit = now + BAR;
    if (!hit && exit !== order.closesAt) continue;
    const left = fundingPoints.findIndex(([t]) => t > order.timestamp) - 1;
    const right = fundingPoints.findIndex(([t]) => t >= exit);
    if (left < 0 || right < 0) return;
    for (let index = left; index < right; index++) {
      if (fundingPoints[index + 1][0] - fundingPoints[index][0] > 28_800_000)
        return;
    }
    const fill = hit
      ? side === 1
        ? Math.min(open, stop)
        : Math.max(open, stop)
      : close;
    const exitPrice = fill * (1 - side * SLIPPAGE);
    const fee = qty * (entry + exitPrice) * FEE;
    return {
      symbol: order.symbol,
      session: order.session,
      timestamp: order.timestamp,
      exit,
      pnl: qty * side * (exitPrice - entry) - fee + funding,
    };
  }
}

export function summarizePortfolio(
  trades: readonly PortfolioTrade[],
  from: number,
  to: number,
) {
  const sorted = trades
    .filter((trade) => trade.exit >= from && trade.exit < to)
    .sort((a, b) => a.exit - b.exit);
  let bestTokyo: PortfolioTrade | undefined;
  let pnl = 0,
    maxDD = 0,
    peak = 0,
    peakAt = from,
    longest = 0;
  let underwater = false;
  for (const trade of sorted) {
    if (trade.session === "tokyo" && trade.pnl > (bestTokyo?.pnl ?? 0))
      bestTokyo = trade;
    pnl += trade.pnl;
    if (pnl >= peak) {
      if (underwater) longest = Math.max(longest, trade.exit - peakAt);
      peakAt = trade.exit;
      peak = pnl;
      underwater = false;
    } else {
      underwater = true;
      maxDD = Math.max(maxDD, peak - pnl);
    }
  }
  if (underwater) longest = Math.max(longest, to - peakAt);
  return {
    trades: sorted.length,
    tokyoTrades: sorted.filter((trade) => trade.session === "tokyo").length,
    pnl,
    maxDD,
    longestDays: longest / 86_400_000,
    pnlWithoutBestTokyo: pnl - (bestTokyo?.pnl ?? 0),
  };
}
