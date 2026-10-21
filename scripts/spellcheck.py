#!/usr/bin/env python3
"""Spell and grammar check for everything a player can read.

Checks the page text (HTML), the strings in the game's JavaScript, the README, and every generated
text field in data/ (names, honours lines, Vault summaries and timelines, distance units).

  codespell   catches common misspellings everywhere ("teh", "recieve")
  aspell      (British English) checks every word in the game's own text; in the generated data,
              where most capitalised words are names, it checks only lower-case words
  rules       double spaces, space before punctuation, "1 marathons"-style plurals, repeated words

Names that aren't in the dictionary go in data/spelling-allowlist.txt (one per line).
Needs: codespell (pip install codespell) and aspell with an English dictionary (apt install aspell-en).

  python3 scripts/spellcheck.py            # report; exit code 1 if anything was found
"""
import json
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ALLOW = ROOT / "data" / "spelling-allowlist.txt"


def allowlist():
    words = set()
    if ALLOW.exists():
        for line in ALLOW.read_text(encoding="utf-8").splitlines():
            line = line.split("#")[0].strip()
            if line:
                words.add(line.lower())
    return words


# ── collecting the text ────────────────────────────────────────────────────────

def strip_html(text):
    text = re.sub(r"<(script|style)\b.*?</\1>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<!--.*?-->", " ", text, flags=re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    return text.replace("&amp;", "&").replace("&nbsp;", " ")


def js_strings(source):
    """The human-readable parts of string literals in a JS file (no code, no CSS, no URLs)."""
    source = re.sub(r"^\s*//.*$", "", source, flags=re.M)        # line comments
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)         # block comments
    out = []
    for m in re.finditer(r'"((?:[^"\\\n]|\\.)*)"|\'((?:[^\'\\\n]|\\.)*)\'|`((?:[^`\\]|\\.)*)`', source):
        s = next(g for g in m.groups() if g is not None)
        whole = "${" not in s and "<" not in s  # nothing will be cut out, so spacing checks are fair
        s = re.sub(r"\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", " ", s)  # ${…} placeholders
        s = strip_html(s)
        # skip code-like strings: selectors, keys, URLs, colours, SVG paths
        if not re.search(r"[A-Za-z]{3,}\s+[A-Za-z]", s) or re.search(r"https?:|[{};=#]|^[.#\[]|\bvar\(", s):
            continue
        out.append((s, whole))
    return out


def sources():
    """[(where, text, strict, spacing)]: strict = check every word, not just lower-case ones;
    spacing = run the spacing rules (not on text with markup or placeholders cut out of it)."""
    items = []
    for name in ("index.html", "palette.html", "contact-sheet.html"):
        items.append((name, strip_html((ROOT / name).read_text(encoding="utf-8")), True, False))
    for path in sorted((ROOT / "js").glob("*.js")):
        for s, whole in js_strings(path.read_text(encoding="utf-8")):
            items.append((f"js/{path.name}", s, True, whole))
    readme = re.sub(r"```.*?```|`[^`]*`|\(https?://[^)]*\)|https?://\S+", " ", (ROOT / "README.md").read_text(encoding="utf-8"), flags=re.S)
    items.append(("README.md", readme, True, False))

    data = ROOT / "data"
    for e in json.loads((data / "players.json").read_text(encoding="utf-8")):
        for f in ("name", "display_name", "city", "country", "achievement", "hint"):
            if e.get(f):
                items.append((f"players.json {e['id']} {f}", e[f], False, True))
    if (data / "football-players.json").exists():  # Football mode
        for e in json.loads((data / "football-players.json").read_text(encoding="utf-8"))["players"]:
            for f in ("name", "birth_place", "birth_country", "metro", "club_now"):
                if e.get(f):
                    items.append((f"football-players.json {e['id']} {f}", e[f], False, True))
            for f in ("achievements", "positions", "nationality"):
                for x in e.get(f) or []:
                    items.append((f"football-players.json {e['id']} {f}", x, False, True))
    if (data / "football-vault.json").exists():
        for k, v in json.loads((data / "football-vault.json").read_text(encoding="utf-8")).items():
            for f in ("summary", "nickname"):
                if v.get(f):
                    items.append((f"football-vault.json {k} {f}", v[f], False, True))
    for u in json.loads((data / "facts.json").read_text(encoding="utf-8"))["units"]:
        items.append((f"facts.json {u['key']}", f"{u['one']}. {u['many']}.", False, True))
    if (data / "vault.json").exists():
        for k, v in json.loads((data / "vault.json").read_text(encoding="utf-8")).items():
            for f in ("summary", "position", "nickname", "league", "ground", "coach", "country"):
                if v.get(f):
                    items.append((f"vault.json {k} {f}", v[f], False, True))
            for t in v.get("timeline", []):
                items.append((f"vault.json {k} timeline", t["what"], False, True))
    return items


# ── the checks ─────────────────────────────────────────────────────────────────

RULES = [
    (re.compile(r"\S  +\S"), "double space"),
    (re.compile(r"\s[,.;:!?](?!\d)"), "space before punctuation"),
    (re.compile(r"\b(?!(?:Boom|Triple|Sánchez|Stoichkov)\b)(\w{2,}) \1\b"), "repeated word"),
    (re.compile(r"\(\s|\s\)"), "space inside brackets"),
    (re.compile(r"(?<![\d.,])(?<!Formula )(?<!No\. )\b1 (?!(?:of|in|to|and|or|for|from|per|km|mi|m|ft|in)\b)[a-z]+s\b"), "plural after 1"),
]


def rule_issues(items):
    found = []
    for where, text, _, spacing in items:
        if not spacing:
            continue
        for line in text.splitlines():
            for pattern, what in RULES:
                m = pattern.search(line)
                if m:
                    found.append((where, what, line.strip()[:120]))
    return found


def codespell_issues(items, allow):
    if not shutil.which("codespell"):
        return [("setup", "codespell is not installed", "pip install codespell")]
    text = "\n".join(t.replace("\n", " ") for _, t, _, _ in items)
    ignore = ",".join(sorted(allow))
    res = subprocess.run(["codespell", "-", "-L", ignore], input=text, capture_output=True, text=True)
    found = []
    lines = text.split("\n")
    for line in res.stdout.splitlines():
        m = re.match(r"\s*(\d+): (.*)", line)  # "  12: teh ==> the"
        if m and ":" not in m.group(2)[:0]:
            n = int(m.group(1)) - 1
            found.append((items[n][0] if n < len(items) else "?", f"codespell: {m.group(2)}", lines[n][:120] if n < len(lines) else ""))
    return [f for f in found if "==>" in f[1]]


def aspell(words, lang):
    res = subprocess.run(["aspell", "list", f"--lang={lang}"], input="\n".join(sorted(words)), capture_output=True, text=True)
    return res.stdout.split()


def aspell_issues(items, allow):
    if not shutil.which("aspell"):
        return [("setup", "aspell is not installed", "apt install aspell aspell-en")]
    found = []
    for where, text, strict, _ in items:
        words = set(re.findall(r"[^\W\d_]+(?:['’][^\W\d_]+)*", text))
        words = {re.sub(r"['’]s$", "", w) for w in words}  # possessives
        words = {w for w in words if len(w) > 2 and (strict or w[0].islower()) and w.lower() not in allow}
        words = {w for w in words if w.isascii()}  # accented words are names here
        if not words:
            continue
        bad = set(aspell(words, "en_GB"))
        if not strict:
            # Wikidata labels and Wikipedia summaries are quoted as written, often in American English
            bad &= set(aspell(bad, "en_US"))
        bad = sorted(bad)
        if bad:
            found.append((where, "unknown words", ", ".join(bad)))
    return found


def main():
    allow = allowlist()
    items = sources()
    issues = codespell_issues(items, allow) + rule_issues(items) + aspell_issues(items, allow)
    for where, what, detail in issues:
        print(f"{where}: {what}: {detail}")
    print(f"\nChecked {len(items)} pieces of text: {len(issues)} issue(s).")
    sys.exit(1 if issues else 0)


if __name__ == "__main__":
    main()
