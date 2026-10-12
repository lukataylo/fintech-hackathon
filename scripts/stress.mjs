// Stress test: burst + sustained mixed traffic. Writes junk data: use a throwaway DB_PATH.
// Usage: node scripts/stress.mjs <baseUrl> <adminKey> [seconds=60] [participants=120] [burst=300]
const [B, AK, SECS = '60', USERS = '120', BURST = '300'] = process.argv.slice(2);
const A = { 'x-admin-key': AK };
const stats = new Map();
async function hit(label, path, opts = {}) {
  const t0 = performance.now();
  try {
    const r = await fetch(B + path, opts); await r.arrayBuffer();
    rec(label, performance.now() - t0, r.status < 400 || r.status === 422 ? null : r.status);
    return r.status;
  } catch (e) { rec(label, performance.now() - t0, e.cause?.code || e.message); return 0; }
}
function rec(label, ms, err) {
  const s = stats.get(label) || { ms: [], errs: {} }; s.ms.push(ms);
  if (err != null) s.errs[err] = (s.errs[err] || 0) + 1; stats.set(label, s);
}
const sub = i => JSON.stringify({ track: ['payments', 'access', 'fraud'][i % 3], title: `Stress ${i}`, tagline: 'Helps freelancers see where a payment is stuck', description: 'x'.repeat(1500), teamName: `T${i}`, members: [1, 2, 3, 4].map(n => ({ name: `Person ${n}`, linkedin: 'https://linkedin.com/in/x' })), videoUrl: 'https://youtu.be/dQw4w9WgXcQ', contactEmail: `s${i}@x.io` });
const post = i => hit('submit (POST)', '/api/submissions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: sub(i) });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = title => {
  console.log(`\n${title}`);
  for (const [label, s] of stats) {
    const a = s.ms.sort((x, y) => x - y), q = p => a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(0);
    const nErr = Object.values(s.errs).reduce((x, y) => x + y, 0);
    console.log(`  ${label.padEnd(22)} ${String(a.length).padStart(6)} req  p50 ${q(.5).padStart(5)}ms  p95 ${q(.95).padStart(5)}ms  p99 ${q(.99).padStart(5)}ms  max ${q(1).padStart(5)}ms  errors ${nErr}${nErr ? ' ' + JSON.stringify(s.errs) : ''}`);
  }
  stats.clear();
};

// 1. Burst
let t0 = performance.now();
await Promise.all(Array.from({ length: Number(BURST) }, (_, i) => post(i)));
report(`Burst: ${BURST} simultaneous submissions in ${(performance.now() - t0).toFixed(0)}ms`);

// 2. Sustained mixed load
const S = await (await fetch(B + '/api/admin/state', { headers: A })).json();
const judges = S.judges.filter(j => j.active);
const end = Date.now() + Number(SECS) * 1000;
const assets = ['/', '/assets/app.css', '/assets/app.js', '/img/hero.webp', '/img/track-payments.webp', '/img/track-access.webp', '/img/track-fraud.webp', '/img/judges/nuan.webp', '/img/judges/till.webp', '/img/judges/anna.webp', '/img/judges/luka.webp', '/sgn-logo.svg', '/generate-logo.svg', '/zaro-logo.svg', '/foldo-mark.svg'];
let n = Number(BURST);
// Like a browser: first visit downloads everything; later visits revalidate the page (304) and reuse cached assets.
const participant = async id => {
  const etags = {};
  const get = async (label, path) => {
    const t0 = performance.now();
    try {
      const r = await fetch(B + path, { headers: etags[path] ? { 'if-none-match': etags[path] } : {} }); await r.arrayBuffer();
      if (r.headers.get('etag')) etags[path] = r.headers.get('etag');
      rec(label, performance.now() - t0, r.status < 400 ? null : r.status);
    } catch (e) { rec(label, performance.now() - t0, e.cause?.code || e.message); }
  };
  await sleep(Math.random() * 10000); // people arrive over ~10s, not in the same millisecond
  await Promise.all(assets.map(a => get(a === '/' ? 'landing page' : a.startsWith('/img') ? 'images (first visit)' : 'css/js/svg (first)', a)));
  while (Date.now() < end) {
    await get('landing page', '/');
    await get('submit page', '/submit');
    if (Math.random() < 0.15) await post(n++);
    await sleep(2000 + Math.random() * 3000);
  }
};
const judge = async j => {
  const H = { 'x-judge-key': j.code };
  while (Date.now() < end) {
    const t = performance.now(); const r = await fetch(B + '/api/judge/state', { headers: H }); const st = await r.json(); rec('judge state (GET)', performance.now() - t, r.ok ? null : r.status);
    for (const s of (st.review || []).slice(0, 5)) {
      await hit('judge score (PUT)', '/api/judge/score', { method: 'PUT', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ submissionId: s.id, round: 1, impact: 1 + s.id % 5, originality: 3, execution: 4, trust: 2, verdict: 'yes', note: 'stress' }) });
    }
    await sleep(2000); // 10x faster than the real 20s poll
  }
};
const adminLoop = async () => { while (Date.now() < end) { await hit('admin state (GET)', '/api/admin/state', { headers: A }); await sleep(1000); } };
t0 = performance.now();
await Promise.all([...Array.from({ length: Number(USERS) }, (_, i) => participant(i)), ...judges.map(judge), adminLoop(), adminLoop()]);
report(`Sustained: ${USERS} participants browsing + ${judges.length} judges at 10x poll rate + admin, for ${SECS}s`);
const fin = await (await fetch(B + '/api/admin/state', { headers: A })).json();
console.log(`\nDB now holds ${fin.submissions.length} submissions; judges: ${fin.judges.filter(j => j.active).map(j => `${j.id}:${j.assigned}`).join(' ')}`);
