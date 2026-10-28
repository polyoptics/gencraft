"""VidBars' SAM 3 worker: text-prompted segmentation with every instance, in its own venv (.sam3-venv).

    python sam3_server.py <cache dir> <sketchLook dir>

One JSON request per line on stdin, one JSON reply per line on stdout (the same protocol as sketch_server.py):

  {"id", "op": "segment", "src": HASH, "frames": [path...], "objects": {name: [phrase...]}}

Writes, in the picture's cache folder that sketch_server.py also uses (<cache dir>/<HASH>/clips/), the matte layout
the looks read - clips/s3_<objects>_matte/<name>/NNNN.png per instance (name, or name_1, name_2 ... left to right
when there are several) and figure/ (all of them) - and clips/s3_<objects>_done.json (the names). Masks are cleaned
with matte_auto.py's own fill_small_holes, as the Grounding DINO + SAM2 engine's are. Replies
{"clip": "s3_<objects>", "objects": {name: [png...]}}.

Phrases can describe ("the man in the yellow jacket"): SAM 3 finds every instance of the concept. A still runs the
image model; a sequence runs the video model, which looks for the concept on every frame and tracks what it finds,
so something that walks in later is found too. Each phrase of a name is prompted; instances two phrases of one name
both found (a "rifle" that is also a "gun") are merged.
"""
import ast
import functools
import hashlib
import io
import contextlib
import json
import os
import sys
import time
import traceback

import cv2
import numpy as np

CACHE, SKETCH = sys.argv[1], sys.argv[2]
OUT = sys.stdout
MODEL = "facebook/sam3"
SAME = 0.6  # mask IoU at which two prompts' instances are the same thing


def short(obj):
    return hashlib.sha1(json.dumps(obj, sort_keys=True).encode()).hexdigest()[:12]


@functools.lru_cache(maxsize=1)
def cleaner():
    """matte_auto.py's own fill_small_holes(), read from the file."""
    p = os.path.join(SKETCH, "tools", "matte_auto.py")
    tree = ast.parse(open(p, encoding="utf-8").read())
    keep = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "fill_small_holes"]
    ns = {"cv2": cv2, "np": np}
    exec(compile(ast.Module(body=keep, type_ignores=[]), p, "exec"), ns)
    return ns["fill_small_holes"]


@functools.lru_cache(maxsize=1)
def image_model():
    import torch
    from transformers import Sam3Model, Sam3Processor
    return Sam3Processor.from_pretrained(MODEL), Sam3Model.from_pretrained(MODEL).to("cuda", torch.bfloat16).eval()


@functools.lru_cache(maxsize=1)
def video_model():
    import torch
    from transformers import Sam3VideoModel, Sam3VideoProcessor
    return Sam3VideoProcessor.from_pretrained(MODEL), Sam3VideoModel.from_pretrained(MODEL).to("cuda", torch.bfloat16).eval()


def objects_of(req):
    """{folder-safe name: [phrases]}; 'person' when it names nothing (as sketch_server.py)."""
    out = {}
    for n, ps in (req.get("objects") or {}).items():
        n = "".join(c if c.isalnum() or c in "_-" else "_" for c in str(n).strip().lower()).strip("_") or "object"
        ps = [str(p).strip().lower() for p in ps if str(p).strip()]
        if ps:
            out[n] = out.get(n, []) + ps
    return out or {"person": ["person"]}


def still(frame, phrases):
    """{phrase: [HxW bool mask, ...]} on one picture (the image model)."""
    import torch
    proc, model = image_model()
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    out = {}
    for ph in phrases:
        inp = proc(images=rgb, text=ph, return_tensors="pt").to("cuda")
        inp = {k: (v.to(torch.bfloat16) if torch.is_floating_point(v) else v) for k, v in inp.items()}
        with torch.inference_mode():
            res = model(**inp)
        r = proc.post_process_instance_segmentation(res, threshold=0.5, mask_threshold=0.5,
                                                    target_sizes=[frame.shape[:2]])[0]
        out[ph] = [m.astype(bool) for m in r["masks"].float().cpu().numpy()]
    return out


def sequence(frames, phrases):
    """{phrase: {object id: {frame: HxW bool}}} over the clip (the video model: detects on every frame, tracks)."""
    import torch
    proc, model = video_model()
    video = [cv2.cvtColor(f, cv2.COLOR_BGR2RGB) for f in frames]
    session = proc.init_video_session(video=video, inference_device="cuda", processing_device="cpu",
                                      video_storage_device="cpu", dtype=torch.bfloat16)
    session = proc.add_text_prompt(inference_session=session, text=list(phrases))
    out = {ph: {} for ph in phrases}
    with torch.inference_mode():
        for mo in model.propagate_in_video_iterator(inference_session=session, max_frame_num_to_track=len(frames)):
            r = proc.postprocess_outputs(session, mo)
            ids = [int(i) for i in r["object_ids"].tolist()]
            masks = r["masks"].float().cpu().numpy() > 0.5
            for ph, pids in r["prompt_to_obj_ids"].items():
                for oid in pids:
                    if oid in ids:
                        out.setdefault(ph, {}).setdefault(int(oid), {})[mo.frame_idx] = masks[ids.index(oid)]
    return out


def iou(a, b):
    u = np.logical_or(a, b).sum()
    return np.logical_and(a, b).sum() / u if u else 0.0


def op_segment(req):
    objs = objects_of(req)
    clip = "s3_" + short(objs)
    root = os.path.join(CACHE, req["src"])
    cdir = os.path.join(root, "clips")
    done = os.path.join(cdir, clip + "_done.json")
    mdir = os.path.join(cdir, clip + "_matte")
    if not os.path.exists(done):
        frames = []
        for p in req["frames"]:
            f = cv2.imread(p, cv2.IMREAD_COLOR)
            if f is None:
                raise ValueError("could not read frame %d" % len(frames))
            frames.append(f)
        H, W = frames[0].shape[:2]
        N = len(frames)
        phrases = [p for ps in objs.values() for p in ps]
        tracks = {n: [] for n in objs}  # name -> [{frame: mask}] (one per instance)
        if N == 1:
            for ph, ms in still(frames[0], phrases).items():
                n = next(k for k, ps in objs.items() if ph in ps)
                tracks[n] += [{0: m} for m in ms if m.sum() >= 0.002 * H * W]
        else:
            for ph, objs_ in sequence(frames, phrases).items():
                n = next(k for k, ps in objs.items() if ph in ps)
                tracks[n] += [t for t in objs_.values() if max(m.sum() for m in t.values()) >= 0.002 * H * W]
        clean = cleaner()
        zero = np.zeros((H, W), bool)
        named = []  # (name, {frame: uint8 mask})
        for n, ts in tracks.items():
            whole = [np.logical_or.reduce([t.get(i, zero) for i in range(N)]) for t in ts]
            merged = []  # an instance two phrases of one name both found is one thing
            for t, w in zip(ts, whole):
                for m in merged:
                    if iou(w, m[1]) > SAME:
                        for i, x in t.items():
                            m[0][i] = np.logical_or(m[0].get(i, zero), x)
                        m[1] |= w
                        break
                else:
                    merged.append([dict(t), w.copy()])
            merged.sort(key=lambda m: np.nonzero(m[1].any(0))[0].mean())  # left to right
            for k, (t, _) in enumerate(merged):
                named.append((n if len(merged) == 1 else "%s_%d" % (n, k + 1),
                              {i: clean(t.get(i, zero).astype(np.uint8), max_frac=0.01) for i in range(N)}))
        if named:
            for n, ms in named:
                os.makedirs(os.path.join(mdir, n), exist_ok=True)
                for i in range(N):
                    cv2.imwrite(os.path.join(mdir, n, "%04d.png" % i), ms[i] * 255)
            os.makedirs(os.path.join(mdir, "figure"), exist_ok=True)
            for i in range(N):
                cv2.imwrite(os.path.join(mdir, "figure", "%04d.png" % i),
                            clean(np.maximum.reduce([ms[i] for _, ms in named])) * 255)
        os.makedirs(cdir, exist_ok=True)
        json.dump([n for n, _ in named], open(done, "w"))
        print("SAM 3 found: %s" % (", ".join(n for n, _ in named) or "nothing"))
    out = {}
    if os.path.isdir(mdir):
        out = {o: [os.path.join(mdir, o, f) for f in sorted(os.listdir(os.path.join(mdir, o)))]
               for o in sorted(os.listdir(mdir)) if os.path.isdir(os.path.join(mdir, o))}
    return {"clip": clip, "objects": out}


def main():
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
                reply = {"segment": op_segment}[req["op"]](req)
        except Exception:
            reply = {"error": traceback.format_exc().strip().splitlines()[-1]}
            log.write(traceback.format_exc())
        sys.stderr.write(log.getvalue())
        reply.update(id=req.get("id"), log=log.getvalue()[-4000:], seconds=round(time.time() - t0, 2))
        OUT.write(json.dumps(reply) + "\n")
        OUT.flush()


if __name__ == "__main__":
    main()
