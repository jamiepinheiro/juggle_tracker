"""Assemble one YOLO dataset from every video in VIDEOS. usage: build_dataset.py [labels_subdir]

Per video (data/videos.json): frames in `neg` ranges are kept as pure negatives (no juggling, labels unreliable),
`val` is a contiguous held-out block (so val isn't near-duplicates of train), and `stride` thins
long videos, since neighbouring frames are near-duplicates anyway.
"""
import glob, json, os, shutil, sys

VIDEOS = {k: v for k, v in json.load(open("data/videos.json")).items() if not k.startswith("_")}
labels = sys.argv[1] if len(sys.argv) > 1 else "labels"
# Hand-checked frames are few and contradict the auto labels where it matters (balls near the
# body, which the auto labels mostly miss), so each one is shown this many times per epoch.
MANUAL_REPEAT = 5
root = "data/ds"
shutil.rmtree(root, ignore_errors=True)
for split in ("train", "val"):
    os.makedirs(f"{root}/images/{split}"); os.makedirs(f"{root}/labels/{split}")
counts = {"train": 0, "val": 0, "manual": 0}
for vid, cfg in VIDEOS.items():
    # hand-checked frames from label.html (Boxes mode) beat everything else. The random-sample ones
    # go to val, so the model is scored on clean labels; the rest train.
    q = f"data/{vid}/review_queue.json"
    random_frames = {f["n"] for f in json.load(open(q))["frames"] if f["why"] == "random"} if os.path.exists(q) else set()
    for p in sorted(glob.glob(f"data/{vid}/frames/*.jpg")):
        name = os.path.basename(p)[:-4]; idx = int(name)
        manual = f"data/{vid}/labels_manual/{name}.txt"
        if os.path.exists(manual):
            split = "val" if (idx - 1) in random_frames or cfg["val"][0] <= idx < cfg["val"][1] else "train"
            txt = open(manual).read()
            counts["manual"] += 1
        else:
            if idx % cfg["stride"]:
                continue
            split = "val" if cfg["val"][0] <= idx < cfg["val"][1] else "train"
            src = f"data/{vid}/{labels}/{name}.txt"
            neg = any(a <= idx < b for a, b in cfg["neg"])
            txt = "" if neg or not os.path.exists(src) else open(src).read()
        repeat = MANUAL_REPEAT if os.path.exists(manual) and split == "train" else 1
        for k in range(repeat):
            out = f"{vid}_{name}" + (f"_r{k}" if k else "")
            os.symlink(os.path.abspath(p), f"{root}/images/{split}/{out}.jpg")
            open(f"{root}/labels/{split}/{out}.txt", "w").write(txt)
            counts[split] += 1
# Kaggle "Juggling" clips (import_kaggle.py): other people, rooms and balls. Whole clips are
# held out for val, so it measures generalisation to new setups.
kclips = "data/kaggle/clips.json"
if os.path.exists(kclips) and os.environ.get("KAGGLE", "1") == "1":
    for cid, c in json.load(open(kclips)).items():
        for p in sorted(glob.glob(f"data/kaggle/frames/{cid}_*.jpg")):
            out = "kaggle_" + os.path.basename(p)[:-4]
            os.symlink(os.path.abspath(p), f"{root}/images/{c['split']}/{out}.jpg")
            shutil.copy(p.replace("/frames/", "/labels/")[:-4] + ".txt", f"{root}/labels/{c['split']}/{out}.txt")
            counts[c["split"]] += 1
            counts["kaggle"] = counts.get("kaggle", 0) + 1
open(f"{root}/data.yaml", "w").write(f"path: {os.path.abspath(root)}\ntrain: images/train\nval: images/val\nnames:\n  0: ball\n")
print(counts)
