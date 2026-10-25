#!/usr/bin/env python3
"""Player cards: every athlete picture becomes a head-and-neck cutout with the background removed, so no
shirt, crest, flag or sponsor can give the country away. The game serves the cutouts from assets/players/.

    python3 scripts/make_cutouts.py              Football (data/football-players.json and its reserve)
    python3 scripts/make_cutouts.py --mix        the Daily mix's athletes (data/players.json)
    python3 scripts/make_cutouts.py --sheet      only rebuild the contact sheet data from the cache

Resumable: every candidate's verdict is cached in scripts/.cache/cut/ (and every download in .cache/img), so a
run that is cut off carries on where it stopped. Delete a player's file in .cache/cut-cands/ to look again.

For each player, candidates come from Commons (files that depict them, their category, their Wikidata image).
  1. Words: free licences only (CC0, public domain, CC BY, CC BY-SA; never NC or ND). Anything about a national
     team, World Cup, Euros, Copa America, Africa Cup of Nations, Asian Cup, Olympics, qualifiers or a
     country-v-country match is out. Awards, galas, press conferences, interviews and signings are preferred
     (a suit or a plain top), then club contexts (one of the player's clubs named).
  2. Face (OpenCV YuNet, as before): one dominant face, sharp, eyes visible, front-on or three-quarter, not cut off.
  3. Kit (CLIP, run locally): turned down if it looks like a national team shirt (score >= NATIONAL_MAX).
  4. Cut out: the person is separated from the background (U2-Net human segmentation, run locally); the part
     holding the face is kept, and the picture is turned down if another person overlaps the crop. The crop is
     a 4:5 head-and-neck portrait ending a little under the chin, and below the chin only skin is kept (the
     neck), so a collar, shirt or scarf turns transparent whatever its colour.
  5. Final checks on the cutout: OCR (no birth town or country) and CLIP (no flag, crest or printed text).
  6. Saved as a 480 x 600 transparent WebP (quality 82), the bottom fading out, in assets/players/<id>.webp.
A player with no passing picture goes to the reserve; the standard is never lowered.
"""
import hashlib
import json
import pathlib
import re
import sys
import time

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import imagecheck  # noqa: E402
import kitcheck  # noqa: E402
from build_players import sparql, val, plain, cached, QueryFailed  # noqa: E402, F401
from pick_images import mwapi_files, mw, one_file, wikidata_refs, NEVER  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "scripts" / ".cache"
OUT_DIR = ROOT / "assets" / "players"
MIX = "--mix" in sys.argv
PLAYERS = ROOT / "data" / ("players.json" if MIX else "football-players.json")
RESERVE = ROOT / "data" / ("reserve.json" if MIX else "football-reserve.json")
REPORT = ROOT / "data" / ("cutout-report-mix.json" if MIX else "cutout-report.json")
OVERRIDES = ROOT / "data" / "images.json"
SEG_MODEL = CACHE / "models" / "u2net_human_seg.onnx"
SEG_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx"

LOOK = 330             # Commons only lets us have its 330 px copies at the moment
OUT_W, OUT_H = 480, 600
MIN_CROP_H = 190       # the head-and-neck crop must be at least this tall in our copy (so at most ~3x enlarged)
NATIONAL_MAX = 0.35    # CLIP's "national team shirt" share at or above this: out (catches 11 of 12 in our sample)
MARK_MAX = 0.5         # CLIP's "flag, crest or text" share on the finished cutout
MAX_TRIES = 12         # candidates looked at per player, best described first (spares Commons)

FREE = re.compile(r"^(cc0|public domain|pd\b|pd-|cc[ -]?by(-sa)?([ -]\d(\.\d)?)?$|cc[ -]?by(-sa)? \d)", re.I)
NOT_FREE = re.compile(r"\bnc\b|non-?commercial|\bnd\b|no ?deriv", re.I)
NATIONAL = re.compile(r"national (football |soccer )?team|\bnational\b.*\bteam\b|selecci[oó]n|nationalmannschaft|"
                      r"squadra azzurra|world cup|copa mundial|coupe du monde|weltmeisterschaft|\bwm \d{4}|\beuro ?\d{4}|"
                      r"european championship|copa am[eé]rica|africa(n)? cup of nations|\bafcon\b|asian cup|gold cup|"
                      r"olympic|olympics|olympia|qualif|nations league|confederations cup|friendly match|international "
                      r"friendly", re.I)
# "Spain v Italy", "Germany vs. Argentina", "Nederland tegen Polen": a match between two countries (club
# matches are fine). Archive captions are often in Dutch, German, French, Spanish or Italian.
VERSUS = re.compile(r"([a-z]+(?: [a-z]+)?) (?:vs?\.?|versus|against|tegen|gegen|contre|contra|contro|[-–]) ([a-z]+(?: [a-z]+)?)")
COUNTRY_WORDS = {plain(n) for f in json.loads((pathlib.Path(__file__).resolve().parent.parent / "data" / "countries.geojson").read_text())["features"]
                 for n in [f["properties"]["name"], *f["properties"]["aliases"]]} | {"england", "scotland", "wales", "northern ireland"} | {
    "nederland", "holland", "polen", "duitsland", "deutschland", "alemania", "allemagne", "germania", "frankrijk", "frankreich",
    "francia", "italie", "italien", "espana", "spanje", "spanien", "espagne", "spagna", "brasil", "brasilien", "bresil",
    "belgie", "belgien", "belgique", "engeland", "inglaterra", "angleterre", "inghilterra", "schotland", "schottland",
    "schweiz", "zwitserland", "suisse", "svizzera", "oostenrijk", "osterreich", "autriche", "ungarn", "hongarije",
    "hongrie", "ungheria", "tsjechoslowakije", "tschechoslowakei", "joegoslavie", "jugoslawien", "yougoslavie",
    "sovjet-unie", "sowjetunion", "urss", "cccp", "denemarken", "danemark", "danimarca", "zweden", "schweden", "suede",
    "svezia", "noorwegen", "norwegen", "norvege", "argentinie", "argentinien", "mexiko", "mexique", "portogallo", "turkije",
    "turkei", "griekenland", "griechenland", "grece", "grecia", "ierland", "irland", "irlande", "polonia", "pologne"}
KIT_FREE = re.compile(r"award|gala|ballon|ceremony|press conference|news conference|conference|interview|signing|"
                      r"presentation|charity|premiere|red carpet|visit|meets|reception|event|portrait|launch|summit|forum", re.I)


# ── candidates ────────────────────────────────────────────────────────────────
def candidates(entry, refs):
    """{title: (meta, source)} from structured data (P180), the player's category and the Wikidata image (cached)."""
    q = entry["id"][3:]

    def fetch():
        out = {}
        for t, m in mwapi_files(f'mwapi:generator "search" ; mwapi:gsrsearch {mw(f"haswbstatement:P180={q} filetype:bitmap")} ; '
                                f'mwapi:gsrnamespace "6" ; mwapi:gsrlimit "80" ;', limit=80).items():
            out[t] = [m, "depicts"]
        if refs.get("cat"):
            for t, m in mwapi_files(f'mwapi:generator "categorymembers" ; mwapi:gcmtitle {mw("Category:" + refs["cat"])} ; '
                                    f'mwapi:gcmtype "file" ; mwapi:gcmlimit "120" ;', limit=120).items():
                out.setdefault(t, [m, "category"])
        if refs.get("p18") and refs["p18"] not in out:
            for t, m in one_file(refs["p18"]).items():
                out[t] = [m, "p18"]
        return out
    path = CACHE / "cut-cands" / f"{entry['id']}.json"
    if path.exists():
        return json.loads(path.read_text())
    got = fetch()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(got, ensure_ascii=False))
    return got


def text_rank(entry, title, meta, source):
    """Points for a candidate from its words, or None if it's out."""
    text = plain(f"{title} {meta['desc']}")
    lic = meta["licence"]
    if not FREE.search(lic) or NOT_FREE.search(lic) or not re.search(r"\.(jpe?g|png)$", title, re.I):
        return None
    if NEVER.search(text) or NATIONAL.search(text):
        return None
    for a, b in VERSUS.findall(text):
        if any(x in COUNTRY_WORDS or x.split(" ")[-1] in COUNTRY_WORDS or x.split(" ")[0] in COUNTRY_WORDS for x in (a, b)):
            return None
    place = [w for w in re.findall(r"[a-z]+", plain(entry.get("city") or entry.get("birth_place") or "")) if len(w) > 3]
    words = set(re.findall(r"[a-z]+", text))
    names = set(re.findall(r"[a-z]+", plain(entry["name"])))
    if any(w in words and w not in names for w in place):
        return None
    surname = [w for w in names if len(w) > 2]
    named = bool(surname) and any(w in words for w in surname)
    if source == "category" and not named:
        return None
    s = {"depicts": 4, "category": 2, "p18": 2}[source] + (1 if named else 0)
    if KIT_FREE.search(text):
        s += 4  # a suit or a plain top: no kit at all
    clubs = [plain(c.get("club", "")) for c in entry.get("career", [])]
    if any(c and c.split(" ")[0] in text for c in clubs if len(c) > 4):
        s += 2  # a club context
    return s


# ── segmentation ──────────────────────────────────────────────────────────────
_seg = []


def person_mask(im):
    """0..1 float array, same size as im: how much each pixel belongs to a person (U2-Net human segmentation)."""
    if not _seg:
        import onnxruntime as ort
        if not SEG_MODEL.exists():
            import urllib.request
            SEG_MODEL.parent.mkdir(parents=True, exist_ok=True)
            urllib.request.urlretrieve(SEG_URL, SEG_MODEL)
        o = ort.SessionOptions()
        o.intra_op_num_threads = 2
        _seg.append(ort.InferenceSession(str(SEG_MODEL), o))
    s = _seg[0]
    x = np.asarray(im.convert("RGB").resize((320, 320), Image.LANCZOS), dtype=np.float32)
    x = x / max(1.0, x.max())
    x = (x - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
    x = x.transpose(2, 0, 1)[None].astype(np.float32)
    m = s.run(None, {s.get_inputs()[0].name: x})[0][0, 0]
    m = (m - m.min()) / max(1e-6, m.max() - m.min())
    return np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize(im.size, Image.LANCZOS), dtype=np.float32) / 255


def components(binary):
    import cv2
    n, lab, stats, _ = cv2.connectedComponentsWithStats(binary.astype(np.uint8), 8)
    return n, lab, stats


# ── one candidate ─────────────────────────────────────────────────────────────
def skin_reference(rgb, face):
    """Median colour of the cheeks and forehead (in Lab), for telling skin from cloth."""
    import cv2
    x, y, w, h = face
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    patch = lab[int(y + h * 0.45):int(y + h * 0.7), int(x + w * 0.2):int(x + w * 0.8)]
    return np.median(patch.reshape(-1, 3), axis=0), lab


def make_card(entry, title, meta):
    """(verdict dict, Image or None). The verdict is cached; the image is only kept when it passes."""
    import cv2
    info = imagecheck.look(title, LOOK)
    if not info or not info.get("faces"):
        return {"ok": False, "why": "no face found"}, None
    w, h, faces, m = info["w"], info["h"], info["faces"], info["main"]
    x, y, fw, fh = faces[0][:4]
    v = {"ok": False, "sharp": m["sharp"], "faceH": round(fh), "yaw": m["yaw"], "pitch": m["pitch"]}
    checks = [
        (faces[0][14] >= 0.85, "face not clear to the detector"),
        (not [f for f in faces[1:] if f[3] > fh * imagecheck.MAX_RIVAL], "another face competes"),
        (m["sharp"] >= imagecheck.MIN_SHARP_AT[LOOK], f"face not sharp ({m['sharp']:.0f})"),
        (m["eyeSpan"] >= imagecheck.MIN_EYE_SPAN and abs(m["yaw"]) <= imagecheck.MAX_YAW, "face turned away (profile)"),
        (imagecheck.MIN_PITCH <= m["pitch"] <= imagecheck.MAX_PITCH, "looking down or up"),
        (m["eyeLight"] >= imagecheck.MIN_EYE_LIGHT and m["eyeDetail"] >= imagecheck.MIN_EYE_DETAIL and m["eyeBright"] >= imagecheck.MIN_EYE_BRIGHT,
         "eyes hidden (shadow, sunglasses or visor)"),
        (fh * 1.8 >= MIN_CROP_H, f"face too small for a sharp card ({fh:.0f} px tall in the {LOOK} px copy)"),
        (meta["w"] * fh / w >= 220, "face under 220 px tall in the original file"),
    ]
    for ok, why in checks:
        if not ok:
            return dict(v, why=why), None
    im = imagecheck.download(title, LOOK)
    if im is None:
        return dict(v, why="couldn't download it"), None
    im = im.convert("RGB")
    sx, sy = im.width / w, im.height / h
    x, y, fw, fh = x * sx, y * sy, fw * sx, fh * sy
    kit = kitcheck.kit(im)
    v["kit"] = kit
    if kit["national"] >= NATIONAL_MAX:
        return dict(v, why=f"looks like a national team shirt ({kit['national']:.0%})"), None
    rgb = np.asarray(im)
    mask = person_mask(im)
    n, lab_ids, stats = components(mask > 0.5)
    cx, cy = int(x + fw / 2), int(y + fh / 2)
    me = lab_ids[min(cy, im.height - 1), min(cx, im.width - 1)]
    if me == 0:
        return dict(v, why="couldn't separate the person from the background"), None
    keep = (lab_ids == me).astype(np.float32) * mask
    ref, lab = skin_reference(rgb, (x, y, fw, fh))
    # Below the chin only skin stays (the neck): a collar, a shirt or a scarf becomes transparent, whatever
    # its colour. Above the chin the whole person stays (hair, ears, beard).
    chin = int(y + fh * 0.98)
    d = np.linalg.norm(lab - ref, axis=2)
    skin = np.clip((21 - d) / 6, 0, 1)
    rows, cols = np.arange(im.height)[:, None], np.arange(im.width)[None, :]
    blend = np.clip((rows - chin) / max(1.0, fh * 0.06), 0, 1)  # soft hand-over at the chin
    keep = keep * (1 - blend) + keep * skin * blend
    # Only a head-shaped oval and a neck column survive: shoulders (and a shirt on them) beside the head go,
    # even when the head is tilted and the shoulders sit higher than the chin.
    # (YuNet's box runs from the brows to the chin: the oval is as wide as the box plus the ears, reaches
    # well up for hair, and closes in under the jaw, where collars sit)
    hx, hy, ax = cx, y + fh * 0.4, fw * 0.62
    ay = np.where(rows < hy, fh * 0.98, fh * 0.7)
    oval = ((cols - hx) / ax) ** 2 + ((rows - hy) / ay) ** 2
    head = np.clip((1.12 - oval) / 0.12, 0, 1)
    neck = np.clip((fw * 0.3 - np.abs(cols - (x + fw / 2))) / (fw * 0.06), 0, 1) * (rows >= y + fh * 0.6)
    keep = keep * np.maximum(head, neck)
    # Strong colours far from skin, beside or below the face (a red collar, a yellow shirt), go too. Hair and
    # beards (dark or pale and low in colour) stay, and nothing inside the face itself is touched.
    chroma_off = np.linalg.norm(lab[..., 1:] - ref[1:], axis=2)
    loud = (chroma_off > 30) & (lab[..., 0] > 60) & (rows > y + fh * 0.3)
    inner = (np.abs(cols - cx) < fw * 0.38) & (rows < y + fh * 0.95)
    keep = keep * ~(loud & ~inner)
    # Beside the jaw, from the mouth down, only skin stays: collar points and lapels rise there. (A soft
    # face ellipse is left alone, and shadowed jaw skin still passes.) Collar points that touch the jaw can
    # survive this, so every card is still looked at on the review sheet.
    face = ((cols - cx) / (fw * 0.56)) ** 2 + ((rows - (y + fh * 0.5)) / (fh * 0.62)) ** 2
    outside = np.clip((face - 1) / 0.3, 0, 1) * np.clip((rows - (y + fh * 0.7)) / (fh * 0.1), 0, 1)
    loose_skin = np.clip((30 - d) / 8, 0, 1)
    keep = keep * (1 - outside) + keep * loose_skin * outside
    # Anything no longer joined to the head (a scrap of collar, a microphone) goes.
    n2, pieces, _ = components(keep > 0.3)
    mine = pieces[min(cy, im.height - 1), min(cx, im.width - 1)]
    if mine:
        joined = cv2.dilate((pieces == mine).astype(np.uint8), np.ones((5, 5), np.uint8)).astype(np.float32)
        keep = keep * joined
    # head and neck, 4:5: from above the hair to a little under the chin
    top = y - fh * 0.48
    bottom = y + fh * 1.26
    H = bottom - top
    W = H * 0.8
    box = (int(cx - W / 2), int(top), int(cx + W / 2), int(bottom))
    bx0, by0, bx1, by1 = max(0, box[0]), max(0, box[1]), min(im.width, box[2]), min(im.height, box[3])
    for k in range(1, n):
        if k != me and stats[k][4] > 0.01 * im.width * im.height and (lab_ids[by0:by1, bx0:bx1] == k).mean() > 0.04:
            return dict(v, why="another person overlaps the crop"), None
    # what's left under the chin should be neck: if much of the person there isn't skin, it's clothing we
    # couldn't separate (a high collar, a polo neck), and the picture is out
    under = (keep[chin:by1, bx0:bx1] > 0.5)
    person_under = (mask[chin:by1, bx0:bx1] > 0.5) & (lab_ids[chin:by1, bx0:bx1] == me)
    v["neck"] = round(float(under.sum() / max(1, person_under.sum())), 3)
    if box[1] < -fh * 0.25:
        return dict(v, why="top of the head is cut off"), None
    # cut out, crop, fade the bottom, scale to the card size
    rgba = np.dstack([rgb, (np.clip(keep, 0, 1) * 255).astype(np.uint8)])
    cut = Image.fromarray(rgba, "RGBA")
    canvas = Image.new("RGBA", (box[2] - box[0], box[3] - box[1]), (0, 0, 0, 0))
    canvas.paste(cut.crop((bx0, by0, bx1, by1)), (bx0 - box[0], by0 - box[1]))
    a = np.asarray(canvas.getchannel("A"), dtype=np.float32)
    fade = np.ones(a.shape[0], dtype=np.float32)
    k = int(a.shape[0] * 0.2)
    fade[-k:] = np.linspace(1, 0, k) ** 1.4
    a = a * fade[:, None]
    canvas.putalpha(Image.fromarray(a.astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6)))
    card = canvas.resize((OUT_W, OUT_H), Image.LANCZOS)
    # final checks: no text naming the place, no flag, crest or printed text left
    flat = Image.new("RGB", card.size, (255, 255, 255))
    flat.paste(card, mask=card.getchannel("A"))
    words = [w for w in (entry.get("city"), entry.get("birth_place"), entry.get("metro"), entry.get("country"), entry.get("birth_country")) if w]
    text = imagecheck.ocr_image(flat)
    why = imagecheck.gives_away(text, words) if text.strip() else None
    if why:
        return dict(v, why=f"text in the cutout ({why})"), None
    mk = kitcheck.marks(flat)
    v["marks"] = mk
    if mk["mark"] >= MARK_MAX:
        return dict(v, why=f"a flag, crest or text may still show ({mk['mark']:.0%})"), None
    v["ok"] = True
    v["why"] = None
    return v, card


def judge(entry, title, meta):
    """The cached verdict for one candidate (making the card file if it passes and isn't saved yet)."""
    key = CACHE / "cut" / (hashlib.md5(f"cut3|{entry['id']}|{title}".encode()).hexdigest() + ".json")
    out = OUT_DIR / f"{entry['id'][3:]}.webp"
    if key.exists():
        v = json.loads(key.read_text())
        if not v["ok"] or out.exists():
            return v
    v, card = make_card(entry, title, meta)
    if card is not None:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        card.save(out, "WEBP", quality=82, method=6)
    key.parent.mkdir(parents=True, exist_ok=True)
    key.write_text(json.dumps(v))
    return v


# ── main ──────────────────────────────────────────────────────────────────────
def main():
    data = json.loads(PLAYERS.read_text())
    meta_top, players = ({k: v for k, v in data.items() if k != "players"}, data["players"]) if isinstance(data, dict) else ({}, data)
    reserve = json.loads(RESERVE.read_text()) if RESERVE.exists() else []
    overrides = {k: v for k, v in (json.loads(OVERRIDES.read_text()) if OVERRIDES.exists() else {}).items() if not k.startswith("_")}
    # everyone gets another chance: the live pool, plus the reserve (except those you've ruled out)
    pool = players + [e for e in reserve if e["id"] not in {p["id"] for p in players}]
    excluded = set() if MIX else {"wd-" + q for q in json.loads((ROOT / "data" / "football-overrides.json").read_text()).get("exclude", [])}
    pool = [e for e in pool if e.get("type", "athlete") == "athlete" and not overrides.get(e["id"], {}).get("none") and e["id"] not in excluded]
    teams = [e for e in players if e.get("type") == "team"]
    refs = cached(f"cutrefs-{'mix' if MIX else 'fb'}-{len(pool)}", lambda: wikidata_refs([e["id"][3:] for e in pool]), False)
    keep, out, report = [], [], {}
    t0 = time.time()
    for n, e in enumerate(pool, 1):
        rejects = set(overrides.get(e["id"], {}).get("reject", []))
        e = {k: v for k, v in e.items() if k not in ("reserveReason",)}
        try:
            cands = candidates(e, refs.get(e["id"][3:], {}))
        except QueryFailed:
            out.append((e, "not checked yet (Wikidata busy): run again")); continue
        ranked = sorted(((text_rank(e, t, m, src), t, m, src) for t, (m, src) in cands.items() if t not in rejects), key=lambda r: -(r[0] or -99))
        ranked = [r for r in ranked if r[0] is not None][:MAX_TRIES]
        chosen, tried, busy = None, [], False
        for s, t, m, src in ranked:
            try:
                v = judge(e, t, m)
            except imagecheck.CommonsBusy:
                busy = True; break
            tried.append({"file": t, "why": v["why"], "kit": v.get("kit"), "marks": v.get("marks")})
            if v["ok"]:
                chosen = (t, m, src, v); break
        if chosen:
            t, m, src, v = chosen
            import urllib.parse
            q = urllib.parse.quote(t.replace(" ", "_"))
            e.update({"image": f"assets/players/{e['id'][3:]}.webp", "imageAuthor": m["author"], "imageLicense": m["licence"],
                      "imagePage": f"https://commons.wikimedia.org/wiki/File:{q}", "imageSource": src, "imageEdited": "cropped, background removed",
                      "imageConfidence": "high"})
            e.pop("imageFocus", None)
            keep.append(e)
            report[e["id"]] = {"name": e["name"], "file": t, "kit": v.get("kit"), "marks": v.get("marks"), "cloth": v.get("cloth"),
                               "neck": v.get("neck"), "sharp": v.get("sharp"), "faceH": v.get("faceH"), "tried": len(tried)}
        else:
            for k in ("image", "imageAuthor", "imageLicense", "imagePage", "imageSource", "imageEdited", "imageConfidence", "imageFocus"):
                e.pop(k, None)
            why = "not checked yet (Commons busy): run again" if busy else (
                "no candidate pictures" if not tried else "no picture passed: " + "; ".join(sorted({x["why"].split(" (")[0] for x in tried})))
            out.append((e, why))
            (OUT_DIR / f"{e['id'][3:]}.webp").unlink(missing_ok=True)
        if n % 25 == 0:
            print(f"   {n}/{len(pool)} · {len(keep)} cards · {time.time() - t0:.0f} s", flush=True)

    if not MIX:  # football: difficulty thirds by fame, each list in its own order
        keep.sort(key=lambda e: -e["fame_score"])
        for k, e in enumerate(keep):
            e["difficulty"] = 1 + min(2, k * 3 // max(1, len(keep)))
        keep.sort(key=lambda e: (e["list"] != "legend", -(e["legend_score"] if e["list"] == "legend" else e["fame_score"])))
        PLAYERS.write_text(json.dumps(dict(meta_top, players=keep), ensure_ascii=False, indent=1) + "\n")
    else:
        keep.sort(key=lambda e: -e.get("fame", 0))
        for k, e in enumerate(keep):
            e["difficulty"] = 1 if k < len(keep) * 0.7 else 2
        PLAYERS.write_text(json.dumps(keep + teams, ensure_ascii=False, indent=1) + "\n")
    RESERVE.write_text(json.dumps([dict(e, reserveReason=why) for e, why in out], ensure_ascii=False, indent=1) + "\n")
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=0) + "\n")
    print(f"\n{len(keep)} players with a card, {len(out)} in the reserve.")
    by = {}
    for e, why in out:
        k = why.split(":")[0]
        by[k] = by.get(k, 0) + 1
    for k, c in sorted(by.items(), key=lambda x: -x[1]):
        print(f"   {c:>4}  {k}")


if __name__ == "__main__":
    main()
