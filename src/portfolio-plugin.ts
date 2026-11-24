import { defineStrategyPlugin } from "@tradejs/core/config";
import type {
  StrategyPluginDefinition,
  StrategyRegistryEntry,
} from "@tradejs/types";

import { BAR } from "./policy.js";
import {
  closePortfolioOrder,
  enterPortfolioOrder,
} from "./portfolio-execution.js";
import type { LotRule, SessionOrder, TokyoRisk } from "./portfolio.js";

type CreateCore = StrategyRegistryEntry["createCore"];

export type PortfolioOrderView =
  | { symbol: string; kind: "position"; order: SessionOrder }
  | {
      symbol: string;
      kind: "entry";
      order: SessionOrder;
      risk: TokyoRisk | 1;
      rule: LotRule;
    };

export interface PortfolioPluginHost {
  /** The host routes a single shared session decision to the correct symbol. */
  getOrderView(
    context: Parameters<CreateCore>[0],
    timestamp: number,
  ): Promise<PortfolioOrderView | undefined>;
}

export function createPortfolioPlugin(
  prototype: StrategyRegistryEntry,
  host: PortfolioPluginHost,
): StrategyPluginDefinition {
  const createCore: CreateCore = (context) => async (candle) => {
    const timestamp = candle.timestamp + BAR;
    const view = await host.getOrderView(context, timestamp);
    if (!view) return context.strategyApi.skip("SESSION_NO_ROUTE");
    if (view.kind === "position") {
      return closePortfolioOrder(
        context.strategyApi,
        view.symbol,
        timestamp,
        view.order,
      );
    }
    return enterPortfolioOrder(
      context.strategyApi,
      view.symbol,
      timestamp,
      view.order,
      view.risk,
      view.rule,
    );
  };
  return defineStrategyPlugin({
    strategyEntries: [{ ...prototype, createCore }],
  });
}
