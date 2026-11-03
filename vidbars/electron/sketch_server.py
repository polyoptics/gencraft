"""VidBars' sketch worker: runs sketchLook's tools UNCHANGED, with their models loaded once.

    python sketch_server.py <sketchLook dir> <cache dir>

One JSON request per line on stdin, one JSON reply per line on stdout (the tools' own printing goes to stderr):

  {"id", "op": "depth",   "src": HASH, "frames": [path...]}
  {"id", "op": "segment", "src": HASH, "frames": [...], "objects": {name: [phrase...]}}
  {"id", "op": "lines",   "src": HASH, "frames": [...], "objects": {...}, "side": 1400, "dials": {dial: number}}

HASH names the picture (its bytes); everything made from it is kept under <cache dir>/<HASH>/, so asking again
(another card, a re-run, a bake) reads the result instead of running the tool. Replies name PNG files:
  depth   -> {"frames": [png...]}                           grey, nearer = brighter, one range for the sequence
  segment -> {"objects": {name: [png...]}}                  white = the thing; "figure" = all of them; {} = none
  lines   -> {"frames": [{"outline", "inside", "paper", "pencil": png}], "colors": {...}}
  formhatch -> {"frames": [{"a", "k", "b", "h": png}]}   dark hatch alpha, its ink colour, light strokes, their colour
  bghatch -> {"frames": [{"a", "k", "p": png}], "colors": {"pencil": hex}}   ink alpha, ink colour, far pencil alpha
  {"op": "look", "look": NAME, ...}  -> {"frames": [{"c0", "a0", "c1", "a1" ...: png}], "colors": {"modes": [...]}}
          one of LOOKS (hatch, cel, boil, misreg, construction, relight, formlight, bg_layout, bg_tonewash): each layer
          the look writes as its colour (cN) and alpha (aN), and how it goes over the frame (modes, in order)

How the tools run: each script is executed from its own file with __file__ pointing into the picture's cache folder,
so its ROOT (the folder above tools/) is that folder and it reads and writes there, never in sketchLook.
  depth   tools/depth.py on a clip of the frames
  segment matte_auto.py's models and settings, but EVERY match kept (it keeps the best box per object): Grounding
          DINO on the first frame, SAM2 tracking each box, matte_auto.py's own cleaning; one matte per instance
  formhatch, bghatch  tools_scale/look_formhatch.py and look_bg_depthhatch.py driven through their own functions
          (their main() is behind __name__), taking the layers render() returns - exactly what they write
  lines   tools_scale/look_hybrid_colerase.py on the frames scaled to `side`, over the segment's mattes. Its own
          compositor (finish) is swapped for one that saves its four layers apart - the silhouette ink (black
          outline), the interior ink (inside lines), the paper highlights and the col-erase pencil - so VidBars
          composites them live; every line it draws is the script's own.
Models: from_pretrained is cached here, so Depth Anything, Grounding DINO and SAM2 load once per worker.
"""
import ast
import contextlib
import functools
import glob
import hashlib
import io
import json
import os
import shutil
import sys
import time
import traceback

sys.dont_write_bytecode = True  # never leave __pycache__ next to sketchLook's tools
import cv2  # noqa: E402
import numpy as np  # noqa: E402

SKETCH, CACHE = sys.argv[1], sys.argv[2]
TOOLS, TOOLS_SCALE = os.path.join(SKETCH, "tools"), os.path.join(SKETCH, "tools_scale")
OUT = sys.stdout
os.makedirs(CACHE, exist_ok=True)
DEFAULT_OBJECTS = ("character", "rifle", "truck")  # what matte_auto.py searches unless told otherwise
LOOK = os.path.join(TOOLS_SCALE, "look_hybrid_colerase.py")
LOOK_SPLIT = "\npool = ThreadPoolExecutor(WORKERS)"  # where the look's set-up ends and its run starts


# ------------------------------------------------------------------------------------------- models, once
def cache_from_pretrained(cls):
    orig = cls.from_pretrained.__func__ if hasattr(cls.from_pretrained, "__func__") else cls.from_pretrained
    kept = {}

    def from_pretrained(c, *a, **k):
        key = (c.__name__, a, tuple(sorted(k.items())))
        if key not in kept:
            kept[key] = orig(c, *a, **k)
        return kept[key]
    cls.from_pretrained = classmethod(from_pretrained)


def warm_models():
    import transformers
    for n in ("AutoImageProcessor", "AutoModelForDepthEstimation", "AutoProcessor",
              "AutoModelForZeroShotObjectDetection"):
        cache_from_pretrained(getattr(transformers, n))
    from sam2.sam2_video_predictor import SAM2VideoPredictor
    cache_from_pretrained(SAM2VideoPredictor)


# ------------------------------------------------------------------------------------------- running a tool
# ------------------------------------------------------------------------------------------- output size
# A bake bigger than the preview draws at its own size (res_factor k): the looks' pixel-size DIALS are scaled (PX,
# scaled_dials), but some sizes are written into the scripts' code - a blur radius, a morphology disk. Those are
# scaled too, as each script is loaded: PX_SRC lists, per script, exact pieces of its source and the same piece with
# the size times VB_K (the run's k, put in the script's globals). The files are never changed; a piece that is not
# found (the script was edited) is reported in the log and left as it is. Scripts executed here (run_tool, load_lib)
# and the modules they import (look_formhatch, the frozen copy tools_marks reads, ...) are patched alike.
VB_K = [1.0]
PX_SRC = {
    # the background depth hatch (and its frozen copy in tools_marks/_frozen, which Stipple and Halftone read)
    "look_bg_depthhatch.py": [
        ("x = blur(x, 4.0)", "x = blur(x, 4.0 * VB_K)"),
        ("    Ls = blur(L, 1.0)\n    return blur(np.hypot(cv2.Sobel(Ls, cv2.CV_32F, 1, 0), cv2.Sobel(Ls, cv2.CV_32F, 0, 1)) / 8, 6 / F)",
         # the detail energy: a gradient per px, so per preview px (x k) - the air thresholds hold at any size
         "    Ls = blur(L, 1.0 * VB_K)\n    return blur(np.hypot(cv2.Sobel(Ls, cv2.CV_32F, 1, 0), cv2.Sobel(Ls, cv2.CV_32F, 0, 1)) / 8 * VB_K, 6 * VB_K / F)"),
        ("disk(8 / F)", "disk(8 * VB_K / F)"),
        ("cv2.erode(sup, disk(4))", "cv2.erode(sup, disk(4 * VB_K))"),
        ("cv2.erode(mb.astype(np.uint8), disk(3 / F))", "cv2.erode(mb.astype(np.uint8), disk(3 * VB_K / F))"),
        ("band &= cv2.dilate((fig > 0.5).astype(np.uint8), disk(2))", "band &= cv2.dilate((fig > 0.5).astype(np.uint8), disk(2 * VB_K))"),
        ("bg = 1 - cv2.dilate((fig > 0.5).astype(np.uint8), disk(3))", "bg = 1 - cv2.dilate((fig > 0.5).astype(np.uint8), disk(3 * VB_K))"),
        ("if m.sum() < 20:", "if m.sum() < 20 * VB_K * VB_K:"),
        ("blur(L, 0.7)", "blur(L, 0.7 * VB_K)"),
        ("blur(np.maximum.reduce(sp), 3)", "blur(np.maximum.reduce(sp), 3 * VB_K)"),
        # a reduced stroke keeps its ink when it is thinner than a PREVIEW pixel (the preview's look; in the bake's
        # own pixels the far strokes are never that thin, and the distance drew half as dark)
        ("hh = np.maximum(hw[r], 0)", "hh = np.maximum(hw[r], 0) / VB_K"),
    ],
    # tools_marks' fields (Stipple, Halftone): its masks' and steadying's own radii
    "fields.py": [
        ("md = blur(cv2.dilate(figh, disk(2)), 1.5)", "md = blur(cv2.dilate(figh, disk(2 * VB_K)), 1.5 * VB_K)"),
        ("core = cv2.erode((m > 0.5).astype(np.uint8), disk(3)) > 0", "core = cv2.erode((m > 0.5).astype(np.uint8), disk(3 * VB_K)) > 0"),
        ("cv2.MORPH_OPEN, disk(3))", "cv2.MORPH_OPEN, disk(3 * VB_K))"),
        ("np.maximum(blur(keep, 1.0), keep)", "np.maximum(blur(keep, 1.0 * VB_K), keep)"),
        ("[blur(m, 1) + 2 * m for m in ms]", "[blur(m, VB_K) + 2 * m for m in ms]"),
        ("region = blur(fig, 0.7) * blur(nondark.astype(np.float32), 0.7)",
         "region = blur(fig, 0.7 * VB_K) * blur(nondark.astype(np.float32), 0.7 * VB_K)"),
        ("dil = cv2.dilate(c, disk(3))", "dil = cv2.dilate(c, disk(3 * VB_K))"),
        ("g = blur(c, 0.8)", "g = blur(c, 0.8 * VB_K)"),
        ("BG.half(t)[2] > 0.5).astype(np.uint8), disk(2))", "BG.half(t)[2] > 0.5).astype(np.uint8), disk(2 * VB_K))"),
        ("0.3 * blur(j, 24)", "0.3 * blur(j, 24 * VB_K)"),
        ("wf = blur(ok, 6)", "wf = blur(ok, 6 * VB_K)"),
        ("blur(x * ok[..., None], 6)", "blur(x * ok[..., None], 6 * VB_K)"),
    ],
    "printkit.py": [("def rel_ndl(fl, kind, win, reg, sigma=32.0):", "def rel_ndl(fl, kind, win, reg, sigma=32.0 * VB_K):")],
    # the Film outline: its matte clean-up, the flecks it drops, the pencil's inside-tone probe and the held frame's
    # reach (not its interior-line detector, which finds as many lines unscaled, nor the 1-px antialiasing of its
    # distance maps, which thins the lines when scaled)
    "look_hybrid_colerase.py": [
        ("cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))", "cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * round(5 * VB_K) + 1,) * 2)"),
        ("cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))), 3)", "cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * round(4 * VB_K) + 1,) * 2)), 3 * VB_K)"),
        ("cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))", "cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * round(1 * VB_K) + 1,) * 2))"),
        ("cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))", "cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * round(2 * VB_K) + 1,) * 2))"),
        ("back = blur(back, 6)", "back = blur(back, 6 * VB_K)"),
        ("    Ls = blur(L, 1.0)\n    gx, gy = cv2.Sobel(Ls", "    Ls = blur(L, 1.0 * VB_K)\n    gx, gy = cv2.Sobel(Ls"),
        ("return blur(cv2.dilate(ok[lab], np.ones((5, 5), np.uint8)), 1)", "return blur(cv2.dilate(ok[lab], np.ones((2 * round(2 * VB_K) + 1,) * 2, np.uint8)), VB_K)"),
        ("r = 4 if not isinstance(S, np.ndarray) and S >= 1 else max(1, int(round(4 * float(np.max(S)))))",
         "r = max(1, int(round(4 * VB_K * (1 if not isinstance(S, np.ndarray) and S >= 1 else float(np.max(S))))))"),
        ("small = np.hypot(st[:, 2], st[:, 3]) < np.maximum(size * at_centres(S, cen)",
         "small = np.hypot(st[:, 2], st[:, 3]) < np.maximum(size * VB_K * at_centres(S, cen)"),
        ("m = soften(fig, 1.0)", "m = soften(fig, 1.0 * VB_K)"),
        ('blur(m, 1.0 + D["motion_soft"] * s)', 'blur(m, 1.0 * VB_K + D["motion_soft"] * s)'),
        ("mb = blur(m, 4)", "mb = blur(m, 4 * VB_K)"),
        ("s = smoothstep(0.1, 0.4, blur(cv2.dilate(sc, np.ones((5, 5), np.uint8)), 1.0))",
         "s = smoothstep(0.1, 0.4, blur(cv2.dilate(sc, np.ones((2 * round(2 * VB_K) + 1,) * 2, np.uint8)), 1.0 * VB_K))"),
        ("sl = smoothstep(0.1, 0.4, blur(cv2.dilate(lo * crest, np.ones((5, 5), np.uint8)), 1.0))",
         "sl = smoothstep(0.1, 0.4, blur(cv2.dilate(lo * crest, np.ones((2 * round(2 * VB_K) + 1,) * 2, np.uint8)), 1.0 * VB_K))"),
        ("onl, _ = gaps(rng2, 0.25, 70, nz)", "onl, _ = gaps(rng2, 0.25, 70 * VB_K, nz)"),
        ("lumc = blur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), 1.5)", "lumc = blur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), 1.5 * VB_K)"),
        ("e = int(round(5 * s))", "e = int(round(5 * s * VB_K))"),
        ("return blur(lumc * fm, 8 * s) / (blur(fm, 8 * s) + 1e-3)", "return blur(lumc * fm, 8 * s * VB_K) / (blur(fm, 8 * s * VB_K) + 1e-3)"),
        ("r.standard_normal((H, W)).astype(np.float32), 0.6))", "r.standard_normal((H, W)).astype(np.float32), 0.6 * VB_K))"),
        ('r = int(10 + 30 * D["trail"])', 'r = int((10 + 30 * D["trail"]) * VB_K)'),
        ("(2 * r + 1, 2 * r + 1))), 2)", "(2 * r + 1, 2 * r + 1))), 2 * VB_K)"),
        ("smoothstep(90, 60, cv2.distanceTransform", "smoothstep(90 * VB_K, 60 * VB_K, cv2.distanceTransform"),
        ("under = cv2.GaussianBlur(img, (0, 0), 3)", "under = cv2.GaussianBlur(img, (0, 0), 3 * VB_K)"),
        # the margin inside the silhouette kept clear of interior and part lines (px, times the line's width scale):
        # unscaled, a part's own edge along the silhouette was inked as a second line at 4K
        ("inner = smoothstep(2.5 * wi, 6 * wi,", "inner = smoothstep(2.5 * wi * VB_K, 6 * wi * VB_K,"),
    ],
    # Boiling ink: how far it looks across an edge (shape thickness, colour edge, darkness), its smoothing along the
    # contour (1 px samples), the thinnest stroke, and the dry brush's own px
    "look_boil.py": [
        ("cv2.COLOR_BGR2GRAY).astype(np.float32) / 255, (0, 0), 2)", "cv2.COLOR_BGR2GRAY).astype(np.float32) / 255, (0, 0), 2 * VB_K)"),
        ("cv2.GaussianBlur(frame, (0, 0), 1.5)", "cv2.GaussianBlur(frame, (0, 0), 1.5 * VB_K)"),
        ("for k in (1.5, 3, 4.5)]", "for k in (1.5 * VB_K, 3 * VB_K, 4.5 * VB_K)]"),
        ("at(lab, q[:, :2] + 3 * q[:, 2:4]) - at(lab, q[:, :2] - 3 * q[:, 2:4])",
         "at(lab, q[:, :2] + 3 * VB_K * q[:, 2:4]) - at(lab, q[:, :2] - 3 * VB_K * q[:, 2:4])"),
        ('axis=1), 5, mode="wrap")', 'axis=1), 5 * VB_K, mode="wrap")'),
        ("(at(fd, q[:, :2]) > 4)", "(at(fd, q[:, :2]) > 4 * VB_K)"),
        ("dark(at(lum, q[:, :2] - 3 * q[:, 2:4])), dark(at(lum, q[:, :2] + 3 * q[:, 2:4]))",
         "dark(at(lum, q[:, :2] - 3 * VB_K * q[:, 2:4])), dark(at(lum, q[:, :2] + 3 * VB_K * q[:, 2:4]))"),
        ("for k in np.arange(1, 17, 1.5)]", "for k in np.arange(1, 17, 1.5) * VB_K]"),
        ("sm(thick, 4), sm(at(spd[part], q[:, :2]), 6)", "sm(thick, 4 * VB_K), sm(at(spd[part], q[:, :2]), 6 * VB_K)"),
        ("def concavity(q, closed, r=8):", "def concavity(q, closed, r=max(1, int(round(8 * VB_K)))):"),
        ("* q[:, 2:4], 1) / 3, 0, 1)", "* q[:, 2:4], 1) / (3 * VB_K), 0, 1)"),
        ("u(0, 1), u(1.5, 6), rng.uniform()", "u(0, 1), u(1.5 * VB_K, 6 * VB_K), rng.uniform()"),
        ("wobl=u(25, 70)", "wobl=u(25 * VB_K, 70 * VB_K)"),
        ("interp(curve, s, closed)[:, 8] / 10", "interp(curve, s, closed)[:, 8] / (10 * VB_K)"),
        ('np.maximum(D["thin"] * 2 * thick, 1.2)', 'np.maximum(D["thin"] * 2 * thick, 1.2 * VB_K)'),
        ("np.clip((w - 1.2) / 3.5, 0.25, 1)", "np.clip((w - 1.2 * VB_K) / (3.5 * VB_K), 0.25, 1)"),
        ("torch.clamp(hw / 1.2, 0, 1)", "torch.clamp(hw / (1.2 * VB_K), 0, 1)"),
        ("(ue / 4 * 10 + rx)", "(ue / (4 * VB_K) * 10 + rx)"),
        ("if not closed and n - 1 - s < 12:", "if not closed and n - 1 - s < 12 * VB_K:"),
    ],
}


def px_source(path, src):
    """src with its PX_SRC pieces scaled for the run's VB_K."""
    subs = PX_SRC.get(os.path.basename(path))
    if not subs or abs(VB_K[0] - 1) < 1e-3:
        return src
    for old, new in subs:
        if old in src:
            src = src.replace(old, new)
        else:
            print("(output size: %s no longer has %r; left at the preview's size)" % (os.path.basename(path), old[:60]))
    return src


class PxImport:
    """Imports PX_SRC's modules from sketchLook with their sizes scaled (while a bigger-than-preview run is on)."""

    def find_spec(self, name, path=None, target=None):
        base = name.rsplit(".", 1)[-1] + ".py"
        if base not in PX_SRC or abs(VB_K[0] - 1) < 1e-3:
            return None
        import importlib.util
        for d in (path or sys.path):
            f = os.path.join(d, base)
            if os.path.isfile(f):
                if not os.path.normcase(os.path.abspath(f)).startswith(os.path.normcase(SKETCH)):
                    return None
                return importlib.util.spec_from_file_location(name, f, loader=self)
        return None

    def create_module(self, spec):
        return None

    def exec_module(self, m):
        m.VB_K = VB_K[0]
        exec(compile(px_source(m.__file__, open(m.__file__, encoding="utf-8").read()), m.__file__, "exec"), m.__dict__)


sys.meta_path.insert(0, PxImport())


def run_tool(script, root, argv, extra_path=(), finish=None):
    """Execute `script` as __main__ with ROOT = root. finish: replaces the look's compositor (see LOOK_SPLIT)."""
    src = px_source(script, open(script, encoding="utf-8").read())
    g = {"__name__": "__main__", "__file__": os.path.join(root, "tools", os.path.basename(script)), "VB_K": VB_K[0]}
    old_argv, old_path = sys.argv, list(sys.path)
    sys.argv = [script] + argv
    for p in reversed(extra_path):
        sys.path.insert(0, p)
    try:
        if finish is None:
            exec(compile(src, script, "exec"), g)
        else:
            cut = src.index(LOOK_SPLIT)
            exec(compile(src[:cut], script, "exec"), g)
            g["finish"] = finish(g)
            # the rest keeps its line numbers, so a traceback points at the script's own lines
            exec(compile("\n" * src[:cut].count("\n") + src[cut:], script, "exec"), g)
    except SystemExit as e:  # matte_auto exits 0 when it finds nothing; the look's --frames run exits with a note
        if e.code not in (None, 0) and not str(e.code).startswith("preview only"):
            raise
    finally:
        sys.argv, sys.path[:] = old_argv, old_path


def short(obj):
    return hashlib.sha1(json.dumps(obj, sort_keys=True).encode()).hexdigest()[:12]


def put_frames(folder, frames, side=None):
    """frames (paths) as folder/NNNN.png, BGR (alpha dropped); side: long edge at most this."""
    os.makedirs(folder, exist_ok=True)
    for i, p in enumerate(frames):
        f = os.path.join(folder, "%04d.png" % i)
        if os.path.exists(f):
            continue
        img = cv2.imread(p, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("could not read frame %d" % i)
        if side and max(img.shape[:2]) > side:
            k = side / max(img.shape[:2])
            img = cv2.resize(img, (round(img.shape[1] * k), round(img.shape[0] * k)), interpolation=cv2.INTER_AREA)
        cv2.imwrite(f, img)


def base(req):
    """The picture's folder, with its frames as clips/src/ (once)."""
    root = os.path.join(CACHE, req["src"])
    put_frames(os.path.join(root, "clips", "src"), req["frames"])
    os.makedirs(os.path.join(root, "out"), exist_ok=True)
    os.utime(root)
    return root


def clip_like(root, name, side=None):
    """clips/<name>/ holding the picture's frames (scaled to side), made once."""
    d = os.path.join(root, "clips", name)
    if not os.path.isdir(d):
        srcs = sorted(os.listdir(os.path.join(root, "clips", "src")))
        put_frames(d + ".tmp", [os.path.join(root, "clips", "src", f) for f in srcs], side)
        os.replace(d + ".tmp", d)
    return d


# ------------------------------------------------------------------------------------------- the ops
def op_depth(req):
    root = base(req)
    res = os.path.join(root, "res", "depth")
    if not os.path.isdir(res):
        ds = [np.load(p) for p in ensure_depth(root)]
        lo, hi = np.percentile(np.stack(ds[::max(1, len(ds) // 20)]), [1, 99])
        os.makedirs(res + ".tmp", exist_ok=True)
        for i, d in enumerate(ds):
            cv2.imwrite(os.path.join(res + ".tmp", "%04d.png" % i),
                        (np.clip((d - lo) / max(hi - lo, 1e-6), 0, 1) * 255).astype(np.uint8))
        os.replace(res + ".tmp", res)
    return {"frames": [os.path.join(res, f) for f in sorted(os.listdir(res))]}


def objects_of(req):
    """{folder-safe name: [lower-case phrases]} of the request; 'person' when it names nothing."""
    out = {}
    for n, ps in (req.get("objects") or {}).items():
        n = "".join(c if c.isalnum() or c in "_-" else "_" for c in str(n).strip().lower()).strip("_") or "object"
        ps = [str(p).strip().lower() for p in ps if str(p).strip()]
        if ps:
            out[n] = out.get(n, []) + ps
    return out or {"person": ["person"]}


# matte_auto.py's detector settings and models, so a mask here is found as the film's were
MIN_SCORE, TEXT_SCORE, MIN_AREA, SAME_BOX = 0.35, 0.25, 0.002, 0.6


@functools.lru_cache(maxsize=1)
def matte_cleaner():
    """matte_auto.py's own fill_small_holes(), read from the file (the script runs its whole pipeline on import)."""
    p = os.path.join(TOOLS, "matte_auto.py")
    tree = ast.parse(open(p, encoding="utf-8").read())
    keep = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "fill_small_holes"]
    ns = {"cv2": cv2, "np": np}
    exec(compile(ast.Module(body=keep, type_ignores=[]), p, "exec"), ns)
    return ns["fill_small_holes"]


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-6)


def find_instances(root, clip, objs):
    """Every match of every phrase, each its own matte: Grounding DINO on the first frame keeps ALL its boxes above
    the score (matte_auto.py keeps the best one per object), SAM2 tracks each through the clip from its box. Writes
    clips/<clip>_matte/<name>/ per instance (name, or name_1, name_2 ... left to right when there are several) and
    figure/ (all of them), cleaned with matte_auto.py's fill_small_holes; nothing found leaves no matte folder."""
    import torch
    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor
    from sam2.sam2_video_predictor import SAM2VideoPredictor
    d = os.path.join(root, "clips", clip)
    frames = sorted(os.listdir(d))
    first = cv2.imread(os.path.join(d, frames[0]))
    H, W = first.shape[:2]
    proc = AutoProcessor.from_pretrained("IDEA-Research/grounding-dino-base")
    det = AutoModelForZeroShotObjectDetection.from_pretrained("IDEA-Research/grounding-dino-base").to("cuda").eval()
    text = ". ".join(p for ps in objs.values() for p in ps) + "."
    inp = proc(images=cv2.cvtColor(first, cv2.COLOR_BGR2RGB), text=text, return_tensors="pt").to("cuda")
    with torch.inference_mode():
        res = proc.post_process_grounded_object_detection(det(**inp), inp.input_ids, box_threshold=MIN_SCORE,
                                                         text_threshold=TEXT_SCORE, target_sizes=[(H, W)])[0]
    found = {o: [] for o in objs}
    for box, score, lab in zip(res["boxes"].tolist(), res["scores"].tolist(), res["labels"]):
        for o, ps in objs.items():
            if any(p in lab for p in ps) and (box[2] - box[0]) * (box[3] - box[1]) >= MIN_AREA * W * H:
                found[o].append((float(score), [float(v) for v in box]))
                break
    inst = []  # (name, box)
    for o, hits in found.items():
        kept = []
        for s, b in sorted(hits, reverse=True):  # one box per thing: a lower box over a kept one is the same thing
            if all(iou(b, k) < SAME_BOX for k in kept):
                kept.append(b)
        kept.sort(key=lambda b: b[0] + b[2])
        inst += [(o if len(kept) == 1 else "%s_%d" % (o, i + 1), b) for i, b in enumerate(kept)]
    mdir = os.path.join(root, "clips", clip + "_matte")
    shutil.rmtree(mdir, ignore_errors=True)
    if not inst:
        return []
    jpg = os.path.join(root, "clips", clip + "_jpg")
    os.makedirs(jpg, exist_ok=True)
    for i, f in enumerate(frames):
        cv2.imwrite(os.path.join(jpg, "%05d.jpg" % i), cv2.imread(os.path.join(d, f)), [cv2.IMWRITE_JPEG_QUALITY, 97])
    predictor = SAM2VideoPredictor.from_pretrained("facebook/sam2.1-hiera-base-plus")
    masks = {n: {} for n, _ in inst}
    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
        state = predictor.init_state(video_path=jpg)
        for oi, (_, b) in enumerate(inst, start=1):
            predictor.add_new_points_or_box(inference_state=state, frame_idx=0, obj_id=oi, box=np.array(b, np.float32))
        for fi, ids, logits in predictor.propagate_in_video(state):
            for k, oid in enumerate(ids):
                masks[inst[oid - 1][0]][fi] = (logits[k] > 0.0).float().cpu().numpy()[0]
    clean = matte_cleaner()
    zero = np.zeros((H, W), np.uint8)
    names = [n for n, _ in inst]
    for n in names:
        masks[n] = {fi: clean(masks[n].get(fi, zero).astype(np.uint8), max_frac=0.01) for fi in range(len(frames))}
    masks["figure"] = {fi: clean(np.maximum.reduce([masks[n][fi] for n in names])) for fi in range(len(frames))}
    for n in names + ["figure"]:
        os.makedirs(os.path.join(mdir, n))
        for fi in range(len(frames)):
            cv2.imwrite(os.path.join(mdir, n, "%04d.png" % fi), masks[n][fi] * 255)
    print("found: %s" % ", ".join(names))
    return names


def segment_clip(req):
    """The picture's clip whose matte folder holds what the request names: (root, clip, objects). Found here with
    Grounding DINO + SAM2, or - engine "sam3" - already found by sam3_server.py (the worker asks it first), whose
    clip this only completes with the frames."""
    root = base(req)
    if req.get("whole"):
        # nothing named: the whole picture is the subject - one element, the picture, and the figure all of it
        clip = "wh"
        mdir = os.path.join(root, "clips", clip + "_matte")
        if not os.path.isdir(mdir):
            clip_like(root, clip)
            d = os.path.join(root, "clips", clip)
            for o in ("figure", "picture"):
                os.makedirs(os.path.join(mdir + ".tmp", o), exist_ok=True)
                for f in sorted(os.listdir(d)):
                    h, w = cv2.imread(os.path.join(d, f)).shape[:2]
                    cv2.imwrite(os.path.join(mdir + ".tmp", o, f), np.full((h, w), 255, np.uint8))
            os.replace(mdir + ".tmp", mdir)
            json.dump(["picture"], open(os.path.join(root, "clips", clip + "_done.json"), "w"))
        return root, clip, {}
    objs = objects_of(req)
    if req.get("engine") == "sam3":
        clip = "s3_" + short(objs)
        if not os.path.exists(os.path.join(root, "clips", clip + "_done.json")):
            raise ValueError("SAM 3 has not segmented this picture")
        clip_like(root, clip)
        return root, clip, objs
    clip = "mi_" + short(objs)  # mi: every instance (m_ was matte_auto's one per object)
    done = os.path.join(root, "clips", clip + "_done.json")
    if not os.path.exists(done):
        clip_like(root, clip)
        json.dump(find_instances(root, clip, objs), open(done, "w"))
    return root, clip, objs


def op_segment(req):
    root, clip, _ = segment_clip(req)
    mdir = os.path.join(root, "clips", clip + "_matte")
    if not os.path.isdir(mdir):
        return {"objects": {}}
    return {"objects": {o: [os.path.join(mdir, o, f) for f in sorted(os.listdir(os.path.join(mdir, o)))]
                        for o in sorted(os.listdir(mdir)) if os.path.isdir(os.path.join(mdir, o))}}


def look_finish(res, e=0):
    """A compositor for the look that saves its four layers (alpha, 0..1) instead of compositing them."""
    def make(g):
        D = g["D"]
        json.dump({"ink": D["ink"], "paper": D["paper"], "pencil": D["rough_hex"], "graphite": g["C"].DIALS["color"],
                   "pencil_tint": D["rough_color"]}, open(os.path.join(res, "colors.json"), "w"))

        def finish(t, s, a, p, q):
            D = g["D"]
            if D["veil"] > 0:  # as the look's own finish
                keep = 1 - D["veil"] * g["veil"].near(g["veil"].veil(*g["load"](t)[:2]))
                s, a, p, q = s * keep, a * keep, p * keep, q * keep
            a = a * D["int_opacity"]
            for name, x in (("outline", s), ("inside", a), ("paper", p), ("pencil", q)):
                cv2.imwrite(os.path.join(res, "%04d_%s.png" % (t, name)), np.clip(crop_edge(x, e) * 255 + 0.5, 0, 255).astype(np.uint8))
        return finish
    return make


# ------------------------------------------------------------------------------------------- size: subject and output
# Two factors, kept apart and multiplied:
#   subject scale  how big each subject is on screen (tools_scale/scale.py): a small or distant subject is drawn as
#                  tight as a close-up. Measured here from the Segment masks AT THE LIVE DRAWING SIZE with scale.py's
#                  own measure() and the Segment card's settings (reference size, minimum, partly-in-view per
#                  subject, a fixed scale per subject), then handed to the looks that read it (Film outline, Form
#                  hatch, Background hatch) by standing in for scale.Scale - their own code does the rest.
#   output size    a bake drawn bigger than the live preview (LIVE px long edge) is drawn at its own size, every
#                  pixel-size dial of the look multiplied by k = drawn / live (areas by k^2, per-px rates by 1/k), so
#                  it looks like the preview, only sharper.
LIVE = 1400

# Each look's pixel-size dials (its DIALS; the construction pencil's are look_construction's own, which the outline
# and the background layout borrow): (lengths, areas, per-length rates).
PX = {
    "look_hybrid_colerase.py": ("contour_w contour_out lap_px detail_px min_len width_px wobble wobble_px break_px "
                                "bristle_px grain grain_px motion_soft motion_px part_w rough_spread rough_overshoot "
                                "rough_min_w min_w solid_w", "", "rough_tangents"),
    "look_construction.py": ("weight pass_spread jitter wobble seek stroke_len overshoot short constr_len constr_offset "
                             "offset smooth min_len min_w", "", "construction"),
    "look_formhatch.py": ("z_px form_px edge_px paint_px local_px colour_px occ_px occ_depth spacing weight min_weight "
                          "stroke_px wobble wobble_px grain min_spacing min_line min_stroke motion_px", "", ""),
    "look_bg_depthhatch.py": ("air_px broad_px ground_px form_px paint_px glint_px close_px core_px shape_px "
                              "far_shape_px edge_soft mass_px occ_px occ_depth spacing weight min_weight stroke_px "
                              "wobble wobble_px grain min_spacing min_line scale_px edge_px hold_px motion_px relief_max",
                              "", ""),
    "look_hatch.py": ("jitter_px speck_px material_px inset overrun core_px spacing spacing_core length length_core "
                      "width contour_px curve_px tooth_px", "min_area", ""),
    "look_cel.py": ("form_px round_px cast_px ao_px simplify_px inset_px edge_soft jitter_px jitter_cell hatch_len "
                    "hatch_gap hatch_w", "min_shape", ""),
    "look_boil.py": ("weight_lit weight_shadow stroke_len attack release flick pos_jitter drift wobble sit bristle_px "
                     "streak_len ragged dark_weight dark_gap smooth min_len motion_px", "", ""),
    "look_misreg.py": ("weight max_w rough_px taper stroke_len overlap overshoot tremor streak_px offset offset_jitter "
                       "smooth", "inner_area min_area", ""),
    "look_relight.py": ("rim_in rim_px ao_px painted_px core_px relief", "", "rim_sharp"),
    "look_formlight.py": ("smooth_px tuck_px normal_px open_px rim_reach_px inset_px cloth_edge_px metal_edge_px "
                          "motion_px cloth_bump", "", ""),
    "look_bg_layout.py": ("sky_far_px sky_reach ms_sp busy_px sky_clip halo bleed min_len smooth weight stroke_len "
                          "pass_spread overshoot constr_len hatch_spacing hatch_w hatch_len", "", "sky_tex dep_norm tangents"),
    "look_bg_tonewash.py": ("bleed_px shade_px shape_px pool_px grain_px mottle_px pencil_weight pencil_min pencil_len "
                            "clear_px edge_px", "", "busy_lo busy_hi"),
}


@functools.lru_cache(maxsize=None)
def dial_defaults(script):
    """A look's numeric DIALS defaults, read from its file."""
    import re
    src = open(os.path.join(TOOLS_SCALE, script), encoding="utf-8").read()
    m = re.search(r"\nDIALS = \{(.*?)\n\}", src, re.S)
    out = {}
    for line in (m.group(1) if m else "").split("\n"):
        mm = re.match(r'\s+"([\w.]+)":\s*([-0-9.]+),', line)
        if mm:
            v = mm.group(2)
            out[mm.group(1)] = float(v) if "." in v else int(v)  # whole-number dials stay so (scaled_dials)
    return out


def src_long(root):
    return max(cv2.imread(os.path.join(root, "clips", "src", "0000.png")).shape[:2])


def res_factor(root, side):
    """k = the long edge this run draws at / the live preview's (both no bigger than the picture)."""
    L = src_long(root)
    return min(side, L) / min(LIVE, L)


def scaled_dials(script, dials, k):
    """dials (the card's) with every pixel-size dial of `script` multiplied for output factor k (its default where the
    card does not set it)."""
    if abs(k - 1) < 1e-3 or script not in PX:
        return dials
    lin, area, rate = (s.split() for s in PX[script])
    base = dial_defaults(script)
    out = dict(dials)
    for keys, f in ((lin, k), (area, k * k), (rate, 1 / k)):
        for key in keys:
            v = dials.get(key, base.get(key))
            if v is not None:
                # a whole-number dial stays one (look_misreg reads its dials back as their defaults' types)
                out[key] = int(round(v * f)) if isinstance(base.get(key), int) and not isinstance(base.get(key), bool) else v * f
    return out


def scale_pencil(k):
    """The construction pencil's own dials (look_construction.DIALS, which the outline and the background layout
    draw their pencil with) for output factor k: the module, imported for this job only, is changed in place."""
    if abs(k - 1) < 1e-3:
        return
    sys.path.insert(0, TOOLS_SCALE)
    import look_construction as C
    lin, area, rate = (s.split() for s in PX["look_construction.py"])
    for keys, f in ((lin, k), (rate, 1 / k)):
        for key in keys:
            if isinstance(C.DIALS.get(key), (int, float)) and not isinstance(C.DIALS.get(key), bool):
                C.DIALS[key] = type(C.DIALS[key])(C.DIALS[key] * f)


def scale_settings(req):
    """The Segment card's scale settings: reference size (px a subject is drawn at as tuned), minimum scale, and per
    subject a partly-in-view factor and a fixed scale (0 = measured)."""
    s = req.get("scale") or {}
    num = lambda d: {str(k): float(v) for k, v in (d or {}).items() if isinstance(v, (int, float))}
    return float(s.get("ref", 500)), float(s.get("lo", 0.25)), num(s.get("view")), num(s.get("fixed"))


def subject_scales(root, mclip, req):
    """({subject: scale per frame}, {subject: px per frame}) measured with scale.py's measure() on the Segment masks
    at the live drawing size; {} with nothing segmented (or the whole picture)."""
    if not mclip or mclip == "wh":
        return {}, {}
    ref, lo, view, fixed = scale_settings(req)
    clip = look_clip(root, mclip, min(LIVE, src_long(root)))
    mdir = os.path.join(root, "clips", clip + "_matte")
    elements = sorted(e for e in os.listdir(mdir) if e != "figure" and os.path.isdir(os.path.join(mdir, e)))
    if not elements:
        return {}, {}
    sys.path.insert(0, TOOLS_SCALE)
    import scale as S
    S.ROOT = root
    S.REF = dict({e: ref for e in elements}, subject=ref)
    S.LO = lo
    n = len(os.listdir(os.path.join(mdir, elements[0])))
    if n < 4:
        # scale.py smooths each subject's size over time with a 9-frame median, which scipy returns as 0 for a
        # series under 4 frames: a still is measured on its masks repeated to 4 frames
        long = clip + "_m4"
        ldir = os.path.join(root, "clips", long + "_matte")
        if not os.path.isdir(ldir):
            for e in os.listdir(mdir):
                if os.path.isdir(os.path.join(mdir, e)):
                    os.makedirs(os.path.join(ldir, e), exist_ok=True)
                    for i in range(4):
                        shutil.copy(os.path.join(mdir, e, "%04d.png" % (i % n)), os.path.join(ldir, e, "%04d.png" % i))
        clip = long
    S.VIEW = {clip: {e: v for e, v in view.items() if e in elements}}
    groups, area = S.measure(clip, {e: e for e in elements})
    groups = {e: v[:n] for e, v in groups.items()}
    area = {e: a[:n] for e, a in area.items()}
    for e, v in fixed.items():
        if e in groups and v > 0:
            groups[e] = np.full_like(groups[e], v)
    return groups, area


def use_scales(root, groups, area, S=None):
    """scale.Scale, for the looks run in this job, serving these measured scales (each subject its own body). S: the
    scale module to serve them from (default tools_scale's; op_marks: tools_marks' frozen copy)."""
    if S is None:
        sys.path.insert(0, TOOLS_SCALE)
        import scale as S
    S.ROOT = root

    class Measured(S.Scale):
        def __init__(self, clip):
            n = len(os.listdir(os.path.join(root, "clips", clip)))
            fit = lambda v: np.concatenate([np.asarray(v, np.float32), np.repeat(np.asarray(v[-1:], np.float32), max(0, n - len(v)))])[:n]
            self.on = bool(groups) and os.environ.get("SCALE_OFF") != "1"
            self.members = {e: e for e in groups}
            self.groups = {e: fit(v) for e, v in groups.items()} if self.on else {}
            self.area = {e: fit(a) for e, a in area.items()} if self.on else {}
    S.Scale = Measured


def op_scales(req):
    """The subjects a Segment card found and their measured scale (the median over the clip) with its settings."""
    root, mclip, _ = segment_clip(req)
    groups, _ = subject_scales(root, mclip, req)
    return {"scales": {e: round(float(np.median(v)), 3) for e, v in groups.items()}}


def size_key(req, dials, k):
    """What a drawing depends on besides the picture and its subject: the dials, the Segment card's scale settings
    and the output factor."""
    # (bigger than the preview: also the code's own sizes, PX_SRC - its version, so older bakes are not reused)
    return short([dials, req.get("scale") or {}, round(k, 3)] + (["px14"] if abs(k - 1) > 1e-3 else []))


def op_lines(req):
    root, mclip, objs = segment_clip(req)
    side = int(req.get("side") or LIVE)
    dials = {k: float(v) for k, v in (req.get("dials") or {}).items()}
    k = VB_K[0] = res_factor(root, side)
    res = os.path.join(root, "res", "lines_%d_%s_%s" % (side, mclip, size_key(req, dials, k)))
    if not os.path.isdir(res):
        clip = look_clip(root, mclip, side)
        n = len(os.listdir(os.path.join(root, "clips", clip)))
        use_scales(root, *subject_scales(root, mclip, req))
        scale_pencil(k)
        argv = [clip, "--frames", ",".join(str(i) for i in range(n)), "--name", "vb"]
        for key, v in scaled_dials("look_hybrid_colerase.py", dials, k).items():
            argv += ["--dial", "%s=%r" % (key, v)]
        os.makedirs(res + ".tmp", exist_ok=True)
        run_tool(LOOK, root, argv, [TOOLS_SCALE], finish=look_finish(res + ".tmp", edge_of(clip)))
        os.replace(res + ".tmp", res)
    n = len([f for f in os.listdir(res) if f.endswith("_outline.png")])
    return {"frames": [{k: os.path.join(res, "%04d_%s.png" % (i, k)) for k in ("outline", "inside", "paper", "pencil")}
                       for i in range(n)],
            "colors": json.load(open(os.path.join(res, "colors.json")))}


def ensure_depth(root):
    """The picture's depth (tools/depth.py on all its frames, once): the .npy paths."""
    dd = os.path.join(root, "clips", "d_depth")
    if not os.path.isdir(dd) or not os.listdir(dd):
        clip_like(root, "d")
        run_tool(os.path.join(TOOLS, "depth.py"), root, ["d"])
    return [os.path.join(dd, f) for f in sorted(os.listdir(dd))]


# A whole-picture subject ("wh": nothing named) is drawn on the picture mirrored out by EDGE px on every side, its
# figure covering that too, so the subject's edge - where a look strokes its silhouette - lies outside the picture;
# the layers are cropped back. Without it the outline would run along the picture's border.
EDGE = 64


def edge_of(clip):
    """How far a look clip extends past the picture (a whole-picture subject's mirrored edge, else 0)."""
    import re
    m = re.search(r"_e(\d+)$", clip)
    return int(m.group(1)) if m else 0


def crop_edge(x, e):
    return x[e:-e, e:-e] if e else x


def look_clip(root, mclip, side, depth=False, pad=False):
    """A clip for a look: the frames scaled to `side`, the segment's mattes at that size (mclip None: no matte
    folder - the whole frame is background; a segment that found nothing: an empty figure) and, with depth, the
    depth at that size. pad: a still gets its frame twice (the hatch looks read motion from a neighbouring frame;
    the same frame again is no motion). Made once; returns its name."""
    e = int(round(EDGE * res_factor(root, side))) if mclip == "wh" else 0
    name = "l%d_%s%s%s" % (side, mclip or "none", "_p" if pad else "", "_e%d" % e if e else "")
    d = clip_like(root, name, side)
    if e and not os.path.exists(os.path.join(root, "clips", name + "_edge.json")):
        for f in sorted(os.listdir(d)):
            p = os.path.join(d, f)
            cv2.imwrite(p, cv2.copyMakeBorder(cv2.imread(p), e, e, e, e, cv2.BORDER_REFLECT))
        json.dump(e, open(os.path.join(root, "clips", name + "_edge.json"), "w"))
    if pad and len(os.listdir(d)) == 1:
        shutil.copy(os.path.join(d, "0000.png"), os.path.join(d, "0001.png"))
    h, w = cv2.imread(os.path.join(d, "0000.png")).shape[:2]
    n = len(os.listdir(d))
    n_src = len(os.listdir(os.path.join(root, "clips", "src")))
    ldir = os.path.join(root, "clips", name + "_matte")
    if mclip and not os.path.isdir(ldir):
        mdir = os.path.join(root, "clips", mclip + "_matte")
        parts = [o for o in os.listdir(mdir) if os.path.isdir(os.path.join(mdir, o))] if os.path.isdir(mdir) else []
        for o in parts or ["figure"]:
            os.makedirs(os.path.join(ldir + ".tmp", o), exist_ok=True)
            for i in range(n):
                m = cv2.imread(os.path.join(mdir, o, "%04d.png" % min(i, n_src - 1)), 0) if parts else None
                m = np.zeros((h, w), np.uint8) if m is None else cv2.resize(m, (w, h), interpolation=cv2.INTER_AREA)
                cv2.imwrite(os.path.join(ldir + ".tmp", o, "%04d.png" % i), np.where(m > 127, 255, 0).astype(np.uint8))
        os.replace(ldir + ".tmp", ldir)
    ddir = os.path.join(root, "clips", name + "_depth")
    if depth and not os.path.isdir(ddir):
        os.makedirs(ddir + ".tmp", exist_ok=True)
        ds = ensure_depth(root)
        for i in range(n):
            z = cv2.resize(np.load(ds[min(i, len(ds) - 1)]), (w - 2 * e, h - 2 * e), interpolation=cv2.INTER_AREA)
            np.save(os.path.join(ddir + ".tmp", "%04d.npy" % i),
                    (cv2.copyMakeBorder(z, e, e, e, e, cv2.BORDER_REFLECT) if e else z).astype(np.float32))
        os.replace(ddir + ".tmp", ddir)
    return name


def load_lib(script, root, extra_path):
    """A look's module, executed from its own file without running its main (main() sits behind __name__), with
    ROOT = root; extra_path stays on sys.path until restore_path()."""
    for p in reversed(extra_path):
        sys.path.insert(0, p)
    g = {"__name__": "vb_" + os.path.splitext(os.path.basename(script))[0],
         "__file__": os.path.join(root, "tools_scale", os.path.basename(script)), "VB_K": VB_K[0]}
    exec(compile(px_source(script, open(script, encoding="utf-8").read()), script, "exec"), g)
    return g


def save_grey(path, x):
    cv2.imwrite(path, np.clip(x * 255 + 0.5, 0, 255).astype(np.uint8))


def dial_args(dials):
    return [a for k, v in dials.items() for a in ("--dial", "%s=%r" % (k, v))]


def op_formhatch(req):
    """tools_scale/look_formhatch.py through its own functions (parse, init, tracks, setup_light, drawing_fields,
    render - its main(), minus the files and videos): per frame the dark hatch alpha and ink colour (multiply) and
    the light strokes' alpha and colour (screen), exactly as its main() writes them into layer/."""
    root, mclip, _ = segment_clip(req)
    side = int(req.get("side") or LIVE)
    dials = {k: float(v) for k, v in (req.get("dials") or {}).items()}
    kf = VB_K[0] = res_factor(root, side)
    res = os.path.join(root, "res", "formhatch_%d_%s_%s" % (side, mclip, size_key(req, dials, kf)))
    if not os.path.isdir(res):
        clip = look_clip(root, mclip, side, depth=True, pad=True)
        n_src = len(os.listdir(os.path.join(root, "clips", "src")))
        old = list(sys.path)
        try:
            use_scales(root, *subject_scales(root, mclip, req))
            g = load_lib(os.path.join(TOOLS_SCALE, "look_formhatch.py"), root, [TOOLS_SCALE])
            g["parse"](dial_args(scaled_dials("look_formhatch.py", dials, kf)))
            g["init"](clip)
            D = g["D"]
            cx, cy, zm, axis, dark = g["tracks"]()
            light3, l2, az, el, fit = g["setup_light"](dark)
            os.makedirs(res + ".tmp", exist_ok=True)
            for t in range(n_src):
                k = t - t % D["boil"]
                if t == k:
                    drw = {s: g["drawing_fields"](k // D["boil"], g["dials"](s))
                           for s in sorted({g["SC"].of(p, k) for p in g["parts"]})}
                A, K, B, Hc = (crop_edge(x, edge_of(clip)) for x in g["render"](t, k, (cx, cy, zm, axis, dark, light3, l2, drw)))
                save_grey(os.path.join(res + ".tmp", "%04d_a.png" % t), A)
                save_grey(os.path.join(res + ".tmp", "%04d_k.png" % t), K)
                save_grey(os.path.join(res + ".tmp", "%04d_b.png" % t), B)
                save_grey(os.path.join(res + ".tmp", "%04d_h.png" % t), Hc)
            print("formhatch: light az %.0f el %.0f (fitted %s) | elements: %s" % (
                az, el, fit, ", ".join("%s%s" % (p, " (dark)" if dk else "") for p, dk in zip(g["parts"], dark))))
        finally:
            sys.path[:] = old
        os.replace(res + ".tmp", res)
    n = len([f for f in os.listdir(res) if f.endswith("_a.png")])
    return {"frames": [{k: os.path.join(res, "%04d_%s.png" % (i, k)) for k in "akbh"} for i in range(n)], "colors": {}}


def op_bghatch(req):
    """tools_scale/look_bg_depthhatch.py through its own functions (parse, prepare, analyse, drawing_fields,
    render): per frame the ink alpha and colour (multiply) and the far col-erase pencil's alpha. With no objects
    named there is no matte: the whole frame is background."""
    named = bool(req.get("objects"))
    if named:
        root, mclip, _ = segment_clip(req)
    else:
        root, mclip = base(req), None
    side = int(req.get("side") or LIVE)
    dials = {k: float(v) for k, v in (req.get("dials") or {}).items()}
    kf = VB_K[0] = res_factor(root, side)
    res = os.path.join(root, "res", "bghatch_%d_%s_%s" % (side, mclip or "none", size_key(req, dials, kf)))
    if not os.path.isdir(res):
        clip = look_clip(root, mclip, side, depth=True, pad=True)
        n_src = len(os.listdir(os.path.join(root, "clips", "src")))
        old = list(sys.path)
        try:
            use_scales(root, *subject_scales(root, mclip, req))
            g = load_lib(os.path.join(TOOLS_SCALE, "look_bg_depthhatch.py"), root, [TOOLS, TOOLS_SCALE])
            g["FH"].ROOT = root  # the subject light fit reads the shot through look_formhatch: this picture's folder
            g["parse"](dial_args(scaled_dials("look_bg_depthhatch.py", dials, kf)))
            g["prepare"](clip)
            D = g["D"]
            os.makedirs(res + ".tmp", exist_ok=True)
            for k in sorted({t - t % D["boil"] for t in range(n_src)}):
                fk, drw = g["analyse"](k), g["drawing_fields"](k // D["boil"])
                for t in range(k, min(k + D["boil"], n_src)):
                    A, Kc, P = g["render"](t, fk, drw)
                    save_grey(os.path.join(res + ".tmp", "%04d_a.png" % t), A)
                    save_grey(os.path.join(res + ".tmp", "%04d_k.png" % t), Kc)
                    save_grey(os.path.join(res + ".tmp", "%04d_p.png" % t), P)
            json.dump({"pencil": D["pencil_hex"]}, open(os.path.join(res + ".tmp", "colors.json"), "w"))
        finally:
            sys.path[:] = old
        os.replace(res + ".tmp", res)
    n = len([f for f in os.listdir(res) if f.endswith("_a.png")])
    return {"frames": [{k: os.path.join(res, "%04d_%s.png" % (i, k)) for k in "akp"} for i in range(n)],
            "colors": json.load(open(os.path.join(res, "colors.json")))}


# The drawing looks run as they are (each as __main__, ROOT = the picture's folder), then the layers they write are
# read back: what each writes, and how its own docstring says the layers go over the frame (in order). mask: the
# figure and element mattes are needed ("need") or used when a Segment card names something ("optional": without,
# the whole picture is background). fixed: string dials the card always sets (the red pencil's hue).
LOOKS = {
    # follow: a normal layer whose colour is the frame's own, deepened (look_hatch.py colour_op: frame * mul + add):
    # VidBars re-colours it from whatever it is laid on
    "hatch": dict(script="look_hatch.py", out="hatch", layers=[("layer", "follow")], mask="need"),
    "cel": dict(script="look_cel.py", out="cel", layers=[("layer/multiply", "multiply"), ("layer/screen", "screen")],
                mask="need"),
    "boil": dict(script="look_boil.py", out="boil", layers=[("lines", "normal")], mask="need"),
    "misreg": dict(script="look_misreg.py", out="misreg", layers=[("lines", "normal")], mask="need"),
    "construction": dict(script="look_construction.py", out="construction", layers=[("lines", "normal")],
                         mask="need", fixed={"color": "c8402a"}),
    "relight": dict(script="look_relight.py", out="relight",
                    layers=[("layer/multiply", "multiply"), ("layer/add", "add"), ("layer/haze", "normal")],
                    mask="need"),
    "formlight": dict(script="look_formlight.py", out="formlight", layers=[("layer", "hardlight")], mask="need"),
    "bg_layout": dict(script="look_bg_layout.py", out="bg_layout", layers=[("layer", "multiply")], mask="optional",
                      argv=["--name", "bg_layout"]),
    "bg_tonewash": dict(script="look_bg_tonewash.py", out="bg_tonewash",
                        layers=[("layer/haze", "normal"), ("layer/multiply", "multiply")], mask="optional",
                        argv=["--name", "bg_tonewash"]),
}


# ------------------------------------------------------------------------------------------- marks
# Stipple and halftone (sketchLook tools_marks/pat_stipple.py, pat_halftone.py): the hatching's shading drawn as
# other marks. They read the film's "fields" (tools_marks/fields.py), which are made from a shot's two saved hatch
# layers - the background's depth hatching and the subject's form hatching - plus its frames, mattes and depth. So
# here both hatches are drawn first (op_bghatch, op_formhatch), their layers written into the picture's folder under
# the names fields.py reads, and fields.ROOT pointed at that folder. tools_marks runs as it is (its frozen copy of
# the background hatch included); nothing is written into sketchLook.
TOOLS_MARKS = os.path.join(SKETCH, "tools_marks")
MARKS = {"stipple": "pat_stipple", "halftone": "pat_halftone"}
# a card's dials -> the pattern module's constants (halftone's INK and ANGLE are per layer kind)
MARK_DIALS = {"stipple": {"ink": "INK", "dot": "DOT", "jitter": "JITTER", "edge": "EDGE", "form": "FORM",
                          "shiver": "BOIL", "dark": "CALIB"},
              "halftone": {"cell": "CELL", "ink": "INK", "form": "FORM", "drift": "DRIFT", "angle": "ANGLE"}}
# the patterns' own pixel sizes (lengths x k, areas x k^2); the rest are in units of the hatch's pitch
MARK_PX = {"stipple": [(c, lambda k: k) for c in ("DOT", "DOT_MIN", "EDGE_PX", "MOD_PX", "FORM_PX")],
           "halftone": [("DRIFT", lambda k: k), ("MOD_PX", lambda k: k), ("MIN_DOT", lambda k: k * k)]}
BG_LAYER = "%s_s_bg_depthhatch"         # fields.py: out/<clip>_s_bg_depthhatch/layer/NNNN.png
SUBJECT_LAYER = "%s_hatch_s_bg_depthhatch"  # fields.py: out/<clip>_hatch_s_bg_depthhatch/layer/{multiply,screen}/


def grey(p):
    im = cv2.imread(p, cv2.IMREAD_UNCHANGED)
    return im.astype(np.float32) / 255


def bgra(path, rgb, a):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cv2.imwrite(path, np.clip(np.dstack([rgb, a]) * 255 + 0.5, 0, 255).astype(np.uint8))


def marks_clip(root, lclip, n_src):
    """lclip's frames, mattes and depth as clips/<lclip>_mk, at least 4 frames (a still repeated): the background
    hatch's frozen scale measurement takes a 9-frame median, which reads nothing from fewer than 4."""
    name = lclip + "_mk"
    c = os.path.join(root, "clips")
    if os.path.isdir(os.path.join(c, name)):
        return name
    n = max(4, n_src)
    for sub, ext in (("", ".png"), ("_depth", ".npy")):
        src = os.path.join(c, lclip + sub)
        if os.path.isdir(src):
            os.makedirs(os.path.join(c, name + sub), exist_ok=True)
            for t in range(n):
                shutil.copy(os.path.join(src, "%04d%s" % (min(t, n_src - 1), ext)), os.path.join(c, name + sub, "%04d%s" % (t, ext)))
    md = os.path.join(c, lclip + "_matte")
    if os.path.isdir(md):
        for o in os.listdir(md):
            if os.path.isdir(os.path.join(md, o)):
                os.makedirs(os.path.join(c, name + "_matte", o), exist_ok=True)
                for t in range(n):
                    shutil.copy(os.path.join(md, o, "%04d.png" % min(t, n_src - 1)), os.path.join(c, name + "_matte", o, "%04d.png" % t))
    return name


def op_marks(req):
    """Stipple or halftone where the dials' "where" says: 0 the figure (what Segment finds; nothing named: the whole
    picture), 1 the background (nothing named: the whole picture), 2 both. Comes back like a look: one multiply
    layer per place, colour and alpha."""
    look = req["look"]
    dials = {k: float(v) for k, v in (req.get("dials") or {}).items()}
    where = int(round(dials.pop("where", 0)))
    named = bool(req.get("objects"))
    kinds = ["subject"] if where == 0 else ["bg"] if where == 1 or not named else ["bg", "subject"]
    side = int(req.get("side") or LIVE)
    if "subject" in kinds:
        root, mclip, _ = segment_clip(dict(req, whole=not named))
    else:
        root, mclip = (segment_clip(req)[:2] if named else (base(req), None))
    # at the output's size: every pixel size (the hatches' own, the fields', the pattern's) x kf, as for the looks
    kf = VB_K[0] = res_factor(root, side)
    res = os.path.join(root, "res", "%s_%d_%s_%d_%s" % (look, side, mclip or "none", where, size_key(req, dials, kf)))
    if not os.path.isdir(res):
        sub = dict(req, dials={}, side=side, scale=req.get("scale"))
        n_src = len(os.listdir(os.path.join(root, "clips", "src")))
        lclip = look_clip(root, mclip, side, depth=True, pad=True)
        e = edge_of(lclip)
        pad = lambda x: cv2.copyMakeBorder(x, e, e, e, e, cv2.BORDER_REFLECT) if e else x
        # the two hatches, as fields.py reads them (tools_scale/look_bg_depthhatch.py and look_formhatch.py main())
        bg = op_bghatch(dict(sub, whole=False)) if mclip != "wh" else None
        fh = op_formhatch(sub) if mclip else None
        mk = marks_clip(root, lclip, n_src)
        n = len(os.listdir(os.path.join(root, "clips", mk)))
        out = os.path.join(root, "out")
        shutil.rmtree(os.path.join(out, BG_LAYER % mk), ignore_errors=True)
        shutil.rmtree(os.path.join(out, SUBJECT_LAYER % mk), ignore_errors=True)
        h, w = cv2.imread(os.path.join(root, "clips", mk, "0000.png")).shape[:2]
        pen = None if bg is None else np.array([int(bg["colors"]["pencil"][i:i + 2], 16) for i in (4, 2, 0)], np.float32) / 255
        for t in range(n):
            s = min(t, n_src - 1)
            name = "%04d.png" % t
            if bg is not None:
                f = bg["frames"][s]
                A, K, P = pad(grey(f["a"])), pad(grey(f["k"])), pad(grey(f["p"]))
                M = (1 - A[..., None] + A[..., None] * K) * (1 - P[..., None] + P[..., None] * pen)
                a = (1 - M).max(-1)
                rgb = 1 - (1 - M) / np.maximum(a, 1e-6)[..., None]
                bgra(os.path.join(out, BG_LAYER % mk, "layer", name), np.where(a[..., None] > 0, rgb, 1), a)
            else:
                bgra(os.path.join(out, BG_LAYER % mk, "layer", name), np.ones((h, w, 3), np.float32), np.zeros((h, w), np.float32))
            if fh is not None:
                f = fh["frames"][s]
                bgra(os.path.join(out, SUBJECT_LAYER % mk, "layer", "multiply", name), pad(grey(f["k"])), pad(grey(f["a"])))
                bgra(os.path.join(out, SUBJECT_LAYER % mk, "layer", "screen", name), pad(grey(f["h"])), pad(grey(f["b"])))
        # the subjects' scale as the hatches had it: measured at the preview's size (subject_scales), so the
        # frozen scale below sizes the marks at any output size as it does in the preview
        sgroups, sarea = subject_scales(root, mclip, req)
        # tools_marks, fresh (the hatches above imported tools_scale's own look_bg_depthhatch / scale, which its
        # frozen copies must not meet), with its data under this picture's folder
        for m in [m for m in sys.modules if os.path.normcase(str(getattr(sys.modules[m], "__file__", "") or "")).startswith(os.path.normcase(SKETCH))]:
            del sys.modules[m]
        old = list(sys.path)
        try:
            sys.path.insert(0, TOOLS_MARKS)
            import fields
            import marks
            fields.ROOT = root
            for m in ("look_bg_depthhatch", "look_formhatch", "look_construction", "scale", "veil"):
                if m in sys.modules:
                    sys.modules[m].ROOT = root
            pat = sys.modules[MARKS[look]]
            for k, v in dials.items():
                c = MARK_DIALS[look].get(k)
                if c is None:
                    continue
                if look == "halftone" and c == "ANGLE":
                    pat.ANGLE = {"bg": v, "subject": v + 30}
                elif isinstance(getattr(pat, c), dict):
                    setattr(pat, c, {kk: v for kk in getattr(pat, c)})
                else:
                    setattr(pat, c, v)
            if abs(kf - 1) > 1e-3:
                BGm = sys.modules["look_bg_depthhatch"]  # the frozen copy: fields' pitch, width and relief come from it
                BGm.D.update(scaled_dials("look_bg_depthhatch.py", dict(BGm.D), kf))
                fields.SU.update({k: v for k, v in scaled_dials("look_formhatch.py", dict(fields.SU), kf).items() if k in fields.SU})
                for c, f_ in MARK_PX[look]:
                    setattr(pat, c, getattr(pat, c) * f_(kf))
            use_scales(root, sgroups, sarea, sys.modules[fields.scale.__name__])
            # its shot set-up cache knows nothing of the scales served here: made afresh with them
            for p in glob.glob(os.path.join(root, "out", "marks", "_cache", mk + "_shot.pkl")):
                os.remove(p)
            fn = marks.get(look)
            shot = fields.Shot(mk)
            use = [k for k in kinds if k != "subject" or shot.has_subject]
            os.makedirs(res + ".tmp", exist_ok=True)
            for t in range(n_src):
                fl = shot.fields(t)
                for i, kind in enumerate(kinds):
                    r = marks.normalize(fn(fl, kind, fl.d, marks.rng_for(look, kind, fl.d)), fl, kind) if kind in use else None
                    a = r["alpha"] if r is not None else np.zeros((fl.H, fl.W), np.float32)
                    ink = r["ink"] if r is not None else np.ones((fl.H, fl.W, 3), np.float32)
                    save_grey(os.path.join(res + ".tmp", "%04d_c%d.png" % (t, i)), crop_edge(ink, e))
                    save_grey(os.path.join(res + ".tmp", "%04d_a%d.png" % (t, i)), crop_edge(a, e))
            print("%s: %s on %s (%d frame%s)" % (look, "+".join(kinds), mclip or "the whole picture", n_src, "s" * (n_src > 1)))
        finally:
            sys.path[:] = old
        os.replace(res + ".tmp", res)
    n = len([f for f in os.listdir(res) if f.endswith("_a0.png")])
    return {"frames": [{"%s%d" % (k, i): os.path.join(res, "%04d_%s%d.png" % (t, k, i)) for i in range(len(kinds)) for k in "ca"}
                       for t in range(n)], "colors": {"modes": ["multiply"] * len(kinds)}}


def op_look(req):
    """One of LOOKS on the picture: the script runs whole on the picture's clip (a still as two frames of itself,
    since several read motion from a neighbour), and each RGBA layer it writes comes back as its colour and its
    alpha (two PNGs: VidBars uploads pictures without their alpha). A script that stops in its movie or contact
    sheets after writing every layer (they assume a long shot) has still made what is needed."""
    if req["look"] in MARKS:
        return op_marks(req)
    spec = LOOKS[req["look"]]
    if spec["mask"] == "need" or (spec["mask"] == "optional" and req.get("objects")):
        root, mclip, _ = segment_clip(req)
    else:
        root, mclip = base(req), None
    side = int(req.get("side") or LIVE)
    dials = {k: float(v) for k, v in (req.get("dials") or {}).items()}
    kf = VB_K[0] = res_factor(root, side)
    res = os.path.join(root, "res", "%s_%d_%s_%s" % (req["look"], side, mclip or "none", size_key(req, dials, kf)))
    if not os.path.isdir(res):
        clip = look_clip(root, mclip, side, depth=True, pad=True)
        n_src = len(os.listdir(os.path.join(root, "clips", "src")))
        out = os.path.join(root, "out", spec["out"])
        shutil.rmtree(out, ignore_errors=True)
        scale_pencil(kf)
        argv = [clip] + spec.get("argv", []) + dial_args(scaled_dials(spec["script"], dials, kf))
        argv += [a for k, v in spec.get("fixed", {}).items() for a in ("--dial", "%s=%s" % (k, v))]
        layer = lambda sub, t: os.path.join(out, sub, "%04d.png" % t)
        try:
            run_tool(os.path.join(TOOLS_SCALE, spec["script"]), root, argv, [TOOLS_SCALE])
        except Exception:
            if not all(os.path.exists(layer(sub, t)) for sub, _ in spec["layers"] for t in range(n_src)):
                raise
            print("(the look stopped after its layers: %s)" % traceback.format_exc().strip().splitlines()[-1])
        os.makedirs(res + ".tmp", exist_ok=True)
        for t in range(n_src):
            for i, (sub, _) in enumerate(spec["layers"]):
                im = cv2.imread(layer(sub, t), cv2.IMREAD_UNCHANGED)
                im = crop_edge(im, edge_of(clip)) if im is not None else None
                if im is None:
                    raise ValueError("%s wrote no %s for frame %d" % (spec["script"], sub, t))
                if im.ndim == 2 or im.shape[2] == 3:  # an opaque layer acts everywhere
                    im = np.dstack([im if im.ndim == 3 else cv2.cvtColor(im, cv2.COLOR_GRAY2BGR),
                                    np.full(im.shape[:2], 255, np.uint8)])
                cv2.imwrite(os.path.join(res + ".tmp", "%04d_c%d.png" % (t, i)), im[..., :3])
                cv2.imwrite(os.path.join(res + ".tmp", "%04d_a%d.png" % (t, i)), im[..., 3])
        os.replace(res + ".tmp", res)
    n = len([f for f in os.listdir(res) if f.endswith("_a0.png")])
    return {"frames": [{"%s%d" % (k, i): os.path.join(res, "%04d_%s%d.png" % (t, k, i))
                        for i in range(len(spec["layers"])) for k in "ca"} for t in range(n)],
            "colors": {"modes": [m for _, m in spec["layers"]]}}


def op_free(req):
    """Give back what the GPU holds between jobs (asked before a job is retried after running out of memory)."""
    import gc
    gc.collect()
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_available():
        torch.cuda.empty_cache()
    return {}


OPS = {"depth": op_depth, "segment": op_segment, "lines": op_lines, "formhatch": op_formhatch, "bghatch": op_bghatch,
       "look": op_look, "scales": op_scales, "free": op_free}


def prune(days=3):
    """Pictures not asked about for a few days go."""
    for e in os.scandir(CACHE):
        if e.is_dir() and time.time() - e.stat().st_mtime > days * 86400:
            shutil.rmtree(e.path, ignore_errors=True)


def main():
    prune()
    warm_models()
    OUT.write(json.dumps({"ready": True}) + "\n")
    OUT.flush()
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        log = io.StringIO()
        t0 = time.time()
        before = set(sys.modules)
        VB_K[0] = 1.0  # each op sets its own
        try:
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                reply = OPS[req["op"]](req)
        except Exception:
            reply = {"error": traceback.format_exc().strip().splitlines()[-1]}
            log.write(traceback.format_exc())
        finally:
            # each look runs as if in its own process: modules it imported from sketchLook go (the background
            # hatch imports tools/look_construction.py, the outline tools_scale's: a cached one is the wrong one)
            for m in set(sys.modules) - before:
                if os.path.normcase(str(getattr(sys.modules[m], "__file__", "") or "")).startswith(os.path.normcase(SKETCH)):
                    del sys.modules[m]
        sys.stderr.write(log.getvalue())
        reply.update(id=req.get("id"), log=log.getvalue()[-4000:], seconds=round(time.time() - t0, 2))
        OUT.write(json.dumps(reply) + "\n")
        OUT.flush()


if __name__ == "__main__":
    main()
