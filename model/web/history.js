// Run history, kept in this browser's localStorage.
const KEY = "juggle-tracker.runs.v1";

export function loadRuns() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}

export function saveRun(run) {
  const runs = loadRuns();
  runs.push(run);
  try { localStorage.setItem(KEY, JSON.stringify(runs)); } catch { /* storage blocked: keep going */ }
}

export function clearRuns() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function summarize(runs, now = Date.now()) {
  const today = dayKey(now);
  const todayRuns = runs.filter((r) => dayKey(r.at) === today);
  const byDay = new Map();
  for (const r of runs) {
    const k = dayKey(r.at);
    byDay.set(k, Math.max(byDay.get(k) || 0, r.n));
  }
  const days = [...byDay].sort(([a], [b]) => (a < b ? -1 : 1)).slice(-30).map(([k, best]) => {
    const [, m, d] = k.split("-");
    return { day: k, best, label: `${+m}/${+d}` };
  });
  return {
    todayRuns: todayRuns.slice(-40),
    bestToday: Math.max(0, ...todayRuns.map((r) => r.n)),
    totalToday: todayRuns.reduce((s, r) => s + r.n, 0),
    best: Math.max(0, ...runs.map((r) => r.n)),
    days,
  };
}
