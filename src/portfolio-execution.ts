import type { StrategyAPI } from "@tradejs/types";

import type { LotRule, SessionOrder, TokyoRisk } from "./portfolio.js";

/** Bind the routed decision to its symbol's StrategyAPI. The host owns settlement and deduplication. */
export async function enterPortfolioOrder(
  api: StrategyAPI,
  symbol: string,
  timestamp: number,
  order: SessionOrder,
  risk: TokyoRisk | 1,
  rule: LotRule,
) {
  if (symbol !== order.symbol || timestamp !== order.timestamp || risk === 0) {
    return api.skip("SESSION_ROUTE_UNAVAILABLE");
  }
  const position = await api.getCurrentPosition();
  if (position && position.qty > 0) return api.skip("SESSION_POSITION_OPEN");
  const { currentPrice } = await api.getDecisionPriceContext();
  const direction = order.side === 1 ? "LONG" : "SHORT";
  const lossDistance = order.side * (currentPrice - order.stop);
  const step = Number(rule.qtyStep);
  const qty = Math.floor((order.qty * risk) / step) * step;
  if (!(
    Number.isFinite(currentPrice) &&
    currentPrice > 0 &&
    lossDistance > 0 &&
    qty > 0 &&
    qty >= Number(rule.minOrderQty) &&
    qty * currentPrice >= Number(rule.minNotionalValue)
  )) {
    return api.skip("SESSION_ORDER_NOT_EXECUTABLE");
  }
  return api.entry({
    direction,
    code: "SESSION_PORTFOLIO_OPEN",
    orderPlan: { qty, stopLossPrice: order.stop, takeProfits: [] },
  });
}

export async function closePortfolioOrder(
  api: StrategyAPI,
  symbol: string,
  timestamp: number,
  order: SessionOrder,
) {
  if (symbol !== order.symbol || timestamp < order.closesAt)
    return api.skip("WAIT_FOR_SESSION_END");
  const position = await api.getCurrentPosition();
  const direction = order.side === 1 ? "LONG" : "SHORT";
  if (!position || position.qty <= 0 || position.direction !== direction)
    return api.skip("SESSION_NO_POSITION");
  return api.exit({ code: "SESSION_END", direction });
}
