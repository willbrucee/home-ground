#!/usr/bin/env python3
"""Builds data/vault.json: the extra facts unlocked in "The Vault" after each round.

Everything here is fetched from Wikidata and English Wikipedia at build time. Nothing is written
by hand or from memory, so a fact is only as good as its source (and is credited on the card).

Run after build_players.py and pick_images.py:  python3 scripts/build_vault.py [--fresh]
"""

import hashlib
import json
import pathlib
import re
import sys
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from build_players import sparql, val, qid, values, in_batches, cached  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLAYERS = ROOT / "data" / "players.json"
OUT = ROOT / "data" / "vault.json"
FOOTBALL = ROOT / "data" / "football-players.json"
FOOTBALL_OUT = ROOT / "data" / "football-vault.json"


def year(v):
    m = re.match(r"-?\d{4}", v or "")
    return int(m.group(0)) if m else None


# ── Wikidata ────────────────────────────────────────────────────────────────────

def athlete_facts(ids):
    """Nationality, position, birth date, height, shirt number, nickname, hometown article, sitelinks."""
    rows = sparql(f"""
SELECT ?p ?bornDate ?diedDate ?height ?num ?nick ?sl ?home ?countryLabel ?posLabel WHERE {{
  VALUES ?p {{ {values(ids)} }}
  ?p wikibase:sitelinks ?sl.
  OPTIONAL {{ ?p wdt:P569 ?bornDate }}
  OPTIONAL {{ ?p wdt:P570 ?diedDate }}
  OPTIONAL {{ ?p p:P2048/psn:P2048/wikibase:quantityAmount ?height }}
  OPTIONAL {{ ?p wdt:P1618 ?num }}
  OPTIONAL {{ ?p wdt:P1449 ?nick FILTER(LANG(?nick) = "en") }}
  OPTIONAL {{ ?p wdt:P19 ?bp. ?home schema:about ?bp; schema:isPartOf <https://en.wikipedia.org/> }}
  OPTIONAL {{ ?p wdt:P1532 ?country }}  # the country they represent in sport, if given
  OPTIONAL {{ FILTER NOT EXISTS {{ ?p wdt:P1532 [] }} ?p wdt:P27 ?country }}
  OPTIONAL {{ ?p wdt:P413 ?pos }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
}}""")
    out = {}
    for r in rows:
        f = out.setdefault(qid(val(r, "p")), {"positions": [], "countries": []})
        f["sitelinks"] = int(val(r, "sl") or 0)
        f["born"] = (val(r, "bornDate") or "")[:10] or f.get("born")
        f["died"] = (val(r, "diedDate") or "")[:10] or f.get("died")
        if val(r, "height"):
            f["heightM"] = round(float(val(r, "height")), 2)  # normalised to metres
        f["number"] = val(r, "num") or f.get("number")
        f["nickname"] = val(r, "nick") or f.get("nickname")
        f["hometownUrl"] = val(r, "home") or f.get("hometownUrl")
        for key, field in (("countryLabel", "countries"), ("posLabel", "positions")):
            v = val(r, key)
            if v and not re.fullmatch(r"Q\d+", v) and v not in f[field]:
                f[field].append(v)
    return out


def athlete_clubs(ids):
    """Teams played for, with years: the Film room timeline."""
    rows = sparql(f"""
SELECT ?p ?teamLabel ?start ?end WHERE {{
  VALUES ?p {{ {values(ids)} }}
  ?p p:P54 ?st. ?st ps:P54 ?team.
  OPTIONAL {{ ?st pq:P580 ?start }}
  OPTIONAL {{ ?st pq:P582 ?end }}
  FILTER NOT EXISTS {{ ?team wdt:P31/wdt:P279* wd:Q6979593 }}  # no national teams
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
}}""")
    out = {}
    for r in rows:
        start = year(val(r, "start"))
        if not start:
            continue
        out.setdefault(qid(val(r, "p")), []).append({"from": start, "to": year(val(r, "end")), "what": val(r, "teamLabel")})
    return out


def dated_awards(ids):
    """Awards with a date: extra timeline stops."""
    rows = sparql(f"""
SELECT ?p ?awardLabel ?when WHERE {{
  VALUES ?p {{ {values(ids)} }}
  ?p p:P166 ?st. ?st ps:P166 ?award; pq:P585 ?when.
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
}}""")
    out = {}
    for r in rows:
        y = year(val(r, "when"))
        if y and not re.fullmatch(r"Q\d+", val(r, "awardLabel") or "Q1"):
            out.setdefault(qid(val(r, "p")), []).append({"from": y, "what": val(r, "awardLabel")})
    return out


def team_facts(ids):
    """Founded, ground (capacity, opened), league, coach, nickname, hometown article, sitelinks."""
    rows = sparql(f"""
SELECT ?t ?founded ?sl ?home ?nick ?groundLabel ?cap ?opened ?leagueLabel ?coachLabel WHERE {{
  VALUES ?t {{ {values(ids)} }}
  ?t wikibase:sitelinks ?sl.
  OPTIONAL {{ ?t wdt:P571 ?founded }}
  OPTIONAL {{ ?t wdt:P1449 ?nick FILTER(LANG(?nick) = "en") }}
  OPTIONAL {{ ?t wdt:P115 ?ground. OPTIONAL {{ ?ground wdt:P1083 ?cap }} OPTIONAL {{ ?ground wdt:P1619 ?opened }} }}
  OPTIONAL {{ ?t wdt:P118 ?league }}
  OPTIONAL {{ ?t wdt:P286 ?coach }}
  OPTIONAL {{ ?t wdt:P159|wdt:P131 ?place. ?home schema:about ?place; schema:isPartOf <https://en.wikipedia.org/> }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
}}""")
    out = {}
    for r in rows:
        f = out.setdefault(qid(val(r, "t")), {})
        f["sitelinks"] = int(val(r, "sl") or 0)
        f["founded"] = f.get("founded") or year(val(r, "founded"))
        f["nickname"] = f.get("nickname") or val(r, "nick")
        for key, field in (("groundLabel", "ground"), ("leagueLabel", "league"), ("coachLabel", "coach")):
            v = val(r, key)
            if v and not re.fullmatch(r"Q\d+", v) and not f.get(field):
                f[field] = v
        if val(r, "cap") and not f.get("capacity"):
            f["capacity"] = int(float(val(r, "cap")))
        if val(r, "opened") and not f.get("groundOpened"):
            f["groundOpened"] = year(val(r, "opened"))
        f["hometownUrl"] = f.get("hometownUrl") or val(r, "home")
    return out


def wiki_titles(ids):
    rows = sparql(f"""
SELECT ?x ?article WHERE {{
  VALUES ?x {{ {values(ids)} }}
  ?article schema:about ?x; schema:isPartOf <https://en.wikipedia.org/>.
}}""")
    return {qid(val(r, "x")): urllib.parse.unquote(val(r, "article").rsplit("/", 1)[1]).replace("_", " ") for r in rows}


# ── Wikipedia ───────────────────────────────────────────────────────────────────

def wiki_intros(titles):
    """The plain-text lead of each article. Asked through the Wikidata query service (MWAPI), because
    Wikipedia's own API rate-limits us within a few calls."""
    blocks = [f"""{{ SERVICE wikibase:mwapi {{
        bd:serviceParam wikibase:api "Generator" ; wikibase:endpoint "en.wikipedia.org" ; wikibase:limit 1 ;
          mwapi:generator "allpages" ; mwapi:gapfrom {json.dumps(t)} ; mwapi:gapto {json.dumps(t)} ;
          mwapi:prop "extracts" ; mwapi:exintro "1" ; mwapi:explaintext "1" .
        ?t wikibase:apiOutput mwapi:title . ?ex wikibase:apiOutput "extract/text()" . }} }}""" for t in titles]
    rows = sparql("SELECT * WHERE { " + " UNION ".join(blocks) + " }")
    return {val(r, "t"): val(r, "ex") or "" for r in rows}


ABBREV = re.compile(r"\b(?:Jr|Sr|St|Dr|Mr|Mrs|Ms|No|vs|Inc|Ltd|Co|U\.S|F\.C|A\.C|S\.L|Mt|ca|c)\.$|\b[A-Z]\.$")


def trim(text, n=3):
    """The first n sentences, without pronunciation guides or other bracketed asides."""
    # brackets can nest one level deep: "(Portuguese pronunciation: [ˈspɔɾ(tɨ) ...])"
    aside = r"\s*\((?:[^()]|\([^()]*\))*?(?:;|listen|pronounced|pronunciation|/|IPA|\[)(?:[^()]|\([^()]*\))*\)"
    text = re.sub(aside, "", text.split("\n")[0])
    # pronunciation respellings left behind by the plain-text export: "( SEL-tiks)", "( DWAYN or doo-WY-ayn, born …)"
    # (a bracket followed by a space is always one of these; real asides start straight after the bracket)
    text = re.sub(r"\(\s+[^()]*?(?:,\s*(?=born\b)|(?=\)))", "(", text)
    text = re.sub(r"\s*\(\s*\)", "", text)
    text = re.sub(r"\s{2,}", " ", text).strip()
    out, start = [], 0
    for m in re.finditer(r"[.!?](?=\s+[A-Z\"“])", text):
        piece = text[start:m.end()].strip()
        if ABBREV.search(piece):  # "St. Louis", "Jr." etc: not the end of a sentence
            continue
        out.append(piece)
        start = m.end()
        if len(out) == n:
            break
    if len(out) < n and text[start:].strip():
        out.append(text[start:].strip())
    return " ".join(out)


# ── Main ────────────────────────────────────────────────────────────────────────

def main():
    fresh = "--fresh" in sys.argv
    # --football: the Football mode's players (data/football-players.json) → data/football-vault.json
    football = "--football" in sys.argv
    src, out = (FOOTBALL, FOOTBALL_OUT) if football else (PLAYERS, OUT)
    players = json.loads(src.read_text())
    players = players["players"] if isinstance(players, dict) else players
    ids = [e["id"][3:] for e in players if e["id"].startswith("wd-")]
    athletes = [e["id"][3:] for e in players if e["type"] == "athlete" and e["id"].startswith("wd-")]
    teams = [e["id"][3:] for e in players if e["type"] == "team" and e["id"].startswith("wd-")]

    def each(prefix, todo, size, fn):
        out = {}
        for batch in in_batches(todo, size):
            out.update(cached(f"vault-{prefix}-{digest(batch)}", lambda b=batch: fn(b), fresh))
        return out

    print("Wikidata facts…")
    af = each("ath", athletes, 40, athlete_facts)
    clubs = each("clubs", athletes, 40, athlete_clubs)
    awards = each("awards", athletes, 40, dated_awards)
    tf = each("team", teams, 30, team_facts)
    titles = each("titles", ids, 100, wiki_titles)
    print(f"Wikipedia intros for {len(titles)} articles…")
    intros = {}
    names = sorted(set(titles.values()))
    for i in range(0, len(names), 10):
        chunk = names[i:i + 10]
        intros.update(cached(f"vault-wiki-{digest(chunk)}", lambda c=chunk: wiki_intros(c), fresh))

    vault, short = {}, 0
    for e in players:
        q = e["id"][3:]
        title = titles.get(q)
        v = {"wikiTitle": title, "wikiUrl": f"https://en.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}" if title else None,
             "summary": trim(intros.get(title, "")) if title else ""}
        if not v["summary"]:
            short += 1
        if e["type"] == "athlete":
            f = af.get(q, {})
            timeline = sorted(clubs.get(q, []) + awards.get(q, []), key=lambda x: (x["from"], x.get("to") or 9999))
            v.update({k: f.get(k) for k in ("born", "died", "heightM", "number", "nickname", "hometownUrl", "sitelinks")})
            v["country"] = ", ".join(f.get("countries", [])[:2]) or None
            v["position"] = ", ".join(f.get("positions", [])[:2]) or None
            v["timeline"] = dedupe(timeline)[:10]
            if football:  # the club career with years (and games and goals where Wikidata has them), caps
                v["career"] = [c for c in e.get("career", []) if c.get("from")][:14]
                v["caps"], v["intlGoals"] = e.get("caps"), e.get("intl_goals")
                v["honours"] = e.get("achievements", [])
        else:
            f = tf.get(q, {})
            v.update({k: f.get(k) for k in ("founded", "nickname", "ground", "capacity", "groundOpened", "league", "coach", "hometownUrl", "sitelinks")})
            tl = []
            if f.get("founded"):
                tl.append({"from": f["founded"], "what": "Club founded"})
            if f.get("groundOpened") and f.get("ground"):
                tl.append({"from": f["groundOpened"], "what": f"{f['ground']} opens"})
            v["timeline"] = sorted(tl, key=lambda x: x["from"])
        vault[e["id"]] = {k: x for k, x in v.items() if x not in (None, "", [])}

    out.write_text(json.dumps(vault, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Wrote {out}: {len(vault)} entries, {len(vault) - short} with a Wikipedia summary.")
    print("Next: python3 scripts/spellcheck.py (or run everything with sh scripts/build_all.sh)")


def digest(items):
    return hashlib.md5("|".join(items).encode()).hexdigest()


def dedupe(items):
    seen, out = set(), []
    for x in items:
        key = (x["from"], x["what"])
        if key not in seen:
            seen.add(key)
            out.append(x)
    return out


if __name__ == "__main__":
    main()
