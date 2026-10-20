"""Keeping the answer out of everything shown before the guess.

A team called "Los Angeles Dodgers" gives the game away, so each team gets a display_name with the
place taken out ("Dodgers"). The place words for each entry (its city, the regions that city sits in,
and its country) are also saved to data/answer-words.json, so pick_images.py can reject pictures whose
text (or file name) names the answer.

Used by build_players.py; not run on its own.
"""
import hashlib
import json
import pathlib
import re
import unicodedata

from build_players import sparql, val, qid, values, in_batches, batched, cached

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORDS_OUT = ROOT / "data" / "answer-words.json"
NO_NICKNAME = ROOT / "data" / "no-nickname.json"

# Words inside place names that say nothing about where a place is ("New", "United", "Saint"…).
# They're only removed from a team name as part of a whole place name ("New York"), never alone.
GENERIC = set("""new old north south east west upper lower great greater united states kingdom republic federal
of the and de del la le las los el san santa saint st city county district region province state metropolitan
borough municipality island islands bay port fort mount lake river valley""".split())
# Club-type words: "FC", "Football Club", "Calcio"… removed from display names.
ORG = set("""fc f c afc cf sc ac ssc ss as rcd cd sl s l c f a club football futbol fútbol calcio clube regatas do
de del da di of the and & associazione sportiva societa società sport sporting? 1907 1899 1900 1903 1909 bc
hc kk sk fk nk bk if ik spvgg vfl vfb tsv sv fsv bv jk balompie balompié""".replace("?", "").split())
# Left-overs that don't make a name on their own ("Real Madrid" minus Madrid is just "Real").
WEAK = set("""real united city athletic atletico atlético sporting racing olympique olympic town rovers wanderers
county albion borussia athletico deportivo dynamo dinamo club ac""".split())
# Region nicknames used in team names that aren't the name of any place on Wikidata.
EXTRA_PLACES = {"california": ["golden state"], "massachusetts": ["new england"], "florida": ["tampa bay"],
                "tampa": ["tampa bay"], "los angeles": ["LA", "L.A."], "new york": ["NY"], "manchester": ["Man"],
                "kansas city": ["KC"]}


def fold(text):
    """Lower-case, accents off, letters only: "Barça" → "barca"."""
    text = unicodedata.normalize("NFKD", text or "")
    return re.sub(r"[^a-z0-9 ]+", " ", "".join(c for c in text if not unicodedata.combining(c)).lower()).strip()


def regions(place_ids):
    """{place: [its label, the labels of up to 3 levels of regions it sits in, its country]}."""
    out = {}
    for batch in in_batches(place_ids, 60):
        rows = sparql(f"""SELECT ?p ?label WHERE {{
          VALUES ?p {{ {values(batch)} }}
          {{ ?p rdfs:label ?label }} UNION {{ ?p wdt:P131 ?a . ?a rdfs:label ?label }}
          UNION {{ ?p wdt:P131/wdt:P131 ?a . ?a rdfs:label ?label }} UNION {{ ?p wdt:P131/wdt:P131/wdt:P131 ?a . ?a rdfs:label ?label }}
          UNION {{ ?p wdt:P17 ?a . ?a rdfs:label ?label }}
          FILTER(LANG(?label) IN ("en", "mul", "it", "es", "de", "fr", "pt", "nl", "tr", "ca"))  # "Roma", "Napoli", "Milano"…
        }}""")
        for r in rows:
            out.setdefault(qid(val(r, "p")), set()).add(val(r, "label"))
    return {k: sorted(v) for k, v in out.items()}


PLACE_KIND = re.compile(r"suburb|district|neighbo|locality|village|town|city|ward|parish|quarter|borough|"
                        r"settlement|municipalit|commune|hamlet|area of|mahalle|freguesia|barrio|stadtteil", re.I)
NICK_LANGS = ["en", "es", "it", "pt", "ca", "fr", "de", "nl", "tr"]  # English first, then the clubs' own languages


def nicknames(team_ids):
    """{team: [nicknames on Wikidata (P1449), English ones first]}. Only Latin-script languages."""
    out = {}
    for batch in in_batches(team_ids, 80):
        rows = sparql(f"""SELECT ?t ?n (LANG(?n) AS ?l) WHERE {{ VALUES ?t {{ {values(batch)} }} ?t wdt:P1449 ?n .
          FILTER(LANG(?n) IN ({", ".join(f'"{l}"' for l in NICK_LANGS)})) }}""")
        for r in sorted(rows, key=lambda r: NICK_LANGS.index(val(r, "l"))):
            out.setdefault(qid(val(r, "t")), []).append(re.sub(r"^I\s+", "", val(r, "n")))  # "I Rossoneri" → "Rossoneri"
    return out


def districts(teams):
    """{team id: [names of places within 30 km that share a word with the team's name]}. Catches clubs named
    after a district of their city (Chelsea, Everton, Benfica, Essendon), which no city or region list has."""
    import json as _json
    import math
    out = {}
    for batch in in_batches(teams, 6):
        blocks, wanted = [], {}
        for tid, name, lat, lng in batch:
            for tok in {name}:  # the whole remaining name: "Chelsea", "Essendon" (single words like "Maple" are too common)
                wanted.setdefault(fold(tok), []).append((tid, lat, lng))
        for tok in wanted:
            blocks.append(f"""{{ SERVICE wikibase:mwapi {{ bd:serviceParam wikibase:endpoint "www.wikidata.org"; wikibase:api "EntitySearch";
                wikibase:limit 12; mwapi:search {_json.dumps(tok)}; mwapi:language "en". ?item wikibase:apiOutputItem mwapi:item. }}
              ?item wdt:P625 ?coord ; rdfs:label ?lab ; wdt:P31 ?c . ?c rdfs:label ?cl .
              FILTER(LANG(?lab) IN ("en", "mul")) FILTER(LANG(?cl) = "en") BIND({_json.dumps(tok)} AS ?tok) }}""")
        rows = sparql("SELECT ?tok ?lab ?coord ?cl WHERE { " + " UNION ".join(blocks) + " }")
        for r in rows:
            # only places people live in: suburbs, districts, towns (not stations, museums or stadiums)
            if fold(val(r, "lab")) != val(r, "tok") or not PLACE_KIND.search(val(r, "cl") or ""):
                continue
            m = re.match(r"Point\(([-\d.]+) ([-\d.]+)\)", val(r, "coord") or "")
            if not m:
                continue
            plng, plat = float(m.group(1)), float(m.group(2))
            for tid, lat, lng in wanted[val(r, "tok")]:
                if math.hypot((plng - lng) * math.cos(math.radians(lat)), plat - lat) * 111.2 <= 30:
                    out.setdefault(tid, set()).add(val(r, "lab"))
    return {k: sorted(v) for k, v in out.items()}


_towns = None


def nearby_towns(lat, lng, km=60):
    """Towns of 15,000+ people (GeoNames) within `km` of a point: a team is often named after the big city
    next to its stadium's town (the Dallas Cowboys play in Arlington)."""
    global _towns
    if _towns is None:
        _towns = []
        path = ROOT / "data" / "places.tsv"
        for line in path.read_text(encoding="utf-8").splitlines() if path.exists() else []:
            if line and not line.startswith("#"):
                n, _, la, ln = line.split("\t")
                _towns.append((n, float(la), float(ln)))
    import math
    out = []
    for n, la, ln in _towns:
        if abs(la - lat) < km / 111 and math.hypot((ln - lng) * math.cos(math.radians(lat)), la - lat) * 111.2 < km:
            out.append(n)
    return out


def place_words(entry, labels):
    """Every place name that would give this entry's answer away (as written, not folded)."""
    words = {entry.get("city", ""), entry.get("country", "")} | set(labels)
    # nearby towns, but only those that appear in the entry's name (the full list is long)
    name = f" {fold(entry['name'])} "
    near = nearby_towns(entry["lat"], entry["lng"])
    for key, extra in EXTRA_PLACES.items():  # "LA" Galaxy play in Carson, next to Los Angeles
        if any(fold(t) == key for t in near):
            words |= {x for x in extra if f" {fold(x)} " in name}
    for town in near:
        if f" {fold(town)} " in name:
            words.add(town)
        else:  # a distinctive part of a town's name: "Saint-Germain" from Saint-Germain-en-Laye
            words |= {t for t in fold(town).split() if len(t) >= 5 and t not in GENERIC and f" {t} " in name}
    for key, extra in EXTRA_PLACES.items():
        if any(fold(w) == key for w in words):
            words |= set(extra)
    words = {re.sub(r"\s*\(.*\)$", "", w) for w in words}  # "Georgia (U.S. state)" → "Georgia"
    return sorted(w for w in words if len(w) > 1 and not re.match(r"^Q\d+$", w))


def place_tokens(words):
    """The folded single words of those place names that mean something on their own ("carolina", "york")."""
    return {t for w in words for t in fold(w).split() if len(t) > 2 and t not in GENERIC}


def mentions_place(text, words):
    """Does this text name the answer's place? Matches whole place names and their distinctive words,
    and near-misses like "Barça" for Barcelona (a shared start of 4+ letters)."""
    f = f" {fold(text)} "
    tokens = place_tokens(words)
    if any(f" {fold(w)} " in f for w in words if fold(w)):
        return True
    for t in f.split():
        if t in tokens:
            return True
        if len(t) >= 4 and any(p.startswith(t) or (len(p) >= 5 and t.startswith(p[:5])) for p in tokens):
            return True
    return False


def strip_places(name, words):
    """The team name with the place, the club-type words and the left-over joins taken out."""
    out = f" {name} "
    for w in sorted(words, key=len, reverse=True):  # whole place names first ("New York" before "York")
        out = re.sub(rf"(?<![\w]){re.escape(w)}(?![\w])", " § ", out, flags=re.I)
    tokens = place_tokens(words)
    parts = ["§" if fold(t) in tokens else t for t in out.split()]
    parts = [t for t in parts if t == "§" or fold(t).replace(" ", "") not in ORG]
    # a generic word right next to a removed place belonged to it: "Tampa Bay Rays" → "Rays"
    edge = GENERIC | {"de", "of", "and"}
    changed = True
    while changed:
        changed = False
        for i, t in enumerate(parts):
            if t != "§" and fold(t) in edge and ((i > 0 and parts[i - 1] == "§") or (i + 1 < len(parts) and parts[i + 1] == "§")):
                parts[i] = "§"
                changed = True
    return " ".join(t for t in parts if t != "§")


def display_name(entry, words, nicks, chosen=None):
    """(display name, how it was made) or (None, reason) when there's no fair name."""
    if chosen:
        return chosen, "chosen by hand"
    stripped = strip_places(entry["name"], words)
    if not re.search(r"[^\W\d_]{3,}", stripped):  # "04" is not a name
        stripped = ""
    if stripped and not all(fold(w) in WEAK for w in stripped.split()) and not mentions_place(stripped, words):
        return stripped, "name without the place"
    clean = [re.sub(r"^the\s+", "The ", n.strip(), flags=re.I) for n in nicks if not mentions_place(n, words)]
    clean = [n for n in clean if len(n.split()) <= 3 and n.lower() != entry["name"].lower()
             and not all(fold(w) in WEAK | {"the"} for w in n.split())]
    if clean:
        return min(clean, key=len), "Wikidata nickname"
    return None, f'"{stripped or entry["name"]}" is all that is left without the place, and Wikidata has no clean nickname'


def apply(entries, fresh=False, chosen=None):
    """Adds display_name to every entry, drops teams with no fair name, writes data/answer-words.json.
    Returns the entries to keep."""
    place_ids = sorted({e["_place"] for e in entries if e.get("_place")})
    labels = batched("regions", place_ids, 60, regions, fresh)
    nicks = batched("nicknames", [e["id"][3:] for e in entries if e["type"] == "team"], 80, nicknames, fresh)
    teams = [e for e in entries if e["type"] == "team"]
    probe = [(e["id"], re.sub(r"\s*\d+\s*", " ", strip_places(e["name"], place_words(e, labels.get(e.get("_place") or "", []))) or e["name"]).strip(),
              e["lat"], e["lng"]) for e in teams]  # digits off: "Schalke 04" → "Schalke"
    local = {}
    for batch in in_batches(probe, 6):
        key = "districts-" + hashlib.md5(json.dumps(batch).encode()).hexdigest()[:10]
        local.update(cached(key, lambda b=batch: districts(b), fresh))
    keep, dropped, answer_words = [], [], {}
    for e in entries:
        words = place_words(e, labels.get(e.pop("_place", None) or "", [])) + local.get(e["id"], [])
        answer_words[e["id"]] = words
        if e["type"] == "team":
            name, how = display_name(e, words, nicks.get(e["id"][3:], []), (chosen or {}).get(e["id"][3:]))
            if not name:
                dropped.append({"id": e["id"], "name": e["name"], "why": how, "nicknames": nicks.get(e["id"][3:], [])})
                continue
            e["display_name"] = name
        else:
            e["display_name"] = e["name"]
            if mentions_place(e["name"], words):
                print(f"   note: {e['name']}'s name contains a place word of their birthplace")
        keep.append(e)
    # Two teams can't share a name ("Inter" for Inter Milan and Inter Miami): the less famous one takes a nickname.
    seen = {}
    for e in sorted(keep, key=lambda e: -e.get("fame", 0)):
        if e["type"] != "team":
            continue
        if e["display_name"].lower() in seen:
            words = answer_words[e["id"]]
            other = [n for n in nicks.get(e["id"][3:], []) if not mentions_place(n, words) and n.lower() not in seen]
            if other:
                e["display_name"] = min(other, key=len)
        seen[e["display_name"].lower()] = e["id"]
    WORDS_OUT.write_text(json.dumps({e["id"]: answer_words[e["id"]] for e in keep}, ensure_ascii=False, indent=0) + "\n")
    NO_NICKNAME.write_text(json.dumps(dropped, ensure_ascii=False, indent=1) + "\n")
    print(f"\nDisplay names: {len(dropped)} team(s) left out with no name that hides the city (see {NO_NICKNAME.name}).")
    for d in dropped:
        print(f"   {d['name']}: {d['why']}")
    return keep
