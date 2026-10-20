"""Builds data/players.json from Wikidata, then merges in your hand-written entries.

    python3 scripts/build_players.py            # full build
    python3 scripts/build_players.py --dry-run  # build and validate, but don't write the file

What it does
  1. Checks every Wikidata ID used below still means what we think it means (by its English label).
  2. Athletes: for each sport, the most famous people (by number of Wikipedia language editions,
     "sitelinks") who have a birthplace with coordinates.
  3. Teams: clubs in major leagues, located at their home stadium (or headquarters if there's no stadium).
  4. Removes duplicates and anything without coordinates, runs the validator, and drops entries with errors.
  5. Merges data/players.manual.json on top (hand entries win if the same id or name exists).

Needs internet access to query.wikidata.org. No extra packages. Takes a few minutes; Wikidata asks
for a polite pace, so queries run one at a time with a pause between them.
"""
import json
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
MANUAL = ROOT / "data" / "players.manual.json"
ENDPOINT = "https://query.wikidata.org/sparql"

# Wikidata asks every script to identify itself with a way to contact the owner. Put your own details here.
USER_AGENT = "HomeGroundGame/0.1 (set-your-contact-here)"

# Athletes: (occupation ID, expected label, sport name shown in the game, how many to take, min sitelinks)
ATHLETE_SPORTS = [
    ("Q937857", "association football player", "Football", 260, 35),
    ("Q3665646", "basketball player", "Basketball", 110, 25),
    ("Q12299841", "cricketer", "Cricket", 70, 20),
    ("Q10833314", "tennis player", "Tennis", 80, 30),
    ("Q10841764", "Formula One driver", "Formula 1", 50, 30),
    ("Q19204627", "American football player", "American football", 70, 12),
    ("Q10871364", "baseball player", "Baseball", 60, 15),
    ("Q11774891", "ice hockey player", "Ice hockey", 60, 20),
    ("Q11303721", "golfer", "Golf", 35, 20),
    ("Q11513337", "athletics competitor", "Athletics", 80, 35),
    ("Q14089670", "rugby union player", "Rugby union", 45, 12),
    ("Q13414980", "Australian rules football player", "Australian rules football", 25, 5),
    ("Q14373094", "rugby league player", "Rugby league", 25, 6),
]

# Teams: (league ID, expected label, sport name shown in the game, max teams, min sitelinks)
LEAGUES = [
    ("Q9448", "Premier League", "Football", 40, 10),
    ("Q324867", "La Liga", "Football", 40, 10),
    ("Q15804", "Serie A", "Football", 40, 10),
    ("Q82595", "Bundesliga", "Football", 40, 10),
    ("Q13394", "Ligue 1", "Football", 40, 10),
    ("Q18543", "Major League Soccer", "Football", 30, 5),
    ("Q155223", "National Basketball Association", "Basketball", 30, 5),
    ("Q1215884", "National Football League", "American football", 32, 5),
    ("Q1163715", "Major League Baseball", "Baseball", 30, 5),
    ("Q1215892", "National Hockey League", "Ice hockey", 32, 5),
    ("Q396412", "Indian Premier League", "Cricket", 10, 5),
    ("Q50783", "Australian Football League", "Australian rules football", 18, 5),
    ("Q1140630", "National Rugby League", "Rugby league", 17, 5),
]
# Famous football clubs from anywhere (Boca, Flamengo, Al Ahly...) by sitelinks alone.
WORLD_CLUBS = ("Q476028", "association football club", "Football", 150, 45)

# Tidy up a few country labels Wikidata uses.
COUNTRY_NAMES = {
    "People's Republic of China": "China",
    "Kingdom of the Netherlands": "Netherlands",
    "Kingdom of Denmark": "Denmark",
    "United States of America": "United States",
    "State of Palestine": "Palestine",
}


class QueryFailed(Exception):
    """Wikidata kept timing out on one query. We skip that category and carry on."""


def sparql(query, retries=4):
    """Runs one SPARQL query and returns the result rows. Retries politely on timeouts and rate limits."""
    data = urllib.parse.urlencode({"query": query, "format": "json"}).encode()
    for attempt in range(retries):
        req = urllib.request.Request(ENDPOINT, data=data, headers={"User-Agent": USER_AGENT, "Accept": "application/sparql-results+json"})
        try:
            with urllib.request.urlopen(req, timeout=150) as r:  # the football query alone can take ~50 s
                return json.load(r)["results"]["bindings"]
        except (urllib.error.URLError, OSError) as err:  # covers HTTP errors, timeouts and dropped connections
            wait = 5 * 2 ** attempt
            retry_after = getattr(err, "headers", None) and err.headers.get("Retry-After")
            if retry_after and retry_after.isdigit():
                wait = int(retry_after)
            print(f"   query failed ({err}); retrying in {wait}s")
            time.sleep(wait)
    raise QueryFailed("Wikidata didn't answer after several tries")


def val(row, key):
    return row[key]["value"] if key in row else None


def qid(uri):
    return uri.rsplit("/", 1)[-1] if uri else None


def parse_point(wkt):
    # Wikidata coordinates look like "Point(-60.639 -32.947)", i.e. longitude first.
    m = re.match(r"Point\(([-\d.eE]+) ([-\d.eE]+)\)", wkt or "")
    return (float(m.group(2)), float(m.group(1))) if m else (None, None)


def slug(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def check_ids():
    """Stops early if one of our hard-coded IDs now points at something else."""
    ids = [a[0] for a in ATHLETE_SPORTS] + [l[0] for l in LEAGUES] + [WORLD_CLUBS[0]]
    expected = {a[0]: a[1] for a in ATHLETE_SPORTS} | {l[0]: l[1] for l in LEAGUES} | {WORLD_CLUBS[0]: WORLD_CLUBS[1]}
    rows = sparql(f"""SELECT ?x ?label WHERE {{
      VALUES ?x {{ {' '.join('wd:' + i for i in ids)} }}
      ?x rdfs:label ?label . FILTER(LANG(?label) IN ("en", "mul"))  # "mul" = one label shared by all languages
    }}""")
    labels = {}
    for r in rows:
        labels.setdefault(qid(val(r, "x")), set()).add(val(r, "label").lower())
    bad = [f"{i}: expected '{expected[i]}', Wikidata says {sorted(labels.get(i, [])) or 'nothing'}" for i in ids if expected[i].lower() not in labels.get(i, set())]
    if bad:
        print("These IDs don't match their expected labels; their categories will be skipped:\n  " + "\n  ".join(bad))
    return {i for i in ids if i not in {b.split(":")[0] for b in bad}}


def difficulty_by_rank(entries):
    """Within each group, the most famous third is difficulty 1, the next third 2, the rest 3."""
    entries.sort(key=lambda e: -e["_sitelinks"])
    n = len(entries)
    for i, e in enumerate(entries):
        e["difficulty"] = 1 if i < n * 0.35 else 2 if i < n * 0.7 else 3


def fetch_athletes(occupation, sport, limit, min_links):
    # The inner query finds the most-linked people first (fast); the outer one adds birthplace details.
    rows = sparql(f"""
    SELECT ?p ?pLabel ?sl ?place ?placeLabel ?coord ?countryLabel WHERE {{
      {{
        SELECT ?p ?sl WHERE {{
          ?p wdt:P106 wd:{occupation} ; wdt:P31 wd:Q5 ; wikibase:sitelinks ?sl .
          FILTER(?sl >= {min_links})
        }} ORDER BY DESC(?sl) LIMIT {limit * 2}
      }}
      ?p wdt:P19 ?place .
      ?place wdt:P625 ?coord .
      OPTIONAL {{ ?place wdt:P17 ?country . }}
      SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
    }}""")
    out = {}
    for r in rows:
        pid = qid(val(r, "p"))
        name = val(r, "pLabel")
        if pid in out or not name or re.fullmatch(r"Q\d+", name):  # skip repeats and people with no English name
            continue
        lat, lng = parse_point(val(r, "coord"))
        if lat is None:
            continue
        country = val(r, "countryLabel") or ""
        out[pid] = {
            "id": f"wd-{pid}", "name": name, "sport": sport, "type": "athlete",
            "city": val(r, "placeLabel"), "country": COUNTRY_NAMES.get(country, country),
            "lat": round(lat, 4), "lng": round(lng, 4), "_sitelinks": int(val(r, "sl")),
        }
    athletes = sorted(out.values(), key=lambda e: -e["_sitelinks"])[:limit]
    difficulty_by_rank(athletes)
    return athletes


def fetch_teams(where, sport, limit, min_links):
    rows = sparql(f"""
    SELECT ?t ?tLabel ?sl ?venueLabel ?vcoord ?vcityLabel ?vcountryLabel ?hq ?hqLabel ?hqcoord ?hqcountryLabel WHERE {{
      {{
        SELECT DISTINCT ?t ?sl WHERE {{
          {where}
          ?t wikibase:sitelinks ?sl .
          FILTER(?sl >= {min_links})
          FILTER NOT EXISTS {{ ?t wdt:P576 ?dissolved . }}
        }} ORDER BY DESC(?sl) LIMIT {limit * 2}
      }}
      OPTIONAL {{ ?t wdt:P115 ?venue . ?venue wdt:P625 ?vcoord .
                  OPTIONAL {{ ?venue wdt:P131 ?vcity . }} OPTIONAL {{ ?venue wdt:P17 ?vcountry . }} }}
      OPTIONAL {{ ?t wdt:P159 ?hq . ?hq wdt:P625 ?hqcoord . OPTIONAL {{ ?hq wdt:P17 ?hqcountry . }} }}
      SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
    }}""")
    out = {}
    for r in rows:
        tid = qid(val(r, "t"))
        name = val(r, "tLabel")
        if tid in out or not name or re.fullmatch(r"Q\d+", name):
            continue
        # Prefer the stadium; fall back to the headquarters city.
        if val(r, "vcoord"):
            lat, lng = parse_point(val(r, "vcoord"))
            city, country = val(r, "vcityLabel") or val(r, "hqLabel"), val(r, "vcountryLabel") or val(r, "hqcountryLabel")
            hint = f"Home ground: {val(r, 'venueLabel')}"
        else:
            lat, lng = parse_point(val(r, "hqcoord"))
            city, country, hint = val(r, "hqLabel"), val(r, "hqcountryLabel"), None
        if lat is None or not city or re.fullmatch(r"Q\d+", city):
            continue
        entry = {
            "id": f"wd-{tid}", "name": name, "sport": sport, "type": "team",
            "city": city, "country": COUNTRY_NAMES.get(country or "", country or ""),
            "lat": round(lat, 4), "lng": round(lng, 4), "_sitelinks": int(val(r, "sl")),
        }
        if hint:
            entry["hint"] = hint
        out[tid] = entry
    teams = sorted(out.values(), key=lambda e: -e["_sitelinks"])[:limit]
    difficulty_by_rank(teams)
    return teams


skipped = []


def attempt(fetch, *args):
    """Runs one category's query; if Wikidata keeps failing, note it and move on instead of stopping."""
    try:
        return fetch(*args)
    except QueryFailed as err:
        print(f"   skipped: {err}")
        skipped.append(args[-3] if fetch is fetch_teams else args[1])
        return []


def main():
    dry_run = "--dry-run" in sys.argv
    if "set-your-contact-here" in USER_AGENT:
        print("Tip: put your own contact in USER_AGENT at the top of this script (Wikidata asks for it).\n")

    print("Checking Wikidata IDs…")
    valid = check_ids()
    entries = []

    for occ, label, sport, limit, min_links in ATHLETE_SPORTS:
        if occ not in valid:
            continue
        print(f"Athletes: {label}…")
        got = attempt(fetch_athletes, occ, sport, limit, min_links)
        print(f"   {len(got)} found")
        entries += got
        time.sleep(2)

    for league, label, sport, limit, min_links in LEAGUES:
        if league not in valid:
            continue
        print(f"Teams: {label}…")
        got = attempt(fetch_teams, f"?t wdt:P118 wd:{league} .", sport, limit, min_links)
        print(f"   {len(got)} found")
        entries += got
        time.sleep(2)

    club_type, label, sport, limit, min_links = WORLD_CLUBS
    if club_type in valid:
        print("Teams: famous football clubs worldwide…")
        got = attempt(fetch_teams, f"?t wdt:P31 wd:{club_type} .", sport, limit, min_links)
        print(f"   {len(got)} found")
        entries += got

    # De-duplicate: the same person or club can turn up in several queries. Keep the first.
    seen, unique = set(), []
    for e in entries:
        if e["id"] not in seen:
            seen.add(e["id"])
            unique.append(e)

    # Hand-written entries win over Wikidata ones with the same id or the same name.
    manual = json.loads(MANUAL.read_text()) if MANUAL.exists() else []
    manual_names = {(m["name"].lower(), m["type"]) for m in manual}
    manual_ids = {m["id"] for m in manual}
    unique = [e for e in unique if e["id"] not in manual_ids and (e["name"].lower(), e["type"]) not in manual_names]
    for e in unique:
        e.pop("_sitelinks", None)
    combined = manual + unique

    print("\nValidating…")
    errors, warnings = validate(combined)
    for _, msg in errors:
        print("   dropped:", msg)
    for _, msg in warnings[:60]:
        print("   check:  ", msg)
    if len(warnings) > 60:
        print(f"   …and {len(warnings) - 60} more warnings (run validate_players.py to see them all)")
    drop = {i for i, _ in errors}
    final = [e for i, e in enumerate(combined) if i not in drop]

    athletes = sum(e["type"] == "athlete" for e in final)
    print(f"\n{len(final)} entries ({athletes} athletes, {len(final) - athletes} teams); {len(manual)} from the manual file.")
    if skipped:
        print(f"Skipped after repeated timeouts: {', '.join(skipped)}. Run the script again later to fill them in.")
    if dry_run:
        print("Dry run: nothing written.")
        return
    OUT.write_text(json.dumps(final, ensure_ascii=False, indent=1) + "\n")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
