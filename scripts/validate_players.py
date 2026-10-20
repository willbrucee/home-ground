"""Checks data/players.json (or any players file) for problems.

Errors (the entry is unusable and the build script drops it):
  - missing fields, wrong type/difficulty values
  - coordinates at 0,0 or outside -90..90 / -180..180
Warnings (worth a look, but kept):
  - the coordinates fall in a different country from the one named
  - the country name isn't one we recognise
  - the same name appears twice

Run:  python3 scripts/validate_players.py [path/to/players.json]
No extra packages needed. Country shapes come from scripts/ref/countries-50m.json (Natural Earth via world-atlas).
"""
import json
import math
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
COUNTRIES_FILE = ROOT / "scripts" / "ref" / "countries-50m.json"

REQUIRED = ["id", "name", "sport", "type", "city", "country", "lat", "lng", "difficulty"]

# Country names people (and Wikidata) commonly use → the name used in the map file.
ALIASES = {
    "united states": "United States of America", "usa": "United States of America", "us": "United States of America",
    "england": "United Kingdom", "scotland": "United Kingdom", "wales": "United Kingdom", "northern ireland": "United Kingdom",
    "uk": "United Kingdom", "great britain": "United Kingdom",
    "türkiye": "Turkey", "turkiye": "Turkey",
    "czech republic": "Czechia",
    "bosnia and herzegovina": "Bosnia and Herz.",
    "dominican republic": "Dominican Rep.",
    "democratic republic of the congo": "Dem. Rep. Congo", "dr congo": "Dem. Rep. Congo",
    "republic of the congo": "Congo",
    "central african republic": "Central African Rep.",
    "north macedonia": "Macedonia",
    "ivory coast": "Côte d'Ivoire", "cote d'ivoire": "Côte d'Ivoire",
    "eswatini": "eSwatini", "swaziland": "eSwatini",
    "south sudan": "S. Sudan",
    "equatorial guinea": "Eq. Guinea",
    "cape verde": "Cabo Verde",
    "antigua and barbuda": "Antigua and Barb.",
    "saint kitts and nevis": "St. Kitts and Nevis",
    "saint vincent and the grenadines": "St. Vin. and Gren.",
    "faroe islands": "Faeroe Is.",
    "solomon islands": "Solomon Is.",
    "state of palestine": "Palestine",
    "são tomé and príncipe": "São Tomé and Principe",
    "east timor": "Timor-Leste",
    "western sahara": "W. Sahara",
    "vatican city": "Vatican",
    "people's republic of china": "China",
    "kingdom of the netherlands": "Netherlands",
    "kingdom of denmark": "Denmark",
    "republic of ireland": "Ireland",
    "korea, south": "South Korea", "republic of korea": "South Korea",
    "russian federation": "Russia",
    "federated states of micronesia": "Micronesia",
    "united states virgin islands": "U.S. Virgin Is.", "us virgin islands": "U.S. Virgin Is.",
    "british virgin islands": "British Virgin Is.",
    "cayman islands": "Cayman Is.",
    "turks and caicos islands": "Turks and Caicos Is.",
    "northern mariana islands": "N. Mariana Is.",
}

NEAR_KM = 30  # coastal towns can sit just outside the simplified coastline; accept anything this close


# ── reading the TopoJSON map file ───────────────────────────────────────────
# TopoJSON stores shared borders ("arcs") once, as small integer steps. We rebuild real coordinates here.
def load_countries():
    topo = json.loads(COUNTRIES_FILE.read_text())
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def ring(indexes):
        out = []
        for i in indexes:
            pts = arcs[i] if i >= 0 else arcs[~i][::-1]  # negative index = same arc, walked backwards
            out.extend(pts if not out else pts[1:])
        return out

    countries = []
    for g in topo["objects"]["countries"]["geometries"]:
        polys = g.get("arcs", [])
        if g["type"] == "Polygon":
            polys = [polys]
        elif g["type"] != "MultiPolygon":
            continue
        rings = [[ring(r) for r in poly] for poly in polys]
        xs = [p[0] for poly in rings for r in poly for p in r]
        ys = [p[1] for poly in rings for r in poly for p in r]
        countries.append({"name": g["properties"]["name"], "polys": rings, "bbox": (min(xs), min(ys), max(xs), max(ys))})
    return countries


def point_in_ring(x, y, ring):
    # Ray casting: count how many edges a line going right from the point crosses. Odd = inside.
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def country_at(countries, lat, lng):
    for c in countries:
        x0, y0, x1, y1 = c["bbox"]
        if not (x0 <= lng <= x1 and y0 <= lat <= y1):
            continue
        for poly in c["polys"]:
            # inside the outer ring and not inside any hole
            if point_in_ring(lng, lat, poly[0]) and not any(point_in_ring(lng, lat, h) for h in poly[1:]):
                return c["name"]
    return None


def nearest_country(countries, lat, lng, max_km):
    """Closest country border within max_km (rough flat-earth maths, fine at this scale)."""
    kx = 111.32 * math.cos(math.radians(lat))  # km per degree of longitude here
    ky = 110.57                                 # km per degree of latitude
    pad = max_km / 100
    best, best_km = None, max_km
    for c in countries:
        x0, y0, x1, y1 = c["bbox"]
        if lng < x0 - pad * 3 or lng > x1 + pad * 3 or lat < y0 - pad or lat > y1 + pad:
            continue
        for poly in c["polys"]:
            for r in poly:
                for (ax, ay), (bx, by) in zip(r, r[1:]):
                    # distance from the point to segment a–b, in km
                    px, py = (lng - ax) * kx, (lat - ay) * ky
                    vx, vy = (bx - ax) * kx, (by - ay) * ky
                    t = max(0, min(1, (px * vx + py * vy) / (vx * vx + vy * vy or 1)))
                    d = math.hypot(px - t * vx, py - t * vy)
                    if d < best_km:
                        best, best_km = c["name"], d
    return best


def validate(entries):
    """Returns (errors, warnings): two lists of (index, message)."""
    countries = load_countries()
    known = {c["name"].lower(): c["name"] for c in countries}
    errors, warnings = [], []
    seen = {}

    for i, e in enumerate(entries):
        label = f"{e.get('name', '?')} ({e.get('id', 'no id')})"
        missing = [k for k in REQUIRED if e.get(k) in (None, "")]
        if missing:
            errors.append((i, f"{label}: missing {', '.join(missing)}"))
            continue
        if e["type"] not in ("athlete", "team"):
            errors.append((i, f"{label}: type must be 'athlete' or 'team', got {e['type']!r}"))
        if e["difficulty"] not in (1, 2, 3):
            errors.append((i, f"{label}: difficulty must be 1, 2 or 3"))

        lat, lng = e["lat"], e["lng"]
        if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
            errors.append((i, f"{label}: lat/lng must be numbers"))
            continue
        if abs(lat) < 0.01 and abs(lng) < 0.01:
            errors.append((i, f"{label}: coordinates are 0,0 (almost certainly missing data)"))
            continue
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            errors.append((i, f"{label}: coordinates out of range ({lat}, {lng})"))
            continue

        key = (e["name"].lower(), e["type"])
        if key in seen:
            warnings.append((i, f"{label}: same name as entry {seen[key]}"))
        seen[key] = i

        named = e["country"].strip()
        expected = ALIASES.get(named.lower()) or known.get(named.lower())
        if not expected:
            warnings.append((i, f"{label}: country {named!r} not recognised (add it to ALIASES if it's right)"))
            continue
        found = country_at(countries, lat, lng) or nearest_country(countries, lat, lng, NEAR_KM)
        if found is None:
            warnings.append((i, f"{label}: {lat}, {lng} isn't on land in any country (check the coordinates)"))
        elif found != expected:
            warnings.append((i, f"{label}: says {named} but {lat}, {lng} is in {found}"))

    return errors, warnings


def main():
    path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "players.json"
    entries = json.loads(path.read_text())
    errors, warnings = validate(entries)
    for _, msg in errors:
        print("ERROR  ", msg)
    for _, msg in warnings:
        print("WARNING", msg)
    print(f"\n{len(entries)} entries · {len(errors)} errors · {len(warnings)} warnings")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
