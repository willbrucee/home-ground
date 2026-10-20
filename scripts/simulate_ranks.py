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
"""
import json
import math
import pathlib
import random
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
POOL = json.loads((ROOT / "data" / "players.json").read_text())
GAMES = 5000
PLAYERS = {  # median miss to the city centre (km), spread (log-normal sigma), chance of a pin inside the city
    "casual": (2500, 0.75, 0.01),
    "good": (800, 0.85, 0.06),
    "expert": (200, 0.9, 0.22),
}
RANKS = ["Wooden spoon", "Reserve", "Starter", "All-star", "Captain", "Hall of Fame"]

# The settings in js/game.js and js/tiers.js (keep them in step).
CURVE = {"full": 25, "scale": 4400, "power": 0.6}
THRESHOLDS = [0, 1500, 2600, 3400, 4200, 4800]


def points(km, curve):
    """Points for a pin `km` outside the city's edge."""
    if km <= curve["full"]:
        return 1000
    return round(1000 * math.exp(-((km - curve["full"]) / curve["scale"]) ** curve["power"]))


def play(kind, curve, rng):
    median, sigma, inside = PLAYERS[kind]
    total = 0
    for e in rng.sample(POOL, 5):
        radius = e.get("radius_km") or 8
        if rng.random() < inside:
            km = 0
        else:
            raw = median * math.exp(rng.gauss(0, sigma))
            km = max(0, raw - radius)
        total += points(km, curve)
    return total


def table(curve, thresholds, seed=1):
    rng = random.Random(seed)
    out = {}
    for kind in PLAYERS:
        counts = [0] * len(RANKS)
        for _ in range(GAMES):
            t = play(kind, curve, rng)
            counts[max(i for i, m in enumerate(thresholds) if t >= m)] += 1
        out[kind] = [c / GAMES for c in counts]
    return out


def show(curve, thresholds):
    res = table(curve, thresholds)
    print(f"curve: full marks within {curve['full']} km, then 1000 × exp(−(km/{curve['scale']})^{curve['power']})")
    print("thresholds: " + ", ".join(f"{n} {m:,}+" for n, m in zip(RANKS, thresholds)))
    print(f"{'':8}" + "".join(f"{n:>14}" for n in RANKS))
    for kind, shares in res.items():
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
    return miss


if __name__ == "__main__":
    show(CURVE, THRESHOLDS)
    if "--search" in sys.argv:
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
