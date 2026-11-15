// bat3d.js must reproduce 3d.html exactly: run the page's worklet once on a WAV, feed the same messages to the page
// script (vm, DOM stubbed) and to Bat3D.create().feed(), compare the Kalman positions every 10 ms and the circle calls.
//   node test_bat3d.js <wav base (teach or circle session)>     env: PHONES=0|1 (use meta.phones), CALIB=<calib.json>
const fs = require('fs'), vm = require('vm'), P = require('./phase.js'), Bat3D = require('../../web/bat3d.js');
const base = process.argv[2], J = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), meta = J.meta || J, wav = P.readWav(base + '.wav');
const ph = Number(process.env.PHONES || 0) ? (meta.phones || []).filter((p) => p.heard !== false).slice(0, Number(process.env.PHONES)) : [];
const calib = process.env.CALIB ? JSON.parse(fs.readFileSync(process.env.CALIB, 'utf8')) : null;
// --- page
const html = fs.readFileSync(__dirname + '/3d.html', 'utf8'), script = html.split('<script>')[1].split('</script>')[0];
const DEF = { geom: 'galaxy', paths: 'avg', vol: '0.5', model: 'learned', phoneHz: ph[0] ? ph[0].hz : 17000, px: ph[0] ? ph[0].x_right_cm : 0, py: ph[0] ? ph[0].h_cm : 45, pz: ph[0] ? ph[0].z_front_cm : 30, phone2Hz: 18750, p2x: -25, p2y: 40, p2z: -2 };
const CHK = { phoneOn: !!ph[0], phone2On: false, swapLR: false, useDefault: true };
const els = {}, el = (id) => (els[id] ||= { id, value: String(DEF[id] ?? ''), checked: !!CHK[id], textContent: '', innerHTML: '', style: {}, addEventListener() {}, setPointerCapture() {}, getContext: () => new Proxy({}, { get: () => () => {} }), clientWidth: 800, clientHeight: 500, width: 800, height: 500 });
const sb = { document: { getElementById: el }, window: { devicePixelRatio: 1 }, performance: { now: () => 0 }, requestAnimationFrame: () => {}, setInterval: () => {}, console, Math, Number, Float32Array, Array, Object, JSON, String, Blob: class {}, URL: { createObjectURL: () => '', revokeObjectURL() {} }, navigator: {} };
vm.createContext(sb);
vm.runInContext(script + '\n;globalThis.__api = { onSteps, live, kf, cfgRef: () => cfg, getCircle: () => lastCircle, setCalib: (c) => { calib = c; buildSolver(); resetLive(); }, originReset, PROC };', sb);
const page = sb.__api;
if (calib) page.setCalib(calib);
page.originReset();
// --- module
const frames = [], circles = [];
const eng = Bat3D.create({ geom: 'galaxy', phones: ph.map((p) => ({ id: p.id, hz: p.hz, x_right_cm: p.x_right_cm, h_cm: p.h_cm, z_front_cm: p.z_front_cm })), calib, model: 'learned', onFrame: (f) => frames.push(f), onCircle: (c) => circles.push(c) });
eng.originReset();
// --- worklet once (from the module's PROC; check it is the page's PROC too)
if (Bat3D.PROC !== page.PROC) console.log('WARNING: worklet code differs between bat3d.js and 3d.html');
let Proc = null; const msgs = [];
const wsb = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => msgs.push(m) }; } }, registerProcessor: (n, c) => { Proc = c; }, sampleRate: wav.rate, Math, Float32Array, Array };
vm.createContext(wsb); vm.runInContext(Bat3D.PROC, wsb);
const cf = page.cfgRef(), proc = new Proc({ processorOptions: { freqs: cf.freqs, pll: cf.pll } });
console.log(`tones page ${cf.freqs.join('/')} module ${eng.info().freqs.join('/')}; calibration ${eng.info().calName}`);
const pagePos = [], pageCircles = []; let lastAt = null;
for (let i = 0; i + 128 <= wav.frames; i += 128) proc.process([wav.ch.map((c) => c.subarray(i, i + 128))]);
for (const m of msgs) {
  const before = page.live.t; page.onSteps(m);
  const c = page.getCircle(); if (c && c !== lastAt) { lastAt = c; pageCircles.push(c); }
  eng.feed(m);
  if (page.live.t !== before) pagePos.push({ t: page.live.t, p: page.kf.p.slice() });
}
// compare at the batch ends (both states after the same message)
let maxd = 0; const modPos = new Map(frames.map((f) => [f.t, f.kf]));
for (const q of pagePos) { const mp = modPos.get(q.t); if (!mp) continue; maxd = Math.max(maxd, ...q.p.map((v, k) => Math.abs(v - mp[k]))); }
console.log(`frames ${frames.length}; max |page kf - module kf| over ${pagePos.length} batch ends = ${(maxd * 1000).toFixed(6)} mm`);
console.log(`circle calls page ${pageCircles.length} [${pageCircles.map((c) => c.dir).join(' ')}] module ${circles.length} [${circles.map((c) => c.dir).join(' ')}]`);
