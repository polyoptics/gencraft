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

How the tools run: each script is executed from its own file with __file__ pointing into the picture's cache folder,
so its ROOT (the folder above tools/) is that folder and it reads and writes there, never in sketchLook.
  depth   tools/depth.py on a clip of the frames
  segment tools/matte_auto.py, every default object switched off (--no-box) and the named ones searched (--phrase)
  lines   tools_scale/look_hybrid_colerase.py on the frames scaled to `side`, over the segment's mattes. Its own
          compositor (finish) is swapped for one that saves its four layers apart - the silhouette ink (black
          outline), the interior ink (inside lines), the paper highlights and the col-erase pencil - so VidBars
          composites them live; every line it draws is the script's own.
Models: from_pretrained is cached here, so Depth Anything, Grounding DINO and SAM2 load once per worker.
"""
import contextlib
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
def run_tool(script, root, argv, extra_path=(), finish=None):
    """Execute `script` as __main__ with ROOT = root. finish: replaces the look's compositor (see LOOK_SPLIT)."""
    src = open(script, encoding="utf-8").read()
    g = {"__name__": "__main__", "__file__": os.path.join(root, "tools", os.path.basename(script))}
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
        clip_like(root, "d")
        run_tool(os.path.join(TOOLS, "depth.py"), root, ["d"])
        ds = [np.load(os.path.join(root, "clips", "d_depth", f))
              for f in sorted(os.listdir(os.path.join(root, "clips", "d_depth")))]
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


def segment_clip(req):
    """The picture's clip whose matte folder holds what the request names: (root, clip, objects)."""
    root = base(req)
    objs = objects_of(req)
    clip = "m_" + short(objs)
    done = os.path.join(root, "clips", clip + "_done.json")
    if not os.path.exists(done):
        clip_like(root, clip)
        argv = [clip]
        for n, ps in objs.items():
            argv += ["--phrase", "%s=%s" % (n, ",".join(ps))]
        argv += [a for d in DEFAULT_OBJECTS if d not in objs for a in ("--no-box", d)]
        run_tool(os.path.join(TOOLS, "matte_auto.py"), root, argv)
        json.dump(objs, open(done, "w"))
    return root, clip, objs


def op_segment(req):
    root, clip, _ = segment_clip(req)
    mdir = os.path.join(root, "clips", clip + "_matte")
    if not os.path.isdir(mdir):
        return {"objects": {}}
    return {"objects": {o: [os.path.join(mdir, o, f) for f in sorted(os.listdir(os.path.join(mdir, o)))]
                        for o in sorted(os.listdir(mdir)) if os.path.isdir(os.path.join(mdir, o))}}


def look_finish(res):
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
                cv2.imwrite(os.path.join(res, "%04d_%s.png" % (t, name)), np.clip(x * 255 + 0.5, 0, 255).astype(np.uint8))
        return finish
    return make


def op_lines(req):
    root, mclip, objs = segment_clip(req)
    side = int(req.get("side") or 1400)
    dials = {k: float(v) for k, v in (req.get("dials") or {}).items()}
    res = os.path.join(root, "res", "lines_%d_%s_%s" % (side, mclip, short(dials)))
    if not os.path.isdir(res):
        clip = "l%d_%s" % (side, mclip[2:])
        d = clip_like(root, clip, side)
        h, w = cv2.imread(os.path.join(d, "0000.png")).shape[:2]
        n = len(os.listdir(d))
        mdir, ldir = os.path.join(root, "clips", mclip + "_matte"), os.path.join(root, "clips", clip + "_matte")
        if not os.path.isdir(ldir):
            # the segment's mattes at the look's size; nothing found = an empty figure (no outline to draw)
            parts = [o for o in os.listdir(mdir) if os.path.isdir(os.path.join(mdir, o))] if os.path.isdir(mdir) else []
            for o in parts or ["figure"]:
                os.makedirs(os.path.join(ldir + ".tmp", o), exist_ok=True)
                for i in range(n):
                    m = cv2.imread(os.path.join(mdir, o, "%04d.png" % i), 0) if parts else None
                    m = np.zeros((h, w), np.uint8) if m is None else cv2.resize(m, (w, h), interpolation=cv2.INTER_AREA)
                    cv2.imwrite(os.path.join(ldir + ".tmp", o, "%04d.png" % i), np.where(m > 127, 255, 0).astype(np.uint8))
            os.replace(ldir + ".tmp", ldir)
        argv = [clip, "--frames", ",".join(str(i) for i in range(n)), "--name", "vb"]
        for k, v in dials.items():
            argv += ["--dial", "%s=%r" % (k, v)]
        os.makedirs(res + ".tmp", exist_ok=True)
        run_tool(LOOK, root, argv, [TOOLS_SCALE], finish=look_finish(res + ".tmp"))
        os.replace(res + ".tmp", res)
    n = len([f for f in os.listdir(res) if f.endswith("_outline.png")])
    return {"frames": [{k: os.path.join(res, "%04d_%s.png" % (i, k)) for k in ("outline", "inside", "paper", "pencil")}
                       for i in range(n)],
            "colors": json.load(open(os.path.join(res, "colors.json")))}


OPS = {"depth": op_depth, "segment": op_segment, "lines": op_lines}


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
        try:
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                reply = OPS[req["op"]](req)
        except Exception:
            reply = {"error": traceback.format_exc().strip().splitlines()[-1]}
            log.write(traceback.format_exc())
        sys.stderr.write(log.getvalue())
        reply.update(id=req.get("id"), log=log.getvalue()[-4000:], seconds=round(time.time() - t0, 2))
        OUT.write(json.dumps(reply) + "\n")
        OUT.flush()


if __name__ == "__main__":
    main()
