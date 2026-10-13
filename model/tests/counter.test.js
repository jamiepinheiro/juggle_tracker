import { test } from "node:test";
import assert from "node:assert/strict";
import { JuggleCounter } from "../web/counter.js";

const FPS = 30, SIZE = 0.04, G = 95 * SIZE; // normalised gravity (frame heights / s^2)

// Synthetic cascade: ball k thrown at k*beat from alternating hands, flight `flight` seconds.
// As in a real cascade, balls are thrown from inside the hands and caught outside.
function cascade({ throws, beat = 0.33, flight = 0.9, handY = 0.8, drop = false, miss = 0 }) {
  const frames = [];
  const end = throws * beat + flight + 0.5;
  for (let f = 0; f < end * FPS; f++) {
    const t = f / FPS, dets = [];
    for (let k = 0; k < throws; k++) {
      const t0 = k * beat, u = t - t0;
      const x0 = k % 2 ? 0.55 : 0.45, x1 = k % 2 ? 0.35 : 0.65;
      if (u < 0 || u > flight) continue;
      const v0 = (G * flight) / 2;
      const y = handY - v0 * u + (G * u * u) / 2;
      if (drop && k === throws - 1 && u > flight / 2) continue;
      if (miss && (f * 7 + k) % miss === 0) continue; // deterministic detection dropouts
      dets.push({ x: x0 + ((x1 - x0) * u) / flight, y, size: SIZE, score: 0.9 });
    }
    frames.push(dets);
  }
  return frames;
}

function run(frames, opts) {
  const c = new JuggleCounter(opts);
  const runs = [];
  c.onRunEnd = (n) => runs.push(n);
  frames.forEach((d, i) => c.update(d, i / FPS));
  c.update([], frames.length / FPS + 5);
  return { total: c.total, runs };
}

test("counts every throw in a clean cascade", () => {
  assert.deepEqual(run(cascade({ throws: 12 })), { total: 12, runs: [12] });
});

test("tolerates missed detections", () => {
  assert.equal(run(cascade({ throws: 15, miss: 4 })).total, 15);
});

test("duplicate detections on one ball count once", () => {
  const frames = cascade({ throws: 6 }).map((d) => d.flatMap((b) => [b, { ...b, x: b.x + 0.005, score: 0.5 }]));
  assert.equal(run(frames).total, 6);
});

test("small hand movements are not throws", () => {
  const frames = [];
  for (let f = 0; f < 90; f++) frames.push([{ x: 0.5, y: 0.8 - 0.04 * Math.sin(f / 5), size: SIZE, score: 0.9 }]);
  assert.equal(run(frames).total, 0);
});

test("ball leaving the top of the frame still counts", () => {
  const frames = cascade({ throws: 3, flight: 1.2, handY: 0.5 }).map((d) => d.filter((b) => b.y > 0));
  assert.equal(run(frames).total, 3);
});

test("separate attempts become separate runs", () => {
  const a = cascade({ throws: 5 }), gap = Array.from({ length: 60 }, () => []), b = cascade({ throws: 3 });
  assert.deepEqual(run([...a, ...gap, ...b]).runs, [5, 3]);
});

test("an arc seen only from near its apex counts (ball blurred on the way up)", () => {
  // keep the top of each arc and the whole fall: drop the rising part below y=0.6
  const full = cascade({ throws: 4 });
  const partial = full.map((d, i) => d.filter((b) => {
    const prev = full[i - 1]?.find((p) => Math.abs(p.x - b.x) < 0.02);
    const rising = prev ? b.y < prev.y : true;
    return !rising || b.y < 0.6;
  }));
  assert.equal(run(partial).total, 4);
});

test("a slow hand lift that peaks and drops is not a throw", () => {
  const frames = [];
  for (let f = 0; f < 60; f++) {
    const u = f / 60; // 2 s up-and-down: far slower than free fall
    frames.push([{ x: 0.5, y: 0.8 - 0.2 * Math.sin(Math.PI * u), size: SIZE, score: 0.9 }]);
  }
  assert.equal(run(frames).total, 0);
});
