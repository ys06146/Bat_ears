// 3D from 4 paths (2 speaker tones x 2 mic channels) on a stereo-mic WAV session with trial.tGo (circle sessions).
//   node track4.js <session name after batears_>      env: GEOM (json override), H0 "x,y,z" (m)
// Frame: x right, y up, z toward the screen; origin = keyboard deck centre. Paths d_ij = |S_i - H| + |H - M_j|.
// Per trial: cumulative path changes D_ij(t) from the phase tracker -> Gauss-Newton for H(t) from H0 (least squares,
// 4 equations, 3 unknowns) -> PCA of the track: planarity (l3/l2), roundness (l2/l1), plane normal, winding in-plane.
const fs = require('fs');
const P = require('./phase.js'), BC = require('../../web/circle.js');
const D = (process.env.DATA || require('path').join(__dirname, '../../ml/data')) + '/batears_', BK = (process.env.WAV_BACKUP || '') + '/batears_';
const name = process.argv[2];
const pick = (ext) => [D + name + ext, BK + name + ext].find((p) => fs.existsSync(p));
const meta = JSON.parse(fs.readFileSync(pick('.json'), 'utf8')), wav = P.readWav(pick('.wav'));
const F = meta.stereoPair || meta.engine.stereoFreqs;
// Galaxy Book estimate: bottom-firing speakers near the front corners, a horizontal mic pair at the top bezel centre.
// ch0 = RIGHT mic: static carrier phase ch0-ch1 is -134 deg on the left speaker's tone and +129 deg on the right's,
// i.e. ch0 is farther from the left speaker and nearer the right one (chan.js).
const G = { SL: [-0.15, -0.01, -0.08], SR: [0.15, -0.01, -0.08], M: [[0.025, 0.19, 0.17], [-0.025, 0.19, 0.17]], ...(process.env.GEOM ? JSON.parse(process.env.GEOM) : {}) };
const H0 = (process.env.H0 || '0,0.12,0').split(',').map(Number);
const gate = Number(process.env.GATE || 1.5), WY = Number(process.env.WY || 0);
const PS = process.env.FIT ? require('./circfit.js').pathStepsFit : P.pathSteps;   // FIT=1: circle-fit static estimate
const tr = { L: [0, 1].map((c) => PS(P.baseband(wav.ch[c], wav.rate, F[0]), F[0], { gate })), R: [0, 1].map((c) => PS(P.baseband(wav.ch[c], wav.rate, F[1]), F[1], { gate })) };
const rate = tr.L[0].rate, t0 = meta.wav.t0, kOf = (t) => Math.floor((t - t0) / 1000 * rate);
const sub = (a, b) => a.map((v, i) => v - b[i]), nrm = (a) => Math.hypot(...a), unit = (a) => { const n = nrm(a); return a.map((v) => v / n); };
// AVG=1: average the two mic channels per tone -> 2 paths to the mic-pair midpoint (the observable part)
const Mc = G.M[0].map((v, i) => (v + G.M[1][i]) / 2);
for (const key of ['L', 'R']) { const a = tr[key][0].step, b = tr[key][1].step, s = new Float32Array(a.length); for (let k = 0; k < a.length; k++) s[k] = (a[k] + b[k]) / 2; tr[key][2] = { step: s }; }
const PATHS = process.env.AVG ? [['L', 2, G.SL, Mc], ['R', 2, G.SR, Mc]] : [['L', 0, G.SL, G.M[0]], ['L', 1, G.SL, G.M[1]], ['R', 0, G.SR, G.M[0]], ['R', 1, G.SR, G.M[1]]];
const dist = (H, S, M) => nrm(sub(H, S)) + nrm(sub(H, M));
const jac = (H) => PATHS.map(([, , S, M]) => { const a = unit(sub(H, S)), b = unit(sub(H, M)); return a.map((v, i) => v + b[i]); });
// 3x3 helpers
const solve3 = (A, b) => { const M = A.map((r, i) => [...r, b[i]]); for (let c = 0; c < 3; c++) { let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; for (let r = 0; r < 3; r++) if (r !== c) { const q = M[r][c] / M[c][c]; for (let j = c; j < 4; j++) M[r][j] -= q * M[c][j]; } } return M.map((r, i) => r[3] / r[i]); };
function eig3(S) {   // Jacobi, symmetric 3x3 -> { val (desc), vec (columns) }
  const A = S.map((r) => r.slice()), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 50; it++) for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
    if (Math.abs(A[p][q]) < 1e-15) continue;
    const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
    for (let k = 0; k < 3; k++) { const a = A[k][p], b = A[k][q]; A[k][p] = c * a - s * b; A[k][q] = s * a + c * b; }
    for (let k = 0; k < 3; k++) { const a = A[p][k], b = A[q][k]; A[p][k] = c * a - s * b; A[q][k] = s * a + c * b; }
    for (let k = 0; k < 3; k++) { const a = V[k][p], b = V[k][q]; V[k][p] = c * a - s * b; V[k][q] = s * a + c * b; }
  }
  const idx = [0, 1, 2].sort((i, j) => A[j][j] - A[i][i]);
  return { val: idx.map((i) => A[i][i]), vec: idx.map((i) => [V[0][i], V[1][i], V[2][i]]) };
}
// observability at H0: singular values of J (sqrt of eig of J^T J)
const J0 = jac(H0), JtJ = [0, 1, 2].map((i) => [0, 1, 2].map((j) => J0.reduce((s, r) => s + r[i] * r[j], 0)));
const ej = eig3(JtJ);
console.log(`${name}: geometry SL ${G.SL} SR ${G.SR} M0 ${G.M[0]} M1 ${G.M[1]}, H0 ${H0}`);
console.log(`Jacobian singular values at H0: ${ej.val.map((v) => Math.sqrt(Math.max(0, v)).toFixed(3)).join(' ')}  (weakest direction ${ej.vec[2].map((v) => v.toFixed(2))})`);
const rows = meta.trials.filter((t) => Number.isFinite(t.tGo)).map((t) => {
  const isC = t.kind === 'cw' || t.kind === 'ccw', k0 = kOf(t.tGo - 200), k1 = kOf(t.tGo + (isC ? 3000 : 1800));
  const Dc = [0, 0, 0, 0], track = [], cum = [[], [], [], []]; let H = H0.slice(), cc = [0, 0, 0, 0];
  const base = PATHS.map(([, , S, M]) => dist(H0, S, M));
  // per-tone channel agreement during the trial
  let sab = [0, 0], saa = [0, 0], sbb = [0, 0];
  for (let k = k0; k <= k1; k++) {
    PATHS.forEach(([key, c], i) => { Dc[i] += tr[key][c].step[k]; cum[i].push(Dc[i]); });
    ['L', 'R'].forEach((key, j) => { const a = tr[key][0].step[k], b = tr[key][1].step[k]; sab[j] += a * b; saa[j] += a * a; sbb[j] += b * b; });
    if ((k - k0) % 10) continue;
    for (let it = 0; it < 3; it++) {     // Gauss-Newton: J dH = D - (d(H) - d(H0))
      // LIN=1: linear solve with the Jacobian fixed at H0 (robust; the nonlinear one runs away on path drift)
      const J = process.env.LIN ? J0 : jac(H), r = PATHS.map(([, , S, M], i) => Dc[i] - (process.env.LIN ? J0[i].reduce((s, v, n) => s + v * (H[n] - H0[n]), 0) : dist(H, S, M) - base[i]));
      // + prior on the unobservable height: pseudo-measurement y = H0.y with weight WY (Tikhonov)
      const A = [0, 1, 2].map((i) => [0, 1, 2].map((j) => J.reduce((s, q) => s + q[i] * q[j], 0) + (i === j ? 1e-4 : 0) + (i === 1 && j === 1 ? WY : 0)));
      const b = [0, 1, 2].map((i) => J.reduce((s, q, n) => s + q[i] * r[n], 0) + (i === 1 ? WY * (H0[1] - H[1]) : 0));
      const dH = solve3(A, b); H = H.map((v, i) => v + dH[i]);
    }
    track.push(H.slice());
  }
  // PCA of the track
  const m = [0, 1, 2].map((i) => track.reduce((s, p) => s + p[i], 0) / track.length);
  const S = [0, 1, 2].map((i) => [0, 1, 2].map((j) => track.reduce((s, p) => s + (p[i] - m[i]) * (p[j] - m[j]), 0) / track.length));
  const e = eig3(S);
  const e1 = e.vec[0], e2 = e.vec[1], n = e.vec[2];
  const pu = track.map((p) => sub(p, m).reduce((s, v, i) => s + v * e1[i], 0)), pv = track.map((p) => sub(p, m).reduce((s, v, i) => s + v * e2[i], 0));
  const w = BC.analyze(track.map((_, i) => 10 * i), pu, pv);
  const xs = track.map((p) => p[0]), zs = track.map((p) => p[2]), ys = track.map((p) => p[1]);
  const wxz = BC.analyze(track.map((_, i) => 10 * i), xs, zs);
  const rg = (A) => 100 * (Math.max(...A) - Math.min(...A));
  return { kind: t.kind, planar: e.val[2] / Math.max(1e-12, e.val[1]), round: e.val[1] / Math.max(1e-12, e.val[0]), n, sizeCm: 200 * Math.sqrt(e.val[0]),
    chCorr: [0, 1].map((j) => sab[j] / Math.sqrt(saa[j] * sbb[j] || 1)), micDiff: [rg(sub(cum[0], cum[1])), rg(sub(cum[2], cum[3]))], spkSum: rg(cum[0].map((v, i) => (v + cum[2][i]) / 2)),
    turns: w.turns, nY: Math.abs(n[1]), txz: wxz.turns, rx: rg(xs), rz: rg(zs), ry: rg(ys),
    // closure: |end - start| / path length (a closed 1.5-turn circle ~0.1-0.2; a straight run 1)
    closure: (() => { let L = 0; for (let i = 1; i < track.length; i++) L += nrm(sub(track[i], track[i - 1])); return nrm(sub(track[track.length - 1], track[0])) / Math.max(1e-9, L); })() };
});
const med = (A) => { const x = A.slice().sort((a, b) => a - b); return x[x.length >> 1]; };
const Cs = rows.filter((r) => r.kind === 'cw' || r.kind === 'ccw');
const sgn = Math.sign(Cs.reduce((s, r) => s + (r.kind === 'cw' ? 1 : -1) * r.txz, 0)) || 1;
const dirOf = (r) => (Math.sign(r.txz) * sgn > 0 ? 'cw' : 'ccw'), firm = Cs.filter((r) => Math.abs(r.txz) >= 1.1);
console.log(`x-z plane: direction (sign voted from all) ${Cs.filter((r) => dirOf(r) === r.kind).length}/${Cs.length}; |turns| >= 1.1: ${firm.filter((r) => dirOf(r) === r.kind).length} right ${firm.filter((r) => dirOf(r) !== r.kind).length} wrong`);
for (const k of ['cw', 'ccw', 'push', 'pull']) {
  const x = rows.filter((r) => r.kind === k); if (!x.length) continue;
  console.log(`  ${k.padEnd(4)} x-z track: range x ${med(x.map((r) => r.rx)).toFixed(1)} z ${med(x.map((r) => r.rz)).toFixed(1)} y ${med(x.map((r) => r.ry)).toFixed(1)} cm, roundness ${med(x.map((r) => r.round)).toFixed(2)}, closure ${med(x.map((r) => r.closure)).toFixed(2)}, turns [${x.map((r) => r.txz.toFixed(1)).join(' ')}]`);
}
for (const k of ['cw', 'ccw', 'push', 'pull']) {
  const x = rows.filter((r) => r.kind === k); if (!x.length) continue;
  console.log(`${k.padEnd(4)} n${x.length}  ch corr L ${med(x.map((r) => r.chCorr[0])).toFixed(2)} R ${med(x.map((r) => r.chCorr[1])).toFixed(2)} | mic-difference path range L ${med(x.map((r) => r.micDiff[0])).toFixed(1)} R ${med(x.map((r) => r.micDiff[1])).toFixed(1)} cm vs speaker path ${med(x.map((r) => r.spkSum)).toFixed(1)} cm` +
    ` | 3D track: size ${med(x.map((r) => r.sizeCm)).toFixed(1)} cm, roundness l2/l1 ${med(x.map((r) => r.round)).toFixed(2)}, planarity l3/l2 ${med(x.map((r) => r.planar)).toFixed(2)}, |normal·up| ${med(x.map((r) => r.nY)).toFixed(2)}, turns [${x.map((r) => r.turns.toFixed(1)).join(' ')}]`);
}
