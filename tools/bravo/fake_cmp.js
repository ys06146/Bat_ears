// Test fixture for auto_train.js: turn a teach sitting into a compare-mode sitting in OUT dir
// (<out>/batears_<date>_cmp_test.{wav,json,_vision.csv} + a _holo.csv from the deployed engine replayed offline,
//  shown = Kalman position, t_ms = audio time + wav.t0 like the hologram's log).
//   node fake_cmp.js <teach base> <out dir>
const fs = require('fs'), vm = require('vm'), path = require('path'), P = require('./phase.js'), B = require('../../web/bat3d.js');
const [base, out] = process.argv.slice(2), J = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), wav = P.readWav(base + '.wav');
const date = path.basename(base).match(/\d{8}_\d{6}/)[0], ob = path.join(out, `batears_${date}_cmp_test`);
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(base + '.wav', ob + '.wav'); fs.copyFileSync(base + '_vision.csv', ob + '_vision.csv');
const frames = [], eng = B.create({ geom: 'galaxy', model: 'learned', onFrame: (f) => frames.push(f) }); eng.originReset();
let Proc = null; const msgs = [];
const wsb = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => msgs.push(m) }; } }, registerProcessor: (n, c) => { Proc = c; }, sampleRate: wav.rate, Math, Float32Array, Array };
vm.createContext(wsb); vm.runInContext(B.PROC, wsb); const proc = new Proc({ processorOptions: { freqs: eng.info().freqs, pll: [] } });
for (let i = 0; i + 128 <= wav.frames; i += 128) proc.process([wav.ch.map((c) => c.subarray(i, i + 128))]);
for (const m of msgs) eng.feed(m);
const hdr = 't_s,raw_x,raw_y,raw_z,shown_x,shown_y,shown_z,moving,levelDb,t_ms';
fs.writeFileSync(ob + '_holo.csv', hdr + '\n' + frames.map((f) => [f.t / 1000, ...f.raw.map((v) => v.toFixed(5)), ...f.kf.map((v) => v.toFixed(5)), f.moving ? 1 : 0, (f.levelDb ?? 0).toFixed(1), (f.t + J.wav.t0).toFixed(1)].join(',')).join('\n') + '\n');
fs.writeFileSync(ob + '.json', JSON.stringify({ ...J, mode: 'compare', screen_angle_deg: null, wav: { ...J.wav, t0: J.wav.t0 + Number(process.env.SHIFT || 0) }, page: 'hologram.html (fake_cmp test)', session: path.basename(ob) }));   // json last
console.log(`${ob}: ${frames.length} holo rows`);
