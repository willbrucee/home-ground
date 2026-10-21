#!/usr/bin/env python3
"""Builds data/football-players.json: footballers only (association football, men's and women's), for
Home Ground's Football mode. Everything comes from Wikidata and Wikipedia; nothing is typed in by hand
except the seed names below, which only make sure the obvious legends are matched and kept.

Two lists:

  LEGENDS: the 500 best footballers of all time, ranked by
      legend score = 50% fame + 50% achievement   (each as a percentile among all candidates, 0..1)
    fame         = sqrt(language editions / 100 × English Wikipedia views in the last 60 days / 300,000)
                   (the same fame formula as the main game: you need both reach and current interest)
    achievement  = log(1 + points), points from Wikidata only:
                   Ballon d'Or / FIFA World Player / The Best (and the women's versions) 30 each,
                   other major individual awards (Golden Ball, Golden Shoe, continental player of the year…) 8,
                   World Cup won 25, continental cup (Euro, Copa América, AFCON, Asian Cup, Gold Cup) 12,
                   Champions League / European Cup / Libertadores and other continental club cups 10,
                   top-league title 3, other league titles 1, any other football award 1 (up to 10),
                   senior caps 0.1 each (up to 20) and international goals 0.2 each (up to 15).
    A title counts when the player took part in that season or tournament (P1344) and its winner (P1346)
    is a team they were with at the time (P54 with dates).
    The seed legends are always kept (they take the places of the lowest-ranked non-seeds).

  CURRENT: the 200 most famous active players (no end of career, not deceased, at a club now), ranked by
    the fame formula above. A player in both lists is kept once, as a legend, with "current": true.

Women's players are ranked by exactly the same formulas, with no quota.

Birthplaces: place of birth (P19) and its coordinates. The scoring radius covers the whole town (from its
Wikidata area, else its population), at least 8 km and at most 25 km. A tiny village next to a big city
also counts the city ("metro"), and the radius grows to take the city in. Entries whose birthplace is
missing, has several values, sits at 0,0, lies outside any country, or falls in a different country
from the one Wikidata gives are listed in data/football-flags.csv and left out until you decide.

Your fixes go in data/football-overrides.json:
  "exclude": [qid, ...]                    never use these
  "include": [qid, ...]                    always consider these (as legends)
  "fix_birthplace": { qid: { "birth_place": "...", "birth_country": "...", "lat": 0, "lng": 0, "radius_km": 10 } }

Usage:
  python3 scripts/build_football.py            uses the cache in scripts/.cache
  python3 scripts/build_football.py --fresh    asks Wikidata again (do this each season for the current list)
"""
import csv
import datetime
import json
import math
import random
import re
import sys
import time

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from build_players import (ROOT, CACHE, COUNTRY_NAMES, QueryFailed, sparql, cached, batched, in_batches, values, val,  # noqa: E402
                           qid, parse_point, file_name, is_qid_label, km_between, city_sizes, extras, pageviews,
                           achievements, resolve_seeds)

OUT = ROOT / "data" / "football-players.json"
FLAGS = ROOT / "data" / "football-flags.csv"
OVERRIDES = ROOT / "data" / "football-overrides.json"
REVIEW = {"legend": ROOT / "data" / "football-review-legends.csv", "current": ROOT / "data" / "football-review-current.csv"}
COUNTRIES = ROOT / "data" / "countries.geojson"
PLACES = ROOT / "data" / "places.tsv"

FOOTBALLER = "Q937857"  # association football player
FEMALE = "Q6581072"
N_LEGENDS, N_CURRENT = 500, 200
MIN_RADIUS, MAX_RADIUS = 8, 25
VILLAGE_POP = 10_000      # below this a birthplace is a village (if Wikidata knows its population)
BIG_CITY_RANK = 4500      # places.tsv is sorted biggest first: the top 4,500 are roughly 100,000 people or more
WELL_KNOWN_RANK = 1000    # roughly 500,000 people or more: "near" city for the result card

# Household-name legends, names only. Each is matched on Wikidata (one footballer by that name) and kept.
SEEDS = [
    "Pelé", "Diego Maradona", "Lionel Messi", "Cristiano Ronaldo", "Johan Cruyff", "Alfredo Di Stéfano",
    "Franz Beckenbauer", "Zinedine Zidane", "Ronaldo Nazário", "Ronaldinho", "Michel Platini", "Marco van Basten",
    "Ferenc Puskás", "Eusébio", "George Best", "Bobby Charlton", "Garrincha", "Gerd Müller", "Lev Yashin",
    "Paolo Maldini", "Franco Baresi", "Roberto Baggio", "Thierry Henry", "Kaká", "Andrés Iniesta", "Xavi",
    "Zico", "Sócrates", "Romário", "Rivaldo", "Lothar Matthäus", "Karl-Heinz Rummenigge", "Ruud Gullit",
    "Frank Rijkaard", "Dennis Bergkamp", "Gianluigi Buffon", "Iker Casillas", "Sergio Ramos", "Andrea Pirlo",
    "Francesco Totti", "Alessandro Del Piero", "Fabio Cannavaro", "Luís Figo", "Raúl González", "David Beckham",
    "Steven Gerrard", "Frank Lampard", "Wayne Rooney", "Ryan Giggs", "Paul Scholes", "Alan Shearer",
    "Bobby Moore", "Gary Lineker", "Kevin Keegan", "Kenny Dalglish", "Ian Rush", "Gordon Banks",
    "Peter Schmeichel", "Michael Laudrup", "Hristo Stoichkov", "George Weah", "Samuel Eto'o", "Didier Drogba",
    "Yaya Touré", "Roger Milla", "Abedi Pele", "Jay-Jay Okocha", "Mohamed Salah", "Hidetoshi Nakata",
    "Park Ji-sung", "Son Heung-min", "Zlatan Ibrahimović", "Andriy Shevchenko", "Pavel Nedvěd", "Luka Modrić",
    "Davor Šuker", "Gheorghe Hagi", "Oleg Blokhin", "Kylian Mbappé", "Erling Haaland", "Neymar",
    "Robert Lewandowski", "Karim Benzema", "Luis Suárez", "Mario Kempes", "Gabriel Batistuta", "Daniel Passarella",
    "Javier Zanetti", "Juan Román Riquelme", "Enzo Francescoli", "Teófilo Cubillas", "Carlos Valderrama",
    "Elías Figueroa", "Hugo Sánchez", "Cafu", "Roberto Carlos", "Carlos Alberto Torres", "Jairzinho", "Rivelino",
    "Didi", "Nílton Santos", "Sepp Maier", "Uwe Seeler", "Fritz Walter", "Miroslav Klose", "Philipp Lahm",
    "Manuel Neuer", "Thomas Müller", "Toni Kroos", "Bastian Schweinsteiger", "Oliver Kahn", "Jürgen Klinsmann",
    "Dino Zoff", "Giuseppe Meazza", "Gianni Rivera", "Paolo Rossi", "Giacinto Facchetti", "Luigi Riva",
    "Raymond Kopa", "Just Fontaine", "Jean-Pierre Papin", "Eric Cantona", "Patrick Vieira", "Lilian Thuram",
    "Antoine Griezmann", "Kevin De Bruyne", "Eden Hazard", "Arjen Robben", "Wesley Sneijder", "Clarence Seedorf",
    "Edwin van der Sar", "Ruud van Nistelrooy", "Robin van Persie", "Virgil van Dijk", "Johan Neeskens",
    "Rinus Michels", "Josef Bican", "Ernst Happel", "Hans Krankl", "Ferenc Bene", "Sándor Kocsis",
    "Kazimierz Deyna", "Zbigniew Boniek", "Grzegorz Lato", "Dragan Džajić", "Dejan Savićević", "Siniša Mihajlović",
    "Ali Daei", "Majed Abdullah", "Tim Cahill", "Landon Donovan", "Christian Pulisic", "Marta", "Mia Hamm",
    "Abby Wambach", "Alex Morgan", "Megan Rapinoe", "Birgit Prinz", "Sun Wen", "Christine Sinclair",
    "Ada Hegerberg", "Alexia Putellas", "Aitana Bonmatí", "Sam Kerr", "Homare Sawa", "Kristine Lilly",
    "Michelle Akers", "Formiga", "Carli Lloyd", "Lucy Bronze", "Vivianne Miedema", "Nadine Angerer",
]

# Titles and awards, by the competition's (or award's) English label. See the formula above.
TOP_INDIVIDUAL = re.compile(r"^(ballon d'or|fifa ballon d'or|ballon d'or féminin|fifa world player of the year|"
                            r"the best fifa (men's|women's) player|fifa women's world player of the year)$", re.I)
MAJOR_INDIVIDUAL = re.compile(r"golden ball|golden shoe|golden boot|player of the year|footballer of the year|"
                              r"kopa trophy|yashin trophy|golden boy|pichichi|capocannoniere|torjägerkanone|"
                              r"world cup all-star|fifa fifpro world 11|ballon d'or dream team", re.I)
WORLD_CUP = re.compile(r"^fifa (women's )?world cup$", re.I)
CONTINENTAL = re.compile(r"uefa (women's )?european championship|uefa euro|uefa women's euro|copa am[eé]rica|"
                         r"africa(n)? cup of nations|afc (women's )?asian cup|concacaf gold cup|ofc nations cup|"
                         r"south american championship", re.I)
CLUB_CONTINENTAL = re.compile(r"champions league|european cup|copa libertadores|uefa women's cup|"
                              r"african cup of champions clubs|asian club championship", re.I)
TOP_LEAGUE = re.compile(r"^(premier league|football league first division|la liga|serie a|bundesliga|ligue 1|"
                        r"french division 1|eredivisie|primeira liga|campeonato brasileiro série a|"
                        r"argentine primera división|scottish premiership|scottish football league|"
                        r"women's super league|fa women's super league|national women's soccer league|"
                        r"division 1 féminine|frauen-bundesliga|liga f|primera división femenina|liga mx|"
                        r"major league soccer|süper lig|russian premier league|belgian pro league|"
                        r"belgian first division)$", re.I)
LEAGUE = re.compile(r"liga|league|division|bundesliga|serie|championship|eredivisie|ligue|superliga|"
                    r"premiership|primera|allsvenskan|eliteserien|super lig", re.I)
FOOTBALLISH = re.compile(r"football|soccer|fifa|uefa|ballon|golden (ball|shoe|boot|boy)|pichichi|capocannoniere|"
                         r"kopa|yashin|torjäger|conmebol|concacaf|caf |afc ", re.I)
NATIONAL = re.compile(r"national", re.I)
FOOTBALL_DESC = re.compile(r"football|soccer|goalkeeper", re.I)
YOUTH = re.compile(r"under-\d+|u-?\d\d|youth|olympic|amateur|\bb\b", re.I)


# ── Stage 1: who might be on the lists ─────────────────────────────────────────
def candidates(fresh):
    """[[qid, sitelinks], ...]: the most-linked footballers, plus the most-linked women (asked separately
    so they aren't crowded out of the query's limit; they're still ranked by the same formula)."""
    def ask(extra, floor, limit):
        return lambda: [[qid(val(r, "p")), int(val(r, "sl"))] for r in sparql(f"""SELECT ?p ?sl WHERE {{
          ?p wdt:P106 wd:{FOOTBALLER} ; wikibase:sitelinks ?sl . {extra}
          FILTER(?sl >= {floor})
        }} ORDER BY DESC(?sl) LIMIT {limit}""")]
    try:
        everyone = cached("fb-cands", ask("", 35, 4000), fresh)
    except QueryFailed:  # the big list sometimes times out; the main game's cached list is a fine stand-in
        print("   the full list timed out; using the cached footballer list instead")
        everyone = [[e["id"][3:], e["_sitelinks"]] for e in json.loads((CACHE / f"athletes-{FOOTBALLER}.json").read_text())
                    if e["_sitelinks"] >= 35]
    women = cached("fb-cands-women", ask(f"?p wdt:P21 wd:{FEMALE} .", 15, 800), fresh)
    seen, out = set(), []
    for q, sl in everyone + women:
        if q not in seen:
            seen.add(q); out.append([q, sl])
    return out


# ── Stage 2: details ───────────────────────────────────────────────────────────
def details(ids):
    """Birthplace(s) with coordinates and country, sex, dates, end of career and picture, per player."""
    out = {}
    for batch in in_batches(ids, 60):
        rows = sparql(f"""SELECT ?p ?pLabel ?sl ?sex ?born ?died ?ended ?place ?placeLabel ?coord ?countryLabel ?img WHERE {{
          VALUES ?p {{ {values(batch)} }}
          ?p wikibase:sitelinks ?sl .
          OPTIONAL {{ ?p wdt:P21 ?sex . }}
          OPTIONAL {{ ?p wdt:P569 ?born . }}
          OPTIONAL {{ ?p wdt:P570 ?died . }}
          OPTIONAL {{ ?p wdt:P2032 ?ended . }}   # end of career ("work period end")
          OPTIONAL {{ ?p wdt:P19 ?place . OPTIONAL {{ ?place wdt:P625 ?coord . }} OPTIONAL {{ ?place wdt:P17 ?country . }} }}
          OPTIONAL {{ ?p wdt:P18 ?img . }}
          SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
        }}""")
        for r in rows:
            q = qid(val(r, "p"))
            d = out.setdefault(q, {"name": val(r, "pLabel"), "sl": int(val(r, "sl")), "female": False, "born": None,
                                   "died": False, "ended": False, "places": {}, "file": None})
            d["female"] |= qid(val(r, "sex")) == FEMALE
            d["born"] = d["born"] or (val(r, "born") or "")[:10] or None
            d["died"] |= bool(val(r, "died"))
            d["ended"] |= bool(val(r, "ended"))
            d["file"] = d["file"] or file_name(val(r, "img"))
            if val(r, "place"):
                p = d["places"].setdefault(qid(val(r, "place")), {"label": val(r, "placeLabel"), "coords": set(), "countries": set()})
                if val(r, "coord"):
                    p["coords"].add(parse_point(val(r, "coord")))
                if val(r, "countryLabel"):
                    p["countries"].add(COUNTRY_NAMES.get(val(r, "countryLabel"), val(r, "countryLabel")))
        time.sleep(1)
    # sets don't survive the JSON cache
    for d in out.values():
        for p in d["places"].values():
            p["coords"], p["countries"] = sorted(p["coords"]), sorted(p["countries"])
    return out


def profile(ids):
    """Positions (P413) and citizenships (P27), as English labels."""
    out = {}
    for batch in in_batches(ids, 80):
        rows = sparql(f"""SELECT ?p (GROUP_CONCAT(DISTINCT ?posL; separator="|") AS ?pos) (GROUP_CONCAT(DISTINCT ?natL; separator="|") AS ?nat) WHERE {{
          VALUES ?p {{ {values(batch)} }}
          OPTIONAL {{ ?p wdt:P413 ?position . ?position rdfs:label ?posL . FILTER(LANG(?posL) = "en") }}
          OPTIONAL {{ ?p wdt:P27 ?country . ?country rdfs:label ?natL . FILTER(LANG(?natL) = "en") }}
        }} GROUP BY ?p""")
        for r in rows:
            out[qid(val(r, "p"))] = {"positions": [x for x in (val(r, "pos") or "").split("|") if x],
                                     "nationality": [COUNTRY_NAMES.get(x, x) for x in (val(r, "nat") or "").split("|") if x]}
        time.sleep(1)
    return out


def clubs(ids):
    """Every team on record (P54) with start and end years, appearances and goals where Wikidata has them."""
    out = {q: [] for q in ids}
    for batch in in_batches(ids, 40):
        rows = sparql(f"""SELECT ?p ?team ?teamLabel ?s ?e ?apps ?goals WHERE {{
          VALUES ?p {{ {values(batch)} }}
          ?p p:P54 ?st . ?st ps:P54 ?team .
          OPTIONAL {{ ?st pq:P580 ?s . }} OPTIONAL {{ ?st pq:P582 ?e . }}
          OPTIONAL {{ ?st pq:P1350 ?apps . }} OPTIONAL {{ ?st pq:P1351 ?goals . }}
          SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
        }}""")
        for r in rows:
            if is_qid_label(val(r, "teamLabel")):
                continue
            num = lambda k: int(float(val(r, k))) if val(r, k) else None  # noqa: E731
            out[qid(val(r, "p"))].append({
                "team": qid(val(r, "team")), "name": val(r, "teamLabel"),
                "from": int(val(r, "s")[:4]) if val(r, "s") and val(r, "s")[:4].isdigit() else None,
                "to": int(val(r, "e")[:4]) if val(r, "e") and val(r, "e")[:4].isdigit() else None,
                "ended": bool(val(r, "e")), "apps": num("apps"), "goals": num("goals"),
            })
        time.sleep(1)
    return out


def titles(ids):
    """Team titles: seasons and tournaments the player took part in (P1344) whose winner (P1346) is a team
    they played for (P54). Returns {qid: [[event label, competition label, winner team, year], ...]}."""
    out = {q: [] for q in ids}
    for batch in in_batches(ids, 30):
        rows = sparql(f"""SELECT ?p ?evLabel ?compLabel ?win ?date WHERE {{
          VALUES ?p {{ {values(batch)} }}
          ?p wdt:P1344 ?ev . ?ev wdt:P1346 ?win . ?p wdt:P54 ?win .
          OPTIONAL {{ ?ev wdt:P3450 ?comp . }}
          OPTIONAL {{ ?ev wdt:P585|wdt:P582|wdt:P580 ?date . }}
          SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
        }}""")
        seen = set()
        for r in rows:
            q, ev = qid(val(r, "p")), val(r, "evLabel")
            if (q, ev) in seen or is_qid_label(ev):
                continue
            seen.add((q, ev))
            comp = val(r, "compLabel") if not is_qid_label(val(r, "compLabel")) else re.sub(r"^\d{4}([–-]\d{2,4})?\s+|\s+\d{4}$", "", ev)
            years = [int(y) for y in re.findall(r"\b(1[89]\d\d|20\d\d)\b", ev)]
            # "2014–15 La Liga" ends in 2015
            m = re.match(r"^(\d{4})[–-](\d{2})\b", ev)
            year = int(m.group(1)[:2] + m.group(2)) if m else (years[-1] if years else int(val(r, "date")[:4]) if val(r, "date") else None)
            out[q].append([ev, comp, qid(val(r, "win")), year])
        time.sleep(1)
    return out


def place_countries(ids):
    """{place id: [current country names]}: country statements with no end date (Wikidata also keeps
    historical ones, like West Germany or Austria-Hungary)."""
    out = {}
    for batch in in_batches(ids, 150):
        rows = sparql(f"""SELECT ?c ?countryLabel WHERE {{
          VALUES ?c {{ {values(batch)} }}
          ?c p:P17 ?st . ?st ps:P17 ?country . FILTER NOT EXISTS {{ ?st pq:P582 ?end . }}
          SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
        }}""")
        for r in rows:
            label = val(r, "countryLabel")
            if label and not is_qid_label(label):
                out.setdefault(qid(val(r, "c")), [])
                name = COUNTRY_NAMES.get(label, label)
                if name not in out[qid(val(r, "c"))]:
                    out[qid(val(r, "c"))].append(name)
        time.sleep(1)
    return out


# ── Stage 3: scoring ───────────────────────────────────────────────────────────
def with_team_then(spells, team, year):
    """Was the player at `team` in `year`? (Spells without dates count; Wikidata often leaves them out.)"""
    for s in spells:
        if s["team"] != team:
            continue
        lo, hi = s["from"] or 0, (s["to"] if s["ended"] else None) or 9999
        if year is None or lo - 1 <= year <= hi + 1:
            return True
    return False


def achievement(awards, won, spells):
    """(points, [readable achievements]) following the formula at the top of this file."""
    pts, items, minor = 0.0, [], 0
    counts = {}
    for label, n, kind, sports in awards:
        if kind == "win" and not FOOTBALLISH.search(label + " " + (sports or "")):
            continue
        if kind == "award" and not FOOTBALLISH.search(label + " " + (sports or "")):
            continue
        base = re.sub(r"^\d{4}([–-]\d{2,4})?\s+|\s+\d{4}([–-]\d{2,4})?$", "", label).strip()
        counts[base] = counts.get(base, 0) + n
    for base, n in counts.items():
        if TOP_INDIVIDUAL.search(base):
            pts += 30 * n; items.append((base, n, 100))
        elif MAJOR_INDIVIDUAL.search(base):
            pts += 8 * n; items.append((base, n, 50))
        else:
            minor += n
    pts += min(10, minor)
    titles_by = {}
    for ev, comp, team, year in won:
        if with_team_then(spells, team, year):
            titles_by[comp] = titles_by.get(comp, 0) + 1
    for comp, n in titles_by.items():
        if WORLD_CUP.search(comp):
            pts += 25 * n; items.append((comp, n, 90))
        elif CONTINENTAL.search(comp):
            pts += 12 * n; items.append((comp, n, 70))
        elif CLUB_CONTINENTAL.search(comp):
            pts += 10 * n; items.append((comp, n, 60))
        elif TOP_LEAGUE.search(comp):
            pts += 3 * n; items.append((comp, n, 30))
        elif LEAGUE.search(comp):
            pts += 1 * n; items.append((comp, n, 10))
    caps = sum(s["apps"] or 0 for s in spells if NATIONAL.search(s["name"]) and not YOUTH.search(s["name"]))
    goals = sum(s["goals"] or 0 for s in spells if NATIONAL.search(s["name"]) and not YOUTH.search(s["name"]))
    pts += min(20, caps * 0.1) + min(15, goals * 0.2)
    items.sort(key=lambda x: (-x[2], -x[1], x[0]))
    return round(pts, 1), [f"{label} ×{n}" if n > 1 else label for label, n, _ in items], caps, goals


def fame(sitelinks, views):
    return round(100 * math.sqrt(min(sitelinks, 300) / 100 * min(views, 2_000_000) / 300_000), 1)


def percentiles(values_by_id):
    """{id: 0..1}, the share of the others each one beats (ties share a rank)."""
    order = sorted(values_by_id.values())
    n = max(1, len(order) - 1)
    import bisect
    return {q: bisect.bisect_left(order, v) / n for q, v in values_by_id.items()}


def current_club(spells, born):
    """The club they're at now: a club spell (not a national team) with no end date, started since 2012."""
    now = [s for s in spells if not s["ended"] and not NATIONAL.search(s["name"]) and (s["from"] or 0) >= 2012]
    return max(now, key=lambda s: s["from"] or 0) if now else None


# ── Stage 4: birthplaces ───────────────────────────────────────────────────────
def load_countries():
    shapes = []
    for f in json.loads(COUNTRIES.read_text())["features"]:
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        names = {f["properties"]["name"].lower(), *[a.lower() for a in f["properties"]["aliases"]]}
        boxes = []
        for poly in polys:
            ring = poly[0]
            xs, ys = [p[0] for p in ring], [p[1] for p in ring]
            boxes.append((min(xs), min(ys), max(xs), max(ys), ring))
        shapes.append((f["properties"]["name"], names, boxes))
    return shapes


def inside(ring, x, y):
    hit = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]; xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            hit = not hit
        j = i
    return hit


def country_at(shapes, lat, lng):
    for name, _, boxes in shapes:
        for x0, y0, x1, y1, ring in boxes:
            if x0 <= lng <= x1 and y0 <= lat <= y1 and inside(ring, lng, lat):
                return name
    return None


def km_to_country(shapes, country, lat, lng):
    """Rough distance (km) from a point to the nearest border vertex of `country` (None if unknown)."""
    for name, names, boxes in shapes:
        if country.lower() in names:
            return min(km_between(lat, lng, p[1], p[0]) for *_, ring in boxes for p in ring)
    return None


def load_places():
    out = []
    for k, line in enumerate(l for l in PLACES.read_text(encoding="utf-8").splitlines() if l and l[0] != "#"):
        n, cc, lat, lng = line.split("\t")
        out.append((k, n, cc, float(lat), float(lng)))
    return out


def nearest(places, lat, lng, max_rank, max_km, skip=""):
    best = None
    for k, n, cc, la, ln in places:
        if k >= max_rank:
            break
        if abs(la - lat) > max_km / 100 or n.lower() == skip.lower():
            continue
        d = km_between(lat, lng, la, ln)
        if d <= max_km and (best is None or d < best[1]):
            best = (n, d, la, ln)
    return best


def radius_for(area_m2, population):
    area = float(area_m2) / 1e6 if area_m2 else 0
    if 0 < area <= 3000:
        r = math.sqrt(area / math.pi)
    elif population and float(population) > 0:
        r = math.sqrt(float(population) / 3000 / math.pi)
    else:
        r = MIN_RADIUS
    return round(min(MAX_RADIUS, max(MIN_RADIUS, r)), 1)


# overseas territories drawn as their own shapes on the map, and the country Wikidata gives for them
TERRITORIES = {"New Caledonia": "France", "Fr. Polynesia": "France", "French Polynesia": "France", "Puerto Rico": "United States",
               "Greenland": "Denmark", "Faeroe Is.": "Denmark", "Faroe Islands": "Denmark", "Curaçao": "Netherlands", "Aruba": "Netherlands"}
SAME_PLACE_KM = 20  # two recorded birthplaces this close are one place at two levels (a town and its district)
BORDER_KM = 15      # the country outlines are simplified, so a border town can land just over the line


def birthplace(d, sizes, shapes, places, current):
    """(fields, problem): where they were born and how big a circle counts, or why we can't say."""
    places_ = {k: v for k, v in d["places"].items() if v["coords"]}
    if not d["places"]:
        return None, "no place of birth on Wikidata"
    if not places_:
        return None, "no coordinates for " + " / ".join(p["label"] for p in d["places"].values())
    also = None
    if len(places_) > 1:
        pts = [p["coords"][0] for p in places_.values()]
        far = max(km_between(a[0], a[1], b[0], b[1]) for a in pts for b in pts)
        if far > SAME_PLACE_KM:
            return None, f"several places of birth {far:.0f} km apart: " + " / ".join(p["label"] for p in places_.values())
        # one place at two levels: the bigger one is the answer, and the circle takes in the other
        pop = lambda k: float((sizes.get(k) or [None, None])[1] or 0)  # noqa: E731
        main = max(places_, key=pop)
        also = [(p["label"], p["coords"][0]) for k, p in places_.items() if k != main]
        places_ = {main: places_[main]}
    pid, p = next(iter(places_.items()))
    p = dict(p, countries=current.get(pid) or p["countries"])
    if is_qid_label(p["label"]):
        return None, "place of birth has no English name"
    if not p["coords"]:
        return None, f"no coordinates for {p['label']}"
    if len(p["coords"]) > 1 and max(km_between(a[0], a[1], b[0], b[1]) for a in p["coords"] for b in p["coords"]) > SAME_PLACE_KM:
        return None, f"{p['label']} has several coordinates far apart"
    lat, lng = p["coords"][0]
    if abs(lat) < 0.01 and abs(lng) < 0.01:
        return None, "coordinates are 0,0"
    found = country_at(shapes, lat, lng)
    country = p["countries"][0] if p["countries"] else None
    if len(p["countries"]) > 1:
        # Wikidata keeps old countries too (Rome: Vatican City; Prague: Bohemia). Use the one the place is in today.
        names = next((n for name, n, _ in shapes if name == found), set()) if found else set()
        today = [c for c in p["countries"] if c.lower() in names]
        if not today:
            return None, f"{p['label']} is in several countries on Wikidata: {', '.join(p['countries'])}"
        country = today[0]
    if found is None:
        near = km_to_country(shapes, country, lat, lng) if country else None
        if near is None or near > 25:
            return None, f"coordinates for {p['label']} are outside any country (in the sea?)"
    elif country and found.lower() != country.lower():
        names = next((n for name, n, _ in shapes if name == found), set())
        near = km_to_country(shapes, country, lat, lng)
        if TERRITORIES.get(found) == country:
            country = found  # New Caledonia, not France: so "Reveal country" lights up the right place
        elif country.lower() not in names and (near is None or near > BORDER_KM):
            return None, f"coordinates for {p['label']} fall in {found}, but Wikidata says {country}"
    country = country or found
    if not country:
        return None, f"no country for {p['label']}"
    area, pop = (sizes.get(pid) or [None, None])
    r = radius_for(area, pop)
    out = {"birth_place": p["label"], "birth_country": country, "lat": round(lat, 4), "lng": round(lng, 4), "radius_km": r}
    if also:  # the other recorded place, inside the circle
        out["also_recorded"] = [a[0] for a in also]
        out["radius_km"] = round(min(MAX_RADIUS + 10, max(r, max(km_between(lat, lng, *a[1]) for a in also) + 5)), 1)
    # A village next to a big city: the city counts too.
    small = (pop and float(pop) < VILLAGE_POP) or (not pop and (not area or float(area) / 1e6 < 20))
    if small:
        big = nearest(places, lat, lng, BIG_CITY_RANK, 20, skip=p["label"])
        if big:
            out["metro"] = big[0]
            out["radius_km"] = round(min(MAX_RADIUS + 10, max(r, big[1] + 5)), 1)
    well = nearest(places, lat, lng, WELL_KNOWN_RANK, 150, skip=p["label"])
    if well and well[0] != out.get("metro"):
        out["near_city"] = {"name": well[0], "km": round(well[1])}
    elif well:
        out["near_city"] = {"name": well[0], "km": round(well[1])}
    return out, None


# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    fresh = "--fresh" in sys.argv
    overrides = json.loads(OVERRIDES.read_text()) if OVERRIDES.exists() else {"exclude": [], "include": [], "fix_birthplace": {}}
    excluded = set(overrides.get("exclude", []))

    print("Seed legends…")
    seed_ids, problems = cached("fb-seeds", lambda: [list(x) for x in resolve_seeds({"Football": SEEDS})], fresh)
    seed_ids = set(seed_ids) | set(overrides.get("include", []))
    for _, name, why in problems:
        print(f"   seed not matched: {name} ({why})")

    print("Candidates…")
    cands = candidates(fresh)
    sl_of = {q: sl for q, sl in cands}
    ids = sorted((set(sl_of) | seed_ids) - excluded)
    print(f"   {len(ids)} footballers")

    print("Details…")
    info = batched("fb-details", ids, 60, details, fresh)
    ids = [q for q in ids if q in info and not is_qid_label(info[q]["name"])]
    more = batched("fb-extras", ids, 150, extras, fresh)
    # Footballers first and foremost: some politicians and writers are on Wikidata as footballers too
    # (Viktor Orbán played for Felcsút). Their English description has to be about football.
    not_footballers = [info[q]["name"] for q in ids if not FOOTBALL_DESC.search(more.get(q, {}).get("desc", ""))
                       and q not in seed_ids and info[q]["sl"] >= 60]
    ids = [q for q in ids if FOOTBALL_DESC.search(more.get(q, {}).get("desc", "")) or q in seed_ids]
    print(f"   left out as not mainly footballers: {', '.join(not_footballers[:15])}{' …' if len(not_footballers) > 15 else ''}")

    # Pageviews only for those with a chance: by language editions, plus all seeds and all women asked for.
    women = {q for q in ids if info[q]["female"]}
    shortlist = sorted(ids, key=lambda q: -info[q]["sl"])[:2500]
    shortlist = sorted(set(shortlist) | (seed_ids & set(ids)) | women)
    titles_ = sorted({more[q]["title"] for q in shortlist if more.get(q, {}).get("title")})
    print(f"Pageviews for {len(titles_)} articles…")
    views_by_title = batched("views", titles_, 15, pageviews, fresh)
    views = {q: views_by_title.get(more.get(q, {}).get("title"), 0) for q in shortlist}

    print("Clubs, titles and awards…")
    spells = batched("fb-clubs", shortlist, 40, clubs, fresh)
    won = batched("fb-titles", shortlist, 30, titles, fresh)
    awards = batched("fb-awards", shortlist, 40, achievements, fresh)
    prof = batched("fb-profile", shortlist, 80, profile, fresh)

    scored = {}
    for q in shortlist:
        pts, items, caps, goals = achievement(awards.get(q, []), won.get(q, []), spells.get(q, []))
        scored[q] = {"fame": fame(info[q]["sl"], views.get(q, 0)), "ach": pts, "items": items, "caps": caps, "goals": goals}
    fame_p = percentiles({q: s["fame"] for q, s in scored.items()})
    ach_p = percentiles({q: math.log1p(s["ach"]) for q, s in scored.items()})
    for q, s in scored.items():
        s["legend"] = round(0.5 * fame_p[q] + 0.5 * ach_p[q], 4)

    print("Birthplaces…")
    place_ids = sorted({pid for q in shortlist for pid in info[q]["places"]})
    sizes = batched("fb-sizes", place_ids, 60, city_sizes, fresh)
    current = batched("fb-countries", place_ids, 150, place_countries, fresh)
    shapes, places = load_countries(), load_places()
    fixes = overrides.get("fix_birthplace", {})
    where, flags = {}, []
    for q in shortlist:
        if q in fixes:
            where[q] = dict(fixes[q]); continue
        fields, problem = birthplace(info[q], sizes, shapes, places, current)
        if problem:
            flags.append((q, info[q]["name"], problem))
        else:
            where[q] = fields

    # LEGENDS: seeds first, then the best of the rest.
    ok = [q for q in shortlist if q in where]
    by_legend = sorted(ok, key=lambda q: -scored[q]["legend"])
    seeds_in = [q for q in by_legend if q in seed_ids]
    legends = seeds_in + [q for q in by_legend if q not in seed_ids][:max(0, N_LEGENDS - len(seeds_in))]
    legends.sort(key=lambda q: -scored[q]["legend"])
    # CURRENT: active players at a club now, by fame.
    def active(q):
        d = info[q]
        return not d["died"] and not d["ended"] and current_club(spells.get(q, []), d["born"]) is not None \
            and (d["born"] or "0")[:4] >= "1982"
    current = sorted([q for q in ok if active(q)], key=lambda q: -scored[q]["fame"])[:N_CURRENT]

    as_of = datetime.date.today().isoformat()
    chosen = list(dict.fromkeys(legends + current))
    entries = []
    for q in chosen:
        d, s, p = info[q], scored[q], prof.get(q, {})
        club_now = current_club(spells.get(q, []), d["born"])
        career = sorted([{"club": c["name"], "from": c["from"], "to": c["to"] if c["ended"] else None,
                          **({"apps": c["apps"]} if c["apps"] is not None else {}),
                          **({"goals": c["goals"]} if c["goals"] is not None else {})}
                         for c in spells.get(q, []) if not NATIONAL.search(c["name"])],
                        key=lambda c: (c["from"] or 9999, c["club"]))
        entries.append({
            "id": "wd-" + q, "name": d["name"], "type": "athlete", "sport": "Football",
            "list": "legend" if q in legends else "current", "current": q in current,
            "female": d["female"],
            **where[q],
            "fame_score": s["fame"], "legend_score": s["legend"], "achievement_points": s["ach"],
            "achievements": s["items"][:8],
            "positions": p.get("positions", [])[:3], "nationality": p.get("nationality", [])[:2],
            "caps": s["caps"] or None, "intl_goals": s["goals"] or None,
            "club_now": club_now["name"] if club_now and q in current else None,
            "career": career,
            "born": d["born"], "_file": d["file"], "_sl": d["sl"], "_views": views.get(q, 0),
        })

    # difficulty 1–3 by fame rank (thirds)
    entries.sort(key=lambda e: -e["fame_score"])
    for k, e in enumerate(entries):
        e["difficulty"] = 1 + min(2, k * 3 // len(entries))
    entries.sort(key=lambda e: (e["list"] != "legend", -(e["legend_score"] if e["list"] == "legend" else e["fame_score"])))

    OUT.write_text(json.dumps({"as_of": as_of, "players": entries}, ensure_ascii=False, indent=1) + "\n")
    with open(FLAGS, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "name", "problem", "legend score", "fame"])
        for q, name, why in sorted(flags, key=lambda x: -scored[x[0]]["legend"]):
            w.writerow(["wd-" + q, name, why, scored[q]["legend"], scored[q]["fame"]])
    for kind, path in REVIEW.items():
        rows = [e for e in entries if e["list"] == kind or (kind == "current" and e["current"])]
        rows.sort(key=lambda e: -(e["legend_score"] if kind == "legend" else e["fame_score"]))
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["rank", "name", "birthplace", "country", "list", "current", "fame score", "legend score", "achievements"])
            for k, e in enumerate(rows, 1):
                place = e["birth_place"] + (f" (near {e['metro']})" if e.get("metro") else "")
                w.writerow([k, e["name"], place, e["birth_country"], e["list"], e["current"], e["fame_score"],
                            e["legend_score"], " · ".join(e["achievements"][:4])])

    n_leg = sum(e["list"] == "legend" for e in entries)
    print(f"\n{len(entries)} footballers ({n_leg} legends, {sum(e['current'] for e in entries)} current, "
          f"{sum(e['current'] and e['list'] == 'legend' for e in entries)} in both), as of {as_of}")
    print(f"   women: {sum(e['female'] for e in entries)} "
          f"({sum(e['female'] and e['list'] == 'legend' for e in entries)} legends, {sum(e['female'] and e['current'] for e in entries)} current)")
    print(f"   seeds kept: {len([q for q in seed_ids if q in legends])} of {len(seed_ids)}; "
          f"seeds left out by birthplace flags: {[info[q]['name'] for q in seed_ids if q in info and q not in where]}")
    print(f"   birthplace flags: {len(flags)} (data/football-flags.csv)")


if __name__ == "__main__":
    main()
