// reference worklet statistics from teach WAVs: carrier amplitude (amp), |dyn|/noise (q), gate pass rate (act) per stream
//   node refamp.js <wav base> ...
const fs = require('fs'), vm = require('vm'), P = require('./phase.js'), Bat3D = require('../../web/bat3d.js');
for (const base of process.argv.slice(2)) {
  const wav = P.readWav(base + '.wav'); let Proc = null; const msgs = [];
  const sb = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => msgs.push(m) }; } }, registerProcessor: (n, c) => { Proc = c; }, sampleRate: wav.rate, Math, Float32Array, Array };
  vm.createContext(sb); vm.runInContext(Bat3D.PROC, sb);
  const proc = new Proc({ processorOptions: { freqs: [18000, 19500], pll: [false, false] } });
  for (let i = 0; i + 128 <= wav.frames; i += 128) proc.process([wav.ch.map((c) => c.subarray(i, i + 128))]);
  const med = (A) => { const x = A.slice().sort((a, b) => a - b); return x[x.length >> 1]; };
  const use = msgs.slice(50);   // skip the start-up
  const amp = [0, 1, 2, 3].map((s) => med(use.map((m) => m.amp[s]))), q = [0, 1, 2, 3].map((s) => med(use.map((m) => m.q[s]))), act = [0, 1, 2, 3].map((s) => use.reduce((a, m) => a + m.act[s], 0) / use.length);
  // while moving: batches with any path activity above the median
  console.log(`${base.split(/[\/]/).pop().slice(8, 23)}: amp ${amp.map((v) => v.toExponential(2)).join(' ')} | q(median) ${q.map((v) => v.toFixed(2)).join(' ')} | gate pass ${act.map((v) => (100 * v).toFixed(0) + '%').join(' ')}`);
}
