"""One market-wide decision from the closed M15 history at a session open."""
import hashlib
import math
from statistics import median, pstdev, stdev

ACTIONS = (('leader', 1), ('leader', -1), ('laggard', 1), ('laggard', -1))
RISK = 10
FEE = 0.00055
SLIP = 0.0002


def market_snapshot(rows, timestamp):
    liquid = sorted((r for r in rows if r['turnover'] >= 10_000_000),
                    key=lambda r: (-r['turnover'], r['symbol']))[:24]
    if len(liquid) < 12:
        return None
    market_return = median(r['fourHour'] for r in liquid)
    def relative(r):
        return (r['fourHour'] - market_return) / max(0.0001, 4 * r['rms'])
    ranked = sorted(liquid, key=lambda r: (relative(r), r['symbol']))
    context = [
        median(r['fourHour'] / max(0.0001, 4 * r['rms']) for r in liquid),
        sum(r['fourHour'] > 0 for r in liquid) / len(liquid),
        pstdev(relative(r) for r in liquid),
        median(r['activity'] for r in liquid),
        median(r['rms'] for r in liquid),
    ]
    seed = hashlib.sha256(str(timestamp).encode()).digest()
    reference = liquid[int.from_bytes(seed[:8], 'big') % len(liquid)]
    return dict(context=context, leader=ranked[-1], laggard=ranked[0], reference=reference)


def fit(history):
    scales = [max(stdev(column), 1e-8) for column in zip(*(r['context'] for r in history))]
    return dict(scales=scales, history=history)


def decide(snapshot, model):
    if not snapshot:
        return None
    def distance(row):
        return sum(((a-b)/s)**2 for a,b,s in zip(snapshot['context'],row['context'],model['scales']))
    neighbors = sorted(model['history'], key=distance)[:48]
    best = None
    for i,(kind,sign) in enumerate(ACTIONS):
        net = [r['netR'][i] for r in neighbors if r['netR'][i] is not None]
        if len(net) < 32:
            continue
        score = sum(net)/(len(net)+16) - stdev(net)/math.sqrt(len(net))
        if score > 0 and (best is None or score > best['score']):
            best = dict(symbol=snapshot[kind]['symbol'],sign=sign,action=i,score=score,
                        neighbors=len(net),meanNetR=sum(net)/len(net))
    return best


def order(row, sign, rule):
    quote = row['price']
    entry = quote * (1+sign*SLIP)
    fraction = max(0.01, min(0.06, 1.25*math.sqrt(26)*row['rms']))
    stop = quote*(1-sign*fraction)
    stop_fill = stop*(1-sign*SLIP)
    unit = sign*(entry-stop_fill) + FEE*(entry+stop_fill)
    step = float(rule['qtyStep'])
    qty = math.floor(min(RISK/unit, float(rule['maxMktOrderQty']))/step)*step
    if qty < float(rule['minOrderQty']) or qty*entry < float(rule['minNotionalValue']):
        return None
    return dict(symbol=row['symbol'],qty=qty,stop=stop,sign=sign)
