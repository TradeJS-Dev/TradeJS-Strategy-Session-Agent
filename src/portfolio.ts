import { BAR, sessionAt } from "./policy.js";
import {
  calibratedAt,
  findAnalogCandidate,
  gateScore,
  rankMarket,
  snapshot,
} from "./portfolio-model.js";
import type {
  DirectionSign,
  MarketRow,
  SessionAgentCalibration,
} from "./portfolio-model.js";

export type {
  DirectionSign,
  MarketRow,
  SessionAgentCalibration,
} from "./portfolio-model.js";

export const FULL_RISK = 10;
export const FEE = 0.00055;
export const SLIPPAGE = 0.0002;

export interface LotRule {
  qtyStep: string | number;
  maxMktOrderQty: string | number;
  minOrderQty: string | number;
  minNotionalValue: string | number;
}

export interface SessionFrame {
  timestamp: number;
  rows: readonly MarketRow[];
}

export interface SessionOrder {
  session: "tokyo" | "newYork";
  symbol: string;
  side: DirectionSign;
  timestamp: number;
  closesAt: number;
  qty: number;
  stop: number;
}

export function portfolioPhase(timestamp: number) {
  if (!Number.isInteger(timestamp / BAR)) return undefined;
  for (let phase = 0; phase < 3; phase++) {
    const opening = timestamp - phase * BAR;
    const session = sessionAt(opening);
    if (session?.opening) return { phase, opening, name: session.name };
  }
  return undefined;
}

function planOrder(
  row: MarketRow,
  side: DirectionSign,
  rule: LotRule | undefined,
  timestamp: number,
  opening: number,
  session: SessionOrder["session"],
): SessionOrder | undefined {
  if (
    !rule ||
    row.price <= 0 ||
    !Number.isFinite(row.price) ||
    !Number.isFinite(row.rms)
  )
    return;
  const step = Number(rule.qtyStep);
  const maximum = Number(rule.maxMktOrderQty);
  const minQty = Number(rule.minOrderQty);
  const minNotional = Number(rule.minNotionalValue);
  if (!(step > 0 && maximum > 0 && minQty >= 0 && minNotional >= 0)) return;
  const distance = Math.max(
    0.01,
    Math.min(0.06, 1.25 * Math.sqrt(26) * row.rms),
  );
  const entry = row.price * (1 + side * SLIPPAGE);
  const stop = row.price * (1 - side * distance);
  const adjustedStop = stop * (1 - side * SLIPPAGE);
  const loss = side * (entry - adjustedStop) + FEE * (entry + adjustedStop);
  const qty = Math.floor(Math.min(FULL_RISK / loss, maximum) / step) * step;
  if (qty <= 0 || qty < minQty || qty * entry < minNotional) return;
  return {
    session,
    symbol: row.symbol,
    side,
    timestamp,
    closesAt: opening + 26 * BAR,
    qty,
    stop,
  };
}

type RoutingState =
  | { kind: "search" }
  | { kind: "done" }
  | { kind: "wait"; symbol: string; side: DirectionSign };

/** Feed synchronized, completed market snapshots in chronological order. One route per session. */
export function createSessionSelector(
  calibration: SessionAgentCalibration,
  rules: Readonly<Record<string, LotRule>>,
) {
  let lastTimestamp = -Infinity;
  let opening = -Infinity;
  let state: RoutingState = { kind: "search" };
  return (frame: SessionFrame): SessionOrder | undefined => {
    if (frame.timestamp <= lastTimestamp) {
      throw new Error("Session frames must arrive once in chronological order");
    }
    lastTimestamp = frame.timestamp;
    const slot = portfolioPhase(frame.timestamp);
    if (!slot) return;
    if (slot.opening !== opening) {
      opening = slot.opening;
      // Starting late without the opening snapshot could issue a duplicate/replacement.
      state = slot.phase === 0 ? { kind: "search" } : { kind: "done" };
    }
    if (state.kind === "done") return;
    const ranked = rankMarket(frame.rows);
    const market = snapshot(ranked.slice(0, slot.name === "newYork" ? 12 : 24));
    if (state.kind === "wait") {
      const pending = state;
      state = { kind: "done" };
      if (slot.phase !== 1 || !market) return;
      const row = ranked
        .slice(0, 12)
        .find((candidate) => candidate.symbol === pending.symbol);
      const gate = calibratedAt(calibration.newYorkGate, frame.timestamp);
      const wide = snapshot(ranked.slice(0, 24))!;
      if (
        !row ||
        !gate ||
        gateScore(gate, row, pending.side, slot.phase, wide.context) <= 0
      )
        return;
      return planOrder(
        row,
        pending.side,
        rules[row.symbol],
        frame.timestamp,
        opening,
        slot.name,
      );
    }
    if (!market) return;
    const venueModels = calibratedAt(
      calibration.bySession[slot.name],
      frame.timestamp,
    );
    const analog = venueModels?.[String(slot.phase)];
    if (!analog) return;
    const pick = findAnalogCandidate(market, analog);
    if (!pick) return;
    const order = planOrder(
      pick.row,
      pick.side,
      rules[pick.row.symbol],
      frame.timestamp,
      opening,
      slot.name,
    );
    if (!order) return;
    state = { kind: "done" };
    if (slot.name === "tokyo") return pick.side === 1 ? order : undefined;

    const gate = calibratedAt(calibration.newYorkGate, frame.timestamp);
    const wide = snapshot(ranked.slice(0, 24))!;
    if (
      !gate ||
      gateScore(gate, pick.row, pick.side, slot.phase, wide.context) <= 0
    )
      return;
    if (slot.phase === 0) {
      state = { kind: "wait", symbol: pick.row.symbol, side: pick.side };
      return;
    }
    return order;
  };
}

export interface TokyoRiskState {
  shadow: number[];
  lossStreak: number;
  lastSession?: number;
}

export type TokyoRisk = 0 | 0.125 | 0.25;

export function nextTokyoRisk(state: TokyoRiskState): TokyoRisk {
  if (state.lossStreak >= 3) return 0;
  return state.shadow.length >= 20 &&
    state.shadow.slice(-20).reduce((total, result) => total + result, 0) > 0
    ? 0.25
    : 0.125;
}

/** Settle once, after the shadow and, if taken, the real order are both closed. */
export function settleTokyo(
  previous: TokyoRiskState,
  result: { session: number; shadowPnl: number; actualPnl: number | null },
): TokyoRiskState {
  if (
    previous.lastSession !== undefined &&
    result.session <= previous.lastSession
  ) {
    throw new Error("Tokyo settlements must be unique and chronological");
  }
  const expectedRisk = nextTokyoRisk(previous);
  if (
    !Number.isFinite(result.shadowPnl) ||
    (result.actualPnl !== null && !Number.isFinite(result.actualPnl)) ||
    (expectedRisk === 0 && result.actualPnl !== null)
  ) {
    throw new Error("Invalid Tokyo settlement");
  }
  return {
    shadow: [...previous.shadow.slice(-19), result.shadowPnl],
    lossStreak:
      expectedRisk === 0
        ? 0
        : result.actualPnl === null
          ? previous.lossStreak
          : result.actualPnl < 0
            ? previous.lossStreak + 1
            : 0,
    lastSession: result.session,
  };
}

/** Session runner shared by the archived replay and hosts with synchronized market frames. */
export function createPortfolioSessionAgent(
  calibration: SessionAgentCalibration,
  rules: Readonly<Record<string, LotRule>>,
  initialTokyoState: TokyoRiskState = { shadow: [], lossStreak: 0 },
) {
  if (
    !Number.isInteger(initialTokyoState.lossStreak) ||
    initialTokyoState.lossStreak < 0 ||
    initialTokyoState.lossStreak > 3 ||
    !initialTokyoState.shadow.every(Number.isFinite)
  )
    throw new Error("Invalid persisted Tokyo state");
  const select = createSessionSelector(calibration, rules);
  let tokyo = { ...initialTokyoState, shadow: [...initialTokyoState.shadow] };
  let unsettled: number | undefined;
  return {
    onFrame(frame: SessionFrame) {
      const order = select(frame);
      if (!order) return;
      if (order.session === "newYork") return { order, risk: 1 as const };
      if (unsettled !== undefined)
        throw new Error(
          "Settle the previous Tokyo signal before routing another",
        );
      unsettled = portfolioPhase(frame.timestamp)!.opening;
      return { order, risk: nextTokyoRisk(tokyo), settlementId: unsettled };
    },
    settle(result: {
      session: number;
      shadowPnl: number;
      actualPnl: number | null;
    }) {
      if (result.session !== unsettled)
        throw new Error("Unknown Tokyo settlement");
      tokyo = settleTokyo(tokyo, result);
      unsettled = undefined;
    },
    snapshot(): TokyoRiskState {
      return { ...tokyo, shadow: [...tokyo.shadow] };
    },
  };
}
