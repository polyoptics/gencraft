"""Runs one of sketchLook's tools (depth.py, matte_auto.py) UNCHANGED on pictures VidBars hands over.

    python sketch_run.py <depth|segment> <work dir> <tools dir> <frame paths file> [tool args...]

The tools read and write under their own ROOT (the folder above tools/), found from __file__. Each script is
executed here with __file__ pointing into <work dir>/tools/, so ROOT becomes the work dir: clips/still/ holds the
frames, and nothing is written into the sketchLook checkout. A still is a one-frame clip.

Writes <work dir>/result/... as 8-bit PNGs and prints one JSON line (prefixed RESULT ) naming them:
  depth   -> {"frames": [...]}                    nearer = brighter, one range for the whole sequence
  segment -> {"objects": {name: [...]}}           white = the object; "figure" is all of them together
"""
import glob
import json
import os
import sys

import cv2
import numpy as np

op, work, tools, listfile, *extra = sys.argv[1:]
CLIP = "still"
clipdir = os.path.join(work, "clips", CLIP)
os.makedirs(clipdir, exist_ok=True)
os.makedirs(os.path.join(work, "out"), exist_ok=True)
for i, p in enumerate(l for l in open(listfile, encoding="utf-8").read().splitlines() if l):
    img = cv2.imread(p, cv2.IMREAD_COLOR)  # drops alpha; tools expect 3-channel PNGs
    if img is None:
        sys.exit("could not read frame %d: %s" % (i, p))
    cv2.imwrite(os.path.join(clipdir, "%04d.png" % i), img)

script = os.path.join(tools, {"depth": "depth.py", "segment": "matte_auto.py"}[op])
sys.argv = [script, CLIP, *extra]
sys.path.insert(0, tools)
try:
    exec(compile(open(script, encoding="utf-8").read(), script,  "exec"),
         {"__name__": "__main__", "__file__": os.path.join(work, "tools", os.path.basename(script))})
except SystemExit as e:  # matte_auto exits 0 when it finds nothing
    if e.code not in (None, 0):
        raise

res = os.path.join(work, "result")
if op == "depth":
    ds = [np.load(f) for f in sorted(glob.glob(os.path.join(work, "clips", CLIP + "_depth", "*.npy")))]
    lo, hi = np.percentile(np.stack(ds[::max(1, len(ds) // 20)]), [1, 99])
    os.makedirs(res, exist_ok=True)
    out = []
    for i, d in enumerate(ds):
        f = os.path.join(res, "depth_%04d.png" % i)
        cv2.imwrite(f, (np.clip((d - lo) / max(hi - lo, 1e-6), 0, 1) * 255).astype(np.uint8))
        out.append(f)
    print("RESULT " + json.dumps({"frames": out}))
else:
    mdir = os.path.join(work, "clips", CLIP + "_matte")
    objs = {}
    if os.path.isdir(mdir):
        for o in sorted(os.listdir(mdir)):
            if os.path.isdir(os.path.join(mdir, o)):
                objs[o] = sorted(glob.glob(os.path.join(mdir, o, "*.png")))
    print("RESULT " + json.dumps({"objects": objs}))
