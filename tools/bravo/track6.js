// 3D from up to 3 tones (L 18k, R 19.5k, phone fP) x 2 mic channels on a WAV session with trial.tGo.
//   node track6.js <session base path or name after batears_>   env: PHONE "x,y,z" (m, phone speaker; omit = laptop only)
//     FP (Hz, default 20500), GEOM (json), WY (height prior, default 10 without phone / 0.02 with), AVG=0 (all 6 paths)
// Linear solve at H0 (x right, y up, z toward the screen). Per trial: PCA of the track -> plane normal, roundness
// (l2/l1), planarity (l3/l2); circles: winding in the best-fit plane (sign voted per session); push / pull trials: the
// height change (for the "push = up, pull = down" height test) and the toward-screen change.
const fs = require('fs');
const P = require('./phase.js'), PH = require('./phone.js'), BC = require('../../web/circle.js');
const D = (process.env.DATA || require('path').join(__dirname, '../../ml/data')) + '/batears_', BK = (process.env.WAV_BACKUP || '') + 'batears_';
const arg = process.argv[2];
const pick = (ext) => [arg + ext, D + arg + ext, BK + arg + ext].find((p) => fs.existsSync(p));
const meta = JSON.parse(fs.readFileSync(pick('.json'), 'utf8')), wav = P.readWav(pick('.wav'));
const F = meta.stereoPair || (meta.engine && meta.engine.stereoFreqs) || [18000, 19500];
const G = { SL: [-0.15, -0.01, -0.08], SR: [0.15, -0.01, -0.08], M: [[0.025, 0.19, 0.17], [-0.025, 0.19, 0.17]], ...(process.env.GEOM ? JSON.parse(process.env.GEOM) : {}) };
const PHONE = process.env.PHONE ? process.env.PHONE.split(',').map(Number) : null, FP = Number(process.env.FP || 20500);
const H0 = (process.env.H0 || '0,0.12,0').split(',').map(Number), gate = Number(process.env.GATE || 1.5);
const WY = Number(process.env.WY ?? (PHONE ? 0.02 : 10)), AVG = process.env.AVG !== '0';
const chans = wav.C > 1 ? [0, 1] : [0];
// path steps per source and channel
const src = [{ key: 'L', S: G.SL, f: F[0] }, { key: 'R', S: G.SR, f: F[1] }];
if (PHONE) src.push({ key: 'P', S: PHONE, f: FP, pll: true });
for (const s of src) s.st = chans.map((c) => (s.pll ? PH.pathStepsPLL : P.pathSteps)(P.baseband(wav.ch[c], wav.rate, s.f), s.f, { gate }));
const rate = src[0].st[0].rate, kOf = (t) => Math.floor((t - meta.wav.t0) / 1000 * rate);
const sub = (a, b) => a.map((v, i) => v - b[i]), nrm = (a) => Math.hypot(...a), unit = (a) => { const n = nrm(a) || 1; return a.map((v) => v / n); };
const Mc = G.M[0].map((v, i) => (v + G.M[1][i]) / 2);
// paths: AVG -> one per source to the mic midpoint (channels averaged), else one per source x channel
const paths = AVG ? src.map((s) => ({ s, ch: 'avg', M: Mc })) : src.flatMap((s) => chans.map((c) => ({ s, ch: c, M: G.M[c] })));
const J = paths.map((p) => { const a = unit(sub(H0, p.s.S)), b = unit(sub(H0, p.M)); return a.map((v, i) => v + b[i]); });
const PRIOR = [1e-3, WY, 1e-3];
const inv3 = (A) => { const [a, b, c] = A[0], [d, e, f] = A[1], [g, h, i] = A[2], det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [[(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det], [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det], [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]]; };
const JtJ = [0, 1, 2].map((i) => [0, 1, 2].map((j) => J.reduce((s, r) => s + r[i] * r[j], 0)));
const Ai = inv3(JtJ.map((r, i) => r.map((v, j) => v + (i === j ? PRIOR[i] : 0))));
const K = Ai.map((r) => J.map((_, n) => r.reduce((s, v, j) => s + v * J[n][j], 0)));
function eig3(S) {
  const A = S.map((r) => r.slice()), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 60; it++) for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
    if (Math.abs(A[p][q]) < 1e-18) continue;
    const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
    for (let k = 0; k < 3; k++) { const x = A[k][p], y = A[k][q]; A[k][p] = c * x - s * y; A[k][q] = s * x + c * y; }
    for (let k = 0; k < 3; k++) { const x = A[p][k], y = A[q][k]; A[p][k] = c * x - s * y; A[q][k] = s * x + c * y; }
    for (let k = 0; k < 3; k++) { const x = V[k][p], y = V[k][q]; V[k][p] = c * x - s * y; V[k][q] = s * x + c * y; }
  }
  const idx = [0, 1, 2].sort((i, j) => A[j][j] - A[i][i]);
  return { val: idx.map((i) => A[i][i]), vec: idx.map((i) => [V[0][i], V[1][i], V[2][i]]) };
}
const sv = eig3(JtJ).val.map((v) => Math.sqrt(Math.max(0, v)));
console.log(`${arg.split('/').pop()}: ${wav.C} ch, sources ${src.map((s) => s.key + ' ' + s.f).join(', ')}${PHONE ? ' at ' + PHONE : ''}; ${paths.length} paths; singular values ${sv.map((v) => v.toFixed(2)).join(' / ')}; height prior ${WY}`);
if (PHONE) { const o = src[2].st[0].offHz; console.log(`  phone clock offset (PLL): ${o[Math.floor(o.length * 0.25)].toFixed(2)} / ${o[Math.floor(o.length * 0.5)].toFixed(2)} / ${o[o.length - 1].toFixed(2)} Hz at 25 / 50 / 100 %`); }
const stepOf = (p, k) => (p.ch === 'avg' ? p.s.st.reduce((s, q) => s + (q.step[k] || 0), 0) / p.s.st.length : p.s.st[p.ch].step[k] || 0);
const isC = (k) => k === 'cw' || k === 'ccw';
const rows = meta.trials.filter((t) => Number.isFinite(t.tGo)).map((t) => {
  const k0 = kOf(t.tGo - 200), k1 = kOf(t.tGo + (isC(t.kind) ? 3000 : 1800)), Dm = paths.map(() => 0), track = [];
  for (let k = k0; k <= k1; k++) {
    paths.forEach((p, i) => { Dm[i] += stepOf(p, k); });
    if ((k - k0) % 10 === 0) track.push(H0.map((h, i) => h + K[i].reduce((s, v, n) => s + v * Dm[n], 0)));
  }
  const m = [0, 1, 2].map((i) => track.reduce((s, q) => s + q[i], 0) / track.length);
  const S = [0, 1, 2].map((i) => [0, 1, 2].map((j) => track.reduce((s, q) => s + (q[i] - m[i]) * (q[j] - m[j]), 0) / track.length));
  const e = eig3(S), [e1, e2, n] = e.vec;
  const pu = track.map((q) => sub(q, m).reduce((s, v, i) => s + v * e1[i], 0)), pv = track.map((q) => sub(q, m).reduce((s, v, i) => s + v * e2[i], 0));
  // orient the in-plane axes so the normal points up (horizontal) or toward the screen (vertical): winding sign comparable
  const nUp = Math.abs(n[1]) >= Math.abs(n[2]) ? Math.sign(n[1]) : Math.sign(n[2]);
  const w = BC.analyze(track.map((_, i) => 10 * i), pu, pv.map((v) => v * nUp));
  const ys = track.map((q) => q[1]), zs = track.map((q) => q[2]);
  const ext = (A) => { let best = 0; for (const v of A) if (Math.abs(v - A[0]) > Math.abs(best)) best = v - A[0]; return 100 * best; };
  return { kind: t.kind, n, round: e.val[1] / Math.max(1e-12, e.val[0]), planar: e.val[2] / Math.max(1e-12, e.val[1]), size: 200 * Math.sqrt(Math.max(0, e.val[0])), turns: w.turns, dy: ext(ys), dz: ext(zs) };
});
const med = (A) => { const x = A.slice().sort((a, b) => a - b); return x.length ? x[x.length >> 1] : NaN; };
const C = rows.filter((r) => isC(r.kind));
if (C.length) {
  const sg = Math.sign(C.reduce((s, r) => s + (r.kind === 'cw' ? 1 : -1) * r.turns, 0)) || 1, dir = (r) => (Math.sign(r.turns) * sg > 0 ? 'cw' : 'ccw');
  const firm = C.filter((r) => Math.abs(r.turns) >= 1.1);
  console.log(`circles: direction ${C.filter((r) => dir(r) === r.kind).length}/${C.length} (sign voted), |turns|>=1.1 ${firm.filter((r) => dir(r) === r.kind).length} right ${firm.filter((r) => dir(r) !== r.kind).length} wrong;` +
    ` size ${med(C.map((r) => r.size)).toFixed(1)} cm, roundness l2/l1 ${med(C.map((r) => r.round)).toFixed(2)}, planarity l3/l2 ${med(C.map((r) => r.planar)).toFixed(2)},` +
    ` plane normal |n.up| ${med(C.map((r) => Math.abs(r.n[1]))).toFixed(2)} |n.screen| ${med(C.map((r) => Math.abs(r.n[2]))).toFixed(2)} |n.side| ${med(C.map((r) => Math.abs(r.n[0]))).toFixed(2)}`);
}
for (const k of ['push', 'pull', 'up', 'down']) {
  const x = rows.filter((r) => r.kind === k); if (!x.length) continue;
  console.log(`${k.padEnd(4)} n${x.length}: height change [${x.map((r) => r.dy.toFixed(1)).join(' ')}] cm, toward-screen change [${x.map((r) => r.dz.toFixed(1)).join(' ')}] cm`);
}
