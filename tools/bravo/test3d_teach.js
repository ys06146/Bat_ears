// 3d.html's own script on a teach session (WAV + phones), optionally with a teach_fit.js calibration loaded, and its
// Kalman position compared with the truth path (synthetic: <base>.truth.json) over 250 ms displacements.
//   node test3d_teach.js <base> [calib.json]     env: MODEL=physics|learned, PHONES=0|1|2, SWAP=0|1
const fs = require('fs'), vm = require('vm'), P = require('./phase.js');
const base = process.argv[2], calibPath = process.argv[3];
const html = fs.readFileSync(__dirname + '/3d.html', 'utf8'), script = html.split('<script>')[1].split('</script>')[0];
const J = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), meta = J.meta || J, wav = P.readWav(base + '.wav');
let truth = fs.existsSync(base + '.truth.json') ? JSON.parse(fs.readFileSync(base + '.truth.json', 'utf8')) : null, truthT = null, heldFrom = -Infinity, nearM = Infinity, camPos = null;
// real sessions: the webcam track is the truth (camera fit from the calibration), scored on the held-out second half only
const truthCalib = process.env.TRUTH_CALIB || calibPath;
if (!truth && truthCalib && fs.existsSync(base + '_vision.csv')) {
  const V = require('./vision3d.js'), cal = JSON.parse(fs.readFileSync(truthCalib, 'utf8'));
  const Lv = fs.readFileSync(base + '_vision.csv', 'utf8').trim().split('\n').map((l) => l.replace(/\r$/, '')), hv = Lv[0].split(','), iv = Object.fromEntries(hv.map((k, i) => [k, i]));
  const fr = Lv.slice(1).map((l) => { const r = l.split(','), q = (k) => Number(r[iv[k]]); return { t: q('t_cap'), present: q('present') === 1, lm: Array.from({ length: 21 }, (_, j) => [q('lm' + j + '_x'), q('lm' + j + '_y'), 0]), wlm: Array.from({ length: 21 }, (_, j) => [q('wlm' + j + '_x'), q('wlm' + j + '_y'), q('wlm' + j + '_z')]) }; }).filter((f) => f.present);
  const camM = meta.camera || {}, r = cal.cam.tilt * Math.PI / 180; camPos = [0, 0.19 * Math.cos(r), 0.10 + 0.19 * Math.sin(r)];
  truthT = fr.map((f) => { const c = V.handCam(f, { W: camM.width || 1280, H: camM.height || 720, hfov: cal.cam.hfov, mirror: cal.cam.mirror }); return c ? { t: f.t - (meta.wav.t0 || 0) + (cal.lagMs || 0), p: V.toLaptop(c, { tilt: cal.cam.tilt, C: camPos }) } : null; }).filter(Boolean);
  heldFrom = truthT[Math.floor(truthT.length / 2)].t; nearM = cal.nearM || 0.45;
}
const DEFPOS = { A: [25, 25, -2], B: [-25, 40, -2] };
const ph = (meta.phones || []).filter((p) => p.heard !== false).slice(0, Number(process.env.PHONES ?? 2)).map((p) => { const d = DEFPOS[p.id] || [25, 25, -2]; return { ...p, x_right_cm: p.x_right_cm ?? d[0], h_cm: p.h_cm ?? d[1], z_front_cm: p.z_front_cm ?? d[2] }; });
const DEF = { geom: 'galaxy', paths: 'avg', vol: '0.5', model: process.env.MODEL || 'physics',
  phoneHz: ph[0] ? ph[0].hz : 20500, px: ph[0] ? ph[0].x_right_cm : 25, py: ph[0] ? ph[0].h_cm : 25, pz: ph[0] ? ph[0].z_front_cm : -2,
  phone2Hz: ph[1] ? ph[1].hz : 21500, p2x: ph[1] ? ph[1].x_right_cm : -25, p2y: ph[1] ? ph[1].h_cm : 40, p2z: ph[1] ? ph[1].z_front_cm : -2 };
const CHK = { phoneOn: !!ph[0], phone2On: !!ph[1], swapLR: (process.env.SWAP ?? '0') === '1', useDefault: process.env.DEFCAL === '1' };
const els = {};
const el = (id) => (els[id] ||= { id, value: String(DEF[id] ?? ''), checked: !!CHK[id], textContent: '', innerHTML: '', style: {}, addEventListener() {}, setPointerCapture() {},
  getContext: () => new Proxy({}, { get: () => () => {} }), clientWidth: 800, clientHeight: 500, width: 800, height: 500 });
const sandbox = { document: { getElementById: el }, window: { devicePixelRatio: 1 }, performance: { now: () => sandbox.__t }, __t: 0, requestAnimationFrame: () => {}, setInterval: () => {},
  console, Math, Number, Float32Array, Array, Object, JSON, String, Blob: class {}, URL: { createObjectURL: () => '', revokeObjectURL() {} }, navigator: {} };
vm.createContext(sandbox);
vm.runInContext(script + '\n;globalThis.__api = { onSteps, live, kf, getCircle: () => lastCircle, cfgRef: () => cfg, solverRef: () => solver, setCalib: (c) => { calib = c; buildSolver(); resetLive(); }, originReset, PROC, renderErr };', sandbox);
const api = sandbox.__api;
if (calibPath) api.setCalib(JSON.parse(fs.readFileSync(calibPath, 'utf8')));
let Proc = null;
const wsb = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => api.onSteps(m) }; } }, registerProcessor: (n, c) => { Proc = c; }, sampleRate: wav.rate, Math, Float32Array, Array };
vm.createContext(wsb); vm.runInContext(api.PROC, wsb);
const cf = api.cfgRef(), proc = new Proc({ processorOptions: { freqs: cf.freqs, pll: cf.pll } });
api.originReset();
const rec = [], calls = []; let resets = 0, lastStill = 0, lastAt = null;
for (let i = 0; i + 128 <= wav.frames; i += 128) {
  sandbox.__t = (i / wav.rate) * 1000;
  proc.process([wav.ch.map((c) => c.subarray(i, i + 128))]);
  if (api.live.still >= 1000 && lastStill < 1000) resets++;
  lastStill = api.live.still;
  if (i % 480 < 128) rec.push({ t: api.live.t, p: api.kf.p.slice(), r: resets });
  const cc = api.getCircle(); if (cc && cc.at !== lastAt) { lastAt = cc.at; calls.push({ t: api.live.t + ((meta.wav && meta.wav.t0) || 0), dir: cc.dir, plane: cc.plane, turns: cc.turns }); }
}
const s = api.solverRef();
console.log(`${base.split(/[\\/]/).pop()} through 3d.html: tones ${cf.freqs.join('/')}, ${s.cal ? 'calibrated' : 'estimated'} geometry, ${s.learned ? 'learned map' : 'physics solve'}, singular values ${s.sv.map((v) => v.toFixed(2)).join(' / ')}, origin resets ${resets}`);
if (!truth && !truthT) process.exit(0);
const tAt = truthT ? (t) => { let lo = 0, hi = truthT.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (truthT[m].t < t) lo = m; else hi = m; } const q = Math.abs(truthT[lo].t - t) < Math.abs(truthT[hi].t - t) ? truthT[lo] : truthT[hi]; return Math.abs(q.t - t) < 60 ? q.p : null; }
  : (t) => { const k = Math.min(truth.length - 1, Math.max(0, Math.round(t / (1000 / 30)))); return truth[k].slice(1); };
const e = [0, 0, 0], v = [0, 0, 0], c = [0, 0, 0], pp = [0, 0, 0]; let n = 0;
for (let i = 0; i + 25 < rec.length; i += 5) {
  const a = rec[i], b = rec[i + 25]; if (a.r !== b.r || a.t < heldFrom) continue;
  const ta = tAt(a.t), tb = tAt(b.t); if (!ta || !tb) continue;
  if (camPos && (Math.hypot(...ta.map((v, k) => v - camPos[k])) > nearM || Math.hypot(...tb.map((v, k) => v - camPos[k])) > nearM)) continue;
  const dm = b.p.map((x, k) => x - a.p[k]), dt = tb.map((x, k) => x - ta[k]);
  if (Math.hypot(...dt) < 0.01) continue;   // moving windows only (as teach_fit)
  for (let k = 0; k < 3; k++) { e[k] += (dm[k] - dt[k]) ** 2; v[k] += dt[k] ** 2; c[k] += dm[k] * dt[k]; pp[k] += dm[k] ** 2; } n++;
}
const f = (k) => `${['x', 'y', 'z'][k]} ${(100 * Math.sqrt(e[k] / n)).toFixed(1)} cm (motion ${(100 * Math.sqrt(v[k] / n)).toFixed(1)}, corr ${(c[k] / Math.sqrt(v[k] * pp[k] || 1)).toFixed(2)})`;
console.log(`  250 ms displacement vs ${truthT ? 'WEBCAM (held-out half, hand near)' : 'truth'} over ${n} moving windows: ${[0, 1, 2].map(f).join(' | ')}`);

// circle calls vs the vision labels (vision_labels.js OUT=<file>), per guided segment
if (process.env.LABELS) {
  const labs = JSON.parse(fs.readFileSync(process.env.LABELS, 'utf8')), r = { ok: 0, wrongDir: 0, wrongPlane: 0, miss: 0, nonCircleFired: 0, nonCircle: 0 };
  for (const t of labs) {
    const v = t.vision && t.vision.lab, cs = calls.filter((c) => c.t >= t.tGo && c.t <= (t.tEnd ?? t.tGo + 1000 * (t.dur || 4)) + 600);
    if (/^c?cw_[hv]$/.test(v)) {
      if (!cs.length) { r.miss++; continue; }
      const want = v.split('_'), dirOk = cs.some((c) => c.dir === want[0]), planeOk = cs.some((c) => (want[1] === 'v') === /수직/.test(c.plane));
      if (dirOk && (planeOk || !api.solverRef().phone)) r.ok++; else if (!dirOk) r.wrongDir++; else r.wrongPlane++;
    } else if (v && v !== 'none') { r.nonCircle++; if (cs.length) r.nonCircleFired++; }
  }
  console.log(`  circle calls vs vision labels: right ${r.ok}, wrong direction ${r.wrongDir}, wrong plane ${r.wrongPlane}, missed ${r.miss}; non-circle segments with a call ${r.nonCircleFired}/${r.nonCircle}; calls in all ${calls.length}`);
}
