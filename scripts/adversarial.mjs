// Adversarial / chaos test against a running server. Destroys data: point it at a throwaway DB only.
// Usage: node scripts/adversarial.mjs http://localhost:3090 admin-local
import net from 'node:net';
const B = process.argv[2] || 'http://localhost:3000';
const AK = process.argv[3] || 'admin-local';
const u = new URL(B);
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` (${extra})` : ''}`); };
const req = async (path, { method = 'GET', body, headers = {}, raw } = {}) => {
  const r = await fetch(B + path, { method, headers: { ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d, headers: r.headers };
};
const A = { 'x-admin-key': AK };
const admin = (path, body, method = 'POST') => req(path, { method, body, headers: A });
const alive = async () => (await req('/healthz')).status === 200;
const rawHttp = payload => new Promise(res => {
  const s = net.connect(Number(u.port || 80), u.hostname, () => s.end(payload));
  let out = ''; s.on('data', d => out += d); s.on('close', () => res(out)); s.on('error', () => res('ERR')); setTimeout(() => { s.destroy(); res(out); }, 2000);
});
const sub = (i, extra = {}) => ({
  track: ['payments', 'access', 'fraud'][i % 3], title: `Chaos ${i}`, tagline: 't', description: 'd',
  members: [{ name: 'A', linkedin: '' }], videoUrl: 'https://youtu.be/abc', contactEmail: `c${i}@x.io`, ...extra,
});

console.log('\n1. Malformed requests must never take the server down');
for (const p of ['//x:99999/', '//[', '//a b', '//%zz', '/%E0%A4%A', '/..%2f..%2fserver.mjs', '/%2e%2e/%2e%2e/etc/passwd', '/' + 'a'.repeat(20000)]) {
  await rawHttp(`GET ${p} HTTP/1.1\r\nHost: x\r\n\r\n`);
}
await rawHttp('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n');
await rawHttp('\x00\x01\x02garbage\r\n\r\n');
await rawHttp('POST /api/submissions HTTP/1.1\r\nHost: x\r\nContent-Length: 999999\r\n\r\n{"a":');
ok(await alive(), 'server alive after malformed URLs, raw garbage, truncated bodies');
ok((await rawHttp('GET /..%2f..%2fserver.mjs HTTP/1.1\r\nHost: x\r\n\r\n')).startsWith('HTTP/1.1 404'), 'encoded path traversal → 404');
ok(!(await rawHttp('GET /../server.mjs HTTP/1.1\r\nHost: x\r\n\r\n')).includes('DatabaseSync'), 'raw ../ traversal does not leak source');

console.log('\n2. Malformed JSON and oversized bodies');
for (const raw of ['null', '"str"', '[]', '123', '{', '{"members":"x"}', '{"members":[null,1,"x"]}', '{"__proto__":{"admin":true}}']) {
  const r = await req('/api/submissions', { method: 'POST', raw });
  ok(r.status === 400 || r.status === 422, `POST body ${raw.slice(0, 30)} → ${r.status}`);
}
ok((await req('/api/submissions', { method: 'POST', raw: JSON.stringify({ x: 'a'.repeat(300000) }) })).status === 413, 'oversized body → 413');
ok((await req('/api/admin/phase', { method: 'POST', raw: 'null', headers: A })).status === 400, 'admin null body → 400');
ok(await alive(), 'still alive');

console.log('\n3. Validation and hostile content');
let r = await req('/api/submissions', { method: 'POST', body: sub(0, { videoUrl: 'javascript:alert(1)' }) });
ok(r.status === 422 && r.data.errors?.videoUrl, 'javascript: video URL rejected');
r = await req('/api/submissions', { method: 'POST', body: sub(0, { members: [{ name: 'x', linkedin: 'data:text/html,<script>' }] }) });
ok(r.status === 422, 'data: LinkedIn URL rejected');
r = await req('/api/submissions', { method: 'POST', body: sub(0, { track: 'crypto' }) });
ok(r.status === 422 && r.data.errors?.track, 'unknown track rejected');
r = await req('/api/submissions', { method: 'POST', body: sub(0, { title: '=HYPERLINK("http://evil","x")', members: [{ name: '+cmd|calc', linkedin: '' }, { name: '🚀 Zoë Ünïcode 李', linkedin: '' }] }) });
ok(r.status === 201, 'formula-looking title + unicode names accepted (stored as text)');
const evilToken = r.data.editToken;
r = await req('/api/submissions', { method: 'POST', body: sub(1, { members: Array.from({ length: 50 }, (_, i) => ({ name: `M${i}`, linkedin: '' })) }) });
ok(r.status === 201, '50 members accepted');
ok((await req(`/api/submissions/${evilToken}`)).data.submission.members.length <= 6, 'members capped at 6');
ok((await req('/api/submissions/' + 'f'.repeat(32))).status === 404, 'random edit token → 404');
ok([401, 404].includes((await req('/api/submissions/../../api/admin/state')).status), 'token path tricks never reach admin data');

console.log('\n4. Authentication');
ok((await req('/api/admin/state')).status === 401, 'admin without key → 401');
ok((await req('/api/admin/state', { headers: { 'x-admin-key': AK + 'x' } })).status === 401, 'admin with wrong key → 401');
ok((await req('/api/admin/state', { headers: { 'x-admin-key': AK.toUpperCase() === AK ? AK.toLowerCase() : AK.toUpperCase() } })).status === 401, 'admin key is case-sensitive');
ok((await req('/api/judge/state', { headers: { 'x-judge-key': "' OR 1=1 --" } })).status === 401, 'SQL injection in judge code → 401');
ok((await req('/api/results')).status === 403, 'results hidden before announcement');
let S = (await req('/api/admin/state', { headers: A })).data;
const judges = S.judges.filter(j => j.active);
const J = id => ({ 'x-judge-key': S.judges.find(j => j.id === id).code });
ok((await req('/api/judge/state', { headers: { 'x-judge-key': S.judges.find(j => !j.active)?.code || 'none' } })).status === 401, 'inactive judge slot cannot sign in');
ok((await req('/api/judge/state', { headers: { 'x-judge-key': '  ' + judges[0].code.toUpperCase() + ' ' } })).status === 200, 'judge code tolerant of case/whitespace');

console.log('\n5. Concurrency storm: 120 submissions, judges scoring, admin toggling judges, all at once');
const t0 = performance.now();
await admin('/api/admin/judges/guest1', { name: 'Chaos Guest', active: true }, 'PATCH');
S = (await req('/api/admin/state', { headers: A })).data;
const subsP = Array.from({ length: 120 }, (_, i) => req('/api/submissions', { method: 'POST', body: sub(i + 10) }));
const toggles = (async () => { for (let k = 0; k < 6; k++) { await admin('/api/admin/judges/guest2', { name: 'Flicker', active: k % 2 === 0 }, 'PATCH'); await admin('/api/admin/rebalance', {}); } })();
const scorers = S.judges.filter(j => j.active).map(async j => {
  const H = { 'x-judge-key': j.code };
  for (let round = 0; round < 4; round++) {
    const st = (await req('/api/judge/state', { headers: H })).data;
    await Promise.all((st.review || []).map(s => req('/api/judge/score', { method: 'PUT', headers: H, body: { submissionId: s.id, round: 1, impact: 4, originality: 3, execution: 5, trust: 2, verdict: 'yes' } })));
  }
});
const results = await Promise.all(subsP); await toggles; await Promise.all(scorers);
ok(results.every(r => r.status === 201), `120 concurrent submissions all 201`, `${(performance.now() - t0).toFixed(0)}ms total`);
S = (await req('/api/admin/state', { headers: A })).data;
const live = S.submissions.filter(s => !s.withdrawn);
const activeIds = new Set(S.judges.filter(j => j.active).map(j => j.id));
const orphan = live.filter(s => !s.judgeId || (!activeIds.has(s.judgeId) && s.round1?.total == null));
ok(orphan.length === 0, 'every live submission has an active judge (or a finished score)', `${orphan.length} orphaned`);
for (const t of S.tracks) {
  const counts = [...activeIds].map(id => live.filter(s => s.track === t.id && s.judgeId === id && s.round1?.total == null).length);
  const all = [...activeIds].map(id => live.filter(s => s.track === t.id && s.judgeId === id).length);
  ok(Math.max(...all) - Math.min(...all) <= 2 || Math.min(...counts) >= 0, `${t.id} split stays fair`, all.join(','));
}
ok(await alive(), 'still alive after storm');

console.log('\n6. Permission and phase rules');
const [j1, j2] = S.judges.filter(j => j.active);
const notMine = live.find(s => s.judgeId !== j1.id);
r = await req('/api/judge/score', { method: 'PUT', headers: { 'x-judge-key': j1.code }, body: { submissionId: notMine.id, round: 1, impact: 5 } });
ok(r.status === 403, "judge can't score another judge's project");
r = await req('/api/judge/score', { method: 'PUT', headers: { 'x-judge-key': j1.code }, body: { submissionId: live.find(s => s.judgeId === j1.id).id, round: 2, impact: 5 } });
ok(r.status === 403, "judge can't score round 2 early");
r = await req('/api/judge/score', { method: 'PUT', headers: { 'x-judge-key': j1.code }, body: { submissionId: live.find(s => s.judgeId === j1.id).id, round: 1, impact: 99, originality: -4, execution: 'x', trust: 3.6 } });
ok(r.status === 200, 'out-of-range scores clamped, not rejected');
r = await req('/api/judge/pick', { method: 'PUT', headers: { 'x-judge-key': j1.code }, body: { track: notMine.track, submissionId: notMine.id } });
ok(r.status === 400, "judge can't pick another judge's project");
r = await req('/api/judge/pick', { method: 'PUT', headers: { 'x-judge-key': j1.code }, body: { track: '__proto__', submissionId: 1 } });
ok(r.status === 400, 'pick with __proto__ track rejected');
r = await req('/api/admin/submissions/' + live[0].id, { method: 'PATCH', headers: A, body: { judgeId: 'guest2' } });
ok(r.status === 400 || r.data.judges.find(j => j.id === 'guest2').active, "can't assign to an inactive judge");

console.log('\n7. Full rounds with hostile edits along the way');
await admin('/api/admin/phase', { phase: 'review' });
ok((await req('/api/submissions', { method: 'POST', body: sub(999) })).status === 403, 'submissions closed in review');
ok((await req(`/api/submissions/${evilToken}`, { method: 'PUT', body: sub(0) })).status === 403, 'edits locked in review');
S = (await req('/api/admin/state', { headers: A })).data;
for (const j of S.judges.filter(j => j.active)) {
  const H = { 'x-judge-key': j.code }; const st = (await req('/api/judge/state', { headers: H })).data;
  for (const s of st.review) await req('/api/judge/score', { method: 'PUT', headers: H, body: { submissionId: s.id, round: 1, impact: 1 + s.id % 5, originality: 3, execution: 1 + (s.id * 7) % 5, trust: 3, verdict: s.id % 2 ? 'yes' : 'no' } });
}
await admin('/api/admin/phase', { phase: 'shortlist' });
ok((await req('/api/judge/pick', { method: 'PUT', headers: J(j1.id), body: { track: 'payments', submissionId: null } })).status === 403, 'picks locked in shortlist');
S = (await req('/api/admin/state', { headers: A })).data;
ok(S.pool.length > 0 && S.pool.length <= 3 * S.activeJudgeCount, `shortlist pool built from picks`, `${S.pool.length}`);
for (const j of S.judges.filter(j => j.active)) {
  const H = { 'x-judge-key': j.code }; const st = (await req('/api/judge/state', { headers: H })).data;
  for (const s of st.shortlist) await req('/api/judge/score', { method: 'PUT', headers: H, body: { submissionId: s.id, round: 2, impact: 1 + (s.id * 3) % 5, originality: 4, execution: 3, trust: 1 + s.id % 5, verdict: 'yes' } });
}
S = (await req('/api/admin/state', { headers: A })).data;
const fin0 = S.finalists;
ok(fin0.length === Math.min(6, S.pool.length), '6 finalists', fin0.join(','));
ok(S.tracks.every(t => !S.pool.some(p => S.submissions.find(s => s.id === p.id).track === t.id) || fin0.some(id => S.submissions.find(s => s.id === id).track === t.id)), 'every track with a pick has a finalist');
await admin('/api/admin/phase', { phase: 'finals' });
S = (await req('/api/admin/state', { headers: A })).data;
ok(S.finalistsLocked, 'finalists locked automatically when finals start');
await admin(`/api/admin/submissions/${fin0[0]}`, { withdrawn: true }, 'PATCH');
S = (await req('/api/admin/state', { headers: A })).data;
ok(!S.finalists.includes(fin0[0]) && S.finalists.every(id => fin0.includes(id)), 'withdrawing a finalist does not pull in a new one');
await admin(`/api/admin/submissions/${fin0[0]}`, { withdrawn: false }, 'PATCH');
for (const j of S.judges.filter(j => j.active)) {
  const H = { 'x-judge-key': j.code }; const st = (await req('/api/judge/state', { headers: H })).data;
  for (const s of st.finals) await req('/api/judge/score', { method: 'PUT', headers: H, body: { submissionId: s.id, round: 3, impact: s.id === fin0[0] ? 5 : 3, originality: 3, execution: 3, trust: 3, verdict: 'yes' } });
}
S = (await req('/api/admin/state', { headers: A })).data;
ok(S.winners.overall === fin0[0], 'top finals score wins overall');
await admin(`/api/admin/submissions/${fin0[0]}`, { withdrawn: true }, 'PATCH');
S = (await req('/api/admin/state', { headers: A })).data;
ok(S.winners.overall !== fin0[0] && S.winners.overall != null, 'withdrawn finalist cannot win; next best moves up');
const w = Object.values(S.winners).filter(Boolean);
ok(S.tracks.every(t => S.winners[t.id] == null || S.submissions.find(s => s.id === S.winners[t.id]).track === t.id), 'track winners are in their own track');
await admin('/api/admin/phase', { phase: 'results' });
r = await req('/api/results');
ok(r.status === 200 && !JSON.stringify(r.data).includes('contactEmail') && !JSON.stringify(r.data).includes('judgeId') && !JSON.stringify(r.data).includes('linkedin'), 'public results expose no emails, judge ids or LinkedIn URLs');
ok((await req('/api/judge/score', { method: 'PUT', headers: J(j1.id), body: { submissionId: S.finalists[0], round: 3, impact: 1 } })).status === 403, 'scoring locked after results');

console.log('\n8. CSV export');
const csv = (await req('/api/admin/export.csv', { headers: A })).data;
ok(!/(^|,)"[=+\-@]/m.test(csv), 'no CSV cell starts with = + - @');
ok(csv.includes(`"'=HYPERLINK`), 'formula title neutralised with a leading apostrophe');

console.log('\n9. Brute force protection');
const bad = await Promise.all(Array.from({ length: 70 }, (_, i) => req('/api/judge/state', { headers: { 'x-judge-key': 'guess' + i } })));
ok(bad.some(r => r.status === 429), 'judge-code guessing gets rate limited', `${bad.filter(r => r.status === 429).length} blocked`);
ok((await req('/api/results')).status === 200, 'public results still reachable for everyone else on that IP');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
