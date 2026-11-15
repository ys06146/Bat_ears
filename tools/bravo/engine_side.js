// side effects of the tracker settings in the live engine: stillness during the 'still' step, origin resets, circle calls
//   node engine_side.js <teach base> <gate> <tauS>
const fs = require('fs'), vm = require('vm'), P = require('./phase.js'), Bat3D = require('../../web/bat3d.js');
const base = process.argv[2], gate = Number(process.argv[3]), tauS = Number(process.argv[4]);
const J = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), wav = P.readWav(base + '.wav'), t0 = J.wav.t0;
let Proc = null; const msgs = [];
const sb = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => msgs.push(m) }; } }, registerProcessor: (n, c) => { Proc = c; }, sampleRate: wav.rate, Math, Float32Array, Array };
// the module's worklet with the tested gate / tauS forced
vm.createContext(sb); vm.runInContext(Bat3D.PROC.replace('xs[Math.floor(0.25 * (xs.length - 1))]', 'xs[Math.floor(' + Number(process.env.PCT || 0.25) + ' * (xs.length - 1))]'), sb);
const proc = new Proc({ processorOptions: { freqs: [18000, 19500], pll: [false, false], gate, tauS } });
for (let i = 0; i + 128 <= wav.frames; i += 128) proc.process([wav.ch.map((c) => c.subarray(i, i + 128))]);
const actOn = Number(process.argv[5] || 0.004);
const fr = [], circ = []; const eng = Bat3D.create({ actOn, onFrame: (f) => fr.push(f), onCircle: (c) => circ.push(c) }); eng.originReset();
for (const m of msgs) eng.feed(m);
const still = J.trials.find((t) => t.kind === 'still'), inStill = fr.filter((f) => f.t + t0 >= still.tGo + 500 && f.t + t0 <= still.tEnd - 300);
const circles = J.trials.filter((t) => /cw/.test(t.kind)), inCirc = (c) => circles.some((t) => c.t + t0 >= t.tGo && c.t + t0 <= t.tEnd + 600);
const jit = (arr) => { const d = [0, 0, 0]; let n = 0; for (let i = 5; i < arr.length; i += 5) { for (let k = 0; k < 3; k++) d[k] += (arr[i].raw[k] - arr[i - 5].raw[k]) ** 2; n++; } return d.map((v) => (1000 * Math.sqrt(v / Math.max(1, n))).toFixed(1)); };
const mv = fr.filter((f) => f.moving);
console.log(`  raw 50 ms jitter during 'still' ${jit(inStill).join('/')} mm, over all frames ${jit(fr).join('/')} mm`);
console.log(`gate ${gate} tau ${tauS} pct ${process.env.PCT || 0.25} actOn ${actOn}: moving ${(100 * fr.filter((f) => f.moving).length / fr.length).toFixed(0)}% of all frames, ${(100 * inStill.filter((f) => f.moving).length / Math.max(1, inStill.length)).toFixed(0)}% during 'still' | origin resets ${fr.filter((f) => f.reset).length} | circle calls ${circ.length} (${circ.filter(inCirc).length} inside circle steps)`);
