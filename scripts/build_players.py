"""Builds data/players.json from Wikidata: well-known athletes who have won something, and top teams.

    python3 scripts/build_players.py            # full build
    python3 scripts/build_players.py --dry-run  # build and validate, but don't write anything
    python3 scripts/build_players.py --fresh    # ignore the cache and ask Wikidata for everything again

How it works, in stages (each Wikidata answer is cached in scripts/.cache/, so reruns are quick):
  1. Check that every Wikidata ID below still means what we think it means (by its English label).
  2. Candidates: per sport, the most famous people by "sitelinks" (the number of Wikipedia language
     editions with an article on them). Per league, its teams.
  3. Details for each candidate: birthplace or stadium, coordinates, country, picture, city size.
  4. Achievements: sports awards received (P166) and competitions won (P1346, "winner").
     Athletes with no achievement are dropped.
  5. Fame score = sitelinks plus a bonus for achievements. Keep the top N per sport, so no sport
     dominates, and give each entry a difficulty from its fame within its sport.
  6. Apply data/overrides.json: "exclude" removes ids, "include" adds ids whatever their fame.
  7. Pictures: author and licence from Wikimedia Commons, minus any whose file name gives the city away.
  8. Validate, then write data/players.json and data/review.csv (a list sorted by fame, for checking by eye).

Needs internet access to query.wikidata.org and commons.wikimedia.org. No extra packages.
"""
import csv
import json
import math
import pathlib
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from validate_players import validate  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "players.json"
REVIEW = ROOT / "data" / "review.csv"
OVERRIDES = ROOT / "data" / "overrides.json"
CACHE = ROOT / "scripts" / ".cache"
ENDPOINT = "https://query.wikidata.org/sparql"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
IMAGE_WIDTH = 400  # pixels; Commons makes a small copy of this width for us

# Wikidata and Commons ask every script to identify itself with a way to contact the owner.
USER_AGENT = "HomeGroundGame/0.2 (https://github.com/willbrucee/home-ground)"

# ── What to include ────────────────────────────────────────────────────────────
# Athletes: (occupation id, its expected label, sport shown in the game, how many to keep, min sitelinks)
# The minimum is lower for sports with less worldwide coverage, so each still has enough well-known names.
ATHLETE_SPORTS = [
    ("Q937857", "association football player", "Football", 70, 60),
    ("Q3665646", "basketball player", "Basketball", 40, 40),
    ("Q10833314", "tennis player", "Tennis", 35, 40),
    ("Q11513337", "athletics competitor", "Athletics", 35, 40),
    ("Q10841764", "Formula One driver", "Formula 1", 25, 40),
    ("Q12299841", "cricketer", "Cricket", 25, 25),
    ("Q19204627", "American football player", "American football", 25, 20),
    ("Q10871364", "baseball player", "Baseball", 25, 25),
    ("Q11774891", "ice hockey player", "Ice hockey", 25, 25),
    ("Q11303721", "golfer", "Golf", 20, 30),
    ("Q11338576", "boxer", "Boxing", 20, 40),
    ("Q2309784", "sport cyclist", "Cycling", 20, 35),
    ("Q14089670", "rugby union player", "Rugby union", 15, 20),
    ("Q11607585", "mixed martial arts fighter", "MMA", 10, 25),
    ("Q14373094", "rugby league player", "Rugby league", 10, 10),
    ("Q13414980", "Australian rules football player", "Australian rules football", 10, 8),
]

# Teams: (league id, expected label, sport, how many to keep, min sitelinks)
LEAGUES = [
    ("Q9448", "Premier League", "Football", 20, 10),
    ("Q324867", "La Liga", "Football", 12, 10),
    ("Q15804", "Serie A", "Football", 12, 10),
    ("Q82595", "Bundesliga", "Football", 12, 10),
    ("Q13394", "Ligue 1", "Football", 8, 10),
    ("Q18543", "Major League Soccer", "Football", 5, 5),
    ("Q155223", "National Basketball Association", "Basketball", 30, 5),
    ("Q1215884", "National Football League", "American football", 32, 5),
    ("Q1163715", "Major League Baseball", "Baseball", 30, 5),
    ("Q1215892", "National Hockey League", "Ice hockey", 25, 5),
    ("Q396412", "Indian Premier League", "Cricket", 10, 5),
    ("Q50783", "Australian Football League", "Australian rules football", 18, 5),
    ("Q1140630", "National Rugby League", "Rugby league", 16, 5),
]
# The most famous football clubs anywhere (Boca, Flamengo, Al Ahly...), by sitelinks.
WORLD_CLUBS = ("Q476028", "association football club", "Football", 25, 60)

# Olympic medals are awards without a "sport" on them, so they're recognised by id.
OLYMPIC_MEDALS = {"Q15243387": "Olympic gold medal", "Q15889641": "Olympic silver medal", "Q15889643": "Olympic bronze medal"}

# Awards count as sporting if Wikidata gives them a sport (P641), or their name says so.
SPORTY_WORDS = re.compile(r"olympic|espy|laureus|sportsperson|sportsman|sportswoman|athlete of the year|"
                          r"champion|sports personality|hall of fame|segrave|world cup|ballon", re.I)
# When writing the one-line achievement summary, these words mark the big titles to show first.
BIG_TITLES = re.compile(r"ballon d'or|most valuable player|olympic gold|world championship|formula one|"
                        r"world cup|champions league|super bowl|stanley cup|world series|grand slam|wimbledon|"
                        r"australian open|french open|u\.?s\.? open|open championship|roland|masters tournament|pga championship|"
                        r"tour de france|giro|vuelta|premier league|la liga|serie a|bundesliga|"
                        r"ligue 1|nba|stanley|grand final|ufc|heavyweight|world player|golden ball", re.I)
SMALL_TITLES = re.compile(r"team of the|player of the month|of the week|dream team|all-|rookie|espy|\bxi\b|team$|"
                          r"best eleven|young player|goal of the|save of the|young|junior|youth|u-?\d\d", re.I)

# An athlete must have won something IN THEIR SPORT. Wikidata records a sport (P641) on most awards and
# competitions; these patterns match its English name. (People often have several occupations: without
# this, a cartoonist with an ice hockey award would count as an ice hockey player.)
SPORT_MATCH = {
    "Football": r"association football|soccer|futsal",
    "Basketball": r"basketball",
    "Tennis": r"tennis",
    "Athletics": r"athletics|running|sprint|marathon|jump|vault|throw|hurdl|decathlon|heptathlon|race walk|distance|relay|cross country",
    "Formula 1": r"formula one|formula 1|motor|auto racing|grand prix",
    "Cricket": r"cricket",
    "American football": r"american football|gridiron",
    "Baseball": r"baseball",
    "Ice hockey": r"ice hockey",
    "Golf": r"golf",
    "Boxing": r"boxing",
    "Cycling": r"cycl|bicycle|bmx",
    "Rugby union": r"rugby union|rugby sevens|rugby football",
    "MMA": r"mixed martial arts|martial art|sambo|judo|wrestling|kickboxing",
    "Rugby league": r"rugby league",
    "Australian rules football": r"australian rules|australian football",
}
# Olympic medals have no sport on them; they count for these sports only.
OLYMPIC_SPORTS = {"Football", "Basketball", "Tennis", "Athletics", "Ice hockey", "Golf", "Boxing", "Cycling", "Rugby union", "Baseball"}
# "Wins" that are single games, not titles ("Game 4 of 1988 NBA Playoffs…", "NRL 2022 Round 1 …").
SINGLE_GAME = re.compile(r"\bvs\.?\b|\bversus\b|^game \d|round \d| at .*\d{4}|\d{1,2} (january|february|march|april|may|june|"
                         r"july|august|september|october|november|december)|points in", re.I)

# Places that are parts of a city (or whole regions) rather than the city itself.
NOT_A_CITY = re.compile(r"arrondissement|district|tehsil|partido|borough|\bward\b|region|county|province|"
                        r"\bstate\b|new south wales|queensland|victoria|south australia|western australia|municipality", re.I)

COUNTRY_NAMES = {
    "People's Republic of China": "China",
    "Kingdom of the Netherlands": "Netherlands",
    "Kingdom of Denmark": "Denmark",
    "United States of America": "United States",
    "State of Palestine": "Palestine",
}

# City size → the radius that counts as "inside the city" (see radius_km below).
MIN_RADIUS_KM, MAX_RADIUS_KM = 8, 60
PEOPLE_PER_KM2 = 3000  # rough urban density, used when Wikidata has a population but no area


# ── Talking to Wikidata ────────────────────────────────────────────────────────
class QueryFailed(Exception):
    """Wikidata kept timing out on one query. We skip that part and carry on."""


def sparql(query, retries=4):
    """Runs one SPARQL query and returns the result rows. Retries politely on timeouts and rate limits."""
    data = urllib.parse.urlencode({"query": query, "format": "json"}).encode()
    for attempt in range(retries):
        req = urllib.request.Request(ENDPOINT, data=data, headers={"User-Agent": USER_AGENT, "Accept": "application/sparql-results+json"})
        try:
            with urllib.request.urlopen(req, timeout=150) as r:  # the big candidate lists can take ~50 s
                return json.load(r)["results"]["bindings"]
        except (urllib.error.URLError, OSError) as err:  # HTTP errors, timeouts and dropped connections
            retry_after = getattr(err, "headers", None) and err.headers.get("Retry-After")
            wait = int(retry_after) if retry_after and retry_after.isdigit() else 5 * 2 ** attempt
            print(f"   query failed ({err}); retrying in {wait}s")
            time.sleep(wait)
    raise QueryFailed("Wikidata didn't answer after several tries")


def cached(key, fetch, fresh):
    """Returns the cached answer for `key`, or runs fetch() and caches what it returns."""
    path = CACHE / f"{key}.json"
    if path.exists() and not fresh:
        return json.loads(path.read_text())
    result = fetch()
    CACHE.mkdir(exist_ok=True)
    path.write_text(json.dumps(result, ensure_ascii=False))
    return result


def batched(prefix, ids, size, fetch, fresh):
    """Runs fetch(batch) for each slice of ids and merges the dicts it returns. Each batch is cached on
    its own (named after a hash of its ids), so a failure part-way keeps everything already fetched."""
    import hashlib
    out = {}
    batches = list(in_batches(sorted(ids), size))
    for n, batch in enumerate(batches, 1):
        key = f"{prefix}-{hashlib.md5(' '.join(batch).encode()).hexdigest()[:10]}"
        out.update(cached(key, lambda: fetch(batch), fresh))
        if n % 10 == 0 or n == len(batches):
            print(f"   {prefix}: {n}/{len(batches)}")
    return out


def in_batches(ids, size=80):
    for i in range(0, len(ids), size):
        yield ids[i:i + size]


def values(ids):
    return " ".join("wd:" + q for q in ids)


def val(row, key):
    return row[key]["value"] if key in row else None


def qid(uri):
    return uri.rsplit("/", 1)[-1] if uri else None


def parse_point(wkt):
    # Wikidata coordinates look like "Point(-60.639 -32.947)", i.e. longitude first.
    m = re.match(r"Point\(([-\d.eE]+) ([-\d.eE]+)\)", wkt or "")
    return (float(m.group(2)), float(m.group(1))) if m else (None, None)


def file_name(url):
    """Wikidata gives images as .../Special:FilePath/Some_File.jpg. We keep just the file name."""
    return urllib.parse.unquote(url.rsplit("/", 1)[-1]).replace("_", " ") if url else None


def plain(text):
    """Lower case without accents, for loose text comparisons."""
    return unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()


def is_qid_label(text):
    return not text or re.fullmatch(r"Q\d+", text)


# ── Stage 1: check our hard-coded ids ──────────────────────────────────────────
def check_ids():
    expected = {a[0]: a[1] for a in ATHLETE_SPORTS} | {l[0]: l[1] for l in LEAGUES} | {WORLD_CLUBS[0]: WORLD_CLUBS[1]} | OLYMPIC_MEDALS
    rows = sparql(f"""SELECT ?x ?label WHERE {{
      VALUES ?x {{ {values(list(expected))} }}
      ?x rdfs:label ?label . FILTER(LANG(?label) IN ("en", "mul"))  # "mul" = one label shared by all languages
    }}""")
    labels = {}
    for r in rows:
        labels.setdefault(qid(val(r, "x")), set()).add(val(r, "label").lower())
    bad = {i for i in expected if expected[i].lower() not in labels.get(i, set())}
    for i in sorted(bad):
        print(f"   {i}: expected '{expected[i]}', Wikidata says {sorted(labels.get(i, [])) or 'nothing'}; skipping it")
    return set(expected) - bad


# ── Stage 2: candidates ────────────────────────────────────────────────────────
def athlete_candidates(occupation, min_links, how_many):
    """[[qid, sitelinks], ...] for the most-linked people with this occupation."""
    rows = sparql(f"""SELECT ?p ?sl WHERE {{
      ?p wdt:P106 wd:{occupation} ; wikibase:sitelinks ?sl .
      FILTER(?sl >= {min_links})
    }} ORDER BY DESC(?sl) LIMIT {how_many}""")
    return [[qid(val(r, "p")), int(val(r, "sl"))] for r in rows]


def team_candidates(where, min_links, how_many):
    rows = sparql(f"""SELECT DISTINCT ?t ?sl WHERE {{
      {where}
      ?t wikibase:sitelinks ?sl .
      FILTER(?sl >= {min_links})
      FILTER NOT EXISTS {{ ?t wdt:P576 ?dissolved . }}
      FILTER NOT EXISTS {{ ?t wdt:P31 wd:Q5 . }}  # players carry a "league" too; we only want clubs
    }} ORDER BY DESC(?sl) LIMIT {how_many}""")
    return [[qid(val(r, "t")), int(val(r, "sl"))] for r in rows]


def old_cache_candidates(occupation, min_links):
    """Earlier versions of this script cached whole athlete lists. Reuse them as candidate lists
    rather than re-running the slowest queries (football alone takes ~50 s and often times out)."""
    path = CACHE / f"athletes-{occupation}.json"
    if not path.exists():
        return None
    return [[e["id"][3:], e["_sitelinks"]] for e in json.loads(path.read_text()) if e["_sitelinks"] >= min_links]


# ── Stage 3: details ───────────────────────────────────────────────────────────
def athlete_details(ids):
    out = {}
    for batch in in_batches(ids):
        rows = sparql(f"""SELECT ?p ?pLabel ?sl ?place ?placeLabel ?parentLabel ?coord ?countryLabel ?img WHERE {{
          VALUES ?p {{ {values(batch)} }}
          ?p wikibase:sitelinks ?sl ; wdt:P19 ?place . ?place wdt:P625 ?coord .
          OPTIONAL {{ ?place wdt:P17 ?country . }}
          OPTIONAL {{ ?place wdt:P131 ?parent . }}  # the city a district belongs to
          OPTIONAL {{ ?p wdt:P18 ?img . }}
          SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
        }}""")
        for r in rows:
            q = qid(val(r, "p"))
            lat, lng = parse_point(val(r, "coord"))
            if q in out or lat is None or is_qid_label(val(r, "pLabel")) or is_qid_label(val(r, "placeLabel")):
                continue
            out[q] = {
                "name": val(r, "pLabel"), "city": city_name(val(r, "placeLabel"), val(r, "parentLabel")),
                "country": COUNTRY_NAMES.get(val(r, "countryLabel") or "", val(r, "countryLabel") or ""),
                "lat": round(lat, 4), "lng": round(lng, 4),
                "_place": qid(val(r, "place")),
                "_file": file_name(val(r, "img")), "_sl": int(val(r, "sl")),
            }
        time.sleep(1)
    return out


def city_name(place, parent):
    """'16th arrondissement of Marseille' → 'Marseille'; 'Lanús Partido' → 'Lanús'. A district gives way
    to its parent city; failing that, the district word is trimmed off."""
    if NOT_A_CITY.search(place or ""):
        if parent and not is_qid_label(parent) and not NOT_A_CITY.search(parent):
            return parent
        m = re.search(r"arrondissement of (.+)$", place)
        if m:
            return m.group(1)
        return re.sub(r"\s+(partido|tehsil|district|region|county)$", "", place, flags=re.I)
    return place


def city_sizes(place_ids):
    """{place id: [area in m², population]} for working out each city's radius."""
    out = {}
    for batch in in_batches(place_ids, 60):
        rows = sparql(f"""SELECT ?c (MAX(?area) AS ?a) (MAX(?pop) AS ?n) WHERE {{
          VALUES ?c {{ {values(batch)} }}
          OPTIONAL {{ ?c p:P2046/psn:P2046/wikibase:quantityAmount ?area . }}  # area, converted to m²
          OPTIONAL {{ ?c wdt:P1082 ?pop . }}
        }} GROUP BY ?c""")
        for r in rows:
            out[qid(val(r, "c"))] = [val(r, "a"), val(r, "n")]
        time.sleep(1)
    return out


def team_details(ids):
    """Teams sit at their stadium. The 'city' is the stadium's town; states and provinces (some
    stadiums list 'Texas') are skipped. With no stadium on record we use the headquarters."""
    out = {}
    for batch in in_batches(ids):
        rows = sparql(f"""SELECT ?t ?tLabel ?sl ?venueLabel ?vcoord ?town ?townLabel ?isState ?hq ?hqLabel ?hqcoord ?countryLabel ?img WHERE {{
          VALUES ?t {{ {values(batch)} }}
          ?t wikibase:sitelinks ?sl .
          OPTIONAL {{ ?t wdt:P115 ?venue . ?venue wdt:P625 ?vcoord .
                      OPTIONAL {{ ?venue wdt:P131 ?town .
                                  BIND(EXISTS {{ ?town wdt:P31 wd:Q35657 }} || EXISTS {{ ?town wdt:P31 wd:Q10864048 }} AS ?isState) }} }}
          OPTIONAL {{ ?t wdt:P159 ?hq . ?hq wdt:P625 ?hqcoord . }}  # headquarters, usually the club's city
          OPTIONAL {{ ?t wdt:P17 ?country . }}
          OPTIONAL {{ ?t wdt:P154 ?img . }}
          SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
        }}""")
        best = {}
        for r in rows:
            q = qid(val(r, "t"))
            if is_qid_label(val(r, "tLabel")):
                continue
            town_ok = val(r, "townLabel") and val(r, "isState") != "true" and not is_qid_label(val(r, "townLabel"))
            # Rank the rows for this team: stadium + real town beats stadium alone beats headquarters.
            rank = 2 if (val(r, "vcoord") and town_ok) else 1 if val(r, "vcoord") else 0
            if q not in best or rank > best[q][0]:
                best[q] = (rank, r, town_ok)
        for q, (rank, r, town_ok) in best.items():
            if val(r, "vcoord"):
                lat, lng = parse_point(val(r, "vcoord"))
                # The stadium's own "town" is often a district or county ("Clark County", "8th arrondissement").
                # The club's headquarters city reads better, so use it when it's close to the stadium.
                hq_lat, hq_lng = parse_point(val(r, "hqcoord"))
                hq_near = (hq_lat is not None and km_between(lat, lng, hq_lat, hq_lng) < 40
                           and not is_qid_label(val(r, "hqLabel")) and not NOT_A_CITY.search(val(r, "hqLabel")))
                city = val(r, "hqLabel") if hq_near else val(r, "townLabel") if town_ok else val(r, "hqLabel")
                place = qid(val(r, "hq")) if hq_near else qid(val(r, "town")) if town_ok else None
                hint = f"Home ground: {val(r, 'venueLabel')}" if not is_qid_label(val(r, "venueLabel")) else None
            else:
                lat, lng = parse_point(val(r, "hqcoord"))
                city, hint, place = val(r, "hqLabel"), None, qid(val(r, "hq"))
            if lat is None or is_qid_label(city):
                continue
            out[q] = {
                "name": val(r, "tLabel"), "city": city_name(city, None),
                "country": COUNTRY_NAMES.get(val(r, "countryLabel") or "", val(r, "countryLabel") or ""),
                "lat": round(lat, 4), "lng": round(lng, 4),
                "_place": place,
                "_file": file_name(val(r, "img")), "_sl": int(val(r, "sl")),
            }
            if hint:
                out[q]["hint"] = hint
        time.sleep(1)
    return out


def km_between(lat1, lng1, lat2, lng2):
    """Great-circle distance (haversine), in km."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def radius_km(area_m2, population):
    """How far from the centre still counts as 'in the city': the radius of a circle with the city's
    area. Without an area, estimate one from the population. Clamped so tiny towns and huge
    administrative areas both stay sensible."""
    area_km2 = float(area_m2) / 1e6 if area_m2 else 0
    if 0 < area_km2 <= 3000:  # bigger than this is a county or region, not a city
        r = math.sqrt(area_km2 / math.pi)
    elif population and float(population) > 0:
        r = math.sqrt(float(population) / PEOPLE_PER_KM2 / math.pi)
    else:
        r = MIN_RADIUS_KM
    return round(min(MAX_RADIUS_KM, max(MIN_RADIUS_KM, r)), 1)


# ── Stage 4: achievements ──────────────────────────────────────────────────────
def achievements(ids):
    """For each id: a list of [label, count, kind] where kind is "award" or "win"."""
    out = {q: [] for q in ids}
    for batch in in_batches(ids, 40):
        awards = sparql(f"""SELECT ?x ?award ?awardLabel (COUNT(DISTINCT ?st) AS ?n)
                                   (GROUP_CONCAT(DISTINCT ?sportName; separator="|") AS ?sports) WHERE {{
          VALUES ?x {{ {values(batch)} }}
          ?x p:P166 ?st . ?st ps:P166 ?award .
          OPTIONAL {{ ?award wdt:P641 ?sp . ?sp rdfs:label ?sportName . FILTER(LANG(?sportName) = "en") }}
          SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
        }} GROUP BY ?x ?award ?awardLabel""")
        for r in awards:
            label, award, sports = val(r, "awardLabel"), qid(val(r, "award")), val(r, "sports") or ""
            if award in OLYMPIC_MEDALS:
                sports = "olympic"
            if (sports or SPORTY_WORDS.search(label or "")) and not is_qid_label(label):
                out[qid(val(r, "x"))].append([label, int(val(r, "n")), "award", sports])
        # "winner" (P1346) on a season or event, grouped by the competition it belongs to (P3450).
        wins = sparql(f"""SELECT ?x ?comp ?compLabel (COUNT(*) AS ?n) WHERE {{
          VALUES ?x {{ {values(batch)} }}
          ?ev wdt:P1346 ?x .
          OPTIONAL {{ ?ev wdt:P3450 ?c . }}
          BIND(COALESCE(?c, ?ev) AS ?comp)
          SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
        }} GROUP BY ?x ?comp ?compLabel""")
        # Only sporting wins count: the competition must have a sport (P641). Without this check,
        # Nobel prizes and science medals sneak in as "wins". Asked separately because doing it
        # inside the query above makes Wikidata time out.
        sporty = sporting(sorted({qid(val(r, "comp")) for r in wins}))  # {competition id: its sport names}
        grouped = {}
        for r in wins:
            label = val(r, "compLabel")
            if is_qid_label(label) or qid(val(r, "comp")) not in sporty or SINGLE_GAME.search(label):
                continue
            # "2003 Wimbledon Championships – men's singles" and "2004 …" are the same title won twice:
            # drop the year so they're counted together.
            label = re.sub(r"^\d{4}(–\d{2,4})?\s+", "", label)
            key = (qid(val(r, "x")), label, sporty[qid(val(r, "comp"))])
            grouped[key] = grouped.get(key, 0) + int(val(r, "n"))
        for (q, label, sports), n in grouped.items():
            out[q].append([label, n, "win", sports])
        time.sleep(1)
    return out


def sporting(ids):
    """{id: "sport|sport"} for the competitions/events here that have a sport (P641) on Wikidata."""
    found = {}
    for batch in in_batches(ids, 150):
        for r in sparql(f"""SELECT ?c (GROUP_CONCAT(DISTINCT ?name; separator="|") AS ?sports) WHERE {{
          VALUES ?c {{ {values(batch)} }}
          ?c wdt:P641 ?sp . ?sp rdfs:label ?name . FILTER(LANG(?name) = "en")
        }} GROUP BY ?c"""):
            found[qid(val(r, "c"))] = val(r, "sports")
    return found


def in_sport(items, sport):
    """Only the achievements that belong to this sport (Olympic medals count for Olympic sports)."""
    pattern = re.compile(SPORT_MATCH.get(sport, re.escape(sport)), re.I)
    return [i for i in items
            if (i[3] == "olympic" and sport in OLYMPIC_SPORTS) or (i[3] != "olympic" and pattern.search(i[3]))]


def summarise(items, limit=2):
    """'NBA Most Valuable Player ×4 · Bill Russell NBA Finals Most Valuable Player ×4' from the raw list.
    Big titles first, then by count. Only uses what Wikidata says; nothing is made up."""
    def tidy(label, kind):
        label = re.sub(r"\s+award$", "", label, flags=re.I)
        return f"{label} winner" if kind == "win" and not re.search(r"champion|medal|trophy|cup$", label, re.I) else label

    def weight(item):
        label, n = item[0], item[1]
        # minor awards stay low even when they name a big competition ("Premier League Player of the Month")
        w = 0.4 if SMALL_TITLES.search(label) else 3 if BIG_TITLES.search(label) else 1
        return w * min(n, 10)

    # Merge editions of the same title: "Super Bowl LII" + "Super Bowl LIX" → "Super Bowl" ×2.
    merged = {}
    for label, n, kind, *_ in items:
        base = re.sub(r"\s+[IVXLCDM]+$", "", re.sub(r"^\d{4}(–\d{2,4})?\s+", "", label))
        merged[(base, kind)] = merged.get((base, kind), 0) + n
    items = [(label, n, kind) for (label, kind), n in merged.items()]

    picked, seen = [], set()
    for label, n, kind in sorted(items, key=weight, reverse=True):
        text = tidy(label, kind)
        if text.lower() in seen:
            continue
        seen.add(text.lower())
        picked.append(f"{text} ×{n}" if n > 1 else text)
        if len(picked) == limit:
            break
    return " · ".join(picked)


# ── Stage 5: fame, ranking and difficulty ──────────────────────────────────────
def fame_score(sitelinks, n_achievements):
    # Sitelinks do most of the work; achievements add a bonus that flattens out (log) so award
    # collectors don't outrank genuinely famous people.
    return round(sitelinks + 8 * math.log2(1 + n_achievements), 1)


def set_difficulty(group):
    """Within one sport, the most famous 40% are difficulty 1, the next 40% are 2, the rest 3.
    Anyone with 150+ sitelinks is a household name (1) whatever their sport."""
    group.sort(key=lambda e: -e["fame"])
    n = len(group)
    for i, e in enumerate(group):
        e["difficulty"] = 1 if i < n * 0.4 or e["_sitelinks"] >= 150 else 2 if i < n * 0.8 else 3


def build_group(kind, cands, sport, keep, details, achieved, need_achievement):
    group = []
    for q, sl in cands:
        d = details.get(q)
        if not d:
            continue
        items = in_sport(achieved.get(q, []), sport)
        count = sum(i[1] for i in items)
        if need_achievement and count == 0:
            continue
        d = {k: v for k, v in d.items() if k != "_sl"}
        group.append({"id": f"wd-{q}", **d, "sport": sport, "type": kind, "_sitelinks": sl,
                      "fame": fame_score(sl, count), "achievement": summarise(items), "_count": count})
    group.sort(key=lambda e: -e["fame"])
    group = group[:keep]
    set_difficulty(group)
    return group


# ── Stage 7: pictures ──────────────────────────────────────────────────────────
def commons_credits(files, fresh):
    """Author and licence for each Commons file, 50 per request, slowly (Commons answers 429 when hurried)."""
    path = CACHE / "commons.json"
    cache = json.loads(path.read_text()) if path.exists() and not fresh else {}
    todo = sorted(set(files) - set(cache))
    for i in range(0, len(todo), 50):
        batch = todo[i:i + 50]
        params = urllib.parse.urlencode({
            "action": "query", "format": "json", "prop": "imageinfo", "iiprop": "extmetadata", "maxlag": 5,
            "iiextmetadatafilter": "Artist|LicenseShortName", "titles": "|".join("File:" + f for f in batch),
        })
        pages = None
        for attempt in range(5):
            try:
                req = urllib.request.Request(f"{COMMONS_API}?{params}", headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=60) as r:
                    pages = json.load(r)["query"]["pages"].values()
                break
            except (urllib.error.URLError, OSError, KeyError) as err:
                retry_after = getattr(err, "headers", None) and err.headers.get("Retry-After")
                wait = int(retry_after) if retry_after and retry_after.isdigit() else 10 * 2 ** attempt
                print(f"   Commons busy ({err}); waiting {wait}s")
                time.sleep(wait)
        if pages is None:
            print(f"   gave up on {len(batch)} pictures for now; run the script again to fill them in")
            continue
        for page in pages:
            meta = (page.get("imageinfo") or [{}])[0].get("extmetadata", {})
            author = re.sub(r"<[^>]+>", "", meta.get("Artist", {}).get("value", "")).strip()  # Commons gives HTML
            license_ = meta.get("LicenseShortName", {}).get("value", "").strip()
            cache[page["title"].removeprefix("File:")] = [author or "Unknown author", license_]
        CACHE.mkdir(exist_ok=True)
        path.write_text(json.dumps(cache, ensure_ascii=False))
        print(f"   picture credits: {min(i + 50, len(todo))}/{len(todo)}")
        time.sleep(3)
    return cache


def attach_images(entries, fresh, no_image=()):
    # Ids listed under "no_image" in overrides.json never get a picture (e.g. a crest that spells out the city).
    for e in entries:
        if e["id"][3:] in no_image:
            e.pop("_file", None)
    credits = commons_credits([e["_file"] for e in entries if e.get("_file")], fresh)
    gives_away, no_licence, logos_to_check = [], [], []
    for e in entries:
        f = e.pop("_file", None)
        if not f:
            continue
        # Anti-cheat: a file called "Old Trafford Manchester.jpg" would give the answer away.
        # Whole words only ("Port" mustn't match "portrait"), and words already in the name don't
        # count: "Los Angeles Lakers logo.svg" reveals nothing the name hasn't already.
        name_words = set(re.findall(r"[a-z]+", plain(e["name"])))
        city_words = [w for w in re.findall(r"[a-z]+", plain(e["city"])) if len(w) > 3 and w not in name_words]
        if any(w in set(re.findall(r"[a-z]+", plain(f))) for w in city_words):
            gives_away.append(f"{e['name']}: {f}")
            continue
        author, license_ = credits.get(f, (None, None))
        if not license_:
            no_licence.append(f"{e['name']}: {f}")
            continue
        quoted = urllib.parse.quote(f.replace(" ", "_"))
        e["image"] = f"https://commons.wikimedia.org/wiki/Special:FilePath/{quoted}?width={IMAGE_WIDTH}"
        e["imageAuthor"] = author
        e["imageLicense"] = license_
        e["imagePage"] = f"https://commons.wikimedia.org/wiki/File:{quoted}"
        # Logos can carry text like "Ajax Amsterdam". If the city isn't already in the team's name,
        # list the logo so a person can glance at it.
        if e["type"] == "team" and city_words:
            logos_to_check.append(f"{e['name']} ({e['city']}): {e['imagePage']}")
    for title, items in [("Pictures left out because the file name mentions the city", gives_away),
                         ("Pictures left out because Commons has no licence on record", no_licence),
                         ("Logos to spot-check for the city name in the artwork", logos_to_check)]:
        if items:
            print(f"\n{title} ({len(items)}):")
            for line in items:
                print("   ", line)


def review_flags(entries):
    """Athletes who held public office (P39) or were convicted of a crime (P1399) are often famous
    for something other than sport. They're listed so a person can decide."""
    ids = [e["id"][3:] for e in entries if e["type"] == "athlete"]
    flagged = {}
    for batch in in_batches(ids, 200):
        for r in sparql(f"""SELECT ?p ?office ?convicted WHERE {{
          VALUES ?p {{ {values(batch)} }}
          BIND(EXISTS {{ ?p wdt:P39 ?x . }} AS ?office)
          BIND(EXISTS {{ ?p wdt:P1399 ?y . }} AS ?convicted)
        }}"""):
            reasons = [why for key, why in (("office", "held public office"), ("convicted", "convicted of a crime")) if val(r, key) == "true"]
            if reasons:
                flagged["wd-" + qid(val(r, "p"))] = reasons
    return flagged


# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    dry_run, fresh = "--dry-run" in sys.argv, "--fresh" in sys.argv
    overrides = json.loads(OVERRIDES.read_text()) if OVERRIDES.exists() else {"exclude": {}, "include": []}
    excluded = set(overrides.get("exclude", {}))
    skipped = []

    print("Checking Wikidata ids…")
    valid = check_ids()

    # Stage 2: candidates per sport / league (3× the quota, since many won't qualify).
    groups = []  # (kind, sport, keep, candidates, need_achievement)
    for occ, label, sport, keep, min_links in ATHLETE_SPORTS:
        if occ not in valid:
            continue
        print(f"Candidates: {label}…")
        try:
            cands = old_cache_candidates(occ, min_links) if not fresh else None
            cands = cands or cached(f"cand-{occ}", lambda: athlete_candidates(occ, min_links, keep * 3), fresh)
        except QueryFailed:
            skipped.append(sport)
            continue
        groups.append(("athlete", sport, keep, cands, True))
    for key, where, sport, keep, min_links in (
        [(f"cand-{l}", f"?t wdt:P118 wd:{l} .", s, k, m) for l, _, s, k, m in LEAGUES if l in valid]
        + [("cand-world-clubs", f"?t wdt:P31 wd:{WORLD_CLUBS[0]} .", *WORLD_CLUBS[2:])]
    ):
        print(f"Candidates: {key}…")
        try:
            cands = cached(key, lambda: team_candidates(where, min_links, keep * 2), fresh)
        except QueryFailed:
            skipped.append(key)
            continue
        groups.append(("team", sport, keep, cands, False))

    # Hand-picked additions bypass the fame filter but go through the same details and achievements.
    includes = {i["id"]: i for i in overrides.get("include", []) if i["id"] not in excluded}

    # Stages 3 + 4, for everyone at once (cached as a whole; delete the cache file to refresh).
    athlete_ids = sorted({q for kind, _, _, c, _ in groups if kind == "athlete" for q, _ in c} | {q for q, i in includes.items() if i["type"] == "athlete"})
    team_ids = sorted({q for kind, _, _, c, _ in groups if kind == "team" for q, _ in c} | {q for q, i in includes.items() if i["type"] == "team"})
    print(f"\nDetails for {len(athlete_ids)} athletes and {len(team_ids)} teams…")
    details = {}
    try:
        details.update(batched("details-a", athlete_ids, 30, athlete_details, fresh))
        details.update(batched("details-t", team_ids, 30, team_details, fresh))
        places = sorted({d["_place"] for d in details.values() if d.get("_place")})
        print(f"City sizes for {len(places)} places…")
        sizes = batched("sizes", places, 60, city_sizes, fresh)
        for d in details.values():
            area, pop = sizes.get(d.pop("_place", None) or "", [None, None])
            d["radius_km"] = radius_km(area, pop)
        print("Achievements…")
        achieved = batched("achieve", athlete_ids + team_ids, 20, achievements, fresh)
    except QueryFailed:
        raise SystemExit("Wikidata is too busy right now. Every finished batch is cached; run the script again later.")

    # Stage 5
    entries, seen = [], set()
    for kind, sport, keep, cands, need in groups:
        cands = [c for c in cands if c[0] not in excluded and c[0] not in seen]
        group = build_group(kind, cands, sport, keep, details, achieved, need)
        seen.update(e["id"][3:] for e in group)
        print(f"   {sport} {kind}s: kept {len(group)}")
        entries += group

    # Stage 6: includes (fame is still worked out for them, so the review list shows where they sit)
    for q, inc in includes.items():
        if q in seen or q not in details:
            if q not in details:
                print(f"   include {q} ({inc.get('note', '')}): no birthplace/stadium coordinates on Wikidata, skipped")
            continue
        items = in_sport(achieved.get(q, []), inc["sport"])
        d = dict(details[q])
        sl = d.pop("_sl", 0)
        e = {"id": f"wd-{q}", **d, "sport": inc["sport"], "type": inc["type"], "_sitelinks": sl,
             "fame": fame_score(sl, sum(i[1] for i in items)), "achievement": summarise(items),
             "difficulty": inc.get("difficulty", 1), "_count": sum(i[1] for i in items)}
        entries.append(e)
        seen.add(q)

    try:
        flagged = review_flags(entries)
    except QueryFailed:
        flagged = {}
    if flagged:
        print(f"\nPlease review these {len(flagged)} athletes (add any that don't belong to the exclude list in {OVERRIDES.name}):")
        for e in entries:
            if e["id"] in flagged:
                print(f"   {e['id'][3:]:<10} {e['name']} ({e['sport']}): {', '.join(flagged[e['id']])}")

    print("\nPictures…")
    attach_images(entries, fresh, set(overrides.get("no_image", [])))

    # Wikidata sometimes has no country for a birthplace: take it from the country shapes instead.
    missing = [e for e in entries if not e["country"]]
    if missing:
        from validate_players import load_countries, country_at
        shapes = load_countries()
        for e in missing:
            found = country_at(shapes, e["lat"], e["lng"])
            e["country"] = {"United States of America": "United States"}.get(found, found or "")

    print("\nValidating…")
    errors, warnings = validate(entries)
    for _, msg in errors:
        print("   dropped:", msg)
    for _, msg in warnings:
        print("   check:  ", msg)
    drop = {i for i, _ in errors}
    final = [e for i, e in enumerate(entries) if i not in drop]
    final.sort(key=lambda e: -e["fame"])

    write_review(final)
    for e in final:
        for k in ("_sitelinks", "_count"):
            e.pop(k, None)
        if not e.get("achievement"):
            e.pop("achievement", None)

    by_sport = {}
    for e in final:
        by_sport[e["sport"]] = by_sport.get(e["sport"], 0) + 1
    athletes = sum(e["type"] == "athlete" for e in final)
    print(f"\n{len(final)} entries ({athletes} athletes, {len(final) - athletes} teams), "
          f"{sum('image' in e for e in final)} with a picture.")
    print("By sport:", ", ".join(f"{s} {n}" for s, n in sorted(by_sport.items(), key=lambda x: -x[1])))
    if skipped:
        print(f"Skipped after repeated timeouts: {', '.join(skipped)}. Run the script again to fill them in.")
    if dry_run:
        print("Dry run: nothing written.")
        return
    OUT.write_text(json.dumps(final, ensure_ascii=False, indent=1) + "\n")
    print(f"Wrote {OUT} and {REVIEW}")


def write_review(entries):
    """A spreadsheet-friendly list sorted by fame, for spotting odd ones by eye."""
    if "--dry-run" in sys.argv:
        return
    with REVIEW.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["fame", "difficulty", "sitelinks", "achievements", "type", "sport", "name", "city", "country", "radius_km", "picture", "achievement", "wikidata"])
        for e in entries:
            w.writerow([e["fame"], e["difficulty"], e["_sitelinks"], e["_count"], e["type"], e["sport"], e["name"], e["city"],
                        e["country"], e["radius_km"], "yes" if e.get("image") else "", e.get("achievement", ""), e["id"][3:]])


if __name__ == "__main__":
    main()
