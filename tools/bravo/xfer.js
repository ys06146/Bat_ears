// Does a learned audio -> displacement map transfer between sessions (no per-sitting calibration)?
// Train ridge on all near-hand windows of session A, test on session B (and within-B second half for reference).
//   node xfer.js <teach base A> <teach base B>   (laptop paths only: 18k, 19.5k x 2 mics)   env: WIN, NEAR
const fs = require('fs'), V = require('./vision3d.js'), P = require('./phase.js');
const WIN = Number(process.env.WIN || 250), NEAR = Number(process.env.NEAR || 0.45);
function load(base) {
  const J = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), cam = J.camera || {}, lean = (J.screen_angle_deg ?? 95) - 90, r = lean * Math.PI / 180, C = [0, 0.19 * Math.cos(r), 0.10 + 0.19 * Math.sin(r)];
  const L = fs.readFileSync(base + '_vision.csv', 'utf8').trim().split('\n').map((l) => l.replace(/\r$/, '')), h = L[0].split(','), ix = Object.fromEntries(h.map((k, i) => [k, i]));
  const tr = L.slice(1).map((l) => { const q = l.split(','), n = (k) => Number(q[ix[k]]); if (n('present') !== 1) return null;
    const f = { lm: Array.from({ length: 21 }, (_, j) => [n(`lm${j}_x`), n(`lm${j}_y`), 0]), wlm: Array.from({ length: 21 }, (_, j) => [n(`wlm${j}_x`), n(`wlm${j}_y`), n(`wlm${j}_z`)]) };
    const c = V.handCam(f, { W: cam.width || 1280, H: cam.height || 720, hfov: 66 }); return c ? { t: n('t_cap'), H: V.toLaptop(c, { tilt: lean, C }) } : null; }).filter(Boolean);
  const wav = P.readWav(base + '.wav'), t0 = J.wav.t0, F = J.stereoFreqs || [18000, 19500];
  const st = F.flatMap((f) => [0, 1].map((c) => P.pathSteps(P.baseband(wav.ch[c], wav.rate, f), f, { gate: 1.5 })));
  const rate = st[0].rate, n = st[0].step.length, cum = st.map((s) => { const q = new Float64Array(n + 1); for (let k = 0; k < n; k++) q[k + 1] = q[k] + s.step[k]; return q; });
  const D = (p, tms) => cum[p][Math.max(0, Math.min(n, Math.round((tms - t0) / 1000 * rate)))];
  const ws = [];
  for (let i = 0, j = 0; i < tr.length; i++) { while (j < tr.length && tr[j].t < tr[i].t + WIN) j++; if (j >= tr.length) break;
    const a = tr[i], b = tr[j]; if (b.t - a.t > WIN + 80) continue; if (Math.hypot(...a.H.map((v, k) => v - C[k])) > NEAR || Math.hypot(...b.H.map((v, k) => v - C[k])) > NEAR) continue;
    const dH = b.H.map((v, k) => v - a.H[k]); if (Math.hypot(...dH) < 0.01 || Math.hypot(...dH) > 0.4) continue;
    ws.push({ t: a.t, x: st.map((_, p) => D(p, b.t) - D(p, a.t)), y: dH }); }
  return { name: base.split(/[\\/]/).pop(), ws };
}
function ridge(train, lam = 1e-4) {
  const X = train.map((w) => [...w.x, 1]), m = X[0].length;
  const A = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => X.reduce((s, x) => s + x[i] * x[j], 0) + (i === j && i < m - 1 ? lam * X.length : 0)));
  const inv = (A) => { const k = A.length, M = A.map((r, i) => [...r, ...A.map((_, j) => (i === j ? 1 : 0))]); for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c] || 1e-12; for (let j = 0; j < 2 * k; j++) M[c][j] /= d; for (let r = 0; r < k; r++) if (r !== c) { const q = M[r][c]; for (let j = 0; j < 2 * k; j++) M[r][j] -= q * M[c][j]; } } return M.map((r) => r.slice(k)); };
  const Ai = inv(A), W = [0, 1, 2].map((ax) => { const xy = Array.from({ length: m }, (_, i) => X.reduce((s, x, n) => s + x[i] * train[n].y[ax], 0)); return Ai.map((r) => r.reduce((s, v, j) => s + v * xy[j], 0)); });
  return (w) => W.map((wa) => wa.reduce((s, v, j) => s + v * [...w.x, 1][j], 0));
}
function score(name, pred, test) {
  const e = [0, 0, 0], v = [0, 0, 0], c = [0, 0, 0], pp = [0, 0, 0];
  for (const w of test) { const p = pred(w); for (let k = 0; k < 3; k++) { e[k] += (p[k] - w.y[k]) ** 2; v[k] += w.y[k] ** 2; c[k] += p[k] * w.y[k]; pp[k] += p[k] ** 2; } }
  const n = test.length;
  console.log(`  ${name.padEnd(34)} ${[0, 1, 2].map((k) => `${'xyz'[k]} ${(100 * Math.sqrt(e[k] / n)).toFixed(1)} cm (corr ${(c[k] / Math.sqrt(v[k] * pp[k] || 1)).toFixed(2)})`).join(' | ')}  [${n} windows, motion ${[0, 1, 2].map((k) => (100 * Math.sqrt(v[k] / n)).toFixed(1)).join('/')}]`);
}
const A = load(process.argv[2]), B = load(process.argv[3]);
const half = B.ws.filter((w) => w.t >= B.ws[Math.floor(B.ws.length / 2)].t), firstB = B.ws.filter((w) => w.t < B.ws[Math.floor(B.ws.length / 2)].t);
console.log(`train ${A.name} (${A.ws.length} windows) -> test ${B.name} second half (${half.length})`);
score('within B (train first half)', ridge(firstB), half);
score('cross: trained on A only', ridge(A.ws), half);
score('A + first half of B', ridge([...A.ws, ...firstB]), half);

// SAVE=<file>: a default laptop-only calibration (learned on A + B, all near windows) in teach_fit's calib format,
// geometry / mics taken from CALIB_FROM (a teach_fit calib.json), errors = the cross-session test above (A -> B)
if (process.env.SAVE) {
  const all = [...A.ws, ...B.ws], X = all.map((w) => [...w.x, 1]), m = X[0].length, lam = 1e-4;
  const Am = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => X.reduce((s, x) => s + x[i] * x[j], 0) + (i === j && i < m - 1 ? lam * X.length : 0)));
  const inv = (M0) => { const k = M0.length, M = M0.map((r, i) => [...r, ...M0.map((_, j) => (i === j ? 1 : 0))]); for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c] || 1e-12; for (let j = 0; j < 2 * k; j++) M[c][j] /= d; for (let r = 0; r < k; r++) if (r !== c) { const q = M[r][c]; for (let j = 0; j < 2 * k; j++) M[r][j] -= q * M[c][j]; } } return M.map((r) => r.slice(k)); };
  const Ai = inv(Am), W = [0, 1, 2].map((ax) => { const xy = Array.from({ length: m }, (_, i) => X.reduce((s, x, n) => s + x[i] * all[n].y[ax], 0)); return Ai.map((r) => r.reduce((s, v, j) => s + +(v * xy[j]).toFixed(8), 0)); });
  // cross-session error (A -> B second half) as the stated error
  const pr = ridge(A.ws), e = [0, 0, 0], v = [0, 0, 0], c = [0, 0, 0], pp = [0, 0, 0];
  for (const w of half) { const p = pr(w); for (let k = 0; k < 3; k++) { e[k] += (p[k] - w.y[k]) ** 2; v[k] += w.y[k] ** 2; c[k] += p[k] * w.y[k]; pp[k] += p[k] ** 2; } }
  const base = JSON.parse(fs.readFileSync(process.env.CALIB_FROM, 'utf8'));
  const out = { v: 1, session: `default (${A.name} + ${B.name})`, created: new Date().toISOString(), winMs: WIN, nearM: NEAR, cam: base.cam, lagMs: 0, mics: base.mics,
    paths: base.paths.filter((p) => !p.pll).slice(0, 4), learned: { laptop: { idx: [0, 1, 2, 3], W: W.map((r) => r.map((x) => +x.toFixed(6))) }, all: null },
    errors: { 'learned, laptop only': { rms: e.map((x) => +(100 * Math.sqrt(x / half.length)).toFixed(2)), motion: v.map((x) => +(100 * Math.sqrt(x / half.length)).toFixed(2)), corr: c.map((x, k) => +(x / Math.sqrt(v[k] * pp[k] || 1)).toFixed(2)) } },
    truthFloorCm: base.truthFloorCm, note: 'Galaxy Book 61f5, 서진, hand 25-45 cm from the webcam; error = trained on one sitting, tested on another' };
  fs.writeFileSync(process.env.SAVE, JSON.stringify(out, null, 1)); console.log('saved ' + process.env.SAVE);
}
