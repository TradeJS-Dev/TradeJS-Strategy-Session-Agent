import { defineStrategyPlugin } from "@tradejs/core/config";
import { createStrategyConfigParser } from "@tradejs/strategy-kit/config";
import type { CreateStrategyCore, StrategyConfig } from "@tradejs/types";
import {
  BAR,
  features,
  sessionAt,
  predict,
  side,
  stopFraction,
  targetFraction,
} from "./policy.js";
import { models } from "./models.js";
import { createPortfolioPlugin } from "./portfolio-plugin.js";
import type { PortfolioPluginHost } from "./portfolio-plugin.js";
export const STRATEGY_NAME = "SessionAgent";
export const defaults = { INTERVAL: "15", MAX_LOSS_VALUE: 10 };
const parse = createStrategyConfigParser({
  strategyName: STRATEGY_NAME,
  defaults,
});
export const parseConfig = (input: unknown) => {
  const config = parse(input);
  if (
    config.INTERVAL !== "15" ||
    !Number.isFinite(config.MAX_LOSS_VALUE) ||
    config.MAX_LOSS_VALUE <= 0
  )
    throw new Error(
      "SessionAgent requires 15-minute bars and a positive risk budget",
    );
  return config;
};
export const createCore: CreateStrategyCore<StrategyConfig> =
  ({ strategyApi, config }) =>
  async (candle) => {
    const time = candle.timestamp + BAR;
    const session = sessionAt(time);
    const position = await strategyApi.getCurrentPosition();
    if (position && position.qty > 0) {
      if (!session || session.opening)
        return strategyApi.exit({
          direction: position.direction,
          code: "SESSION_END",
        });
      return strategyApi.skip("SESSION_POSITION_OPEN");
    }
    if (!session?.opening) return strategyApi.skip("WAIT_FOR_SESSION");
    const history = await strategyApi.getClosedCandles({
      interval: "15",
      start: time - 96 * BAR,
      end: time,
      limit: 96,
    });
    const x = history.complete && features(history.candles, time);
    if (!x) return strategyApi.skip("INCOMPLETE_CONTEXT");
    const forecast = predict(x, models[session.name]);
    const direction = side(forecast);
    if (!direction) return strategyApi.skip("BELOW_COST_THRESHOLD");
    const { currentPrice } = await strategyApi.getDecisionPriceContext();
    if (!(Number.isFinite(currentPrice) && currentPrice > 0))
      return strategyApi.skip("INVALID_PRICE");
    const sign = direction === "LONG" ? 1 : -1;
    return strategyApi.entry({
      direction,
      code: "SESSION_OPEN",
      indicators: { expectedReturnBps: forecast },
      orderPlan: {
        qty:
          Number(config.MAX_LOSS_VALUE ?? 10) / (currentPrice * stopFraction),
        stopLossPrice: currentPrice * (1 - sign * stopFraction),
        stopLossDistance: currentPrice * stopFraction,
        takeProfits: [
          { price: currentPrice * (1 + sign * targetFraction), rate: 1 },
        ],
      },
    });
  };
export const strategyEntries = defineStrategyPlugin({
  strategyEntries: [
    { manifest: { name: STRATEGY_NAME }, defaults, parseConfig, createCore },
  ],
}).strategyEntries;
export default defineStrategyPlugin({ strategyEntries });

export * from "./portfolio.js";
export { marketRowFromCandles } from "./portfolio-features.js";
export {
  simulatePortfolioTrade,
  summarizePortfolio,
} from "./portfolio-replay.js";
export {
  closePortfolioOrder,
  enterPortfolioOrder,
} from "./portfolio-execution.js";

export type {
  PortfolioOrderView,
  PortfolioPluginHost,
} from "./portfolio-plugin.js";

/** Register the portfolio variant where the host supplies one market-wide execution owner. */
export function createSessionAgentPortfolioPlugin(host: PortfolioPluginHost) {
  return createPortfolioPlugin(strategyEntries[0], host);
}
