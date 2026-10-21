#!/usr/bin/env python3
"""Builds data/country-labels.geojson: one point per country, where its name is written on the map.

The point is the "pole of inaccessibility" of the country's largest piece of land: the spot furthest
from any border (so "Chile" sits in Chile, and "Croatia" doesn't land in Bosnia, as a plain centre
point can). Each point carries the country's name and its area, so bigger countries get bigger
labels and win when two names would overlap.

Run after build_countries.py:  python3 scripts/build_country_labels.py
"""
import heapq
import json
import math
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "countries.geojson"
OUT = ROOT / "data" / "country-labels.geojson"

# The map shapes use short forms ("Bosnia and Herz."); written on the map, the full names read better.
FULL = {"Bosnia and Herz.": "Bosnia and Herzegovina", "Central African Rep.": "Central African Republic",
        "Dem. Rep. Congo": "DR Congo", "Dominican Rep.": "Dominican Republic", "Eq. Guinea": "Equatorial Guinea",
        "S. Sudan": "South Sudan", "Solomon Is.": "Solomon Islands", "Falkland Is.": "Falkland Islands",
        "Fr. S. Antarctic Lands": "French Southern Lands", "N. Cyprus": "Northern Cyprus", "W. Sahara": "Western Sahara",
        "Fr. Polynesia": "French Polynesia", "Faeroe Is.": "Faroe Islands", "Côte d'Ivoire": "Ivory Coast",
        "United States of America": "United States"}


def ring_area(ring):
    """Area in square degrees, scaled by latitude (good enough to compare countries)."""
    a = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        a += (x1 * y2 - x2 * y1)
    lat = sum(p[1] for p in ring) / len(ring)
    return abs(a) / 2 * math.cos(math.radians(lat))


def point_to_ring(x, y, ring):
    """Signed distance from a point to the polygon (positive inside), in degrees."""
    inside, best = False, float("inf")
    for (ax, ay), (bx, by) in zip(ring, ring[1:]):
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / ((by - ay) or 1e-12) + ax:
            inside = not inside
        dx, dy = bx - ax, by - ay
        t = max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / ((dx * dx + dy * dy) or 1e-12)))
        best = min(best, math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
    return best if inside else -best


def polylabel(poly, precision=0.05):
    """The point inside the polygon furthest from its edge (Mapbox's polylabel, without holes)."""
    ring = poly[0]
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    size = min(x1 - x0, y1 - y0)
    if size == 0:
        return xs[0], ys[0]
    h = size / 2
    cells = []
    x = x0
    while x < x1:
        y = y0
        while y < y1:
            d = point_to_ring(x + h, y + h, ring)
            heapq.heappush(cells, (-(d + h * math.sqrt(2)), d, x + h, y + h, h))
            y += size
        x += size
    cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
    best = (point_to_ring(cx, cy, ring), cx, cy)
    while cells:
        _, d, x, y, h = heapq.heappop(cells)
        if d > best[0]:
            best = (d, x, y)
        if d + h * math.sqrt(2) - best[0] <= precision:
            continue
        h /= 2
        for dx in (-h, h):
            for dy in (-h, h):
                nd = point_to_ring(x + dx, y + dy, ring)
                heapq.heappush(cells, (-(nd + h * math.sqrt(2)), nd, x + dx, y + dy, h))
    return best[1], best[2]


def main():
    features = []
    for f in json.loads(SRC.read_text())["features"]:
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        main_poly = max(polys, key=lambda p: ring_area(p[0]))
        x, y = polylabel(main_poly)
        name = f["properties"]["name"]
        area = sum(ring_area(p[0]) for p in polys)
        features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(x, 3), round(y, 3)]},
                         "properties": {"name": FULL.get(name, name), "area": round(area, 2)}})
    features.sort(key=lambda f: -f["properties"]["area"])
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"{len(features)} country labels → {OUT}")


if __name__ == "__main__":
    main()
