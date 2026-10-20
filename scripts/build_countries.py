"""Builds data/countries.geojson: country shapes for the "Reveal country" highlight
(and the plain land map shown if satellite imagery can't load).

Source: Natural Earth 1:50m admin-0 countries (public domain), via world-atlas, in scripts/ref/.
Each country gets:
  name     the Natural Earth name, e.g. "United States of America"
  aliases  other names our player data may use, e.g. ["united states", "usa"] (from validate_players.ALIASES)
  fit      [west, south, east, north] of its biggest piece of land, used to frame the camera
           (so France frames mainland France, not France + French Guiana)

Then it checks that every entry in data/players.json resolves to a shape, and lists any that don't.

Run:  python3 scripts/build_countries.py
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from validate_players import ALIASES, load_countries  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "countries.geojson"
PLAYERS = ROOT / "data" / "players.json"


def ring_area(ring):
    # Shoelace formula. Only used to compare sizes, so flat degrees are fine.
    return abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ring, ring[1:]))) / 2


def rounded(ring):
    # 2 decimals ≈ 1 km: plenty for an outline, and keeps the file small.
    out = []
    for x, y in ring:
        p = [round(x, 2), round(y, 2)]
        if not out or p != out[-1]:
            out.append(p)
    return out


def split_at_antimeridian(poly):
    """Russia's far east and Fiji come with rings that hop between +180° and -180° (a seam left over from
    the map data). Drawn on a flat map, each hop is a stripe right across the world. Cut the ring at every
    hop and close each side's part into its own polygon."""
    outer = poly[0]
    if not any(abs(a[0] - b[0]) > 180 for a, b in zip(outer, outer[1:])):
        return [poly]
    runs, run = [], [outer[0]]
    for a, b in zip(outer, outer[1:]):
        if abs(a[0] - b[0]) > 180:
            runs.append(run)
            run = []
        run.append(b)
    runs.append(run)
    if len(runs) > 1 and (runs[0][0][0] > 0) == (runs[-1][-1][0] > 0):
        runs[0] = runs.pop() + runs[0]  # the ring's start and end are on the same side: one run
    sides = {}
    for r in runs:
        side = sum(x for x, _ in r) > 0
        sides.setdefault(side, []).extend(r)
    out = []
    for pts in sides.values():
        if len(pts) >= 3:
            out.append([pts + [pts[0]]])
    return out


def main():
    aliases = {}
    for alias, target in ALIASES.items():
        aliases.setdefault(target, []).append(alias)

    features = []
    for c in load_countries():
        polys = [[rounded(r) for r in poly] for poly in c["polys"]]
        polys = [p for p in polys if len(p[0]) >= 4]
        polys = [piece for poly in polys for piece in split_at_antimeridian(poly)]
        biggest = max(c["polys"], key=lambda poly: ring_area(poly[0]))[0]
        xs, ys = [x for x, _ in biggest], [y for _, y in biggest]
        features.append({
            "type": "Feature",
            "properties": {
                "name": c["name"],
                "aliases": sorted(aliases.get(c["name"], [])),
                "fit": [round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)],
            },
            "geometry": {"type": "MultiPolygon", "coordinates": polys},
        })
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, separators=(",", ":")))
    print(f"Wrote {len(features)} countries to {OUT} ({OUT.stat().st_size // 1024} KB)")

    # Every player's country must match a shape, or "Reveal country" would have nothing to show.
    known = {f["properties"]["name"].lower() for f in features} | {a for f in features for a in f["properties"]["aliases"]}
    players = json.loads(PLAYERS.read_text())
    missing = [p for p in players if p["country"].strip().lower() not in known]
    if missing:
        print(f"\n{len(missing)} entries have a country with no shape (add an alias in validate_players.py):")
        for p in missing:
            print(f"   {p['name']} ({p['id']}): {p['country']!r}")
    else:
        print(f"All {len(players)} entries resolve to a country shape.")


if __name__ == "__main__":
    main()
