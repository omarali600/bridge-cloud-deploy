/**
 * In-process metrics. Simple counters + latency histogram.
 * Exposed via /metrics. Render's free tier doesn't include Prometheus
 * scraping, so we just return JSON.
 */

const counters = new Map();
const observations = new Map();   // name → array of values
const startedAt = Date.now();

export const metrics = {
  incr(name, amount = 1) {
    counters.set(name, (counters.get(name) ?? 0) + amount);
  },
  observe(name, value) {
    if (!observations.has(name)) observations.set(name, []);
    const arr = observations.get(name);
    arr.push(value);
    if (arr.length > 1000) arr.shift();
  },
  snapshot() {
    const obsSummary = {};
    for (const [name, values] of observations.entries()) {
      if (values.length === 0) continue;
      const sorted = [...values].sort((a, b) => a - b);
      obsSummary[name] = {
        count: values.length,
        min: sorted[0],
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        max: sorted[sorted.length - 1],
      };
    }
    return {
      ts: new Date().toISOString(),
      uptime_sec: Math.floor((Date.now() - startedAt) / 1000),
      counters: Object.fromEntries(counters),
      latency: obsSummary,
    };
  },
};
