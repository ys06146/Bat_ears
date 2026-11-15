// Training features (phase.js steps) vs engine features (worklet steps) on the same sitting and tick grid: ctx statistics
// and the gated model's window score vs the webcam with each source.  node feat_src.js <gated json> <base> ...
const fs = require('fs'), path = require('path'), vm = require('vm'), P = require('./phase.js');
const src = fs.readFileSync(path.join(__dirname, 'gated_stream.js'), 'utf8'), cut = src.indexOf('const S = process.argv.slice(2).map(load);');
const mod = { exports: {} }; new Function('require', 'module', '__dirname', 'process', src.slice(0, cut) + '\nmodule.exports = { load, predictor };')(require, mod, __dirname, process);
const { load, predictor } = mod.exports, B = require('../../web/bat3d.js');
const MJ = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), M = MJ.gated || MJ, k = M.amp.modes.half.k;
const acc = () => ({ v: [0, 0, 0], c: [0, 0, 0], p: [0, 0, 0] }), add = (A, p, y) => { for (let a = 0; a < 3; a++) { A.v[a] += y[a] ** 2; A.c[a] += p[a] * y[a]; A.p[a] += p[a] ** 2; } };
const cr = (A) => A.c.map((x, a) => (x / Math.sqrt(A.v[a] * A.p[a] || 1)).toFixed(2)).join('/');
for (const base of process.argv.slice(3)) {
  const s = load(base), wav = P.readWav(base + '.wav');
  let Proc = null; const msgs = []; const wsb = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => msgs.push(m) }; } }, registerProcessor: (n, c) => { Proc = c; }, sampleRate: wav.rate, Math, Float32Array, Array };
  vm.createContext(wsb); vm.runInContext(B.PROC, wsb); const proc = new Proc({ processorOptions: { freqs: [18000, 19500], pll: [false, false] } });
  for (let i = 0; i + 128 <= wav.frames; i += 128) proc.process([wav.ch.map((c) => c.subarray(i, i + 128))]);
  const steps = [0, 1, 2, 3].map((p) => { const o = []; for (const m of msgs) for (const v of m.steps[p]) o.push(v); return o; }), n = steps[0].length;
  const cum = steps.map((st) => { const q = new Float64Array(n + 1); for (let i = 0; i < n; i++) q[i + 1] = q[i] + st[i]; return q; }), ca = steps.map((st) => { const q = new Float64Array(n + 1); for (let i = 0; i < n; i++) q[i + 1] = q[i] + (st[i] !== 0 ? 1 : 0); return q; });
  const D = (p, i) => cum[p][Math.max(0, Math.min(n, i))], A = (p, i) => ca[p][Math.max(0, Math.min(n, i))];
  const w2 = { ...s, dD: new Float64Array(s.nT * 4), ctx: new Float64Array(s.nT * 12) };
  for (let t = 1; t < s.nT; t++) { const i = 10 * t; for (let p = 0; p < 4; p++) { w2.dD[t * 4 + p] = D(p, i) - D(p, i - 10); w2.ctx[t * 12 + p] = D(p, i) - D(p, i - 250); w2.ctx[t * 12 + 4 + p] = D(p, i - 250) - D(p, i - 500); w2.ctx[t * 12 + 8 + p] = (A(p, i) - A(p, i - 250)) / 250; } }
  const stat = (S, j) => { let m = 0, v = 0, c = 0; for (const w of S.ws) for (let t = w.k0 + 1; t <= w.k1; t += 5) { const x = S.ctx[t * 12 + j]; m += x; v += x * x; c++; } m /= c; return [m, Math.sqrt(v / c - m * m)]; };
  console.log(`${s.name}: ctx gate share mean (phase.js | worklet) ${[8, 9, 10, 11].map((j) => stat(s, j)[0].toFixed(3) + '|' + stat(w2, j)[0].toFixed(3)).join('  ')}`);
  console.log(`   ctx 250 ms path change sd (phase.js | worklet) ${[0, 1, 2, 3].map((j) => (1000 * stat(s, j)[1]).toFixed(1) + '|' + (1000 * stat(w2, j)[1]).toFixed(1)).join('  ')} mm`);
  const pn = predictor(M, true), pb = predictor(M, false), r = { ph: acc(), wk: acc(), phLin: acc(), wkLin: acc() };
  for (const w of s.ws) { add(r.ph, pn(s, w).map((v, a) => v * k[a]), w.y); add(r.wk, pn(w2, w).map((v, a) => v * k[a]), w.y); add(r.phLin, pb(s, w), w.y); add(r.wkLin, pb(w2, w), w.y); }
  console.log(`   gated vs webcam: phase.js ${cr(r.ph)} | worklet ${cr(r.wk)}     (its W0 alone: phase.js ${cr(r.phLin)} | worklet ${cr(r.wkLin)})`);
}
