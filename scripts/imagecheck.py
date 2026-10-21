"""Looks inside candidate pictures: reads any text in them (OCR, with tesseract) so a logo saying
"PITTSBURGH" or a photo of a stadium sign can't give the answer away.

Used by pick_images.py. Needs tesseract (apt install tesseract-ocr) and Pillow.
Downloads and results are cached in scripts/.cache/img/.
"""
import difflib
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import threading
import time
import urllib.parse
import urllib.error
import urllib.request

from PIL import Image, ImageOps

from build_players import USER_AGENT
from spoilers import fold, mentions_place, place_tokens

CACHE = pathlib.Path(__file__).resolve().parent / ".cache" / "img"


class CommonsBusy(Exception):
    """Commons kept refusing downloads (rate limit): try this entry again on the next run."""


_gate = threading.Lock()
_last = [0.0]


_big_gate = threading.Lock()
_big_last = [0.0]


def _polite(width=500):
    """Pacing. Commons serves small copies freely but limits how fast it makes new big ones for us,
    so small copies go at about two a second and big ones (over 500 px) one every six seconds."""
    if width > 500:
        with _big_gate:
            wait = _big_last[0] + 6 - time.time()
            if wait > 0:
                time.sleep(wait)
            _big_last[0] = time.time()
    with _gate:
        wait = _last[0] + 0.5 - time.time()
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()


def download(title, width=1280):
    """The file from Commons at `width` pixels wide, as a Pillow image (cached on disk). None if it fails."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / (hashlib.md5(f"{title}|{width}".encode()).hexdigest() + ".img")
    if not path.exists():
        url = f"https://commons.wikimedia.org/wiki/Special:FilePath/{urllib.parse.quote(title.replace(' ', '_'))}?width={width}"
        busy = 0
        for attempt in range(7):
            try:
                _polite(width)
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                path.write_bytes(urllib.request.urlopen(req, timeout=60).read())
                break
            except urllib.error.HTTPError as err:
                if err.code == 404:
                    return None
                busy += err.code == 429
                time.sleep(60 if err.code == 429 and width > 500 else int(err.headers.get("Retry-After") or 0) or 10 * (attempt + 1))  # back off
            except Exception:  # noqa: BLE001 (timeouts, dropped connections: try again a little later)
                time.sleep(3 * (attempt + 1))
        else:
            if busy:
                raise CommonsBusy(title)
            return None
    try:
        im = Image.open(io.BytesIO(path.read_bytes()))
        im.load()
        return im
    except Exception:  # noqa: BLE001
        return None


def ocr(title, width=500, photo=False):
    """All the text tesseract can find in the picture, as one string (cached).
    photo: one pass at the size it is (enough for a watermark); logos get enlarged and inverted too."""
    if not shutil.which("tesseract"):
        raise SystemExit("tesseract is not installed (apt install tesseract-ocr)")
    key = CACHE / (hashlib.md5(f"ocr|{title}".encode()).hexdigest() + ".json")
    if key.exists():
        return json.loads(key.read_text())["text"]
    im = download(title, width)
    text = ""
    if im is not None:
        # flatten transparency onto white, grey, enlarge small logos; read both normal and inverted
        im = im.convert("RGBA")
        flat = Image.new("RGBA", im.size, "white")
        flat.alpha_composite(im)
        grey = flat.convert("L")
        if grey.width < 1200 and not photo:
            grey = grey.resize((grey.width * 2, grey.height * 2))
        parts = []
        for variant in (grey,) if photo else (grey, ImageOps.invert(grey)):
            buf = io.BytesIO()
            variant.save(buf, format="PNG")
            res = subprocess.run(["tesseract", "stdin", "stdout", "--psm", "11"], input=buf.getvalue(), capture_output=True,
                                 env={**os.environ, "OMP_THREAD_LIMIT": "1"})  # one thread each: we run several at once
            parts.append(res.stdout.decode("utf-8", "ignore"))
        text = " ".join(parts)
    key.write_text(json.dumps({"text": text}))
    return text


def words_in(text):
    """Plausible words in OCR output: runs of 4+ letters (OCR noise on graphics is mostly short scraps)."""
    return [w for w in re.findall(r"[^\W\d_]{4,}", fold(text)) if len(set(w)) > 2]


def gives_away(text, words, allowed=()):
    """Why this picture's text names the answer's place (a reason string), or None.
    `allowed`: words that may appear (the team's own nickname)."""
    found = words_in(text)
    if not found:
        return None
    if mentions_place(" ".join(found), words):
        return "text names the place"
    tokens = place_tokens(words)
    for w in found:  # OCR misreads: "PITTSBURGM" for Pittsburgh
        for t in tokens:
            if len(t) >= 5 and len(w) >= 5 and difflib.SequenceMatcher(None, w, t).ratio() >= 0.75:
                return f'text "{w}" looks like "{t}"'
    return None


def foreign_text(text, allowed):
    """Words in a logo other than the team's own name/nickname (a logo is best with no text at all)."""
    ok = {t for a in allowed for t in fold(a).split() if len(t) >= 3}
    extra = []
    for w in words_in(text):
        if len(w) < 5 or any(w in o or o in w or difflib.SequenceMatcher(None, w, o).ratio() >= 0.7 for o in ok):
            continue
        extra.append(w)
    return extra


# ── faces and sharpness (athlete photos) ─────────────────────────────────────────
# OpenCV's face models (opencv_zoo, Apache 2.0): YuNet finds faces, SFace tells whose face it is.
MODELS = CACHE.parent / "models"
MODEL_URLS = {
    "face_detection_yunet_2023mar.onnx": "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "face_recognition_sface_2021dec.onnx": "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
}


def model(name):
    """Path to a face model, downloaded the first time it's needed."""
    path = MODELS / name
    if not path.exists():
        MODELS.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(MODEL_URLS[name], headers={"User-Agent": USER_AGENT})
        path.write_bytes(urllib.request.urlopen(req, timeout=300).read())
    return path
_local = threading.local()  # one detector per thread: they aren't safe to share


def _cv():
    import cv2  # pip install opencv-python-headless
    try:
        cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_ERROR)  # quiet the "targets not supported" notes
    except AttributeError:
        pass
    return cv2


LOOK_WIDTH = 1280  # we judge each picture at the size the game loads it (a standard Commons thumbnail size: fast)


def look(title, width=None):
    """What's in the picture, judged at the size the game loads it (1,000 px wide):
    {"w", "h", "faces": [[x, y, w, h, 10 landmark numbers, score], ...] biggest first, "main": {...}}.
    "main" measures the biggest face: sharpness (variance of the Laplacian on the face crop), the eye
    spacing and nose position (to tell front-on from profile, and looking down), and how bright and
    detailed the eye areas are compared with the lower face (cap shadow, sunglasses, a visor). Cached."""
    width = width or LOOK_WIDTH
    key = CACHE / (hashlib.md5(f"look6|{title}|{width}".encode()).hexdigest() + ".json")
    if key.exists():
        return json.loads(key.read_text())
    im = download(title, width)
    if im is None:
        return None
    cv2 = _cv()
    import numpy as np
    bgr = np.array(im.convert("RGB"))[:, :, ::-1].copy()
    h, w = bgr.shape[:2]
    if not hasattr(_local, "detector"):
        _local.detector = cv2.FaceDetectorYN.create(str(model("face_detection_yunet_2023mar.onnx")), "", (w, h), score_threshold=0.6)
    _local.detector.setInputSize((w, h))
    _, found = _local.detector.detect(bgr)
    # each face: x, y, w, h, then five landmarks (right eye, left eye, nose tip, mouth right, mouth left), score
    faces = sorted(([round(float(v), 1) for v in f[:14]] + [round(float(f[14]), 3)] for f in (found if found is not None else [])),
                   key=lambda f: -f[3])
    out = {"w": w, "h": h, "faces": faces, "main": None}
    if faces:
        grey = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype("float32")
        x, y, fw, fh = faces[0][:4]
        (rex, rey), (lex, ley), (nx, ny), (mrx, mry), (mlx, mly) = zip(faces[0][4:14:2], faces[0][5:14:2])
        crop = grey[int(max(0, y)):int(min(h, y + fh)), int(max(0, x)):int(min(w, x + fw))]
        sharp = 0.0
        if crop.size:
            crop = cv2.resize(crop, (160, max(1, int(160 * crop.shape[0] / max(crop.shape[1], 1)))))
            sharp = float(cv2.Laplacian(crop, cv2.CV_32F).var())
        eye_d = max(1.0, ((lex - rex) ** 2 + (ley - rey) ** 2) ** 0.5)
        mid_x, mid_y = (rex + lex) / 2, (rey + ley) / 2

        def patch(cx, cy, r):
            r = max(2, int(r))
            p_ = grey[int(max(0, cy - r)):int(min(h, cy + r)), int(max(0, cx - r)):int(min(w, cx + r))]
            return (float(p_.mean()), float(p_.std())) if p_.size else (0.0, 0.0)
        eyes = [patch(rex, rey, eye_d * 0.18), patch(lex, ley, eye_d * 0.18)]
        lower = patch((nx + (mrx + mlx) / 2) / 2, (ny + (mry + mly) / 2) / 2, eye_d * 0.25)  # between nose and mouth
        import numpy as np

        def brightest(cx, cy, r):  # the eye-whites and catchlights: missing behind sunglasses or a visor
            r = max(2, int(r))
            p_ = grey[int(max(0, cy - r)):int(min(h, cy + r)), int(max(0, cx - r)):int(min(w, cx + r))]
            return float(np.percentile(p_, 95)) if p_.size else 0.0
        eye_bright = min(brightest(rex, rey, eye_d * 0.22), brightest(lex, ley, eye_d * 0.22)) / max(lower[0], 1)
        out["main"] = {
            "sharp": round(sharp, 1),
            "eyeSpan": round(eye_d / max(fw, 1), 3),        # ~0.4 front-on, under ~0.25 is a profile
            "yaw": round((nx - mid_x) / eye_d, 3),           # nose left/right of the eyes' midpoint
            "pitch": round((ny - mid_y) / eye_d, 3),         # nose below the eyes: small = looking down
            "eyeLight": round(min(e[0] for e in eyes) / max(lower[0], 1), 3),  # eyes vs lower face brightness
            "eyeDetail": round(min(e[1] for e in eyes), 1),  # flat and dark = sunglasses or deep shadow
            "eyeBright": round(eye_bright, 3),               # under 1: no eye-whites brighter than the skin
        }
    key.write_text(json.dumps(out))
    return out


# The thresholds every athlete photo must pass (see judge_photo).
MIN_FACE_SHARE = 0.18    # face height / picture height
MIN_FACE_PX = 120        # face width, in the 1,000 px picture we load
MAX_RIVAL = 0.35         # any other face must be smaller than this share of the main face
MIN_SHARP = 20           # Laplacian variance on the face crop (160 px wide), measured on the 500 px copy
                         # (about 120 on the 1,280 px copy; see the calibration note in the README)
MIN_EYE_SPAN, MAX_YAW = 0.27, 0.42
MIN_PITCH, MAX_PITCH = 0.32, 1.05
MIN_EYE_LIGHT, MIN_EYE_DETAIL, MIN_EYE_BRIGHT = 0.5, 7, 1.0


def worth_a_closer_look(title):
    """A quick first pass on Commons' small 500 px copy: face share and rival faces don't depend on the size,
    so most pictures can be ruled out without downloading the big copy."""
    info = look(title, 500)
    if not info or not info["faces"]:
        return False
    main = info["faces"][0]
    return main[3] / info["h"] >= MIN_FACE_SHARE * 0.9 and not [f for f in info["faces"][1:] if f[3] > main[3] * MAX_RIVAL]


def judge_photo(info, served_width=1280):
    """(points, reason to reject or None, focus "x% y%", numbers for the contact sheet) for an athlete photo.
    `info` comes from look() on Commons' 500 px copy (Commons limits how fast it makes big copies for us);
    face widths are scaled to the copy the game loads (`served_width`, at most the original's width)."""
    if not info:
        return 0, "couldn't open it", None, {}
    w, h, faces, m = info["w"], info["h"], info["faces"], info["main"]
    if not faces or not m:
        return 0, "no face found", None, {}
    x, y, fw, fh = faces[0][:4]
    stats = {"faceShare": round(fh / h, 3), "facePx": round(fw * served_width / w), "sharp": m["sharp"], "box": [round(x / w, 3), round(y / h, 3), round(fw / w, 3), round(fh / h, 3)],
             "eyeSpan": m["eyeSpan"], "yaw": m["yaw"], "pitch": m["pitch"], "eyeLight": m["eyeLight"], "eyeDetail": m["eyeDetail"], "eyeBright": m["eyeBright"], "score": faces[0][14]}
    checks = [
        (faces[0][14] >= 0.85, "face not clear to the detector"),
        (fh / h >= MIN_FACE_SHARE, f"face too small ({fh / h:.0%} of the height)"),
        (fw * served_width / w >= MIN_FACE_PX, f"face only {fw * served_width / w:.0f} px wide"),
        (not [f for f in faces[1:] if f[3] > fh * MAX_RIVAL], "another face competes"),
        (m["sharp"] >= MIN_SHARP, f"face not sharp ({m['sharp']:.0f})"),
        (m["eyeSpan"] >= MIN_EYE_SPAN and abs(m["yaw"]) <= MAX_YAW, "face turned away (profile)"),
        (MIN_PITCH <= m["pitch"] <= MAX_PITCH, "looking down or up"),
        (m["eyeLight"] >= MIN_EYE_LIGHT and m["eyeDetail"] >= MIN_EYE_DETAIL and m["eyeBright"] >= MIN_EYE_BRIGHT,
         "eyes hidden (shadow, sunglasses or visor)"),
        (x >= w * 0.01 and x + fw <= w * 0.99 and y - fh * 0.15 >= 0 and y + fh <= h * 0.99, "face cut off by the edge"),
    ]
    for ok, why in checks:
        if not ok:
            return 0, why, None, stats
    cx, cy = (x + fw / 2) / w, (y + fh / 2) / h
    focus = f"{round(cx * 100)}% {round(max(0, cy - 0.05) * 100)}%"
    points = min(fh / h, 0.5) * 10 + min(m["sharp"], 600) / 150 + (1 - abs(m["yaw"])) * 2
    return round(points, 2), None, focus, stats


WATERMARK = re.compile(r"©|copyright|\bphoto\b|www\.|\.com\b|getty|shutterstock|alamy|reuters|\bafp\b|imago|dreamstime", re.I)


def has_watermark(title):
    """Text laid over the picture: a copyright line, an agency name or a web address."""
    return bool(WATERMARK.search(ocr(title, photo=True)))
