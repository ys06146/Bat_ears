// End to end: what the engine actually draws (bat3d.js worklet + solver + Kalman + stillness resets) against the
// webcam hand, per sitting, with a map the sitting never saw (W from the other sittings: leave-one-sitting-out).
// Scores displacements of the drawn position over 250 ms and 1 s (pairs that cross a reset are dropped), hand near.
// Variants patch the module's constants (Kalman Q / R) or options (actOn, amp, stillMode) to tune them on unseen data.
//   node e2e.js <base> ...     env: MODULE (bat3d.js path), VARIANTS (comma list of names below, default all)
const fs = require('fs'), vm = require('vm'), path = require('path'), os = require('os'), V = require('./vision3d.js'), P = require('./phase.js');
const MOD = process.env.MODULE || path.join(__dirname, '../../web/bat3d.js'), NEAR = 0.45, src = fs.readFileSync(MOD, 'utf8');
const VARS = {
  deployed: {},
  'Q 1': { Q: 1 }, 'Q 16': { Q: 16 }, 'Q 64': { Q: 64 },
  'R 0.8cm': { R: 0.008 }, 'R 3cm': { R: 0.03 },
  'actOn 0.002': { opt: { actOn: 0.002 } }, 'actOn 0.008': { opt: { actOn: 0.008 } },
  'rebase': { opt: { stillMode: 'rebase' } },
};
const pick = (process.env.VARIANTS || Object.keys(VARS).join(',')).split(',');
function loadModule(v) {
  let s = src;
  if (v.Q != null) s = s.replace('const KF_Q = 4.0,', `const KF_Q = ${v.Q},`);
  if (v.R != null) s = s.replace('KF_R = 0.015 ** 2;', `KF_R = ${v.R} ** 2;`);
  const f = path.join(os.tmpdir(), `bat3d_e2e_${process.pid}_${Math.random().toString(36).slice(2)}.js`); fs.writeFileSync(f, s);
  const B = require(f); fs.unlinkSync(f); return B;
}
// LOSO maps from auto_train's cache (same windows / ridge as the deployed default)
const CACHE = path.join(__dirname, 'cache');
function winsOf(base) { const n = path.basename(base), f = fs.readdirSync(CACHE).filter((x) => x.startsWith(n + '.')).map((x) => path.join(CACHE, x)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]; if (!f) throw new Error('no cache for ' + n + ' (run auto_train.js first)'); return JSON.parse(fs.readFileSync(f, 'utf8')).ws; }
function fitW(train, lam = 1e-4) { const m = 5, A = Array.from({ length: m }, () => new Array(m).fill(0)), B = [0, 1, 2].map(() => new Array(m).fill(0));
  for (const w of train) { const x = [...w.x, 1]; for (let i = 0; i < m; i++) { for (let j = 0; j < m; j++) A[i][j] += x[i] * x[j]; for (let a = 0; a < 3; a++) B[a][i] += x[i] * w.y[a]; } }
  for (let i = 0; i < 4; i++) A[i][i] += lam * train.length;
  const solve = (b) => { const n = m, M = A.map((r, i) => [...r, b[i]]); for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c] || 1e-15; for (let j = c; j <= n; j++) M[c][j] /= d; for (let r = 0; r < n; r++) if (r !== c) { const q = M[r][c]; for (let j = c; j <= n; j++) M[r][j] -= q * M[c][j]; } } return M.map((r) => r[n]); };
  return B.map(solve); }

const bases = process.argv.slice(2), W8 = new Map(bases.map((b) => [b, winsOf(b)]));
const sit = bases.map((base) => {
  const J = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), cam = J.camera || {}, lean = (J.screen_angle_deg ?? 95) - 90, r = lean * Math.PI / 180, C = [0, 0.19 * Math.cos(r), 0.10 + 0.19 * Math.sin(r)];
  const L = fs.readFileSync(base + '_vision.csv', 'utf8').trim().split('\n').map((l) => l.replace(/\r$/, '')), h = L[0].split(','), ix = Object.fromEntries(h.map((k, i) => [k, i]));
  const tr = L.slice(1).map((l) => { const q = l.split(','), n = (k) => Number(q[ix[k]]); if (n('present') !== 1) return null;
    const f = { lm: Array.from({ length: 21 }, (_, j) => [n(`lm${j}_x`), n(`lm${j}_y`), 0]), wlm: Array.from({ length: 21 }, (_, j) => [n(`wlm${j}_x`), n(`wlm${j}_y`), n(`wlm${j}_z`)]) };
    const c = V.handCam(f, { W: cam.width || 1280, H: cam.height || 720, hfov: 66 }); return c ? { ta: n('t_cap') - J.wav.t0, H: V.toLaptop(c, { tilt: lean, C }) } : null; }).filter((f) => f && Math.hypot(...f.H.map((v, k) => v - C[k])) <= NEAR);
  const W = fitW(bases.filter((b) => b !== base).flatMap((b) => W8.get(b)));
  return { base, name: path.basename(base).slice(8, 23), wav: P.readWav(base + '.wav'), tr, W };
});
const msgsCache = new Map();
function runEngine(B, s, v) {
  const calib = JSON.parse(JSON.stringify(B.DEFAULT_CALIB.galaxy)); calib.learned.laptop.W = s.W;
  const frames = [], eng = B.create({ geom: 'galaxy', calib, model: 'learned', ...(v.opt || {}), onFrame: (f) => frames.push({ t: f.t, kf: f.kf, reset: f.reset }) });
  eng.originReset();
  let msgs = msgsCache.get(s.base);
  if (!msgs) { let Proc = null; msgs = [];
    const wsb = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => msgs.push(m) }; } }, registerProcessor: (n, c) => { Proc = c; }, sampleRate: s.wav.rate, Math, Float32Array, Array };
    vm.createContext(wsb); vm.runInContext(B.PROC, wsb); const proc = new Proc({ processorOptions: { freqs: eng.info().freqs, pll: [] } });
    for (let i = 0; i + 128 <= s.wav.frames; i += 128) proc.process([s.wav.ch.map((c) => c.subarray(i, i + 128))]);
    msgsCache.set(s.base, msgs); }
  for (const m of msgs) eng.feed(m);
  return frames;
}
function score(frames, tr, lagMs) {
  // drawn position at audio time t (ms): frames are every 10 ms; reset count up to t to drop pairs across a reset
  const t0 = frames[0].t, at = (t) => { const i = Math.round((t - t0) / 10); return i >= 0 && i < frames.length ? i : -1; };
  const resets = new Int32Array(frames.length); let c = 0; frames.forEach((f, i) => { if (f.reset) c++; resets[i] = c; });
  const out = { e: [0, 0, 0], v: [0, 0, 0], c: [0, 0, 0], p: [0, 0, 0], n: 0 };
  for (let i = 0, j = 0; i < tr.length; i++) { while (j < tr.length && tr[j].ta < tr[i].ta + lagMs) j++; if (j >= tr.length) break;
    const a = tr[i], b = tr[j]; if (b.ta - a.ta > lagMs + 80) continue; const ia = at(a.ta), ib = at(b.ta); if (ia < 0 || ib < 0 || resets[ia] !== resets[ib]) continue;
    const y = b.H.map((v, k) => v - a.H[k]), m = Math.hypot(...y); if (m < 0.01 || m > 0.4 * Math.sqrt(lagMs / 250)) continue;
    const p = frames[ib].kf.map((v, k) => v - frames[ia].kf[k]);
    for (let k = 0; k < 3; k++) { out.e[k] += (p[k] - y[k]) ** 2; out.v[k] += y[k] ** 2; out.c[k] += p[k] * y[k]; out.p[k] += p[k] ** 2; } out.n++; }
  return out;
}
const fin = (A) => { const corr = A.c.map((x, k) => x / Math.sqrt(A.v[k] * A.p[k] || 1)); return `err ${A.e.map((x) => (100 * Math.sqrt(x / Math.max(1, A.n))).toFixed(2)).join('/')} cm corr ${corr.map((x) => x.toFixed(3)).join('/')} (mean ${(corr.reduce((a, b) => a + b) / 3).toFixed(3)})`; };
const sum = (A, B) => { for (const k of ['e', 'v', 'c', 'p']) for (let i = 0; i < 3; i++) A[k][i] += B[k][i]; A.n += B.n; };
for (const name of pick) {
  const v = VARS[name], B = loadModule(v), agg = { 250: { e: [0, 0, 0], v: [0, 0, 0], c: [0, 0, 0], p: [0, 0, 0], n: 0 }, 1000: { e: [0, 0, 0], v: [0, 0, 0], c: [0, 0, 0], p: [0, 0, 0], n: 0 } };
  let resets = 0; const per = [];
  for (const s of sit) { const fr = runEngine(B, s, v); resets += fr.filter((f) => f.reset).length; const a = score(fr, s.tr, 250), b = score(fr, s.tr, 1000); sum(agg[250], a); sum(agg[1000], b);
    const c = a.c.map((x, k) => x / Math.sqrt(a.v[k] * a.p[k] || 1)); per.push(s.name.slice(9) + ' ' + (c.reduce((x, y) => x + y) / 3).toFixed(2)); }
  console.log(`${name.padEnd(12)} 250 ms ${fin(agg[250])} | 1 s ${fin(agg[1000])} | resets ${resets} | per sitting 250 ms mean corr ${per.join(' ')}`);
}
