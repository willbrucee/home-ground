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
  6. Adds a picture: athlete photo (Wikidata P18) or team logo (P154), plus its author and licence
     from Wikimedia Commons. Pictures whose file name mentions the answer city are left out.

Each category's Wikidata answer is cached in scripts/.cache/, so a rerun only re-asks for what failed.
Add --fresh to ignore the cache and fetch everything again.

Needs internet access to query.wikidata.org. No extra packages. Takes a few minutes; Wikidata asks
for a polite pace, so queries run one at a time with a pause between them.
"""
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
MANUAL = ROOT / "data" / "players.manual.json"
ENDPOINT = "https://query.wikidata.org/sparql"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
CACHE = ROOT / "scripts" / ".cache"
IMAGE_WIDTH = 400  # pixels; Commons makes a small copy of this width for us

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


def file_name(url):
    """Wikidata gives images as .../Special:FilePath/Some_File.jpg. We keep just the file name."""
    if not url:
        return None
    return urllib.parse.unquote(url.rsplit("/", 1)[-1]).replace("_", " ")


def plain(text):
    """Lower case without accents, for loose text comparisons."""
    return unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()


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
    SELECT ?p ?pLabel ?sl ?place ?placeLabel ?coord ?countryLabel ?img WHERE {{
      {{
        SELECT ?p ?sl WHERE {{
          ?p wdt:P106 wd:{occupation} ; wikibase:sitelinks ?sl .  # an occupation already implies a person
          FILTER(?sl >= {min_links})
        }} ORDER BY DESC(?sl) LIMIT {limit * 2}
      }}
      ?p wdt:P19 ?place .
      ?place wdt:P625 ?coord .
      OPTIONAL {{ ?place wdt:P17 ?country . }}
      OPTIONAL {{ ?p wdt:P18 ?img . }}  # photo
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
            "_file": file_name(val(r, "img")),
        }
    athletes = sorted(out.values(), key=lambda e: -e["_sitelinks"])[:limit]
    difficulty_by_rank(athletes)
    return athletes


def fetch_teams(where, sport, limit, min_links):
    rows = sparql(f"""
    SELECT ?t ?tLabel ?sl ?venueLabel ?vcoord ?vcityLabel ?vcountryLabel ?hq ?hqLabel ?hqcoord ?hqcountryLabel ?img WHERE {{
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
      OPTIONAL {{ ?t wdt:P154 ?img . }}  # logo
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
            "_file": file_name(val(r, "img")),
        }
        if hint:
            entry["hint"] = hint
        out[tid] = entry
    teams = sorted(out.values(), key=lambda e: -e["_sitelinks"])[:limit]
    difficulty_by_rank(teams)
    return teams


skipped = []


def attempt(fetch, *args, key, fresh):
    """Runs one category's query, using the cached answer if we have one.
    If Wikidata keeps failing, note it and move on instead of stopping."""
    cached = CACHE / f"{key}.json"
    if cached.exists() and not fresh:
        return json.loads(cached.read_text())
    try:
        got = fetch(*args)
    except QueryFailed as err:
        print(f"   skipped: {err}")
        skipped.append(key)
        return []
    CACHE.mkdir(exist_ok=True)
    cached.write_text(json.dumps(got, ensure_ascii=False))
    return got


def find_images_by_name(entries):
    """Hand-written entries have no Wikidata id, so look their pictures up by name.
    Names can be shared (there are several "Crusaders"), so a match only counts if the item's
    birthplace or stadium is within 60 km of our entry. Among those, the best-known one wins."""
    if not entries:
        return {}
    wanted = {(e["name"], e["type"]): e for e in entries}
    values = " ".join('"' + n.replace('"', '\\"') + '"@en' for n, _ in wanted)
    rows = sparql(f"""
    SELECT ?name ?img ?sl ?kind ?c WHERE {{
      VALUES ?name {{ {values} }}
      ?x rdfs:label ?name ; wikibase:sitelinks ?sl .
      {{ ?x wdt:P31 wd:Q5 ; wdt:P18 ?img ; wdt:P19/wdt:P625 ?c . BIND("athlete" AS ?kind) }}
      UNION {{ ?x wdt:P154 ?img ; wdt:P115/wdt:P625 ?c . BIND("team" AS ?kind) }}
      UNION {{ ?x wdt:P154 ?img ; wdt:P159/wdt:P625 ?c . BIND("team" AS ?kind) }}
    }}""")
    best = {}
    for r in rows:
        key = (val(r, "name"), val(r, "kind"))
        e = wanted.get(key)
        lat, lng = parse_point(val(r, "c"))
        if not e or lat is None or km_between(lat, lng, e["lat"], e["lng"]) > 60:
            continue
        sl = int(val(r, "sl"))
        if key not in best or sl > best[key][0]:
            best[key] = (sl, file_name(val(r, "img")))
    return {k: v[1] for k, v in best.items()}


def km_between(lat1, lng1, lat2, lng2):
    """Great-circle distance (haversine), in km."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def commons_credits(files):
    """Author and licence for each Commons file, 50 files per request."""
    out = {}
    files = sorted(set(files))
    for i in range(0, len(files), 50):
        batch = files[i:i + 50]
        params = urllib.parse.urlencode({
            "action": "query", "format": "json", "prop": "imageinfo", "iiprop": "extmetadata",
            "iiextmetadatafilter": "Artist|LicenseShortName", "titles": "|".join("File:" + f for f in batch),
        })
        req = urllib.request.Request(f"{COMMONS_API}?{params}", headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                pages = json.load(r)["query"]["pages"].values()
        except (urllib.error.URLError, OSError) as err:
            print(f"   Commons request failed ({err}); those pictures are left out")
            continue
        for page in pages:
            meta = (page.get("imageinfo") or [{}])[0].get("extmetadata", {})
            author = re.sub(r"<[^>]+>", "", meta.get("Artist", {}).get("value", "")).strip()  # Commons gives HTML
            license_ = meta.get("LicenseShortName", {}).get("value", "").strip()
            out[page["title"].removeprefix("File:")] = (author or "Unknown author", license_)
        time.sleep(1)
    return out


def attach_images(entries, manual_lookup):
    """Turns each entry's file name into image fields, or drops the picture if it's unusable."""
    files = {}
    for e in entries:
        f = e.pop("_file", None) or manual_lookup.get((e["name"], e["type"]))
        if f:
            files[e["id"]] = f
    credits = commons_credits(files.values())
    dropped_for_city, no_licence, logos_to_check = [], [], []
    for e in entries:
        f = files.get(e["id"])
        if not f:
            continue
        # Anti-cheat: a file called "Old Trafford Manchester.jpg" would give the answer away.
        city_words = [w for w in re.split(r"[ ,/-]+", plain(e["city"])) if len(w) > 3]
        if any(w in plain(f) for w in city_words):
            dropped_for_city.append(f"{e['name']}: {f}")
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
        # Logos can carry text such as "Ajax Amsterdam". If the team's name doesn't already
        # contain its city, list the logo so a person can glance at it.
        if e["type"] == "team" and not any(w in plain(e["name"]) for w in city_words):
            logos_to_check.append(f"{e['name']} ({e['city']}): {e['imagePage']}")
    with_image = sum("image" in e for e in entries)
    print(f"Pictures: {with_image} of {len(entries)} entries have one.")
    for title, items in [("Left out because the file name mentions the city", dropped_for_city),
                         ("Left out because Commons has no licence on record", no_licence),
                         ("Logos to spot-check for city names in the artwork", logos_to_check)]:
        if items:
            print(f"   {title} ({len(items)}):")
            for line in items:
                print("     ", line)


def main():
    dry_run = "--dry-run" in sys.argv
    fresh = "--fresh" in sys.argv
    if "set-your-contact-here" in USER_AGENT:
        print("Tip: put your own contact in USER_AGENT at the top of this script (Wikidata asks for it).\n")

    print("Checking Wikidata IDs…")
    valid = check_ids()
    entries = []

    for occ, label, sport, limit, min_links in ATHLETE_SPORTS:
        if occ not in valid:
            continue
        print(f"Athletes: {label}…")
        got = attempt(fetch_athletes, occ, sport, limit, min_links, key=f"athletes-{occ}", fresh=fresh)
        print(f"   {len(got)} found")
        entries += got
        if not (CACHE / f"athletes-{occ}.json").exists() or fresh:
            time.sleep(2)

    for league, label, sport, limit, min_links in LEAGUES:
        if league not in valid:
            continue
        print(f"Teams: {label}…")
        got = attempt(fetch_teams, f"?t wdt:P118 wd:{league} .", sport, limit, min_links, key=f"league-{league}", fresh=fresh)
        print(f"   {len(got)} found")
        entries += got
        time.sleep(2)

    club_type, label, sport, limit, min_links = WORLD_CLUBS
    if club_type in valid:
        print("Teams: famous football clubs worldwide…")
        got = attempt(fetch_teams, f"?t wdt:P31 wd:{club_type} .", sport, limit, min_links, key="world-clubs", fresh=fresh)
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

    print("\nFinding pictures…")
    try:
        manual_lookup = find_images_by_name([m for m in manual if not m.get("image")])
    except QueryFailed:
        manual_lookup = {}
    attach_images(combined, manual_lookup)

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
