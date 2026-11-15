// Hybrid tracker: phase steps from a FAST static removal (tau 0.05 s), but kept only where the DEPLOYED tracker
// (tau 0.1 s, gate 1.0 x 25th-percentile noise) passes them -> the fast tracker's motion accuracy without its
// extra jitter when the hand is still? Leave-one-sitting-out 250 ms displacement scores (as the deployed numbers)
// + jitter of the mapped position during the teach 'still' step (50 ms changes of W . cumulative steps).
//   node hybrid_loso.js <teach base> ...
const fs = require('fs'), V = require('./vision3d.js'), P = require('./phase.js');
const NEAR = 0.45, WIN = 250, FAST = Number(process.env.FAST || 0.05);
const MODES = ['deployed', 'fast', 'hybrid'];
function load(base) {
  const J = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), cam = J.camera || {}, lean = (J.screen_angle_deg ?? 95) - 90, r = lean * Math.PI / 180, C = [0, 0.19 * Math.cos(r), 0.10 + 0.19 * Math.sin(r)];
  const L = fs.readFileSync(base + '_vision.csv', 'utf8').trim().split('\n').map((l) => l.replace(/\r$/, '')), h = L[0].split(','), ix = Object.fromEntries(h.map((k, i) => [k, i]));
  const tr = L.slice(1).map((l) => { const q = l.split(','), n = (k) => Number(q[ix[k]]); if (n('present') !== 1) return null;
    const f = { lm: Array.from({ length: 21 }, (_, j) => [n(`lm${j}_x`), n(`lm${j}_y`), 0]), wlm: Array.from({ length: 21 }, (_, j) => [n(`wlm${j}_x`), n(`wlm${j}_y`), n(`wlm${j}_z`)]) };
    const c = V.handCam(f, { W: cam.width || 1280, H: cam.height || 720, hfov: 66 }); return c ? { t: n('t_cap'), H: V.toLaptop(c, { tilt: lean, C }) } : null; }).filter(Boolean);
  const wav = P.readWav(base + '.wav'), t0 = J.wav.t0, F = J.stereoFreqs || [18000, 19500];
  const steps = { deployed: [], fast: [], hybrid: [] };
  for (const f of F) for (const c of [0, 1]) {
    const bb = P.baseband(wav.ch[c], wav.rate, f), d = P.pathSteps(bb, f, { gate: 1.0, tauS: 0.1, pct: 0.25 }), fa = P.pathSteps(bb, f, { gate: 1.0, tauS: FAST, pct: 0.1 }), raw = P.pathSteps(bb, f, { gate: 0, tauS: FAST, pct: 0.25 });
    steps.deployed.push(d.step); steps.fast.push(fa.step); steps.hybrid.push(raw.step.map((v, k) => (d.step[k] !== 0 ? v : 0)));
  }
  const rate = 1000, n = steps.deployed[0].length, cum = {};
  for (const m of MODES) cum[m] = steps[m].map((s) => { const q = new Float64Array(n + 1); for (let k = 0; k < n; k++) q[k + 1] = q[k] + s[k]; return q; });
  const idx = (tms) => Math.max(0, Math.min(n, Math.round((tms - t0) / 1000 * rate)));
  const ws = [];
  for (let i = 0, j = 0; i < tr.length; i++) { while (j < tr.length && tr[j].t < tr[i].t + WIN) j++; if (j >= tr.length) break;
    const a = tr[i], b = tr[j]; if (b.t - a.t > WIN + 80) continue; if (Math.hypot(...a.H.map((v, k) => v - C[k])) > NEAR || Math.hypot(...b.H.map((v, k) => v - C[k])) > NEAR) continue;
    const y = b.H.map((v, k) => v - a.H[k]); if (Math.hypot(...y) < 0.01 || Math.hypot(...y) > 0.4) continue;
    const ia = idx(a.t), ib = idx(b.t); ws.push({ y, x: Object.fromEntries(MODES.map((m) => [m, cum[m].map((q) => q[ib] - q[ia])])) }); }
  const still = (J.trials || []).find((t) => t.kind === 'still'), stillIdx = still ? [idx(still.tGo + 500), idx(still.tEnd - 300)] : null;
  return { name: base.split(/[\\/]/).pop().slice(17, 23), ws, cum, stillIdx };
}
function fitW(train, m0) { const m = 5, A = Array.from({ length: m }, () => new Array(m).fill(0)), B = [0, 1, 2].map(() => new Array(m).fill(0));
  for (const w of train) { const x = [...w.x[m0], 1]; for (let i = 0; i < m; i++) { for (let j = 0; j < m; j++) A[i][j] += x[i] * x[j]; for (let a = 0; a < 3; a++) B[a][i] += x[i] * w.y[a]; } }
  for (let i = 0; i < 4; i++) A[i][i] += 1e-4 * train.length;
  const solve = (b) => { const M = A.map((r, i) => [...r, b[i]]); for (let c = 0; c < m; c++) { let p = c; for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c] || 1e-15; for (let j = c; j <= m; j++) M[c][j] /= d; for (let r = 0; r < m; r++) if (r !== c) { const q = M[r][c]; for (let j = c; j <= m; j++) M[r][j] -= q * M[c][j]; } } return M.map((r) => r[m]); };
  return B.map(solve); }
const S = process.argv.slice(2).map(load);
for (const m of MODES) {
  const e = [0, 0, 0], v = [0, 0, 0], c = [0, 0, 0], p2 = [0, 0, 0]; let n = 0; const per = [], jit = [];
  S.forEach((s, i) => { const W = fitW(S.filter((_, j) => j !== i).flatMap((o) => o.ws), m), a = { c: [0, 0, 0], v: [0, 0, 0], p: [0, 0, 0] };
    for (const w of s.ws) { const p = W.map((r) => r.slice(0, 4).reduce((q, x, j) => q + x * w.x[m][j], 0) + r[4]); for (let k = 0; k < 3; k++) { e[k] += (p[k] - w.y[k]) ** 2; v[k] += w.y[k] ** 2; c[k] += p[k] * w.y[k]; p2[k] += p[k] ** 2; a.c[k] += p[k] * w.y[k]; a.v[k] += w.y[k] ** 2; a.p[k] += p[k] ** 2; } n++; }
    per.push(s.name + ' ' + (a.c.reduce((q, x, k) => q + x / Math.sqrt(a.v[k] * a.p[k] || 1), 0) / 3).toFixed(3));
    if (s.stillIdx) { const [k0, k1] = s.stillIdx, d = [0, 0, 0]; let nn = 0; const pos = (k) => W.map((r) => r.slice(0, 4).reduce((q, x, j) => q + x * s.cum[m][j][k], 0));
      for (let k = k0 + 50; k <= k1; k += 50) { const a1 = pos(k - 50), b1 = pos(k); for (let q = 0; q < 3; q++) d[q] += (b1[q] - a1[q]) ** 2; nn++; } jit.push(d.map((x) => 1000 * Math.sqrt(x / Math.max(1, nn)))); } });
  const corr = c.map((x, k) => x / Math.sqrt(v[k] * p2[k] || 1)), jm = [0, 1, 2].map((k) => jit.reduce((q, j) => q + j[k], 0) / Math.max(1, jit.length));
  console.log(`${m.padEnd(9)} err ${e.map((x) => (100 * Math.sqrt(x / n)).toFixed(2)).join('/')} cm | corr ${corr.map((x) => x.toFixed(3)).join('/')} (mean ${(corr.reduce((a, b) => a + b) / 3).toFixed(3)}) | 'still' 50 ms jitter ${jm.map((x) => x.toFixed(1)).join('/')} mm | per sitting ${per.join(' ')}`);
}
