"""Rank already-admitted native TradeJS signals at a single session opening."""
from math import floor, isfinite

FEE = 0.00055
SLIP = 0.0002
BAR = 900_000


def select(offers, histories, instruments):
    ranked = []
    for offer in offers:
        symbol, time = offer["symbol"], offer["t"]
        series = histories[symbol]
        if time - BAR not in series or not offer["targets"]:
            continue
        price = series[time - BAR][3]
        sign = 1 if offer["direction"] == "LONG" else -1
        target, stop = offer["targets"][0]["price"], offer["stop"]
        if not all(isfinite(v) and v > 0 for v in (price, target, stop)):
            continue
        # An hourly setup can be 30 minutes old at the New York opening.
        intervening = [series.get(t) for t in range(offer["asOf"], time, BAR)]
        lower, upper = sorted((stop, target))
        if any(not b or b[2] <= lower or b[1] >= upper for b in intervening):
            continue
        entry = price * (1 + sign * SLIP)
        if sign * (entry - stop) <= 0 or sign * (target - entry) <= 0:
            continue
        sl, tp = (p * (1 - sign * SLIP) for p in (stop, target))
        loss = sign * (entry - sl) + FEE * (entry + sl)
        gain = sign * (tp - entry) - FEE * (entry + tp)
        rr = gain / loss
        if rr <= 0 or rr < offer["minRR"]:
            continue
        rules = instruments[symbol]["lotSizeFilter"]
        step = float(rules["qtyStep"])
        qty = floor(min(10 / loss, float(rules["maxMktOrderQty"])) / step) * step
        if qty < float(rules["minOrderQty"]) or qty * entry < float(rules["minNotionalValue"]):
            continue
        ranked.append(dict(offer, qty=qty, rr=rr, sign=sign, target=target))
    ranked.sort(key=lambda o: (-o["rr"], -(o["quality"] or 0), o["symbol"], o["strategy"]))
    return ranked[0] if ranked else None


def settle(order, series, rates):
    time, sign = order["t"], order["sign"]
    bars = [series.get(time + i * BAR) for i in range(26)]
    if not bars[0] or not rates or rates[0][0] > time or rates[-1][0] < time + 26 * BAR:
        raise ValueError("Missing price or funding coverage for selected trade")
    entry = bars[0][0] * (1 + sign * SLIP)
    stop, target = order["stop"], order["target"]
    payments = {ts: float(rate) for ts, rate in rates}
    for left, right in zip(rates, rates[1:]):
        if left[0] < time + 26 * BAR and right[0] > time and right[0] - left[0] > 8 * 3600_000:
            raise ValueError("Gap in funding history for selected trade")
    funding = 0
    for i, bar in enumerate(bars):
        if not bar:
            raise ValueError("Missing bar for selected trade")
        op, hi, lo, close = bar
        now = time + i * BAR
        if i and now in payments:
            funding -= sign * order["qty"] * op * payments[now]
        hit_stop = lo <= stop if sign == 1 else hi >= stop
        hit_target = hi >= target if sign == 1 else lo <= target
        if hit_stop:
            price = min(op, stop) if sign == 1 else max(op, stop)
            reason = "stop"
        elif hit_target:
            price, reason = target, "target"
        elif i == 25:
            price, reason = close, "session_close"
        else:
            continue
        exit_price = price * (1 - sign * SLIP)
        net = order["qty"] * (sign * (exit_price - entry) - FEE * (entry + exit_price)) + funding
        return dict(pnl=net, reason=reason, exit=now+BAR, funding=funding)
