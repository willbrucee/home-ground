"""Picks a picture for every entry in data/players.json: an ACTION photo for athletes, the club logo for teams.

    python3 scripts/pick_images.py            # pick pictures, move entries without one to data/reserve.json
    python3 scripts/pick_images.py --fresh    # ignore cached Commons answers

How a picture is chosen
  Athletes: candidates come from three places, then each is scored:
    - their Commons category (Wikidata P373): files that are about them
    - a Commons search for "<name> <sport>"
    - their main Wikidata image (P18), which is often a portrait
  Points for action words (match, final, race, serve, "vs"...) and the sport's own terms, a landscape
  or square shape, a good resolution and the person's name in the title. Points off for portraits,
  press conferences, red carpets, statues, team photos and so on. Rejected outright: no free licence,
  too small, not a photo, or the answer city named in the file name or description (anti-cheat).
  Teams: their logo (P154). With no logo, an action photo of the team; with neither, the team is
  moved to data/reserve.json rather than shown without a picture.

Commons is asked through the Wikidata query service ("MWAPI"), which runs the Commons API calls on
Wikimedia's side. Asking Commons directly hits its rate limits within a few requests.

Your overrides live in data/images.json:
  { "wd-Q615": { "use": "Lionel Messi 2022.jpg" },          use this file
    "wd-Q123": { "reject": ["Some bad file.jpg"] },          never use these files
    "wd-Q456": { "none": true } }                            no picture: move to the reserve
"""
import hashlib
from concurrent.futures import ThreadPoolExecutor
import json
import pathlib
import re
import sys
import time
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from build_players import sparql, val, qid, values, in_batches, plain, cached, QueryFailed  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLAYERS = ROOT / "data" / "players.json"
RESERVE = ROOT / "data" / "reserve.json"
OVERRIDES = ROOT / "data" / "images.json"
ANSWER_WORDS = ROOT / "data" / "answer-words.json"  # place names per entry, written by build_players.py
WIDTH = 600         # logos: Commons serves a resized copy this wide
PHOTO_WIDTH = 1280  # athlete photos: large enough to stay sharp in the 4:5 card frame (a standard Commons size)
REPORT = ROOT / "data" / "image-report.json"  # face box and numbers per picture, for contact-sheet.html

FREE_LICENCE = re.compile(r"^(cc[ -]?by|cc0|public domain|pd\b|pd-|attribution)", re.I)
PHOTO_FILE = re.compile(r"\.(jpe?g|png|webp)$", re.I)
LOGO_FILE = re.compile(r"\.(svg|png|jpe?g|gif|webp)$", re.I)

# Words that suggest the person is playing.
ACTION = re.compile(r"\b(match|game|playing|plays|played|during|vs\.?|v\.|versus|final|finals|semi.?final|race|racing|"
                    r"serve|serving|in action|tournament|season|cup|championship|open|grand prix|lap|round|dunk|shot|"
                    r"goal|scores|kick|tackle|run|running|sprint|heat|stage|bout|fight|olympic|olympics|games|"
                    r"qualif\w*|derby|league|warm.?up|training|celebrat\w*|competition|world cup|tour)\b", re.I)
# The sport's own vocabulary adds a little more.
SPORT_TERMS = {
    "Football": r"football|soccer|fifa|uefa|premier league|la liga|serie a|bundesliga|ligue 1|copa|euro \d{4}",
    "Basketball": r"basketball|nba|fiba|dunk|euroleague",
    "Tennis": r"tennis|atp|wta|wimbledon|roland.?garros|us open|australian open|davis cup|serve|forehand|backhand",
    "Athletics": r"athletics|100 ?m|200 ?m|400 ?m|800 ?m|1500 ?m|marathon|hurdles|relay|long jump|high jump|pole vault|javelin|discus|shot put|diamond league",
    "Formula 1": r"formula (one|1)|f1|grand prix|gp|pit|qualifying|ferrari|mclaren|mercedes|red bull|williams|renault",
    "Cricket": r"cricket|test match|odi|t20|ipl|innings|batting|bowling|wicket|ashes",
    "American football": r"nfl|football|super bowl|touchdown|quarterback|pro bowl",
    "Baseball": r"baseball|mlb|pitch(ing|er)?|batting|world series|inning",
    "Ice hockey": r"hockey|nhl|ice|stanley cup|iihf",
    "Golf": r"golf|pga|masters|open championship|ryder cup|tee|putt|swing",
    "Boxing": r"boxing|bout|fight|wbc|wba|ibf|wbo|ring",
    "Cycling": r"cycling|tour de france|giro|vuelta|stage|peloton|time trial|velodrome|bike|bicycle",
    "Rugby union": r"rugby|six nations|world cup|scrum|try",
    "Rugby league": r"rugby league|nrl|state of origin|super league",
    "MMA": r"ufc|mma|bellator|fight",
    "Australian rules football": r"afl|vfl|aussie rules|australian football|mcg",
}
def core_team_name(name):
    """'Real Madrid Club de Fútbol' → 'real madrid'; 'Manchester United F.C.' → 'manchester united'."""
    n = plain(name)
    n = re.sub(r"\b(f\.?c\.?|c\.?f\.?|a\.?f\.?c\.?|s\.?c\.?|s\.?k\.?|s\.?l\.?|club de futbol|club|football|futbol|"
               r"calcio|associazione|sportiva|de futebol)\b", " ", n)
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", n)).strip()


# Words that suggest it isn't a sports shot (or isn't really a photo of them).
NOT_SPORT = re.compile(r"portrait|headshot|head shot|press conference|conference|signing|signs|interview|premiere|"
                       r"red carpet|fan ?(event|fest|zone|meet)|wax|statue|sculpture|bust\b|caricature|mural|graffiti|"
                       r"stamp|coin|poster|autograph|award|gala|ceremony|reception|visit|meets|meeting|"
                       r"at the (premiere|gala|awards|white house|kremlin|palace|embassy|summit)|wedding|funeral|grave|"
                       r"tomb|house|birthplace|street|avenue|plaque|logo|chart|ranking|graph|map|diagram|signature|"
                       r"book|cover|magazine|banner|billboard|cartoon|drawing|painting|illustration|"
                       r"team photo|squad|line.?up|team picture|group photo|with fans|selfie", re.I)


def mwapi_files(service_params, limit=40):
    """Runs one Commons API call through the Wikidata query service and returns
    {file title: {w, h, licence, author, desc}}. `service_params` are the mwapi:… lines.
    `limit` caps the number of results (MWAPI would otherwise keep paging through thousands)."""
    rows = sparql(f"""SELECT ?title ?w ?h ?mime ?lic ?artist ?desc WHERE {{
      SERVICE wikibase:mwapi {{
        bd:serviceParam wikibase:api "Generator" ; wikibase:endpoint "commons.wikimedia.org" ; wikibase:limit {limit} ;
          {service_params}
          mwapi:prop "imageinfo" ; mwapi:iiprop "size|mime|extmetadata" ;
          mwapi:iiextmetadatafilter "LicenseShortName|Artist|ImageDescription" .
        ?title wikibase:apiOutput mwapi:title .
        ?w wikibase:apiOutput "imageinfo/ii/@width" .
        ?h wikibase:apiOutput "imageinfo/ii/@height" .
        ?mime wikibase:apiOutput "imageinfo/ii/@mime" .
        ?lic wikibase:apiOutput "imageinfo/ii/extmetadata/LicenseShortName/@value" .
        ?artist wikibase:apiOutput "imageinfo/ii/extmetadata/Artist/@value" .
        ?desc wikibase:apiOutput "imageinfo/ii/extmetadata/ImageDescription/@value" .
      }}
    }}""")
    out = {}
    for r in rows:
        title = (val(r, "title") or "").removeprefix("File:")
        if not title or title in out:
            continue
        out[title] = {
            "w": int(float(val(r, "w") or 0)), "h": int(float(val(r, "h") or 0)), "mime": val(r, "mime") or "",
            "licence": (val(r, "lic") or "").strip(),
            "author": re.sub(r"<[^>]+>", "", val(r, "artist") or "").strip() or "Unknown author",
            "desc": re.sub(r"<[^>]+>", " ", val(r, "desc") or "")[:400],
        }
    return out


def mw(text):
    """Quote a value for an mwapi parameter inside SPARQL."""
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def one_file(name):
    """Metadata for one known file (P18, P154 or an override). 'allimages' starting at its name, limit 1."""
    files = mwapi_files(f'mwapi:generator "allimages" ; mwapi:gaifrom {mw(name.replace(" ", "_"))} ; mwapi:gailimit "1" ;', limit=1)
    return {k: v for k, v in files.items() if k.replace("_", " ") == name.replace("_", " ")}


def wikidata_refs(ids):
    """{qid: {"p18": file, "p154": file, "cat": category}} for every entry, in batches."""
    out = {}
    for batch in in_batches(ids, 150):
        rows = sparql(f"""SELECT ?x ?img ?logo ?cat WHERE {{
          VALUES ?x {{ {values(batch)} }}
          OPTIONAL {{ ?x wdt:P18 ?img . }} OPTIONAL {{ ?x wdt:P154 ?logo . }} OPTIONAL {{ ?x wdt:P373 ?cat . }}
        }}""")
        for r in rows:
            d = out.setdefault(qid(val(r, "x")), {})
            for key, var in (("p18", "img"), ("p154", "logo")):
                if val(r, var) and key not in d:
                    d[key] = urllib.parse.unquote(val(r, var).rsplit("/", 1)[-1]).replace("_", " ")
            if val(r, "cat") and "cat" not in d:
                d["cat"] = val(r, "cat")
        time.sleep(1)
    return out


def score(entry, title, meta, source):
    """How good a picture this is for the game. None means 'never use it'."""
    text = plain(f"{title} {meta['desc']}")
    city_words = [w for w in re.findall(r"[a-z]+", plain(entry["city"])) if len(w) > 3]
    name_words = set(re.findall(r"[a-z]+", plain(entry["name"])))
    words = set(re.findall(r"[a-z]+", text))
    # rejected outright
    if not FREE_LICENCE.search(meta["licence"]):
        return None  # no free licence on record
    if any(w in words and w not in name_words for w in city_words):
        return None  # names the answer city: gives the game away
    if entry["type"] == "athlete" and not PHOTO_FILE.search(title):
        return None  # drawings, diagrams, animations
    if entry["type"] == "team" and source != "logo" and not re.search(r"\.jpe?g$", title, re.I):
        return None  # a team's match photo is a photo; PNGs here are line-up diagrams and charts
    if min(meta["w"], meta["h"]) < 500:
        return None  # too small to look good

    s = 0.0
    title_text = plain(title)
    if entry["type"] == "team":
        # the team's core name as a phrase ("manchester united", "real madrid"), so a photo of
        # Manchester City or "F.C. United of Manchester" doesn't count
        phrase = core_team_name(entry["name"])
        named, in_title = phrase in text, phrase in title_text
    else:
        surname = [w for w in re.findall(r"[a-z]+", plain(entry["name"])) if len(w) > 2]
        named = bool(surname) and surname[-1] in words
        in_title = named and surname[-1] in set(re.findall(r"[a-z]+", title_text))
    if named:
        s += 3 if in_title else 1  # named in the file's title is the strongest sign it's really them
    elif source == "search":
        s -= 8  # a search hit that doesn't name them is probably someone else
    elif source == "category":
        s -= 3  # a file in their category that doesn't name them is often the venue or a team-mate
    s += {"category": 1, "p18": 1, "search": 0}[source]
    actions = len(set(m.group(0).lower() for m in ACTION.finditer(text)))
    s += min(actions, 3) * 2 + (2 if actions else 0)
    if re.search(SPORT_TERMS.get(entry["sport"], r"$^"), text, re.I):
        s += 2
    bad = set(m.group(0).lower() for m in NOT_SPORT.finditer(text))
    if entry["type"] == "team":
        bad = {b for b in bad if not re.search(r"team|squad|line|group", b)}  # a squad photo is fine for a team
    s -= min(len(bad), 2) * 6
    ratio = meta["w"] / meta["h"]
    # landscape or square crops best into our frames; very wide panoramas and tall strips don't
    s += -4 if ratio > 2.2 else 2 if ratio >= 0.95 else 0 if ratio >= 0.65 else -3
    s += 1 if min(meta["w"], meta["h"]) >= 1200 else 0
    return round(s, 1)


# Athlete photos. First choice: a sharp action shot with the face big and clear. Second choice: a sharp,
# close head-and-shoulders photo. Otherwise the athlete sits out. These are never used…
NEVER = re.compile(r"\bwax\b|tussaud|statue|sculpture|\bbust\b|caricature|mural|stamp|coin|banknote|grave|tomb|"
                   r"drawing|painting|cartoon|poster|autograph|signature|team photo|squad|line-?up", re.I)
# …these mark a posed picture (allowed, but only as the second choice)…
POSED = re.compile(r"portrait|head ?shot|press conference|news conference|signing|premiere|red carpet|award|gala|"
                   r"interview|visit|meets|reception|ceremony|launch", re.I)
# …and these the moment we want most.
PREFER = re.compile(r"\b(match|game|playing|plays|during|final|race|serve|serving|goal|celebrat\w*|scores|in action|"
                    r"vs\.?|versus|dunk|swing|tee shot|bowling|batting|pitching|lap|fight|bout|round)\b", re.I)
MIN_LONG_SIDE = 1000


def athlete_text_score(entry, title, meta, source):
    """(tier, points) from the file's name, description, size and source; None = never use it.
    tier 1 = looks like an action shot, tier 2 = posed or unclear."""
    text = plain(f"{title} {meta['desc']}")
    city_words = [w for w in re.findall(r"[a-z]+", plain(entry["city"])) if len(w) > 3]
    name_words = set(re.findall(r"[a-z]+", plain(entry["name"])))
    words = set(re.findall(r"[a-z]+", text))
    if not FREE_LICENCE.search(meta["licence"]) or not re.search(r"\.jpe?g$", title, re.I):
        return None  # a free licence, and a photo
    if max(meta["w"], meta["h"]) < MIN_LONG_SIDE or NEVER.search(text):
        return None
    if any(w in words and w not in name_words for w in city_words):
        return None  # names the answer city
    surname = [w for w in re.findall(r"[a-z]+", plain(entry["name"])) if len(w) > 2]
    named = bool(surname) and surname[-1] in words
    # Who it is comes from Commons, never from the face: "depicts" says so, or their own category or
    # Wikidata image plus their name in the file's title or description.
    if source == "category" and not named:
        return None
    s = {"depicts": 4, "category": 2, "p18": 2}[source] + (1 if named else 0)
    action = bool(PREFER.search(text) or re.search(SPORT_TERMS.get(entry["sport"], r"$^"), text, re.I))
    tier = 1 if action and not POSED.search(text) else 2
    s += min(len(set(m.group(0).lower() for m in PREFER.finditer(text))), 3)
    s -= min(len(set(m.group(0).lower() for m in NOT_SPORT.finditer(text))), 2) * 4
    return tier, s


def pick_for_athlete(entry, refs, rejects):
    """Candidates from Commons files that depict them (structured data, P180), their Commons category and
    their main Wikidata image; ranked by the words, then looked at properly (imagecheck.judge_photo).
    Returns passing pictures best first: action shots before posed ones."""
    import imagecheck
    q = entry["id"][3:]
    cands = {}  # title -> (meta, source)
    for t, m in mwapi_files(f'mwapi:generator "search" ; mwapi:gsrsearch {mw(f"haswbstatement:P180={q} filetype:bitmap")} ; '
                            f'mwapi:gsrnamespace "6" ; mwapi:gsrlimit "80" ;', limit=80).items():
        cands[t] = (m, "depicts")
    if refs.get("cat"):
        for t, m in mwapi_files(f'mwapi:generator "categorymembers" ; mwapi:gcmtitle {mw("Category:" + refs["cat"])} ; '
                                f'mwapi:gcmtype "file" ; mwapi:gcmlimit "100" ;', limit=100).items():
            cands.setdefault(t, (m, "category"))
    if refs.get("p18") and refs["p18"] not in cands:
        for t, m in one_file(refs["p18"]).items():
            cands[t] = (m, "p18")
    scored = []
    for t, (m, src) in cands.items():
        if t in rejects:
            continue
        r = athlete_text_score(entry, t, m, src)
        if r is not None:
            scored.append((r[0], r[1], t, m, src))
    action = sorted([c for c in scored if c[0] == 1], key=lambda c: -c[1])[:28]
    posed = sorted([c for c in scored if c[0] == 2], key=lambda c: -c[1])[:14]
    out, looked = [], []
    for tier, sc, t, m, src in action + posed:
        if not imagecheck.worth_a_closer_look(t):
            continue  # the face is small, or shares the picture: no need for the big copy
        points, why, focus, stats = imagecheck.judge_photo(imagecheck.look(t))
        looked.append((t, why))
        if why:
            continue
        if imagecheck.has_watermark(t):
            looked[-1] = (t, "text over the picture (watermark)")
            continue
        out.append(((2 - tier) * 100 + sc + points, t, dict(m, focus=focus, tier=tier, stats=stats), src))
        if len(out) >= 2:
            break  # candidates come best-described first: two that pass is plenty (and spares Commons)
    out.sort(key=lambda x: -x[0])
    return out


def pick_for_team(entry, refs, rejects):
    if refs.get("p154") and refs["p154"] not in rejects:
        for t, m in one_file(refs["p154"]).items():
            if FREE_LICENCE.search(m["licence"]) and LOGO_FILE.search(t):
                return [(99, t, m, "logo")]
    # no usable logo: an action photo of the team, from its Commons category and a search
    found = {}
    if refs.get("cat"):
        found.update(mwapi_files(f'mwapi:generator "categorymembers" ; mwapi:gcmtitle {mw("Category:" + refs["cat"])} ; '
                                 f'mwapi:gcmtype "file" ; mwapi:gcmlimit "100" ;', limit=100))
    found |= mwapi_files(f'mwapi:generator "search" ; mwapi:gsrsearch {mw(entry["name"] + " " + entry["sport"] + " match")} ; '
                        f'mwapi:gsrnamespace "6" ; mwapi:gsrlimit "40" ;', limit=40)
    scored = [(score(entry, t, m, "search"), t, m, "search") for t, m in found.items() if t not in rejects]  # strict naming rules
    return sorted([s for s in scored if s[0] is not None], key=lambda x: -x[0])


def main():
    fresh = "--fresh" in sys.argv
    players = json.loads(PLAYERS.read_text())
    reserve = json.loads(RESERVE.read_text()) if RESERVE.exists() else []
    overrides = {k: v for k, v in (json.loads(OVERRIDES.read_text()) if OVERRIDES.exists() else {}).items() if not k.startswith("_")}
    pool = players + [e for e in reserve if e["id"] not in {p["id"] for p in players}]  # give the reserve another chance

    print(f"Wikidata picture references for {len(pool)} entries…")
    refs = cached(f"imgrefs-{len(pool)}", lambda: wikidata_refs([e["id"][3:] for e in pool]), fresh)

    def picks_for(e):
        """All usable candidates for one entry, best first (cached per entry). None = Wikidata too busy."""
        ov = overrides.get(e["id"], {})
        rejects = set(ov.get("reject", []))
        try:
            if ov.get("use"):
                meta = cached(f"img-use-{e['id']}-{hashlib.md5(ov['use'].encode()).hexdigest()[:8]}", lambda: one_file(ov["use"]), fresh)
                return [(99, t, m, "chosen by hand") for t, m in meta.items()]
            if e["type"] == "team":
                return cached(f"img-team-{e['id']}", lambda: pick_for_team(e, refs.get(e["id"][3:], {}), rejects), fresh)
            return cached(f"img4-ath-{e['id']}", lambda: pick_for_athlete(e, refs.get(e["id"][3:], {}), rejects), fresh)
        except QueryFailed:
            return None

    # Four lookups at a time: much faster, still polite to Wikidata (its limit is 5 at once).
    todo = [e for e in pool if not overrides.get(e["id"], {}).get("none")]
    with ThreadPoolExecutor(max_workers=3) as workers:
        found = {}
        for n, (e, picks) in enumerate(zip(todo, workers.map(picks_for, todo)), 1):
            found[e["id"]] = picks
            if n % 50 == 0:
                print(f"   {n}/{len(todo)}")

    # Read the text in each entry's candidates (best first) until one doesn't give the answer away.
    import imagecheck
    answer_words = json.loads(ANSWER_WORDS.read_text()) if ANSWER_WORDS.exists() else {}

    def vet(e):
        picks = found.get(e["id"]) or []
        rejects = set(overrides.get(e["id"], {}).get("reject", []))
        words = answer_words.get(e["id"], [e["city"], e["country"]]) + ([e["name"]] if e["type"] == "team" else [])
        turned_down = []
        for p in [p for p in picks if p[1] not in rejects][:8]:
            if p[3] == "chosen by hand":
                return p, turned_down
            text = imagecheck.ocr(p[1])
            why = imagecheck.gives_away(text, words)
            if not why and p[3] == "logo":
                extra = imagecheck.foreign_text(text, [e.get("display_name") or e["name"]])
                why = f"logo has other text ({', '.join(extra[:3])})" if extra else None
            if why:
                turned_down.append((p[1], why))
                continue
            return p, turned_down
        return None, turned_down

    print("Reading the text in the pictures (OCR)…")
    with ThreadPoolExecutor(max_workers=6) as workers:
        vetted = dict(zip([e["id"] for e in pool], workers.map(vet, pool)))
    ocr_log = []

    keep, removed, report = [], [], {}
    for e in pool:
        for k in ("image", "imageAuthor", "imageLicense", "imagePage", "imageSource", "imageConfidence", "imageFocus"):
            e.pop(k, None)
        ov = overrides.get(e["id"], {})
        if ov.get("none"):
            removed.append((e, "override: no picture")); continue
        picks = found.get(e["id"])
        if picks is None:
            print(f"   {e['name']}: Wikidata too busy, kept as it was; rerun later")
            keep.append(e); continue
        chosen, turned_down = vetted.get(e["id"], (None, []))
        ocr_log += [(e["name"], t, why) for t, why in turned_down]
        if not chosen:
            removed.append((e, "no usable picture" + (" (text in the others names the place)" if turned_down else ""))); continue
        sc, title, meta, src = chosen
        quoted = urllib.parse.quote(title.replace(" ", "_"))
        e["image"] = f"https://commons.wikimedia.org/wiki/Special:FilePath/{quoted}?width={PHOTO_WIDTH if e['type'] == 'athlete' else WIDTH}"
        e["imageAuthor"] = meta["author"]
        e["imageLicense"] = meta["licence"]
        e["imagePage"] = f"https://commons.wikimedia.org/wiki/File:{quoted}"
        e["imageSource"] = src
        if e["type"] == "athlete" and src == "chosen by hand":  # your choice stands, but the face is still found
            import imagecheck
            _, _, focus, stats = imagecheck.judge_photo(imagecheck.look(title))
            meta = dict(meta, focus=focus, stats=stats, tier=0)
        if meta.get("focus"):
            e["imageFocus"] = meta["focus"]  # CSS object-position that keeps the face in the crop
        # "low" = worth a human look on the contact sheet
        if e["type"] == "athlete":  # an action shot that Commons says depicts them; posed shots get a look
            e["imageConfidence"] = "high" if src == "chosen by hand" or (meta.get("tier") == 1 and src == "depicts") else "low"
            report[e["id"]] = {"file": title, "source": src, "tier": meta.get("tier"), **(meta.get("stats") or {})}
        else:
            e["imageConfidence"] = "high" if src in ("logo", "chosen by hand") or (sc >= 9 and ACTION.search(plain(title + " " + meta["desc"]))) else "low"
        # A team with no free logo needs a clear match photo; a doubtful one (a scan, a chart, an empty
        # stand) is worse than none, so the team sits out until a picture is chosen by hand.
        if e["type"] == "team" and e["imageConfidence"] == "low":
            removed.append((e, "no logo and no clear match photo")); continue
        keep.append(e)

    # difficulty over the final pool: the most famous 70% are 1 (household names), the rest 2
    keep.sort(key=lambda e: -e.get("fame", 0))
    for k, e in enumerate(keep):
        e["difficulty"] = 1 if k < len(keep) * 0.7 else 2
    PLAYERS.write_text(json.dumps(keep, ensure_ascii=False, indent=1) + "\n")
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=0) + "\n")
    with open(ROOT / "data" / "image-rejects.csv", "w", newline="", encoding="utf-8") as f:  # for checking by eye
        import csv
        w = csv.writer(f)
        w.writerow(["entry", "file", "why"])
        w.writerows(ocr_log)
    print(f"{len(ocr_log)} pictures turned down because of their text (see data/image-rejects.csv).")
    RESERVE.write_text(json.dumps([dict(e, reserveReason=why) for e, why in removed], ensure_ascii=False, indent=1) + "\n")

    by_sport = {}
    for e in keep:
        s = by_sport.setdefault(e["sport"], [0, 0])
        s[0] += 1
        s[1] += e["imageConfidence"] == "low"
    print(f"\n{len(keep)} entries with a picture ({sum(v[1] for v in by_sport.values())} low-confidence), {len(removed)} moved to the reserve.")
    out_by_sport = {}
    for e, _ in removed:
        out_by_sport[e["sport"]] = out_by_sport.get(e["sport"], 0) + 1
    print(f"   {'sport':<26} {'in':>4} {'out':>4}")
    for sport in sorted(set(by_sport) | set(out_by_sport), key=lambda x: -by_sport.get(x, [0])[0]):
        n, low = by_sport.get(sport, [0, 0])
        print(f"   {sport:<26} {n:>4} {out_by_sport.get(sport, 0):>4}  ({low} to check)")
    for e, why in removed:
        print(f"   reserve: {e['name']} ({e['sport']}): {why}")


if __name__ == "__main__":
    main()
