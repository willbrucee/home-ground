#!/usr/bin/env python3
"""Builds data/places.tsv from GeoNames cities15000 (every town of 15,000+ people; CC BY 4.0, geonames.org).
The Full time screen uses it to say where a pin landed ("near Lyon"). One line per town:
name, ISO country code, latitude, longitude (2 decimals, about 1 km).

Usage: python3 scripts/build_places.py path/to/cities15000.txt
(download and unzip https://download.geonames.org/export/dump/cities15000.zip first)
"""
import pathlib
import sys

OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "places.tsv"

rows = []
for line in open(sys.argv[1], encoding="utf-8"):
    f = line.rstrip("\n").split("\t")
    name, lat, lng, fclass, fcode, cc, pop = f[1], float(f[4]), float(f[5]), f[6], f[7], f[8], int(f[14] or 0)
    if fclass != "P" or fcode in ("PPLX", "PPLH", "PPLQ", "PPLW"):  # skip city districts and abandoned places
        continue
    rows.append((pop, name, cc, lat, lng))
rows.sort(reverse=True)  # biggest first, so the nearest-place search can prefer them on ties
OUT.write_text("# GeoNames cities15000, CC BY 4.0, https://www.geonames.org\n" +
               "".join(f"{n}\t{cc}\t{lat:.2f}\t{lng:.2f}\n" for _, n, cc, lat, lng in rows), encoding="utf-8")
print(f"{len(rows)} places → {OUT} ({OUT.stat().st_size // 1024} KB)")
