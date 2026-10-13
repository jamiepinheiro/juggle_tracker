"""Drop labels on static objects (e.g. bookshelf spines). A juggled ball is never motionless for
long: even at the top of an arc it only lingers 2-3 frames. Boxes that stay put across RUN
consecutive frames are scenery. (Counting total recurrences instead would also hit the spot where
every throw peaks.)
Scenery that flickers in and out of detection needs an explicit ignore box (normalised x0,y0,x1,y1).
usage: drop_static.py data/<video> [run_frames] [ignore_box]   (edits data/<video>/labels in place)"""
import glob, sys
VID = sys.argv[1]
RUN = int(sys.argv[2]) if len(sys.argv) > 2 else 6
IGNORE = [float(v) for v in sys.argv[3].split(",")] if len(sys.argv) > 3 else None
TOL = 0.008  # ~8 px at 960 wide
files = sorted(glob.glob(f"{VID}/labels/*.txt"))
rows = [[l.split() for l in open(p) if l.strip()] for p in files]
pts = [[(float(r[1]), float(r[2])) for r in rs] for rs in rows]
near = lambda a, fr: any(abs(a[0] - b[0]) < TOL and abs(a[1] - b[1]) < TOL for b in fr)
static = [set() for _ in rows]
for t in range(len(rows) - RUN + 1):
    for j, a in enumerate(pts[t]):
        if all(near(a, pts[t + k]) for k in range(1, RUN)):
            for k in range(RUN):  # mark the matching box in every frame of the run
                for i, b in enumerate(pts[t + k]):
                    if abs(a[0] - b[0]) < 2 * TOL and abs(a[1] - b[1]) < 2 * TOL:
                        static[t + k].add(i)
if IGNORE:
    x0, y0, x1, y1 = IGNORE
    for t, ps in enumerate(pts):
        static[t] |= {i for i, (x, y) in enumerate(ps) if x0 <= x <= x1 and y0 <= y <= y1}
dropped = 0
for p, rs, st in zip(files, rows, static):
    dropped += len(st)
    open(p, "w").write("".join(" ".join(r) + "\n" for i, r in enumerate(rs) if i not in st))
print("dropped", dropped, "of", sum(map(len, rows)))
