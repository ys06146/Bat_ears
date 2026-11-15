// Session drift of the auth.js style features on the existing collection sessions (same person + same laptop, many
// sittings): per gesture event (CSV 'gesture' column) BatAuth.segment on frames {t, v, a} -> peak, dur, tPeak.
// Compares the spread inside a session with the shift between sessions, for absolute and within-attempt-relative cues.
//   node drift.js
const fs = require('fs');
const A = require('../../web/auth.js');
const D = (process.env.DATA || require('path').join(__dirname, '../../ml/data')) + '/';
const sessions = fs.readdirSync(D).filter((f) => /^batears_2026\d{4}_\d{6}_.*\.json$/.test(f)).map((f) => f.replace(/\.json$/, ''));
const mean = (x) => x.reduce((s, v) => s + v, 0) / Math.max(1, x.length);
const sd = (x) => { const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, x.length - 1)); };
const rows = [];
for (const s of sessions) {
  if (!fs.existsSync(D + s + '.csv')) continue;
  const meta = JSON.parse(fs.readFileSync(D + s + '.json', 'utf8'));
  const lines = fs.readFileSync(D + s + '.csv', 'utf8').trim().split(/\r?\n/), h = lines[0].split(','), ix = Object.fromEntries(h.map((k, i) => [k, i]));
  const fr = [], ev = [], cues = [];
  for (const l of lines.slice(1)) {
    const r = l.split(','), t = Number(r[ix.t_ms]);
    const v = Number(r[ix.v_mps]), a = Math.max(Number(r[ix.dUp_db]), Number(r[ix.dDown_db]));
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    fr.push({ t, v, a: Number.isFinite(a) ? a : 0 });
    const g = r[ix.gesture]; if (g && g !== 'idle' && g !== '') ev.push({ t, kind: g });
    if (r[ix.cue]) cues.push(t);
  }
  const tr = meta.trials || [];
  for (const e of ev) {
    const q = tr.find((x) => e.t >= x.tStart && e.t <= x.tEnd);
    if (!q || q.kind !== e.kind || !['push', 'pull'].includes(e.kind)) continue;   // only correctly detected push / pull
    const seg = A.segment(fr, e.t, { lo: q.tStart, hi: q.tEnd });
    const cue = cues.find((c) => c >= q.tStart && c <= q.tEnd);
    if (seg) rows.push({ s, who: meta.who, dev: meta.device || s.split('_').pop(), dist: meta.dist, kind: e.kind, lp: Math.log(seg.peak), dur: seg.dur, tPeak: seg.tPeak, on: cue != null ? seg.t0 - cue : NaN, pk: cue != null ? seg.t0 + seg.tPeak * seg.dur - cue : NaN, lead: seg.tPeak * seg.dur });
  }
}
// group = person + laptop; only groups with >= 3 sessions
const groups = {};
for (const r of rows) (groups[r.who + '/' + r.dev] ||= {})[r.s] ||= [], groups[r.who + '/' + r.dev][r.s].push(r);
for (const [g, ss] of Object.entries(groups)) {
  const names = Object.keys(ss).filter((n) => ss[n].filter((r) => r.kind === 'push').length >= 2 && ss[n].filter((r) => r.kind === 'pull').length >= 2);
  if (names.length < 3) continue;
  console.log(`\n${g}: ${names.length} sessions (${names.map((n) => ss[n][0].dist + 'cm').join(' ')}), ${names.reduce((s, n) => s + ss[n].length, 0)} push/pull events`);
  const feats = {
    'log peak push': (x) => x.filter((r) => r.kind === 'push').map((r) => r.lp),
    'log peak pull': (x) => x.filter((r) => r.kind === 'pull').map((r) => r.lp),
    'dur push (ms)': (x) => x.filter((r) => r.kind === 'push').map((r) => r.dur),
    'dur pull (ms)': (x) => x.filter((r) => r.kind === 'pull').map((r) => r.dur),
    'tPeak push': (x) => x.filter((r) => r.kind === 'push').map((r) => r.tPeak),
    'onset-cue ms': (x) => x.map((r) => r.on).filter(Number.isFinite),
    'peak-cue ms': (x) => x.map((r) => r.pk).filter(Number.isFinite),
    'lead push ms': (x) => x.filter((r) => r.kind === 'push').map((r) => r.lead),
    'lead pull ms': (x) => x.filter((r) => r.kind === 'pull').map((r) => r.lead),
  };
  // relative cue: pull vs push in the same session (an attempt's own gestures), as a difference of session means
  for (const [nm, f] of Object.entries(feats)) {
    const within = mean(names.map((n) => sd(f(ss[n])))), means = names.map((n) => mean(f(ss[n])));
    console.log(`  ${nm.padEnd(15)} within-session sd ${within.toFixed(3)}  session means ${means.map((m) => m.toFixed(2)).join(' ')}  between sd ${sd(means).toFixed(3)}  => drift/within ${(sd(means) / within).toFixed(2)}`);
  }
  const rel = (n, key) => mean(ss[n].filter((r) => r.kind === 'pull').map((r) => r[key])) - mean(ss[n].filter((r) => r.kind === 'push').map((r) => r[key]));
  const relDur = (n) => Math.log(mean(ss[n].filter((r) => r.kind === 'pull').map((r) => r.dur)) / mean(ss[n].filter((r) => r.kind === 'push').map((r) => r.dur)));
  // within-session spread of a single pair difference ~ sqrt(sd_pull^2 + sd_push^2)
  const wPair = (key) => mean(names.map((n) => Math.hypot(sd(ss[n].filter((r) => r.kind === 'pull').map((r) => r[key])), sd(ss[n].filter((r) => r.kind === 'push').map((r) => r[key])))));
  const rl = names.map((n) => rel(n, 'lp')), rd = names.map(relDur);
  const wDurRel = mean(names.map((n) => Math.hypot(...['pull', 'push'].map((k) => { const d = ss[n].filter((r) => r.kind === k).map((r) => r.dur); return sd(d) / mean(d); }))));
  console.log(`  rel log peak pull-push  pair sd ${wPair('lp').toFixed(3)}  session means ${rl.map((m) => m.toFixed(2)).join(' ')}  between sd ${sd(rl).toFixed(3)}  => drift/within ${(sd(rl) / wPair('lp')).toFixed(2)}`);
  console.log(`  rel log dur  pull/push  pair sd ${wDurRel.toFixed(3)}  session means ${rd.map((m) => m.toFixed(2)).join(' ')}  between sd ${sd(rd).toFixed(3)}  => drift/within ${(sd(rd) / wDurRel).toFixed(2)}`);
}
