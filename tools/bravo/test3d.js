// Runs 3d.html's own script (worklet + solver + Kalman + still / origin + circle call) on a WAV session in Node,
// with the DOM / canvas / audio stubbed, and scores the circle calls against the trial labels.
//   node test3d.js <session name after batears_>    env: PATHS=avg|all, GEOM=galaxy|macbook
const fs = require('fs'), vm = require('vm'), P = require('./phase.js');
const html = fs.readFileSync(__dirname + '/3d.html', 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
const D = (process.env.DATA || require('path').join(__dirname, '../../ml/data')) + '/batears_', name = process.argv[2], base = fs.existsSync(name + '.json') ? name : D + name;
const meta = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), wav = P.readWav(base + '.wav');
const DEF = { geom: process.env.GEOM || 'galaxy', paths: process.env.PATHS || 'avg', vol: '0.5', phoneHz: process.env.FP || '20500', px: '25', py: '25', pz: '12' };
if (process.env.PHONE) { const [a, b, c] = process.env.PHONE.split(','); Object.assign(DEF, { px: a, py: b, pz: c }); }
// DOM stubs
const els = {};
const el = (id) => (els[id] ||= { id, value: DEF[id] ?? '', checked: id === 'phoneOn' ? !!process.env.PHONE : id === 'swapLR' ? (process.env.SWAP ?? '1') === '1' : false, textContent: '', innerHTML: '', style: {},
  addEventListener() {}, setPointerCapture() {}, getContext: () => new Proxy({}, { get: () => () => {} }), clientWidth: 800, clientHeight: 500, width: 800, height: 500 });
let Proc = null;
const sandbox = {
  document: { getElementById: el }, window: { devicePixelRatio: 1 }, performance: { now: () => sandbox.__t }, __t: 0,
  requestAnimationFrame: () => {}, setInterval: () => {}, console, Math, Number, Float32Array, Array, Object, JSON, Blob: class {}, URL: { createObjectURL: () => '', revokeObjectURL() {} },
  navigator: {},
};
vm.createContext(sandbox);
vm.runInContext(script + '\n;globalThis.__api = { onSteps, live, kf, trail, segLog, setAct: (v) => { ACT_ON = v; }, solverRef: () => solver, cfgRef: () => cfg, getCircle: () => lastCircle, originReset, PROC };', sandbox);
const api = sandbox.__api;
if (process.env.ACT) api.setAct(Number(process.env.ACT));
// run the worklet code from the page on the WAV
const wsb = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => api.onSteps(m) }; } }, registerProcessor: (n, c) => { Proc = c; }, sampleRate: wav.rate, Math, Float32Array, Array };
vm.createContext(wsb); vm.runInContext(api.PROC, wsb);
const cf = api.cfgRef(), proc = new Proc({ processorOptions: { freqs: cf.freqs, pll: cf.pll } });
api.originReset();
const calls = []; let lastAt = null;
for (let i = 0; i + 128 <= wav.frames; i += 128) {
  sandbox.__t = (i / wav.rate) * 1000;
  proc.process([wav.ch.map((c) => c.subarray(i, i + 128))]);
  const c = api.getCircle();
  if (c && c.at !== lastAt) { lastAt = c.at; calls.push({ t: api.live.t, dir: c.dir, turns: c.turns, plane: c.plane }); }
}
// live.t counts decimated samples (ms) from the WAV start -> trial windows in the same clock
const trials = meta.trials.filter((t) => Number.isFinite(t.tGo)).map((t) => ({ kind: t.kind, a: t.tGo - meta.wav.t0 - 200, b: t.tGo - meta.wav.t0 + (t.kind === 'cw' || t.kind === 'ccw' ? 3600 : 2400) }));
const r = { ok: 0, rev: 0, miss: 0, pp: 0, ppFire: 0, outside: 0 };
for (const t of trials) {
  const cs = calls.filter((c) => c.t >= t.a && c.t <= t.b);
  if (t.kind === 'cw' || t.kind === 'ccw') { if (!cs.length) r.miss++; else if (cs[0].dir === t.kind) r.ok++; else r.rev++; } else { r.pp++; if (cs.length) r.ppFire++; }
}
r.outside = calls.filter((c) => !trials.some((t) => c.t >= t.a && c.t <= t.b)).length;
const sv = api.solverRef().sv, segs = api.segLog.map(([a, b]) => b - a).sort((x, y) => x - y);
console.log(`motion segments: ${segs.length}, length ms median ${segs[segs.length >> 1]} max ${segs[segs.length - 1]}`);
console.log(`${name} through 3d.html (${process.env.PATHS || 'avg'} paths, ${process.env.GEOM || 'galaxy'}): singular values ${sv.map((v) => v.toFixed(2)).join(' / ')}`);
console.log(`circles right/reversed/missed ${r.ok}/${r.rev}/${r.miss} of ${r.ok + r.rev + r.miss}; push/pull called a circle ${r.ppFire}/${r.pp}; calls outside trials ${r.outside}; channels identical ${(100 * api.live.identical).toFixed(0)}%`);
if (process.env.TL) {
  console.log('trials: ' + trials.slice(0, 10).map((t) => `${t.kind}@${(t.a / 1000).toFixed(1)}-${(t.b / 1000).toFixed(1)}`).join(' '));
  console.log('segments: ' + api.segLog.filter(([a]) => a < trials[9].b).map(([a, b]) => `${(a / 1000).toFixed(1)}-${(b / 1000).toFixed(1)}`).join(' '));
  console.log('calls: ' + calls.filter((c) => c.t < trials[9].b).map((c) => `${c.dir}@${(c.t / 1000).toFixed(1)}(${c.turns.toFixed(1)})`).join(' '));
}

console.log('planes of the calls: ' + JSON.stringify(calls.reduce((o, c) => { o[c.plane] = (o[c.plane] || 0) + 1; return o; }, {})) + (api.live.off && api.live.off[2] ? `; phone clock offset ${api.live.off[2].toFixed(2)} Hz` : ''));
