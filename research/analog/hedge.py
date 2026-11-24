"""Size and manage a two-contract, approximately dollar-neutral session position."""
import math


def pair_plan(symbol, sign, asset_prices, hedge_prices, asset_rule, hedge_rule, fee, slip):
    if len(asset_prices)!=96 or len(hedge_prices)!=96:
        return None
    changes=[math.log(a/b)-math.log(c/e) for a,b,c,e in
             zip(asset_prices[1:],asset_prices,hedge_prices[1:],hedge_prices)]
    rms=math.sqrt(sum(x*x for x in changes)/len(changes))
    shock=max(0.01,min(0.06,1.25*math.sqrt(26)*rms))
    budget=10/(shock+4*(fee+slip))
    def leg(price,rule,limit):
        step=float(rule['qtyStep'])
        qty=math.floor(min(limit/price,float(rule['maxMktOrderQty']))/step)*step
        return qty if qty>=float(rule['minOrderQty']) and qty*price>=float(rule['minNotionalValue']) else 0
    a,b=asset_prices[-1],hedge_prices[-1]
    limit=min(budget,a*float(asset_rule['maxMktOrderQty']),b*float(hedge_rule['maxMktOrderQty']))
    # Match the other leg to the realizable notional of the coarser lot.
    if a*float(asset_rule['qtyStep']) >= b*float(hedge_rule['qtyStep']):
        q=leg(a,asset_rule,limit);h=leg(b,hedge_rule,q*a)
    else:
        h=leg(b,hedge_rule,limit);q=leg(a,asset_rule,h*b)
    if not q or not h or abs(q*asset_prices[-1]-h*hedge_prices[-1])>0.02*max(q*a,h*b):
        return None
    return dict(symbol=symbol,sign=sign,assetQty=q,hedgeQty=h,
                hedgeSymbol='ETHUSDT' if symbol=='BTCUSDT' else 'BTCUSDT')


def liquidation(plan,opens,marks,funding,fee,slip):
    net=funding
    for i,qty in enumerate((plan['assetQty'],plan['hedgeQty'])):
        sign=plan['sign']*(1 if i==0 else -1)
        entry=opens[i]*(1+sign*slip);exit_px=marks[i]*(1-sign*slip)
        net+=qty*(sign*(exit_px-entry)-fee*(entry+exit_px))
    return net
