"""Scatter ball height vs time from a labels dir, to eyeball/count throw arcs. usage: plot_traj.py labels_dir|dets.json out.png [start end] [throws.json]"""
import glob, json, os, sys
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
ldir, out = sys.argv[1], sys.argv[2]
a, b = (int(sys.argv[3]), int(sys.argv[4])) if len(sys.argv) > 4 else (0, 10**9)
pts = []
if ldir.endswith(".json"):  # dump_dets.py output, frame index = position
    for i, dets in enumerate(json.load(open(ldir))["frames"], start=1):
        if a <= i < b:
            pts += [(i, 1 - d["y"]) for d in dets]
else:
    for p in sorted(glob.glob(f"{ldir}/*.txt")):
        i = int(os.path.basename(p)[:-4])
        if a <= i < b:
            pts += [(i, 1 - float(l.split()[2])) for l in open(p) if l.strip()]
fig, ax = plt.subplots(figsize=(22, 4))
ax.scatter(*zip(*pts), s=6)
if len(sys.argv) > 5:  # counted throws (0-based frame index from run_counter.mjs)
    for f in json.load(open(sys.argv[5])):
        if a <= f + 1 < b:
            ax.axvline(f + 1, color="tab:red", alpha=0.6, lw=1)
ax.set_xticks(range(a - a % 10, min(b, max(p[0] for p in pts)) + 1, 10), minor=True)
ax.set_xticks(range(a - a % 50, min(b, max(p[0] for p in pts)) + 1, 50))
ax.grid(True, which="both", alpha=0.3); ax.set_ylim(0, 1); ax.set_xlim(a, min(b, max(p[0] for p in pts)) + 1)
fig.tight_layout(); fig.savefig(out, dpi=90)
