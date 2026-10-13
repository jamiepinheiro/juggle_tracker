// Replay dumped detections through the browser counter. usage: node run_counter.mjs dets.json [throws_out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { JuggleCounter } from "../web/counter.js";
const { fps, frames } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const c = new JuggleCounter();
const throws = [], runs = [];
c.onThrow = (e) => throws.push(Math.round(e.t * fps));
c.onRunEnd = (n) => runs.push(n);
frames.forEach((d, i) => c.update(d, i / fps));
c.update([], frames.length / fps + 10);
console.log(`throws=${c.total} runs=${JSON.stringify(runs)}`);
console.log(`apex frames: ${throws.join(" ")}`);
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(throws));
