"""What is the person in a photo wearing? CLIP (ViT-B/32, run locally with onnxruntime) compares the picture
with a few short descriptions and says how well each fits. Used to turn down national team shirts before
a player card is made, and to look for flags and crests left in the finished cutout.

Models (downloaded on first use into scripts/.cache/models, from Hugging Face "Xenova/clip-vit-base-patch32"):
clip-vision_model.onnx, clip-text_model.onnx, clip-tokenizer.json.
"""
import pathlib
import urllib.request

import numpy as np
from PIL import Image

MODELS = pathlib.Path(__file__).resolve().parent / ".cache" / "models"
HF = "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/"
FILES = {"clip-vision_model.onnx": "onnx/vision_model.onnx", "clip-text_model.onnx": "onnx/text_model.onnx",
         "clip-tokenizer.json": "tokenizer.json"}

# What the shirt (or lack of one) might be. "national" sums the first two.
KIT_LABELS = {
    "national": ["a footballer wearing his country's national team football shirt with the national crest",
                 "a football player in a national team kit at an international match"],
    "club": ["a footballer wearing a club football shirt with a sponsor logo",
             "a football player in a club training top"],
    "suit": ["a man in a suit and tie at an awards ceremony", "a person in a blazer at a press conference"],
    "plain": ["a person in a plain t-shirt or jumper", "a person in a plain jacket"],
}
# Anything national left in a finished head-and-neck cutout.
MARK_LABELS = {
    "mark": ["a national flag", "a football badge or crest", "printed text on clothing"],
    "clean": ["a portrait of a person's head and neck on a plain background", "a close-up of a face"],
}

_sess = {}


def _models():
    if _sess:
        return _sess
    import onnxruntime as ort
    from tokenizers import Tokenizer
    MODELS.mkdir(parents=True, exist_ok=True)
    for name, path in FILES.items():
        if not (MODELS / name).exists():
            urllib.request.urlretrieve(HF + path, MODELS / name)
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 2
    _sess["vision"] = ort.InferenceSession(str(MODELS / "clip-vision_model.onnx"), opts)
    _sess["text"] = ort.InferenceSession(str(MODELS / "clip-text_model.onnx"), opts)
    tok = Tokenizer.from_file(str(MODELS / "clip-tokenizer.json"))
    tok.enable_padding(length=77, pad_id=49407)
    tok.enable_truncation(77)
    _sess["tok"] = tok
    _sess["texts"] = {}
    return _sess


def _text_embeds(labels):
    s = _models()
    key = tuple(labels)
    if key not in s["texts"]:
        ids = np.array([e.ids for e in s["tok"].encode_batch(list(labels))], dtype=np.int64)
        t = s["text"].run(None, {"input_ids": ids})[0]
        s["texts"][key] = t / np.linalg.norm(t, axis=1, keepdims=True)
    return s["texts"][key]


def _image_embed(im):
    """CLIP's preprocessing: shortest side to 224, centre crop, normalise."""
    im = im.convert("RGB")
    w, h = im.size
    sc = 224 / min(w, h)
    im = im.resize((max(224, round(w * sc)), max(224, round(h * sc))), Image.BICUBIC)
    w, h = im.size
    im = im.crop(((w - 224) // 2, (h - 224) // 2, (w - 224) // 2 + 224, (h - 224) // 2 + 224))
    x = np.asarray(im, dtype=np.float32) / 255
    x = (x - [0.48145466, 0.4578275, 0.40821073]) / [0.26862954, 0.26130258, 0.27577711]
    x = x.transpose(2, 0, 1)[None].astype(np.float32)
    e = _models()["vision"].run(None, {"pixel_values": x})[0]
    return e / np.linalg.norm(e, axis=1, keepdims=True)


def _classify(im, groups):
    labels = [l for ls in groups.values() for l in ls]
    logits = 100 * (_image_embed(im) @ _text_embeds(labels).T)[0]
    p = np.exp(logits - logits.max())
    p /= p.sum()
    out, i = {}, 0
    for g, ls in groups.items():
        out[g] = round(float(p[i:i + len(ls)].sum()), 3)
        i += len(ls)
    return out


def kit(im):
    """{"national", "club", "suit", "plain"}: shares that add up to 1."""
    return _classify(im, KIT_LABELS)


def marks(im):
    """{"mark", "clean"}: how much a finished cutout looks like it still shows a flag, crest or text."""
    return _classify(im, MARK_LABELS)
