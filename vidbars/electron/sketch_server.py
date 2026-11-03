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
            out[mm.group(1)] = float(mm.group(2))
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
                out[key] = v * f
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


def use_scales(root, groups, area):
    """scale.Scale, for the looks run in this job, serving these measured scales (each subject its own body)."""
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
    return short([dials, req.get("scale") or {}, round(k, 3)])


def op_lines(req):
    root, mclip, objs = segment_clip(req)
    side = int(req.get("side") or LIVE)
    dials = {k: float(v) for k, v in (req.get("dials") or {}).items()}
    k = res_factor(root, side)
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
         "__file__": os.path.join(root, "tools_scale", os.path.basename(script))}
    exec(compile(open(script, encoding="utf-8").read(), script, "exec"), g)
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
    kf = res_factor(root, side)
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
    kf = res_factor(root, side)
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


def op_look(req):
    """One of LOOKS on the picture: the script runs whole on the picture's clip (a still as two frames of itself,
    since several read motion from a neighbour), and each RGBA layer it writes comes back as its colour and its
    alpha (two PNGs: VidBars uploads pictures without their alpha). A script that stops in its movie or contact
    sheets after writing every layer (they assume a long shot) has still made what is needed."""
    spec = LOOKS[req["look"]]
    if spec["mask"] == "need" or (spec["mask"] == "optional" and req.get("objects")):
        root, mclip, _ = segment_clip(req)
    else:
        root, mclip = base(req), None
    side = int(req.get("side") or LIVE)
    dials = {k: float(v) for k, v in (req.get("dials") or {}).items()}
    kf = res_factor(root, side)
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


OPS = {"depth": op_depth, "segment": op_segment, "lines": op_lines, "formhatch": op_formhatch, "bghatch": op_bghatch,
       "look": op_look, "scales": op_scales}


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
