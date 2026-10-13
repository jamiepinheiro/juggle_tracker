// Score the counter against hand-tapped throws from web/label.html.
// usage: node tools/eval_counts.mjs <dets.json> <labels.json> [tolerance_s]
//
// Each counted apex is matched to the nearest unmatched tap within the tolerance (taps carry
// reaction time and may be at release or apex, so the window is generous). Reports per-segment
// counts plus precision/recall over individual throws.
import { readFileSync } from "node:fs";
import { JuggleCounter } from "../web/counter.js";

const [detsPath, labelsPath, tolArg] = process.argv.slice(2);
const tol = tolArg ? +tolArg : 0.35;
const { fps, frames } = JSON.parse(readFileSync(detsPath, "utf8"));
const labels = JSON.parse(readFileSync(labelsPath, "utf8"));

const c = new JuggleCounter();
const counted = [];
c.onThrow = (e) => counted.push(e.t);
frames.forEach((d, i) => c.update(d, i / fps));
c.update([], frames.length / fps + 10);

const taps = labels.segments.flatMap((s) => s.taps ?? []).sort((a, b) => a - b);
// partially labelled videos: only score counts up to the end of the labelled part
const labelledUntil = Math.max(...labels.segments.map((s) => s.end ?? s.start), ...taps) + 1;
const allCounted = counted.splice(0).filter((t) => t <= labelledUntil);
counted.push(...allCounted);
const used = new Set();
let tp = 0;
const extra = [];
for (const t of counted) {
  let best = -1;
  taps.forEach((x, i) => {
    if (!used.has(i) && Math.abs(x - t) <= tol && (best < 0 || Math.abs(x - t) < Math.abs(taps[best] - t))) best = i;
  });
  if (best >= 0) { used.add(best); tp++; } else extra.push(t);
}
const missed = taps.filter((_, i) => !used.has(i));

console.log(`labelled up to ${labelledUntil.toFixed(1)} s`);
console.log(`taps ${taps.length}  counted ${counted.length}  matched ${tp}`);
console.log(`recall ${(tp / taps.length).toFixed(3)}  precision ${(tp / Math.max(counted.length, 1)).toFixed(3)}`);
console.log("per segment (labelled -> counted):");
for (const s of labels.segments) {
  const end = s.end ?? Infinity;
  const n = counted.filter((t) => t >= s.start - tol && t <= end + tol).length;
  console.log(`  ${s.start.toFixed(1)}-${Number.isFinite(end) ? end.toFixed(1) : "?"}s  ${s.count} -> ${n}`);
}
const fmt = (a) => a.map((t) => t.toFixed(2)).join(" ");
console.log(`missed taps (s): ${fmt(missed)}`);
console.log(`unmatched counts (s): ${fmt(extra)}`);
