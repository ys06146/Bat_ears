// Live-style run of circle.js over a whole session: phase track from the WAV, CircleDetector.update every 100 ms on
// the last 3 s, fires attributed to the trial whose [tStart, tEnd] holds them.
//   node circle_scan.js <session base | name after batears_> ...      env: NEED (turns), VMIN, SPAN, SIGN
const fs = require('fs'), P = require('./phase.js'), BC = require('../../web/circle.js');
const D = (process.env.DATA || require('path').join(__dirname, '../../ml/data')) + '/', BK = (process.env.WAV_BACKUP || '') + '/';
const opt = { needTurns: Number(process.env.NEED || 1.1), vMin: Number(process.env.VMIN || 0.06), minSpanCm: Number(process.env.SPAN || 3), cwSign: Number(process.env.SIGN || 1) };
let tot = { c: 0, ok: 0, rev: 0, miss: 0, other: 0, fpOther: 0, fpIdle: 0, min: 0 };
for (const arg of process.argv.slice(2)) {
  const name = arg.split('/').pop().replace(/^batears_/, '');
  const pick = (ext) => [arg + ext, D + 'batears_' + name + ext, BK + 'batears_' + name + ext].find((p) => fs.existsSync(p));
  const meta = JSON.parse(fs.readFileSync(pick('.json'), 'utf8')), wp = pick('.wav');
  if (!wp) { console.log(name + ': no WAV'); continue; }
  const wav = P.readWav(wp), tr = P.track({ ...wav, ch: [wav.ch[0]], C: 1 }, meta.stereoPair || meta.engine.stereoFreqs, meta.wav.t0, { gate: 1.5 });
  // cumulative u, w on the 1 kHz grid
  const n = tr.L[0].step.length, T = new Float64Array(n), U = new Float64Array(n), W = new Float64Array(n);
  let u = 0, w = 0; for (let k = 0; k < n; k++) { const sL = tr.L[0].step[k], sR = tr.R[0].step[k]; u += (sR - sL) / 2; w += -(sR + sL) / 2; T[k] = tr.t0 + k / tr.rate * 1000; U[k] = u; W[k] = w; }
  const cd = new BC.CircleDetector(opt), fires = [];
  for (let now = T[0] + 3000; now < T[n - 1]; now += 100) {
    const k1 = Math.floor((now - tr.t0) / 1000 * tr.rate), k0 = Math.max(0, k1 - 3 * tr.rate), t = [], uu = [], ww = [];
    for (let k = k0; k <= k1; k += 10) { t.push(T[k]); uu.push(U[k]); ww.push(W[k]); }
    const ev = cd.update({ t, u: uu, w: ww }, now); if (ev) fires.push(ev);
  }
  const trials = (meta.trials || []).map((x) => ({ ...x, fires: [] }));
  let idle = 0;
  for (const f of fires) { const q = trials.find((x) => f.t >= x.tStart && f.t <= (x.tEnd || x.tStart + 4000) + 300); if (q) q.fires.push(f); else idle++; }
  const isC = (k) => k === 'cw' || k === 'ccw', r = { c: 0, ok: 0, rev: 0, miss: 0, other: 0, fpOther: 0 };
  for (const q of trials) {
    if (isC(q.kind)) { r.c++; const f = q.fires[0]; if (!f) r.miss++; else if (f.dir === q.kind) r.ok++; else r.rev++; }
    else { r.other++; if (q.fires.length) r.fpOther++; }
  }
  const mins = (T[n - 1] - T[0]) / 60000;
  const kinds = {}; trials.forEach((q) => { kinds[q.kind] = (kinds[q.kind] || 0) + 1; });
  console.log(`${name}: ${Object.entries(kinds).map(([k, v]) => k + ' ' + v).join(', ')} | ` + (r.c ? `circles right/reversed/missed ${r.ok}/${r.rev}/${r.miss} (${Math.round(100 * r.ok / r.c)}%) | ` : '') +
    `other gestures with a circle fire ${r.fpOther}/${r.other} | fires outside trials ${idle} in ${mins.toFixed(1)} min` + (process.env.V ? '\n  ' + fires.map((f) => `${((f.t - meta.wav.t0) / 1000).toFixed(1)}s ${f.dir} ${f.turns}t ${f.span}`).join('\n  ') : ''));
  for (const k of Object.keys(r)) tot[k] = (tot[k] || 0) + r[k]; tot.fpIdle += idle; tot.min += mins;
}
if (process.argv.length > 3) console.log(`total: circles ${tot.ok}/${tot.rev}/${tot.miss} of ${tot.c}, other gestures fired ${tot.fpOther}/${tot.other}, outside trials ${tot.fpIdle} in ${tot.min.toFixed(1)} min`);
