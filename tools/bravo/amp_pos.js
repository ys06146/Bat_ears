// Can the reflection STRENGTH give an absolute hand position (esp. height), unlike the phase which only gives changes?
// Per vision frame (hand near, moving): for each laptop path p, over +-WIN/2 ms:
//   r_p = log(mean |dynamic vector| / mean |baseband|)   (echo vs direct sound, volume-free)
//   s_p = log(mean |baseband|) - its sitting median     (direct-path level change, e.g. hand shadowing)
// Ridge from these 8 features (+ products r_p r_q) to the absolute hand position, leave-one-sitting-out.
// Reported: corr / rms vs the vision position, both raw (absolute) and within-sitting (sitting means removed),
// against the trivial "always the training mean" error.
//   node amp_pos.js <teach base> ...    env: GATE 1.0, TAU 0.1, NEAR 0.45, WIN 250, MOVING (1: only frames with motion)
const fs = require('fs'), V = require('./vision3d.js'), P = require('./phase.js');
const NEAR = Number(process.env.NEAR || 0.45), WIN = Number(process.env.WIN || 250), MOV = process.env.MOVING !== '0';
function load(base) {
  const J = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), cam = J.camera || {}, lean = (J.screen_angle_deg ?? 95) - 90, r = lean * Math.PI / 180, C = [0, 0.19 * Math.cos(r), 0.10 + 0.19 * Math.sin(r)];
  const L = fs.readFileSync(base + '_vision.csv', 'utf8').trim().split('\n').map((l) => l.replace(/\r$/, '')), h = L[0].split(','), ix = Object.fromEntries(h.map((k, i) => [k, i]));
  const tr = L.slice(1).map((l) => { const q = l.split(','), n = (k) => Number(q[ix[k]]); if (n('present') !== 1) return null;
    const f = { lm: Array.from({ length: 21 }, (_, j) => [n(`lm${j}_x`), n(`lm${j}_y`), 0]), wlm: Array.from({ length: 21 }, (_, j) => [n(`wlm${j}_x`), n(`wlm${j}_y`), n(`wlm${j}_z`)]) };
    const c = V.handCam(f, { W: cam.width || 1280, H: cam.height || 720, hfov: 66 }); return c ? { t: n('t_cap'), H: V.toLaptop(c, { tilt: lean, C }) } : null; }).filter(Boolean);
  const wav = P.readWav(base + '.wav'), t0 = J.wav.t0, F = J.stereoFreqs || [18000, 19500];
  const ch = F.flatMap((f) => [0, 1].map((c) => { const bb = P.baseband(wav.ch[c], wav.rate, f); const ps = P.pathSteps(bb, f, { gate: Number(process.env.GATE || 1.0), tauS: Number(process.env.TAU || 0.1) });
    const tot = new Float32Array(bb.I.length); for (let k = 0; k < tot.length; k++) tot[k] = Math.hypot(bb.I[k], bb.Q[k]); return { ...ps, tot }; }));
  const rate = ch[0].rate, n = ch[0].mag.length, half = Math.round(WIN / 2000 * rate);
  const med = ch.map((c) => { const a = Array.from(c.tot.filter((_, k) => k % 50 === 0)).sort((x, y) => x - y); return a[a.length >> 1]; });
  const rows = [];
  for (const f of tr) {
    if (Math.hypot(...f.H.map((v, k) => v - C[k])) > NEAR) continue;
    const k0 = Math.round((f.t - t0) / 1000 * rate); if (k0 - half < 0 || k0 + half >= n) continue;
    let moving = 0; const x = [];
    ch.forEach((c, p) => { let m = 0, t = 0, act = 0; for (let k = k0 - half; k <= k0 + half; k++) { m += c.mag[k]; t += c.tot[k]; if (c.step[k] !== 0) act++; } m /= 2 * half + 1; t /= 2 * half + 1;
      x.push(Math.log(m / t), Math.log(t / med[p])); if (act > half) moving++; });
    if (MOV && moving < 2) continue;
    rows.push({ x, y: f.H });
  }
  return { name: base.split(/[\\/]/).pop().slice(8, 23), rows };
}
function solve(A, b) { const n = A.length, M = A.map((r, i) => [...r, b[i]]); for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c] || 1e-15; for (let j = c; j <= n; j++) M[c][j] /= d; for (let r = 0; r < n; r++) if (r !== c) { const q = M[r][c]; for (let j = c; j <= n; j++) M[r][j] -= q * M[c][j]; } } return M.map((r) => r[n]); }
const feat = (x, quad) => { const r = [0, 2, 4, 6].map((i) => x[i]), out = [...x]; if (quad) for (let i = 0; i < 4; i++) for (let j = i; j < 4; j++) out.push(r[i] * r[j]); out.push(1); return out; };
function ridge(train, quad, lam = 1e-2) {
  const X = train.map((w) => feat(w.x, quad)), m = X[0].length, mu = Array.from({ length: m - 1 }, (_, i) => X.reduce((s, x) => s + x[i], 0) / X.length), sd = mu.map((u, i) => Math.sqrt(X.reduce((s, x) => s + (x[i] - u) ** 2, 0) / X.length) || 1);
  const Z = X.map((x) => [...x.slice(0, -1).map((v, i) => (v - mu[i]) / sd[i]), 1]), A = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => Z.reduce((s, z) => s + z[i] * z[j], 0) + (i === j && i < m - 1 ? lam * Z.length : 0)));
  const W = [0, 1, 2].map((a) => solve(A, Array.from({ length: m }, (_, i) => Z.reduce((s, z, n) => s + z[i] * train[n].y[a], 0))));
  return (x) => { const f = feat(x, quad), z = [...f.slice(0, -1).map((v, i) => (v - mu[i]) / sd[i]), 1]; return W.map((w) => w.reduce((s, v, j) => s + v * z[j], 0)); };
}
const S = process.argv.slice(2).map(load);
console.log(`${S.length} sittings, ${S.reduce((s, x) => s + x.rows.length, 0)} frames (${MOV ? 'moving only' : 'all near frames'})`);
for (const quad of [false, true]) {
  const pairs = [];
  S.forEach((s, i) => { const train = S.filter((_, j) => j !== i).flatMap((x) => x.rows), pr = ridge(train, quad), mean = [0, 1, 2].map((a) => train.reduce((q, w) => q + w.y[a], 0) / train.length);
    for (const w of s.rows) pairs.push({ s: i, p: pr(w.x), y: w.y, m: mean }); });
  const corr = (a, b) => { const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length; let sab = 0, saa = 0, sbb = 0; a.forEach((v, i) => { sab += (v - ma) * (b[i] - mb); saa += (v - ma) ** 2; sbb += (b[i] - mb) ** 2; }); return sab / Math.sqrt(saa * sbb || 1); };
  const res = [0, 1, 2].map((a) => {
    const rms = 100 * Math.sqrt(pairs.reduce((q, w) => q + (w.p[a] - w.y[a]) ** 2, 0) / pairs.length), base = 100 * Math.sqrt(pairs.reduce((q, w) => q + (w.m[a] - w.y[a]) ** 2, 0) / pairs.length);
    // within sitting: remove each sitting's mean of truth and of prediction
    const cen = (key) => pairs.map((w) => { const g = pairs.filter((q) => q.s === w.s); return w[key][a] - g.reduce((s, q) => s + q[key][a], 0) / g.length; });
    return { rms, base, cAbs: corr(pairs.map((w) => w.p[a]), pairs.map((w) => w.y[a])), cIn: corr(cen('p'), cen('y')) };
  });
  console.log(`${quad ? 'with products' : 'linear       '}: ` + res.map((r, a) => `${'xyz'[a]} err ${r.rms.toFixed(1)} cm (mean-only ${r.base.toFixed(1)}) corr ${r.cAbs.toFixed(2)} within-sitting ${r.cIn.toFixed(2)}`).join(' | '));
}
