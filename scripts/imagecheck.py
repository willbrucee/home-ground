"""Looks inside candidate pictures: reads any text in them (OCR, with tesseract) so a logo saying
"PITTSBURGH" or a photo of a stadium sign can't give the answer away.

Used by pick_images.py. Needs tesseract (apt install tesseract-ocr) and Pillow.
Downloads and results are cached in scripts/.cache/img/.
"""
import difflib
import hashlib
import io
import json
import pathlib
import re
import shutil
import subprocess
import threading
import time
import urllib.parse
import urllib.request

from PIL import Image, ImageOps

from build_players import USER_AGENT
from spoilers import fold, mentions_place, place_tokens

CACHE = pathlib.Path(__file__).resolve().parent / ".cache" / "img"


def download(title, width=800):
    """The file from Commons at `width` pixels wide, as a Pillow image (cached on disk). None if it fails."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / (hashlib.md5(f"{title}|{width}".encode()).hexdigest() + ".img")
    if not path.exists():
        url = f"https://commons.wikimedia.org/wiki/Special:FilePath/{urllib.parse.quote(title.replace(' ', '_'))}?width={width}"
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                path.write_bytes(urllib.request.urlopen(req, timeout=60).read())
                break
            except Exception:  # noqa: BLE001 (busy, timeouts: try again a little later)
                time.sleep(3 * (attempt + 1))
        else:
            return None
    try:
        im = Image.open(io.BytesIO(path.read_bytes()))
        im.load()
        return im
    except Exception:  # noqa: BLE001
        return None


def ocr(title):
    """All the text tesseract can find in the picture, as one string (cached)."""
    if not shutil.which("tesseract"):
        raise SystemExit("tesseract is not installed (apt install tesseract-ocr)")
    key = CACHE / (hashlib.md5(f"ocr|{title}".encode()).hexdigest() + ".json")
    if key.exists():
        return json.loads(key.read_text())["text"]
    im = download(title)
    text = ""
    if im is not None:
        # flatten transparency onto white, grey, enlarge small logos; read both normal and inverted
        im = im.convert("RGBA")
        flat = Image.new("RGBA", im.size, "white")
        flat.alpha_composite(im)
        grey = flat.convert("L")
        if grey.width < 1200:
            grey = grey.resize((grey.width * 2, grey.height * 2))
        parts = []
        for variant in (grey, ImageOps.invert(grey)):
            buf = io.BytesIO()
            variant.save(buf, format="PNG")
            res = subprocess.run(["tesseract", "stdin", "stdout", "--psm", "11"], input=buf.getvalue(), capture_output=True)
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


def look(title):
    """What's in the picture: {"w", "h", "faces": [[x, y, w, h, score], ...] biggest first, "sharp": float}.
    Faces come from OpenCV's YuNet detector; "sharp" is the variance of the Laplacian over the main face
    (or the whole picture with no face): low means blurry. Cached. None if the file can't be read."""
    key = CACHE / (hashlib.md5(f"look3|{title}".encode()).hexdigest() + ".json")
    if key.exists():
        return json.loads(key.read_text())
    im = download(title)
    if im is None:
        return None
    cv2 = _cv()
    import numpy as np
    rgb = np.array(im.convert("RGB"))
    bgr = rgb[:, :, ::-1].copy()
    h, w = bgr.shape[:2]
    if not hasattr(_local, "detector"):
        _local.detector = cv2.FaceDetectorYN.create(str(model("face_detection_yunet_2023mar.onnx")), "", (w, h), score_threshold=0.75)
    _local.detector.setInputSize((w, h))
    _, found = _local.detector.detect(bgr)
    # each face: x, y, w, h, five landmark points (10 numbers), score
    faces = sorted(([round(float(v), 1) for v in f[:14]] + [float(f[14])] for f in (found if found is not None else [])), key=lambda f: -f[3])
    grey = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    if faces:
        x, y, fw, fh = (int(max(0, v)) for v in faces[0][:4])
        region = grey[y:y + max(fh, 8), x:x + max(fw, 8)]
        if region.size:
            # judge sharpness at a common scale, so a big face isn't penalised for having more pixels
            region = cv2.resize(region, (128, int(128 * region.shape[0] / max(region.shape[1], 1)) or 128))
    else:
        region = cv2.resize(grey, (800, int(800 * h / w)))
    sharp = float(cv2.Laplacian(region, cv2.CV_64F).var()) if region.size else 0.0
    out = {"w": w, "h": h, "faces": faces, "sharp": round(sharp, 1)}
    key.write_text(json.dumps(out))
    return out


def judge_photo(info):
    """(points, reason to reject or None, focus "x% y%") for an athlete photo, from look()."""
    if not info:
        return 0, "couldn't open it", None
    w, h, faces = info["w"], info["h"], info["faces"]
    if w < h * 0.8:
        return 0, "tall picture (wants landscape)", None
    if not faces:
        return 0, "no face found", None
    main = faces[0]
    share = main[3] / h  # face height as a share of the picture height
    if share < 0.08:
        return 0, f"face too small ({share:.0%} of the height)", None
    rivals = [f for f in faces[1:] if f[3] >= main[3] * 0.6]
    if rivals:
        return 0, f"{len(rivals) + 1} faces of similar size (group shot)", None
    if info["sharp"] < 40:
        return 0, f"blurry (sharpness {info['sharp']:.0f})", None
    cx, cy = (main[0] + main[2] / 2) / w, (main[1] + main[3] / 2) / h
    focus = f"{round(cx * 100)}% {round(max(0, cy - 0.08) * 100)}%"  # a little above the face, so the head has room
    points = 0.0
    points += 3 if 0.1 <= share <= 0.4 else 1   # big in frame, but not a passport photo
    points += 2 if w >= h * 1.2 else 0          # landscape
    points += min(info["sharp"], 400) / 200      # up to +2 for crisp
    points += 1 if w >= 1200 else 0
    return round(points, 1), None, focus


def face_print(title, face):
    """A face's fingerprint (SFace feature vector) for comparing who it is. Cached."""
    key = CACHE / (hashlib.md5(f"print|{title}|{face[:4]}".encode()).hexdigest() + ".json")
    if key.exists():
        return json.loads(key.read_text())
    cv2 = _cv()
    import numpy as np
    im = download(title)
    if im is None:
        return None
    bgr = np.array(im.convert("RGB"))[:, :, ::-1].copy()
    if not hasattr(_local, "recogniser"):
        _local.recogniser = cv2.FaceRecognizerSF.create(str(model("face_recognition_sface_2021dec.onnx")), "")
    crop = _local.recogniser.alignCrop(bgr, np.array(face, dtype=np.float32))
    vec = _local.recogniser.feature(crop).flatten().tolist()
    key.write_text(json.dumps(vec))
    return vec


def same_face(a, b):
    """Cosine similarity of two face fingerprints: SFace says 0.363+ is the same person."""
    import numpy as np
    a, b = np.array(a), np.array(b)
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))
