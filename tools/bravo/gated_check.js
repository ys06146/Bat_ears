// Checks for the gated engine (gated/bat3d.js) on one WAV:
//  1) model 'learned' (v15 linear map) gives exactly the same frames as the repo's web/bat3d.js
//  2) model 'gated': the engine's raw position equals the offline gated computation on the worklet's own steps
//     (same ticks / ctx / net as gated_stream.js) -> the trained model is what runs
//  3) prints the engine's model, amp and err for the record
//   node gated_check.js <wav base> [repo bat3d.js]
const fs = require('fs'), vm = require('vm'), P = require('./phase.js');
const base = process.argv[2], repo = process.argv[3] || require('path').join(__dirname, '../../web/bat3d.js');
const NEW = require('./gated/bat3d.js'), OLD = require(repo), wav = P.readWav(base + '.wav');
let Proc = null; const msgs = [];
const wsb = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => msgs.push(m) }; } }, registerProcessor: (n, c) => { Proc = c; }, sampleRate: wav.rate, Math, Float32Array, Array };
if (NEW.PROC !== OLD.PROC) console.log('WARNING: worklet code differs from the repo');
vm.createContext(wsb); vm.runInContext(NEW.PROC, wsb); const proc = new Proc({ processorOptions: { freqs: [18000, 19500], pll: [false, false] } });
for (let i = 0; i + 128 <= wav.frames; i += 128) proc.process([wav.ch.map((c) => c.subarray(i, i + 128))]);
const run = (B, opts) => { const fr = []; const e = B.create({ geom: 'galaxy', onFrame: (f) => fr.push(f), ...opts }); e.originReset(); for (const m of msgs) e.feed(m); return { fr, info: e.info() }; };
// 1
const a = run(OLD, { model: 'learned' }), b = run(NEW, { model: 'learned' });
let d1 = 0; a.fr.forEach((f, i) => { const g = b.fr[i]; d1 = Math.max(d1, ...f.kf.map((v, k) => Math.abs(v - g.kf[k])), ...f.raw.map((v, k) => Math.abs(v - g.raw[k]))); });
console.log(`1) linear mode vs repo: ${a.fr.length} / ${b.fr.length} frames, max |diff| ${d1} m, circles ${a.fr.filter((f) => f.circle).length} / ${b.fr.filter((f) => f.circle).length}, model ${b.info.model}`);
// 2
const c = run(NEW, { model: 'gated', autoReset: false }), M = NEW.DEFAULT_CALIB.galaxy.gated, gK = M.amp.modes[c.info.amp].k;
const steps = [0, 1, 2, 3].map((p) => { const out = []; for (const m of msgs) for (const v of m.steps[p]) out.push(v); return out; }), n = steps[0].length;
const cum = steps.map((s) => { const q = new Float64Array(n + 1); for (let k = 0; k < n; k++) q[k + 1] = q[k] + s[k]; return q; }), ca = steps.map((s) => { const q = new Float64Array(n + 1); for (let k = 0; k < n; k++) q[k + 1] = q[k] + (s[k] !== 0 ? 1 : 0); return q; });
const Pos = [0, 0, 0], ref = []; const firstTick = 10;   // the engine's first tick is after 10 samples; its history starts there
for (let i = firstTick, k = 0; i <= n; i += 10, k++) {
  const back = (j) => Math.max(firstTick, i - 10 * j), Dn = (p, ii) => cum[p][ii], An = (p, ii) => ca[p][ii];
  if (k > 0) { const dD = [0, 1, 2, 3].map((p) => Dn(p, i) - Dn(p, back(1)));
    const ctx = [...[0, 1, 2, 3].map((p) => Dn(p, i) - Dn(p, back(25))), ...[0, 1, 2, 3].map((p) => Dn(p, back(25)) - Dn(p, back(50))), ...[0, 1, 2, 3].map((p) => (An(p, i) - An(p, back(25))) / 250)].map((v, j) => (v - M.mu[j]) / M.sd[j]);
    const hh = []; for (let h = 0; h < M.H; h++) { let q = M.b1[h]; for (let j = 0; j < 12; j++) q += M.W1[h * 12 + j] * ctx[j]; hh.push(Math.tanh(q)); }
    for (let ax = 0; ax < 3; ax++) { let q = 0; for (let p = 0; p < 4; p++) { let g = M.b2[ax * 4 + p]; for (let h = 0; h < M.H; h++) g += M.W2[(ax * 4 + p) * M.H + h] * hh[h]; q += (M.W0[ax][p] + M.Sg * g) * dD[p]; } Pos[ax] += gK[ax] * q; } }
  ref.push(Pos.map((v, ax) => NEW.H0[ax] + v));
}
let d2 = 0; const m2 = Math.min(ref.length, c.fr.length); for (let i = 0; i < m2; i++) d2 = Math.max(d2, ...ref[i].map((v, k) => Math.abs(v - c.fr[i].raw[k])));
const span = [0, 1, 2].map((k) => { const v = c.fr.map((f) => f.raw[k]); return (100 * (Math.max(...v) - Math.min(...v))).toFixed(1); });
console.log(`2) gated engine vs offline gated computation: ${m2} ticks, max |diff| ${(d2 * 1000).toFixed(6)} mm (raw position span ${span.join('/')} cm)`);
console.log(`3) gated info: model ${c.info.model}, amp ${c.info.amp} k ${gK.join('/')}, err ${JSON.stringify(c.info.err)}`);
