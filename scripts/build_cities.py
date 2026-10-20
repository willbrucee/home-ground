"""Builds data/cities.geojson: unlabelled dots for cities over 100k people.

Source: Natural Earth 1:10m populated places (public domain).
Names are stripped out on purpose so the map can't give away answers (not even via dev tools).

Run:  python3 scripts/build_cities.py
"""
import json
import pathlib
import urllib.request

SOURCE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson"
MIN_POP = 100_000
OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "cities.geojson"


def main():
    with urllib.request.urlopen(SOURCE, timeout=120) as r:
        places = json.load(r)["features"]

    features = []
    for f in places:
        p = f["properties"]
        pop = max(p.get("pop_max") or 0, p.get("pop_min") or 0)
        if pop < MIN_POP:
            continue
        lng, lat = f["geometry"]["coordinates"]
        features.append({
            "type": "Feature",
            # Only the population is kept ("p"). Coordinates are rounded to ~100 m to keep the file small.
            "properties": {"p": int(pop)},
            "geometry": {"type": "Point", "coordinates": [round(lng, 3), round(lat, 3)]},
        })

    # Biggest first, so big cities are drawn under smaller ones and never hide them.
    features.sort(key=lambda f: -f["properties"]["p"])
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
    print(f"Wrote {len(features)} cities to {OUT}")


if __name__ == "__main__":
    main()
