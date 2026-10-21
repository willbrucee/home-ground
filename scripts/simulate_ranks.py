#!/usr/bin/env python3
"""Simulates daily games for three kinds of player, to set the rank thresholds and the scoring curve.

  casual  typical miss about 2,500 km
  good    typical miss about 800 km
  expert  typical miss about 200 km, and a fair share of pins inside the city

"Typical" is the median distance from the pin to the city centre; misses are spread log-normally around it
(most a bit closer or further, a few way off). Each game is five real entries from data/players.json,
so city sizes (a pin inside the city scores in full) are as in the game.

  python3 scripts/simulate_ranks.py              # the table for the current settings
  python3 scripts/simulate_ranks.py --search     # also try other curves and thresholds
  python3 scripts/simulate_ranks.py --football   # the same on data/football-players.json, with Football's
                                                 # thresholds (FOOTBALL_* below; keep js/modes.js in step)
"""
import json
import math
import pathlib
import random
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FOOTBALL = "--football" in sys.argv
_data = json.loads((ROOT / "data" / ("football-players.json" if FOOTBALL else "players.json")).read_text())
POOL = _data["players"] if isinstance(_data, dict) else _data
GAMES = 5000
PLAYERS = {  # median miss to the city centre (km), spread (log-normal sigma), chance of a pin inside the city
    "casual": (2500, 0.75, 0.01),
    "good": (800, 0.85, 0.06),
    "expert": (200, 0.9, 0.22),
}
# A fourth player, "country": knows each player's country but not the town, and pins the middle of the
# country (data/country-labels.geojson). In Football most birthplaces are in small European countries, so
# this player gets close without knowing much; the ranks should still ask for more than that.
_labels = {f["properties"]["name"]: f["geometry"]["coordinates"]
           for f in json.loads((ROOT / "data" / "country-labels.geojson").read_text())["features"]}
_alias = {}
for _f in json.loads((ROOT / "data" / "countries.geojson").read_text())["features"]:
    for _k in [_f["properties"]["name"].lower(), *_f["properties"]["aliases"]]:
        _alias[_k] = _f["properties"]["name"]
_SHORT = {"Bosnia and Herz.": "Bosnia and Herzegovina", "United States of America": "United States", "Côte d'Ivoire": "Ivory Coast",
          "Dem. Rep. Congo": "DR Congo", "Dominican Rep.": "Dominican Republic"}


def km_between(lat1, lng1, lat2, lng2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def country_miss(e):
    """How far (km, to the edge of the town) a pin in the middle of the entry's country lands."""
    name = _alias.get((e.get("birth_country") or e.get("country") or "").lower())
    point = _labels.get(_SHORT.get(name, name)) or _labels.get(name)
    if not point:
        return 2500
    return max(0, km_between(e["lat"], e["lng"], point[1], point[0]) - (e.get("radius_km") or 8))


RANKS = ["Wooden spoon", "Reserve", "Starter", "All-star", "Captain", "Hall of Fame"]

# The settings in js/game.js and js/tiers.js (keep them in step).
CURVE = {"full": 25, "scale": 4400, "power": 0.6}
THRESHOLDS = [0, 1500, 2600, 3400, 4200, 4800]
TIER_KM = [25, 150, 500, 1200, 2500, 5000]  # Hole in one … Air ball; anything further is Own goal
TIER_NAMES = ["Hole in one", "Top corner", "Slam dunk", "On the board", "Off the pace", "Air ball", "Own goal"]
# Football mode's own settings (js/modes.js): the same until calibrated.
FOOTBALL_CURVE = dict(CURVE)
FOOTBALL_THRESHOLDS = list(THRESHOLDS)
FOOTBALL_TIER_KM = list(TIER_KM)
if FOOTBALL:
    CURVE, THRESHOLDS, TIER_KM = FOOTBALL_CURVE, FOOTBALL_THRESHOLDS, FOOTBALL_TIER_KM


def points(km, curve):
    """Points for a pin `km` outside the city's edge."""
    if km <= curve["full"]:
        return 1000
    return round(1000 * math.exp(-((km - curve["full"]) / curve["scale"]) ** curve["power"]))


def tier_of(km, tier_km):
    return next((i for i, m in enumerate(tier_km) if km < m), len(tier_km))


def play(kind, curve, rng, tiers=None, tier_km=None):
    total = 0
    if kind == "country":
        for e in rng.sample(POOL, 5):
            km = country_miss(e)
            total += points(km, curve)
            if tiers is not None:
                tiers[tier_of(km, tier_km or TIER_KM)] += 1
        return total
    median, sigma, inside = PLAYERS[kind]
    for e in rng.sample(POOL, 5):
        radius = e.get("radius_km") or 8
        if rng.random() < inside:
            km = 0
        else:
            raw = median * math.exp(rng.gauss(0, sigma))
            km = max(0, raw - radius)
        total += points(km, curve)
        if tiers is not None:
            tiers[tier_of(km, tier_km or TIER_KM)] += 1
    return total


def table(curve, thresholds, seed=1, tier_km=None, tiers_out=None):
    rng = random.Random(seed)
    out = {}
    for kind in [*PLAYERS, "country"]:
        counts = [0] * len(RANKS)
        tiers = [0] * len(TIER_NAMES)
        for _ in range(GAMES):
            t = play(kind, curve, rng, tiers, tier_km)
            counts[max(i for i, m in enumerate(thresholds) if t >= m)] += 1
        out[kind] = [c / GAMES for c in counts]
        if tiers_out is not None:
            tiers_out[kind] = [c / (GAMES * 5) for c in tiers]
    return out


def show(curve, thresholds, tier_km=None):
    tiers = {}
    res = table(curve, thresholds, tier_km=tier_km or TIER_KM, tiers_out=tiers)
    print(f"pool: {'football-players.json' if FOOTBALL else 'players.json'} ({len(POOL)} entries), {GAMES:,} games per player")
    print(f"curve: full marks within {curve['full']} km, then 1000 × exp(−(km/{curve['scale']})^{curve['power']})")
    print("thresholds: " + ", ".join(f"{n} {m:,}+" for n, m in zip(RANKS, thresholds)))
    print(f"{'':8}" + "".join(f"{n:>14}" for n in RANKS))
    for kind, shares in res.items():
        print(f"{kind:8}" + "".join(f"{s:>14.1%}" for s in shares))
    print("tiers (share of rounds): " + ", ".join(f"{n} <{m:,} km" for n, m in zip(TIER_NAMES, tier_km or TIER_KM)))
    print(f"{'':8}" + "".join(f"{n:>14}" for n in TIER_NAMES))
    for kind, shares in tiers.items():
        print(f"{kind:8}" + "".join(f"{s:>14.1%}" for s in shares))
    return res


def fits(res):
    """How well a result meets the targets (lower is better)."""
    c, g, x = res["casual"], res["good"], res["expert"]
    miss = 0.0
    miss += max(0, 0.7 - (c[1] + c[2])) * 3           # casual mostly Reserve/Starter
    miss += max(0, 0.6 - (g[3] + g[4])) * 3           # good mostly All-star/Captain
    miss += abs(x[5] - 0.04) * 10                     # Hall of Fame: a few per cent of expert games
    miss += max(0, g[5] - 0.005) * 10                 # and almost never for a good player
    if "country" in res:                              # knowing only the country isn't Captain form
        k = res["country"]
        miss += max(0, (k[4] + k[5]) - 0.2) * 5
    return miss


if __name__ == "__main__":
    show(CURVE, THRESHOLDS)
    if "--search" in sys.argv and FOOTBALL:
        # Football: search the curve's scale and power and every threshold (in steps of 100)
        best = None
        for scale in range(1200, 4401, 400):
            for power in (0.6, 0.7, 0.8):
                curve = dict(CURVE, scale=scale, power=power)
                for res_ in range(1000, 2201, 200):
                    for st in range(res_ + 800, res_ + 1601, 200):
                        for al in range(st + 600, st + 1201, 200):
                            for cap in range(al + 500, 4601, 200):
                                for hof in (4600, 4700, 4800):
                                    if hof <= cap:
                                        continue
                                    th = [0, res_, st, al, cap, hof]
                                    GAMES = 600  # a quick pass; the winner is re-run at full size below
                                    f = fits(table(curve, th))
                                    if best is None or f < best[0]:
                                        best = (f, curve, th)
        GAMES = 5000
        print("\nbest found:")
        show(best[1], best[2])
    elif "--search" in sys.argv:
        best = None
        for scale in range(1400, 4001, 200):
            for power in (0.6, 0.65, 0.7, 0.75, 0.8, 0.9, 1.0):
                curve = dict(CURVE, scale=scale, power=power)
                for hof in (4500, 4550, 4600, 4650, 4700, 4750):
                    th = THRESHOLDS[:5] + [hof]
                    res = table(curve, th)
                    f = fits(res)
                    if best is None or f < best[0]:
                        best = (f, curve, th)
        print("\nbest found:")
        show(best[1], best[2])
