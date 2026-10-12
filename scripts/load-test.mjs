// Fires N submissions at once, plus judge/landing traffic, and reports latency.
// Usage: node scripts/load-test.mjs [baseUrl] [count]
const base = process.argv[2] || 'http://localhost:3000';
const n = Number(process.argv[3] || 80);
const tracks = ['payments', 'access', 'fraud'];

const one = async i => {
  const t0 = performance.now();
  const res = await fetch(`${base}/api/submissions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      track: tracks[i % 3], title: `Load test project ${i}`, tagline: 'Helps people see where a payment is stuck',
      description: 'A test submission. '.repeat(40), teamName: `Team ${i}`,
      members: [{ name: 'Ada Lovelace', linkedin: 'https://www.linkedin.com/in/example' }, { name: 'Alan Turing', linkedin: '' }],
      videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', demoUrl: '', contactEmail: `team${i}@example.com`,
    }),
  });
  return { ok: res.status === 201, status: res.status, ms: performance.now() - t0 };
};
const page = async p => { const t0 = performance.now(); const r = await fetch(base + p); await r.arrayBuffer(); return { ok: r.ok, status: r.status, ms: performance.now() - t0 }; };

const t0 = performance.now();
const results = await Promise.all([
  ...Array.from({ length: n }, (_, i) => one(i)),
  ...Array.from({ length: n }, () => page('/')),
  ...Array.from({ length: n }, () => page('/submit')),
]);
const subs = results.slice(0, n), pages = results.slice(n);
const pct = (arr, q) => arr.map(r => r.ms).sort((a, b) => a - b)[Math.floor(arr.length * q) - (q === 1 ? 1 : 0)].toFixed(0);
console.log(`submissions: ${subs.filter(r => r.ok).length}/${n} ok · p50 ${pct(subs, .5)}ms · p95 ${pct(subs, .95)}ms · max ${pct(subs, 1)}ms`);
console.log(`page loads:  ${pages.filter(r => r.ok).length}/${pages.length} ok · p50 ${pct(pages, .5)}ms · p95 ${pct(pages, .95)}ms · max ${pct(pages, 1)}ms`);
const bad = results.filter(r => !r.ok); if (bad.length) console.log('failures:', bad.map(r => r.status));
console.log(`total wall time ${(performance.now() - t0).toFixed(0)}ms`);
process.exit(bad.length ? 1 : 0);
