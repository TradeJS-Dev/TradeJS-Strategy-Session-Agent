"""Replay one opening offline. Input JSON: asOf (UTC epoch ms) and closed
candles per USDT symbol, each [barStartMs, open, close, quoteTurnover].
Print a decision and its historical evidence. Never submits an order.
"""
import argparse
import datetime as dt
import json
import math
from pathlib import Path
from zoneinfo import ZoneInfo
from agent import ACTIONS, decide, market_snapshot, order

BAR = 900_000


def build_row(symbol, candles, as_of):
    if not symbol.endswith('USDT'):
        return None
    bars = sorted((b for b in candles if b[0]+BAR <= as_of), key=lambda b:b[0])[-96:]
    if len(bars) != 96 or any(b[0] != as_of-(96-i)*BAR for i,b in enumerate(bars)):
        return None
    if any(not all(math.isfinite(v) for v in b) or min(b[1:3]) <= 0 or b[3] < 0 for b in bars):
        return None
    volume = sum(b[3] for b in bars)
    if volume < 10_000_000:
        return None
    prev = bars[0][1]
    squares = 0
    for _,_,price,_ in bars:
        squares += math.log(price/prev)**2
        prev = price
    return dict(symbol=symbol, price=prev, turnover=volume, rms=math.sqrt(squares/96),
                activity=24*sum(b[3] for b in bars[-4:])/volume,
                fourHour=math.log(prev/bars[-16][1]))


def on_open(data, models, rules):
    t = data['asOf']
    instant = dt.datetime.fromtimestamp(t/1000, dt.timezone.utc)
    ny = instant.astimezone(ZoneInfo('America/New_York'))
    if t % BAR or not (instant.hour==instant.minute==0 or (ny.hour,ny.minute)==(9,30)):
        return dict(action='WAIT', reason='outside_session_open')
    name = 'Asia' if instant.hour == 0 else 'America'
    if any(row['t']+26*BAR>t for row in models[name]['history']):
        raise ValueError('The model includes outcomes unavailable at this opening')
    rows = [row for s,bars in data['candles'].items() if s in rules
            and (row:=build_row(s,bars,t)) is not None]
    snapshot = market_snapshot(rows,t)
    if not snapshot:return dict(action='SKIP',reason='insufficient_liquid_contracts')
    choice=decide(snapshot,models[name])
    if not choice:return dict(action='SKIP',reason='no_positive_adjusted_score')
    kind,sign=ACTIONS[choice['action']]
    plan=order(snapshot[kind],sign,rules[choice['symbol']])
    if not plan:return dict(action='SKIP',reason='lot_size')
    return dict(action='LONG' if sign==1 else 'SHORT',asOf=t,session=name,
                symbol=choice['symbol'],role=kind,quantity=plan['qty'],stop=plan['stop'],
                closeBy=t+26*BAR,scoreR=choice['score'],neighbors=choice['neighbors'],
                neighborMeanR=choice['meanNetR'])


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('snapshot','model','rules'):parser.add_argument(name,type=Path)
    args=parser.parse_args()
    print(json.dumps(on_open(*(json.loads(p.read_text()) for p in (args.snapshot,args.model,args.rules))),indent=2))
