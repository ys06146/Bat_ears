// Can a better LINEAR map (same engine: position = H0 + k * W * D) beat the deployed one on unseen sittings?
// Variants of W: ridge strength, training window length (250 / 500 / 1000 ms: longer windows = less noise per sample),
// leaving out a sitting from training. Scored the same way as the deployed numbers: leave-one-sitting-out, 250 ms
// displacements, hand within NEAR of the webcam, pooled.
//   node map_loso.js <teach base> ...
const fs = require('fs'), V = require('./vision3d.js'), P = require('./phase.js');
const NEAR = Number(process.env.NEAR || 0.45);
function load(base) {
  const J = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), cam = J.camera || {}, lean = (J.screen_angle_deg ?? 95) - 90, r = lean * Math.PI / 180, C = [0, 0.19 * Math.cos(r), 0.10 + 0.19 * Math.sin(r)];
  const L = fs.readFileSync(base + '_vision.csv', 'utf8').trim().split('\n').map((l) => l.replace(/\r$/, '')), h = L[0].split(','), ix = Object.fromEntries(h.map((k, i) => [k, i]));
  const tr = [];
  for (const l of L.slice(1)) { const q = l.split(','), n = (k) => Number(q[ix[k]]); if (n('present') !== 1) continue;
    const f = { lm: Array.from({ length: 21 }, (_, j) => [n(`lm${j}_x`), n(`lm${j}_y`), 0]), wlm: Array.from({ length: 21 }, (_, j) => [n(`wlm${j}_x`), n(`wlm${j}_y`), n(`wlm${j}_z`)]) };
    const c = V.handCam(f, { W: cam.width || 1280, H: cam.height || 720, hfov: 66 }); if (c) tr.push({ t: n('t_cap'), H: V.toLaptop(c, { tilt: lean, C }) }); }
  const wav = P.readWav(base + '.wav'), t0 = J.wav.t0, F = J.stereoFreqs || [18000, 19500];
  const st = F.flatMap((f) => [0, 1].map((c) => P.pathSteps(P.baseband(wav.ch[c], wav.rate, f, { lpHz: Number(process.env.LPHZ || 250) }), f, { gate: Number(process.env.GATE || 1.5), tauS: Number(process.env.TAU || 0.25), pct: Number(process.env.PCT || 0.25) })));
  const rate = st[0].rate, nS = st[0].step.length, cum = st.map((s) => { const q = new Float64Array(nS + 1); for (let k = 0; k < nS; k++) q[k + 1] = q[k] + s.step[k]; return q; });
  const D = (p, tms) => cum[p][Math.max(0, Math.min(nS, Math.round((tms - t0) / 1000 * rate)))];
  const near = (H) => Math.hypot(...H.map((v, k) => v - C[k])) <= NEAR;
  const windows = (WIN) => { const ws = []; for (let i = 0, j = 0; i < tr.length; i++) { while (j < tr.length && tr[j].t < tr[i].t + WIN) j++; if (j >= tr.length) break;
    const a = tr[i], b = tr[j]; if (b.t - a.t > WIN + 80 || !near(a.H) || !near(b.H)) continue; const y = b.H.map((v, k) => v - a.H[k]); const m = Math.hypot(...y);
    if (m < 0.01 * Math.sqrt(WIN / 250) || m > 0.4 * Math.sqrt(WIN / 250)) continue; ws.push({ x: st.map((_, p) => D(p, b.t) - D(p, a.t)), y }); } return ws; };
  return { name: base.split(/[\\/]/).pop().slice(8, 23), w250: windows(250), w500: windows(500), w1000: windows(1000) };
}
function ridge(train, lam) {
  const X = train.map((w) => [...w.x, 1]), m = X[0].length;
  const A = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => X.reduce((s, x) => s + x[i] * x[j], 0) + (i === j && i < m - 1 ? lam * X.length : 0)));
  const inv = (M0) => { const k = M0.length, M = M0.map((r, i) => [...r, ...M0.map((_, j) => (i === j ? 1 : 0))]); for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c] || 1e-12; for (let j = 0; j < 2 * k; j++) M[c][j] /= d; for (let r = 0; r < k; r++) if (r !== c) { const q = M[r][c]; for (let j = 0; j < 2 * k; j++) M[r][j] -= q * M[c][j]; } } return M.map((r) => r.slice(k)); };
  const Ai = inv(A), W = [0, 1, 2].map((ax) => { const xy = Array.from({ length: m }, (_, i) => X.reduce((s, x, n) => s + x[i] * train[n].y[ax], 0)); return Ai.map((r) => r.reduce((s, v, j) => s + v * xy[j], 0)); });
  return (w) => W.map((wa) => wa.slice(0, m - 1).reduce((s, v, j) => s + v * w.x[j], 0));   // no intercept at use (the engine integrates W * dD)
}
const S = process.argv.slice(2).map(load), TEST = process.env.TEST || 'w250';
console.log(`${S.length} sittings; 250 ms test windows ${S.reduce((s, x) => s + x.w250.length, 0)}`);
function evalCfg(name, trainKey, lam, skip = []) {
  const e = [0, 0, 0], v = [0, 0, 0], c = [0, 0, 0], pp = [0, 0, 0]; let n = 0;
  S.forEach((s, i) => { const pr = ridge(S.filter((x, j) => j !== i && !skip.includes(x.name)).flatMap((x) => x[trainKey]), lam);
    for (const w of s[TEST]) { const p = pr(w); for (let k = 0; k < 3; k++) { e[k] += (p[k] - w.y[k]) ** 2; v[k] += w.y[k] ** 2; c[k] += p[k] * w.y[k]; pp[k] += p[k] ** 2; } n++; } });
  const corr = c.map((x, k) => x / Math.sqrt(v[k] * pp[k] || 1)), rms = e.map((x) => 100 * Math.sqrt(x / n));
  console.log(`  [test ${TEST}] ${name.padEnd(34)} err ${rms.map((x) => x.toFixed(2)).join('/')} cm | corr ${corr.map((x) => x.toFixed(3)).join('/')} | mean corr ${(corr.reduce((a, b) => a + b) / 3).toFixed(3)}`);
}
evalCfg(`gate ${process.env.GATE || 1.5} tau ${process.env.TAU || 0.25} lp ${process.env.LPHZ || 250} pct ${process.env.PCT || 0.25}`, 'w250', 1e-4);
if (process.env.ONLY) process.exit(0);
for (const lam of [1e-6, 1e-5, 1e-3, 1e-2]) evalCfg(`250 ms, lam ${lam}`, 'w250', lam);
for (const lam of [1e-5, 1e-4, 1e-3]) evalCfg(`500 ms train, lam ${lam}`, 'w500', lam);
for (const lam of [1e-5, 1e-4, 1e-3]) evalCfg(`1000 ms train, lam ${lam}`, 'w1000', lam);
evalCfg('250 ms, without 044652 in training', 'w250', 1e-4, ['20261115_044652']);
