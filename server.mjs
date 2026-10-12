// Fintech Hackathon: landing page, submission portal, judging portal and admin console.
// Zero dependencies: node:http + node:sqlite (Node 22.13+).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'hackathon.db');
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin-local';
if (!process.env.ADMIN_KEY) console.warn('ADMIN_KEY not set, using "admin-local" (fine locally, set it in production)');

export const TRACKS = [
  { id: 'payments', name: 'Payments' },
  { id: 'access', name: 'Access to finance' },
  { id: 'fraud', name: 'Fraud and security' },
];
export const CRITERIA = [
  { id: 'impact', name: 'Real-world impact', weight: 30, hint: 'Who needs this, and what would it improve for them?' },
  { id: 'originality', name: 'Originality', weight: 25, hint: 'What makes the approach different and better?' },
  { id: 'execution', name: 'Execution & craft', weight: 25, hint: 'Does the main task work from start to finish?' },
  { id: 'trust', name: 'Trust & responsibility', weight: 20, hint: 'What could go wrong, and how are users protected?' },
];
const JUDGES = [
  { id: 'nuan', name: 'Nuan Zhang', org: 'Episode 1' },
  { id: 'till', name: 'Till Tornieporth', org: 'Verdane' },
  { id: 'anna', name: 'Anna Zverkova', org: 'Experian' },
  { id: 'luka', name: 'Luka Dadiani', org: 'Howden HX' },
  // Optional slots: off until an organiser names and switches them on in /admin.
  { id: 'guest1', name: 'Guest judge 1', org: '', optional: true },
  { id: 'guest2', name: 'Guest judge 2', org: '', optional: true },
];
const PHASES = ['submissions', 'review', 'shortlist', 'finals', 'results'];
const FINALIST_COUNT = 6;

// ---------- database ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, track TEXT NOT NULL, tagline TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    team_name TEXT NOT NULL DEFAULT '', members TEXT NOT NULL DEFAULT '[]',
    video_url TEXT NOT NULL DEFAULT '', demo_url TEXT NOT NULL DEFAULT '', contact_email TEXT NOT NULL DEFAULT '',
    edit_token TEXT NOT NULL UNIQUE, judge_id TEXT, withdrawn INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS judges (id TEXT PRIMARY KEY, name TEXT NOT NULL, org TEXT NOT NULL, code TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS scores (
    judge_id TEXT NOT NULL, submission_id INTEGER NOT NULL, round INTEGER NOT NULL,
    impact INTEGER, originality INTEGER, execution INTEGER, trust INTEGER,
    verdict TEXT, note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
    PRIMARY KEY (judge_id, submission_id, round)
  );
  CREATE TABLE IF NOT EXISTS picks (judge_id TEXT NOT NULL, track TEXT NOT NULL, submission_id INTEGER NOT NULL, PRIMARY KEY (judge_id, track));
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
if (!db.prepare("SELECT 1 FROM pragma_table_info('judges') WHERE name = 'active'").get()) db.exec('ALTER TABLE judges ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
const codeFor = () => crypto.randomBytes(4).toString('hex');
JUDGES.forEach((j, i) => {
  const envCode = process.env[`JUDGE_CODE_${j.id.toUpperCase()}`]?.trim().toLowerCase();
  const row = db.prepare('SELECT code FROM judges WHERE id = ?').get(j.id);
  if (!row) db.prepare('INSERT INTO judges (id, name, org, code, sort, active) VALUES (?, ?, ?, ?, ?, ?)').run(j.id, j.name, j.org, envCode || codeFor(), i, j.optional ? 0 : 1);
  else {
    if (j.optional) db.prepare('UPDATE judges SET sort = ? WHERE id = ?').run(i, j.id); // organisers rename these
    else db.prepare('UPDATE judges SET name = ?, org = ?, sort = ? WHERE id = ?').run(j.name, j.org, i, j.id);
    if (envCode && envCode !== row.code) db.prepare('UPDATE judges SET code = ? WHERE id = ?').run(envCode, j.id);
  }
});

const getSetting = (key, fallback) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
};
const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
const phase = () => getSetting('phase', 'submissions');
const submissionsOpen = () => getSetting('submissionsOpen', true);
const now = () => new Date().toISOString();

// ---------- domain helpers ----------
const judges = () => db.prepare('SELECT id, name, org, code, active FROM judges ORDER BY sort').all()
  .map(j => ({ ...j, active: !!j.active, optional: !!JUDGES.find(x => x.id === j.id)?.optional }));
const activeJudges = () => judges().filter(j => j.active);
const findJudge = code => (code ? db.prepare('SELECT id, name, org FROM judges WHERE code = ? AND active = 1').get(String(code).trim().toLowerCase()) : null);

function rowToSubmission(r, { includePrivate = false } = {}) {
  if (!r) return null;
  const s = {
    id: r.id, title: r.title, track: r.track, tagline: r.tagline, description: r.description, teamName: r.team_name,
    members: JSON.parse(r.members || '[]'), videoUrl: r.video_url, demoUrl: r.demo_url, judgeId: r.judge_id,
    withdrawn: !!r.withdrawn, createdAt: r.created_at, updatedAt: r.updated_at,
  };
  if (includePrivate) s.contactEmail = r.contact_email;
  return s;
}
const activeSubmissions = () => db.prepare('SELECT * FROM submissions WHERE withdrawn = 0 ORDER BY id').all().map(r => rowToSubmission(r));
const submissionById = id => rowToSubmission(db.prepare('SELECT * FROM submissions WHERE id = ?').get(Number(id)));

export const weighted = s => {
  if (!s || CRITERIA.some(c => !s[c.id])) return null;
  return Math.round(CRITERIA.reduce((sum, c) => sum + (s[c.id] / 5) * c.weight, 0) * 10) / 10;
};
const scoreRow = r => r && ({
  submissionId: r.submission_id, judgeId: r.judge_id, round: r.round, impact: r.impact, originality: r.originality,
  execution: r.execution, trust: r.trust, verdict: r.verdict, note: r.note, total: weighted(r), updatedAt: r.updated_at,
});
const scoresFor = round => db.prepare('SELECT * FROM scores WHERE round = ?').all(round).map(scoreRow);

// Balanced assignment: the judge with fewest entries in this track, then fewest overall.
function pickJudgeFor(track) {
  const load = db.prepare(`SELECT j.id,
      (SELECT COUNT(*) FROM submissions s WHERE s.judge_id = j.id AND s.withdrawn = 0 AND s.track = ?) AS inTrack,
      (SELECT COUNT(*) FROM submissions s WHERE s.judge_id = j.id AND s.withdrawn = 0) AS total
    FROM judges j WHERE j.active = 1 ORDER BY j.sort`).all(track);
  load.sort((a, b) => a.inTrack - b.inTrack || a.total - b.total);
  return load[0]?.id || null;
}
// Re-split after judges join or leave. Projects a judge has already scored stay with them; only unscored ones move,
// and only as far as needed to even out each track across the active judges.
function rebalance() {
  const active = new Set(activeJudges().map(j => j.id));
  if (!active.size) return;
  const scored = new Set(scoresFor(1).filter(r => r.total != null).map(r => `${r.judgeId}:${r.submissionId}`));
  const isScored = s => scored.has(`${s.judgeId}:${s.id}`);
  const move = (id, judgeId) => db.prepare('UPDATE submissions SET judge_id = ? WHERE id = ?').run(judgeId, id);
  for (const s of activeSubmissions()) if (s.judgeId && !active.has(s.judgeId) && !isScored(s)) move(s.id, null);
  assignUnassigned();
  for (const t of TRACKS) {
    for (let guard = 0; guard < 500; guard++) {
      const subs = activeSubmissions().filter(s => s.track === t.id);
      const load = [...active].map(id => ({ id, n: subs.filter(s => s.judgeId === id).length }));
      load.sort((a, b) => a.n - b.n);
      const lo = load[0];
      const donor = [...load].reverse().find(h => h.n - lo.n > 1 && subs.some(s => s.judgeId === h.id && !isScored(s)));
      if (!donor) break;
      move(subs.filter(s => s.judgeId === donor.id && !isScored(s)).pop().id, lo.id);
    }
  }
  // Then even out totals: move an unscored project from the busiest judge to the quietest, from a track where
  // that keeps the per-track split within one.
  for (let guard = 0; guard < 500; guard++) {
    const subs = activeSubmissions();
    const load = [...active].map(id => ({ id, n: subs.filter(s => s.judgeId === id).length })).sort((a, b) => a.n - b.n);
    const lo = load[0];
    const inTrack = (id, t) => subs.filter(s => s.judgeId === id && s.track === t).length;
    let moved = false;
    for (const hi of [...load].reverse()) {
      if (hi.n - lo.n <= 1) break;
      const cand = subs.filter(s => s.judgeId === hi.id && !isScored(s) && inTrack(lo.id, s.track) < inTrack(hi.id, s.track)).pop();
      if (cand) { move(cand.id, lo.id); moved = true; break; }
    }
    if (!moved) break;
  }
}
function assignUnassigned() {
  for (const s of activeSubmissions().filter(s => !s.judgeId)) db.prepare('UPDATE submissions SET judge_id = ? WHERE id = ?').run(pickJudgeFor(s.track), s.id);
}

// A judge's pick per track: their explicit choice, or (if they never chose) their best-scored project there.
function effectivePicks() {
  const subs = activeSubmissions();
  const live = new Map(subs.map(s => [s.id, s]));
  const explicit = db.prepare('SELECT judge_id, track, submission_id FROM picks').all();
  const r1 = scoresFor(1).filter(s => s.total != null);
  const out = [];
  for (const j of judges()) for (const t of TRACKS) { // includes judges who left after scoring
    const e = explicit.find(p => p.judge_id === j.id && p.track === t.id);
    const es = e && live.get(e.submission_id);
    if (es && es.judgeId === j.id && es.track === t.id) { out.push({ judgeId: j.id, track: t.id, submissionId: e.submission_id, auto: false }); continue; }
    const best = r1.filter(s => s.judgeId === j.id && live.get(s.submissionId)?.judgeId === j.id && live.get(s.submissionId)?.track === t.id)
      .sort((a, b) => (b.verdict === 'yes') - (a.verdict === 'yes') || b.total - a.total)[0];
    if (best) out.push({ judgeId: j.id, track: t.id, submissionId: best.submissionId, auto: true });
  }
  return out;
}
// Round 2 pool = every judge's round 1 picks.
const poolIds = () => [...new Set(effectivePicks().map(p => p.submissionId))];

function aggregate(round, ids) {
  const scores = scoresFor(round);
  return ids.map(id => {
    const mine = scores.filter(s => s.submissionId === id && s.total != null);
    const avg = mine.length ? Math.round((mine.reduce((a, s) => a + s.total, 0) / mine.length) * 10) / 10 : null;
    return { id, avg, count: mine.length, yes: mine.filter(s => s.verdict === 'yes').length, scores: mine };
  });
}
const byScore = (a, b) => (b.avg ?? -1) - (a.avg ?? -1) || b.yes - a.yes || a.id - b.id;

// Top 6, but every track that has a pick gets at least one finalist.
function suggestedFinalists() {
  const subs = new Map(activeSubmissions().map(s => [s.id, s]));
  const ranked = aggregate(2, poolIds()).sort(byScore);
  const chosen = [];
  for (const t of TRACKS) {
    const best = ranked.find(r => subs.get(r.id)?.track === t.id);
    if (best) chosen.push(best.id);
  }
  for (const r of ranked) if (chosen.length < FINALIST_COUNT && !chosen.includes(r.id)) chosen.push(r.id);
  return chosen;
}
const finalists = () => {
  const live = new Set(activeSubmissions().map(s => s.id));
  return (getSetting('finalists', null) || suggestedFinalists()).filter(id => live.has(id));
};

// Overall winner = best finals score; each track winner = best in track, excluding the overall winner where possible.
function suggestedWinners() {
  const subs = new Map(activeSubmissions().map(s => [s.id, s]));
  const ranked = aggregate(3, finalists()).filter(r => r.avg != null).sort(byScore);
  const overall = ranked[0]?.id ?? null;
  const winners = { overall };
  for (const t of TRACKS) {
    const inTrack = ranked.filter(r => subs.get(r.id)?.track === t.id);
    winners[t.id] = (inTrack.find(r => r.id !== overall) || inTrack[0])?.id ?? null;
  }
  return winners;
}
const winners = () => ({ ...suggestedWinners(), ...(getSetting('winners', null) || {}) });

// ---------- validation ----------
const clean = (v, max) => String(v ?? '').replace(/\s+$/g, '').trim().slice(0, max);
const isUrl = v => { try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } };
function validateSubmission(body) {
  const errors = {};
  const out = {
    title: clean(body.title, 90), track: clean(body.track, 20), tagline: clean(body.tagline, 160),
    description: clean(body.description, 2000), teamName: clean(body.teamName, 80),
    videoUrl: clean(body.videoUrl, 500), demoUrl: clean(body.demoUrl, 500), contactEmail: clean(body.contactEmail, 200),
    members: (Array.isArray(body.members) ? body.members : []).slice(0, 6)
      .map(m => ({ name: clean(m?.name, 80), linkedin: clean(m?.linkedin, 300) })).filter(m => m.name || m.linkedin),
  };
  if (!out.title) errors.title = 'Give your project a name.';
  if (!TRACKS.some(t => t.id === out.track)) errors.track = 'Choose a track.';
  if (!out.tagline) errors.tagline = 'Add a one-line summary.';
  if (!out.description) errors.description = 'Describe what you built and who it helps.';
  if (!out.members.length) errors.members = 'Add at least one team member.';
  out.members.forEach((m, i) => {
    if (!m.name) errors[`members.${i}.name`] = 'Add a name.';
    if (m.linkedin && !isUrl(m.linkedin)) errors[`members.${i}.linkedin`] = 'Use a full link starting with https://';
  });
  if (!isUrl(out.videoUrl)) errors.videoUrl = 'Add a Loom or YouTube link starting with https://';
  if (out.demoUrl && !isUrl(out.demoUrl)) errors.demoUrl = 'Use a full link starting with https://';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.contactEmail)) errors.contactEmail = 'Add an email so we can reach your team.';
  return { out, errors };
}
const clampScore = v => (v == null || v === '' ? null : Math.min(5, Math.max(1, Math.round(Number(v)))) || null);

// ---------- http plumbing ----------
class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const send = (res, status, body, headers = {}) => {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  let out = Buffer.from(isJson ? JSON.stringify(body) : body);
  const h = { 'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', vary: 'accept-encoding', ...headers };
  // Judge and admin payloads grow with every submission; gzip makes them ~10x smaller.
  if (out.length > 1024 && /\bgzip\b/.test(res.req?.headers['accept-encoding'] || '')) { out = zlib.gzipSync(out, { level: 6 }); h['content-encoding'] = 'gzip'; }
  h['content-length'] = out.length;
  res.writeHead(status, h);
  res.end(out);
};
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 200_000) throw new HttpError(413, 'Request too large'); chunks.push(c); }
  if (!chunks.length) return {};
  let v;
  try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Expected a JSON object');
  return v;
}
// Slow down code guessing (the venue shares one IP, so be generous): 60 failed judge/admin sign-ins per IP per 10 minutes.
const failures = new Map();
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function guardFailures(req) {
  const f = failures.get(clientIp(req));
  if (f && f.n >= 60 && Date.now() - f.t < 600_000) throw new HttpError(429, 'Too many wrong codes. Wait a few minutes and try again.');
}
function noteFailure(req) {
  const ip = clientIp(req), f = failures.get(ip);
  failures.set(ip, f && Date.now() - f.t < 600_000 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() });
  if (failures.size > 10_000) failures.clear();
}
const requireJudge = req => {
  guardFailures(req);
  const j = findJudge(req.headers['x-judge-key']);
  if (!j) { noteFailure(req); throw new HttpError(401, 'That judge code was not recognised.'); }
  return j;
};
const requireAdmin = req => {
  guardFailures(req);
  const a = crypto.createHash('sha256').update(String(req.headers['x-admin-key'] || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_KEY).digest();
  if (!crypto.timingSafeEqual(a, b)) { noteFailure(req); throw new HttpError(401, 'Wrong admin key.'); }
};

// ---------- judge state ----------
function judgeState(judge) {
  const ph = phase();
  const subs = activeSubmissions();
  const byId = new Map(subs.map(s => [s.id, s]));
  const myScores = round => new Map(db.prepare('SELECT * FROM scores WHERE judge_id = ? AND round = ?').all(judge.id, round).map(r => [r.submission_id, scoreRow(r)]));
  const r1 = myScores(1);
  const withScore = (list, scores) => list.map(s => ({ ...s, score: scores.get(s.id) || null }));
  const state = {
    judge, phase: ph, tracks: TRACKS, criteria: CRITERIA, finalistCount: FINALIST_COUNT,
    review: withScore(subs.filter(s => s.judgeId === judge.id), r1),
    picks: Object.fromEntries(db.prepare('SELECT track, submission_id FROM picks WHERE judge_id = ?').all(judge.id).map(r => [r.track, r.submission_id])),
  };
  if (ph === 'shortlist' || ph === 'finals' || ph === 'results') {
    const r2 = myScores(2);
    const pickers = effectivePicks();
    const names = new Map(judges().map(j => [j.id, j.name]));
    state.shortlist = withScore(poolIds().map(id => byId.get(id)), r2).map(s => ({
      ...s, pickedBy: pickers.filter(p => p.submissionId === s.id).map(p => p.judgeId === judge.id ? 'You' : names.get(p.judgeId)), round1: r1.get(s.id) || null,
    }));
  }
  if (ph === 'finals' || ph === 'results') state.finals = withScore(finalists().map(id => byId.get(id)).filter(Boolean), myScores(3));
  return state;
}

// ---------- admin state ----------
function adminState() {
  const subs = db.prepare('SELECT * FROM submissions ORDER BY id').all().map(r => rowToSubmission(r, { includePrivate: true }));
  const live = subs.filter(s => !s.withdrawn);
  const r1 = scoresFor(1);
  const picks = effectivePicks();
  const js = judges().map(j => {
    const mine = live.filter(s => s.judgeId === j.id);
    return {
      ...j, assigned: mine.length,
      reviewed: mine.filter(s => r1.some(x => x.judgeId === j.id && x.submissionId === s.id && x.total != null)).length,
      picks: Object.fromEntries(picks.filter(p => p.judgeId === j.id).map(p => [p.track, { id: p.submissionId, auto: p.auto }])),
      shortlistScored: scoresFor(2).filter(x => x.judgeId === j.id && x.total != null).length,
      finalsScored: scoresFor(3).filter(x => x.judgeId === j.id && x.total != null).length,
    };
  });
  return {
    phase: phase(), phases: PHASES, submissionsOpen: submissionsOpen(), tracks: TRACKS, criteria: CRITERIA, judges: js, activeJudgeCount: activeJudges().length,
    submissions: subs.map(({ description, ...s }) => ({ ...s, round1: r1.find(x => x.submissionId === s.id && x.judgeId === s.judgeId) || null })),
    pool: aggregate(2, poolIds()).sort(byScore),
    finalists: finalists(), finalistsLocked: !!getSetting('finalists', null), suggestedFinalists: suggestedFinalists(),
    finals: aggregate(3, finalists()).sort(byScore),
    winners: winners(), suggestedWinners: suggestedWinners(), winnersLocked: !!getSetting('winners', null),
  };
}

function csvExport() {
  const subs = db.prepare('SELECT * FROM submissions ORDER BY id').all().map(r => rowToSubmission(r, { includePrivate: true }));
  const agg = round => new Map(aggregate(round, subs.map(s => s.id)).map(a => [a.id, a]));
  const [a1, a2, a3] = [agg(1), agg(2), agg(3)];
  const fin = new Set(finalists()); const w = winners();
  const q = v => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; return `"${t.replace(/"/g, '""')}"`; };
  const head = ['id', 'title', 'track', 'team', 'members', 'video', 'demo', 'email', 'judge', 'round1', 'round2_avg', 'finals_avg', 'finalist', 'award', 'withdrawn'];
  const rows = subs.map(s => [s.id, s.title, s.track, s.teamName, s.members.map(m => `${m.name} ${m.linkedin}`).join('; '), s.videoUrl, s.demoUrl,
    s.contactEmail, s.judgeId, a1.get(s.id)?.avg, a2.get(s.id)?.avg, a3.get(s.id)?.avg, fin.has(s.id) ? 'yes' : '',
    Object.entries(w).filter(([, id]) => id === s.id).map(([k]) => k).join(' '), s.withdrawn ? 'yes' : '']);
  return [head, ...rows].map(r => r.map(q).join(',')).join('\n');
}

// ---------- routes ----------
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  let match;

  if (p === '/api/config' && m === 'GET') return send(res, 200, { phase: phase(), submissionsOpen: submissionsOpen(), tracks: TRACKS, criteria: CRITERIA });

  // Submissions (public)
  if (p === '/api/submissions' && m === 'POST') {
    if (!submissionsOpen()) throw new HttpError(403, 'Submissions are closed.');
    const { out, errors } = validateSubmission(await readJson(req));
    if (Object.keys(errors).length) throw new HttpError(422, 'Please check the highlighted fields.', { errors });
    const token = crypto.randomBytes(16).toString('hex');
    const t = now();
    const r = db.prepare(`INSERT INTO submissions (title, track, tagline, description, team_name, members, video_url, demo_url, contact_email, edit_token, judge_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(out.title, out.track, out.tagline, out.description, out.teamName, JSON.stringify(out.members),
      out.videoUrl, out.demoUrl, out.contactEmail, token, pickJudgeFor(out.track), t, t);
    return send(res, 201, { id: Number(r.lastInsertRowid), editToken: token });
  }
  if ((match = p.match(/^\/api\/submissions\/([a-f0-9]{32})$/))) {
    const row = db.prepare('SELECT * FROM submissions WHERE edit_token = ?').get(match[1]);
    if (!row) throw new HttpError(404, 'We could not find that submission.');
    if (m === 'GET') return send(res, 200, { submission: rowToSubmission(row, { includePrivate: true }), submissionsOpen: submissionsOpen() });
    if (m === 'PUT') {
      if (!submissionsOpen()) throw new HttpError(403, 'Submissions are closed, so edits are locked.');
      const { out, errors } = validateSubmission(await readJson(req));
      if (Object.keys(errors).length) throw new HttpError(422, 'Please check the highlighted fields.', { errors });
      const judgeId = out.track === row.track ? row.judge_id : pickJudgeFor(out.track);
      db.prepare(`UPDATE submissions SET title = ?, track = ?, tagline = ?, description = ?, team_name = ?, members = ?, video_url = ?, demo_url = ?, contact_email = ?, judge_id = ?, updated_at = ? WHERE id = ?`)
        .run(out.title, out.track, out.tagline, out.description, out.teamName, JSON.stringify(out.members), out.videoUrl, out.demoUrl, out.contactEmail, judgeId, now(), row.id);
      return send(res, 200, { ok: true });
    }
  }

  // Results (public once published)
  if (p === '/api/results' && m === 'GET') {
    const isAdmin = !!req.headers['x-admin-key'] && (() => { try { requireAdmin(req); return true; } catch { return false; } })();
    if (phase() !== 'results' && !isAdmin) throw new HttpError(403, 'Results have not been announced yet.');
    const pub = s => s && { id: s.id, title: s.title, track: s.track, tagline: s.tagline, teamName: s.teamName, members: s.members.map(m => ({ name: m.name })) };
    const byId = new Map(activeSubmissions().map(s => [s.id, pub(s)]));
    const w = winners();
    return send(res, 200, {
      tracks: TRACKS, finalists: finalists().map(id => byId.get(id)).filter(Boolean),
      winners: Object.fromEntries(Object.entries(w).map(([k, id]) => [k, byId.get(id) || null])),
    });
  }

  // Judges
  if (p === '/api/judge/state' && m === 'GET') return send(res, 200, judgeState(requireJudge(req)));
  if (p === '/api/judge/score' && m === 'PUT') {
    const j = requireJudge(req); const b = await readJson(req);
    const round = Number(b.round); const sid = Number(b.submissionId);
    const s = submissionById(sid);
    if (!s || s.withdrawn) throw new HttpError(404, 'That submission is no longer in the running.');
    const ph = phase();
    const allowed = round === 1 ? s.judgeId === j.id && ['submissions', 'review'].includes(ph)
      : round === 2 ? ph === 'shortlist' && poolIds().includes(sid)
      : round === 3 ? ph === 'finals' && finalists().includes(sid) : false;
    if (!allowed) throw new HttpError(403, 'This round is not open for scoring right now.');
    const v = ['yes', 'no'].includes(b.verdict) ? b.verdict : null;
    const sc = Object.fromEntries(CRITERIA.map(c => [c.id, clampScore(b[c.id])]));
    db.prepare(`INSERT INTO scores (judge_id, submission_id, round, impact, originality, execution, trust, verdict, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(judge_id, submission_id, round) DO UPDATE SET impact = excluded.impact, originality = excluded.originality, execution = excluded.execution,
      trust = excluded.trust, verdict = excluded.verdict, note = excluded.note, updated_at = excluded.updated_at`)
      .run(j.id, sid, round, sc.impact, sc.originality, sc.execution, sc.trust, v, clean(b.note, 1000), now());
    return send(res, 200, { ok: true, total: weighted(sc) });
  }
  if (p === '/api/judge/pick' && m === 'PUT') {
    const j = requireJudge(req); const b = await readJson(req);
    if (!['submissions', 'review'].includes(phase())) throw new HttpError(403, 'Top picks are locked now that the shortlist round has started.');
    if (!TRACKS.some(t => t.id === b.track)) throw new HttpError(400, 'Unknown track.');
    if (b.submissionId == null) { db.prepare('DELETE FROM picks WHERE judge_id = ? AND track = ?').run(j.id, b.track); return send(res, 200, { ok: true }); }
    const s = submissionById(b.submissionId);
    if (!s || s.withdrawn || s.judgeId !== j.id || s.track !== b.track) throw new HttpError(400, 'Pick a project from your own list in this track.');
    db.prepare('INSERT INTO picks (judge_id, track, submission_id) VALUES (?, ?, ?) ON CONFLICT(judge_id, track) DO UPDATE SET submission_id = excluded.submission_id').run(j.id, b.track, s.id);
    return send(res, 200, { ok: true });
  }

  // Admin
  if (p.startsWith('/api/admin/')) {
    requireAdmin(req);
    if (p === '/api/admin/state' && m === 'GET') return send(res, 200, adminState());
    if (p === '/api/admin/export.csv' && m === 'GET') return send(res, 200, csvExport(), { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="fintech-hackathon-results.csv"' });
    const b = m === 'GET' ? {} : await readJson(req);
    if (p === '/api/admin/phase' && m === 'POST') {
      if (!PHASES.includes(b.phase)) throw new HttpError(400, 'Unknown phase.');
      if (b.phase !== 'submissions') setSetting('submissionsOpen', false);
      if (b.phase === 'review') assignUnassigned();
      // Freeze the line-up once presentations start, so later edits can't swap a finalist in or out.
      if ((b.phase === 'finals' || b.phase === 'results') && !getSetting('finalists', null)) setSetting('finalists', suggestedFinalists());
      setSetting('phase', b.phase);
      return send(res, 200, adminState());
    }
    if (p === '/api/admin/submissions-open' && m === 'POST') { setSetting('submissionsOpen', !!b.open); return send(res, 200, adminState()); }
    if (p === '/api/admin/rebalance' && m === 'POST') { rebalance(); return send(res, 200, adminState()); }
    if ((match = p.match(/^\/api\/admin\/judges\/([a-z0-9]+)$/)) && m === 'PATCH') {
      const j = judges().find(x => x.id === match[1]);
      if (!j) throw new HttpError(404, 'Unknown judge.');
      if (j.optional && 'name' in b) db.prepare('UPDATE judges SET name = ? WHERE id = ?').run(clean(b.name, 60) || j.name, j.id);
      if (j.optional && 'org' in b) db.prepare('UPDATE judges SET org = ? WHERE id = ?').run(clean(b.org, 60), j.id);
      if ('active' in b && !!b.active !== j.active) {
        if (!b.active && activeJudges().length <= 1) throw new HttpError(400, 'At least one judge must stay active.');
        db.prepare('UPDATE judges SET active = ? WHERE id = ?').run(b.active ? 1 : 0, j.id);
        rebalance();
      }
      return send(res, 200, adminState());
    }
    if (p === '/api/admin/finalists' && m === 'POST') {
      if (b.ids === null) setSetting('finalists', null);
      else {
        const live = new Set(activeSubmissions().map(s => s.id));
        setSetting('finalists', [...new Set((b.ids || []).map(Number))].filter(id => live.has(id)));
      }
      return send(res, 200, adminState());
    }
    if (p === '/api/admin/winners' && m === 'POST') {
      if (b.winners === null) setSetting('winners', null);
      else setSetting('winners', Object.fromEntries(['overall', ...TRACKS.map(t => t.id)].map(k => [k, b.winners?.[k] == null ? null : Number(b.winners[k])])));
      return send(res, 200, adminState());
    }
    if (p === '/api/admin/submissions' && m === 'POST') {
      const { out, errors } = validateSubmission(b);
      if (Object.keys(errors).length) throw new HttpError(422, 'Please check the highlighted fields.', { errors });
      const t = now();
      db.prepare(`INSERT INTO submissions (title, track, tagline, description, team_name, members, video_url, demo_url, contact_email, edit_token, judge_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(out.title, out.track, out.tagline, out.description, out.teamName, JSON.stringify(out.members),
        out.videoUrl, out.demoUrl, out.contactEmail, crypto.randomBytes(16).toString('hex'), pickJudgeFor(out.track), t, t);
      return send(res, 201, adminState());
    }
    if ((match = p.match(/^\/api\/admin\/submissions\/(\d+)$/)) && m === 'PATCH') {
      const s = submissionById(match[1]);
      if (!s) throw new HttpError(404, 'Not found');
      if ('judgeId' in b) {
        if (b.judgeId && !activeJudges().some(j => j.id === b.judgeId)) throw new HttpError(400, 'Pick an active judge.');
        db.prepare('UPDATE submissions SET judge_id = ? WHERE id = ?').run(b.judgeId || null, s.id);
        db.prepare('DELETE FROM picks WHERE submission_id = ? AND judge_id != ?').run(s.id, b.judgeId || '');
      }
      if ('withdrawn' in b) db.prepare('UPDATE submissions SET withdrawn = ? WHERE id = ?').run(b.withdrawn ? 1 : 0, s.id);
      if ('track' in b && TRACKS.some(t => t.id === b.track)) {
        db.prepare('UPDATE submissions SET track = ? WHERE id = ?').run(b.track, s.id);
        db.prepare('DELETE FROM picks WHERE submission_id = ? AND track != ?').run(s.id, b.track);
      }
      if ('videoUrl' in b && isUrl(b.videoUrl)) db.prepare('UPDATE submissions SET video_url = ? WHERE id = ?').run(clean(b.videoUrl, 500), s.id);
      return send(res, 200, adminState());
    }
  }
  throw new HttpError(404, 'Not found');
}

const PAGES = { '/': 'index.html', '/submit': 'submit.html', '/judge': 'judge.html', '/admin': 'admin.html', '/results': 'results.html' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon' };
// Files are read once and kept in memory (gzipped where it helps): the whole site is under 1 MB.
const fileCache = new Map();
function loadFile(file) {
  let entry = fileCache.get(file);
  if (!entry) {
    const body = fs.readFileSync(file);
    const ext = path.extname(file);
    const gz = ['.html', '.css', '.js', '.svg'].includes(ext) ? zlib.gzipSync(body, { level: 9 }) : null;
    entry = { body, gz, ext, etag: `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16)}"` };
    fileCache.set(file, entry);
  }
  return entry;
}
function serveStatic(req, res, url) {
  let rel = PAGES[url.pathname.replace(/\/$/, '') || '/'];
  if (!rel) { try { rel = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { return send(res, 404, 'Not found'); } }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found');
  const { body, gz, ext, etag } = loadFile(file);
  const headers = {
    'content-type': TYPES[ext] || 'application/octet-stream', etag, vary: 'accept-encoding',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  const useGz = gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, { ...headers, ...(useGz ? { 'content-encoding': 'gzip' } : {}), 'content-length': (useGz ? gz : body).length });
  res.end(req.method === 'HEAD' ? undefined : useGz ? gz : body);
}

const server = http.createServer(async (req, res) => {
  try {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Bad request'); }
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (url.pathname === '/favicon.ico') { res.writeHead(301, { location: '/favicon.svg' }); return res.end(); }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...(err.extra || {}) });
    console.error(err);
    if (res.headersSent) return res.destroy();
    return send(res, 500, { error: 'Something went wrong on our side. Try again in a moment.' });
  }
});
process.on('unhandledRejection', err => console.error('unhandledRejection', err));
process.on('uncaughtException', err => console.error('uncaughtException', err));
server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); else socket.destroy(); });
server.keepAliveTimeout = 65_000; // longer than the Railway proxy idle timeout
server.listen({ port: PORT, backlog: 2048 }, () => {
  console.log(`Fintech Hackathon on http://localhost:${PORT}  (db: ${DB_PATH})`);
  if (!process.env.ADMIN_KEY) for (const j of activeJudges()) console.log(`  judge ${j.name}: /judge?k=${j.code}`);
});
