// Synthetic teach.html session in alpha's final format: <out>.wav (2 mics; L/R laptop tones, phones), <out>.json
// (meta: camera, mirror false, stereoFreqs, screenAngle, palmWidthCm, phones[]; trials) and <out>_vision.csv
// (t_cap, t_res, present, lm*_x/y/z, wlm*_x/y/z). A 21-point hand facing the webcam; the webcam faces the user (image
// right = laptop -x), leaned back with the screen. Truth hand path in <out>.truth.json.
//   node teachsynth2.js <out base>   env: SWAP=1 (18k from the right speaker), PHONES=0|1|2, LEAN (deg), NOISE, LMN (landmark noise)
const fs = require('fs');
const out = process.argv[2], rate = 48000;
let seed = Number(process.env.SEED || 31); const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const g = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const add = (a, b, s = 1) => a.map((v, i) => v + s * b[i]), sub = (a, b) => a.map((v, i) => v - b[i]), dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const ease = (s) => { s = Math.min(1, Math.max(0, s)); return s * s * (3 - 2 * s); };
const swap = process.env.SWAP === '1', nPh = Number(process.env.PHONES ?? 2), lean = Number(process.env.LEAN || 5), noise = Number(process.env.NOISE || 0.003), lmn = Number(process.env.LMN || 0.0015);
const SPK = { L: [-0.15, -0.01, -0.08], R: [0.15, -0.01, -0.08] };
const r = lean * Math.PI / 180, C = [0, 0.19 * Math.cos(r), 0.10 + 0.19 * Math.sin(r)], M = [[0.025, C[1], C[2]], [-0.025, C[1], C[2]]];
const PHONES = [{ id: 'A', hz: 20500, x_right_cm: 25, h_cm: 25, z_front_cm: -2 }, { id: 'B', hz: 21500, x_right_cm: -25, h_cm: 40, z_front_cm: -2 }].slice(0, nPh);
const phonePos = (p) => [p.x_right_cm / 100, p.h_cm / 100 - 0.015, 0.10 - p.z_front_cm / 100];
// schedule like teach.html
const plan = [['rest', 5], ['lr', 6], ['ud', 6], ['fb', 6], ['cw_h', 5], ['ccw_h', 5], ['cw_v', 5], ['ccw_v', 5], ['push', 4], ['pull', 4], ['lr', 6], ['ud', 6], ['cw_v', 5], ['ccw_h', 5], ['rest', 4]];
const trials = []; let tt = 1.0; for (const [k, d] of plan) { trials.push({ kind: k, tGo: Math.round(tt * 1000), dur: d }); tt += d + 2; }
const T = tt + 1, N = Math.round(T * rate), H0 = (process.env.H0 || '0,0.18,-0.25').split(',').map(Number);
function hand(t) {
  let q = null; for (const x of trials) if (t * 1000 >= x.tGo) q = x;
  if (!q) return H0;
  const u = t - q.tGo / 1000, k = q.kind, env = ease(u / 0.4) * (1 - ease((u - q.dur + 0.4) / 0.4)), osc = (A, f) => A * Math.sin(2 * Math.PI * f * u) * env;
  if (u > q.dur) return H0;
  if (k === 'lr') return add(H0, [osc(0.10, 0.6), 0, 0]);
  if (k === 'ud') return add(H0, [0, osc(0.06, 0.6), 0]);
  if (k === 'fb') return add(H0, [0, 0, osc(0.07, 0.6)]);
  if (k === 'push' || k === 'pull') return add(H0, [0, 0, (k === 'push' ? 1 : -1) * osc(0.08, 0.7)]);
  if (k === 'rest') return H0;
  const v = k.endsWith('_v'), sg = k.startsWith('cw') ? 1 : -1, rad = 0.06, a = -Math.PI / 2 - sg * 2 * Math.PI * 0.8 * u;
  const b1 = v ? [0, 1, 0] : [0, 0, 1], c = add(H0, b1, rad);
  return add(H0, sub(add(add(c, [1, 0, 0], rad * Math.cos(a)), b1, rad * Math.sin(a)), H0), env);
}
// ---------------------------------------------------------------- audio
const src = [{ S: swap ? SPK.R : SPK.L, f: 18000 }, { S: swap ? SPK.L : SPK.R, f: 19500 }, ...PHONES.map((p, i) => ({ S: phonePos(p), f: p.hz * (1 + (i ? -18e-6 : 25e-6)) }))];
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const t = i / rate, h = hand(t);
  for (let c = 0; c < 2; c++) {
    let v = 0;
    for (const s of src) { const dd = d3(s.S, M[c]), a = d3(h, s.S), b = d3(h, M[c]); v += 0.02 / dd * Math.cos(2 * Math.PI * s.f * (t - dd / 343)) + 0.0004 / (a * b) * Math.cos(2 * Math.PI * s.f * (t - (a + b) / 343)); }
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((v + noise * g()) * 32768))), 44 + 4 * i + 2 * c);
  }
}
fs.writeFileSync(out + '.wav', buf);
// ---------------------------------------------------------------- vision: 21-point hand, palm toward the camera, fingers up
const HAND = [[0, 0, 0], [0.025, 0.02, 0], [0.04, 0.04, 0], [0.05, 0.06, 0], [0.06, 0.075, 0], [0.03, 0.09, 0], [0.035, 0.12, 0], [0.037, 0.14, 0], [0.038, 0.16, 0],
  [0.01, 0.095, 0], [0.01, 0.13, 0], [0.01, 0.155, 0], [0.01, 0.175, 0], [-0.012, 0.09, 0], [-0.013, 0.12, 0], [-0.014, 0.143, 0], [-0.015, 0.16, 0], [-0.032, 0.08, 0], [-0.036, 0.1, 0], [-0.038, 0.117, 0], [-0.04, 0.13, 0]];
const palm = Math.hypot(...sub(HAND[5], HAND[17]));
const Wd = 1280, Hd = 720, hfov = 70, f = (Wd / 2) / Math.tan(hfov * Math.PI / 360);
const ax = { x: [-1, 0, 0], y: [0, -Math.cos(r), -Math.sin(r)], z: [0, Math.sin(r), -Math.cos(r)] };   // camera: image right, image down, forward
const head = ['t_cap', 't_res', 'cap_src', 'present', 'hand', 'score', ...Array.from({ length: 21 }, (_, j) => [`lm${j}_x`, `lm${j}_y`, `lm${j}_z`]).flat(), ...Array.from({ length: 21 }, (_, j) => [`wlm${j}_x`, `wlm${j}_y`, `wlm${j}_z`]).flat()];
const lines = [head.join(',')], truth = [];
let vis = 0, tot = 0;
for (let t = 0; t < T; t += 1 / 30) {
  const P = hand(t), wob = 0.25 * Math.sin(0.5 * t), fy = [Math.sin(wob), Math.cos(wob), 0], fz = [0, 0, -1], fx = [fy[1] * fz[2] - fy[2] * fz[1], fy[2] * fz[0] - fy[0] * fz[2], fy[0] * fz[1] - fy[1] * fz[0]];
  const pts = HAND.map((q) => add(add(add(P, fx, q[0] - 0.01), fy, q[1] - 0.09), fz, q[2]));
  const cen = pts.reduce((s, p) => add(s, p, 1 / 21), [0, 0, 0]);
  truth.push([+(t * 1000).toFixed(1), ...cen.map((x) => +x.toFixed(4))]);
  const cam = pts.map((p) => { const d = sub(p, C); return [dot(d, ax.x), dot(d, ax.y), dot(d, ax.z)]; });
  const img = cam.map((c) => [0.5 + f * c[0] / c[2] / Wd + lmn * g(), 0.5 + f * c[1] / c[2] / Hd + lmn * g(), 0]);
  const ok = cam.every((c) => c[2] > 0.05) && img.every((p) => p[0] > 0 && p[0] < 1 && p[1] > 0 && p[1] < 1);
  tot++; const tc = (t * 1000).toFixed(1);
  if (!ok) { lines.push([tc, tc, 'c', 0, '', '', ...new Array(126).fill('')].join(',')); continue; }
  vis++;
  const cm = cam.reduce((s, c) => add(s, c, 1 / 21), [0, 0, 0]), wl = cam.map((c) => sub(c, cm).map((x) => 0.94 * x + 0.002 * g()));
  lines.push([tc, (t * 1000 + 40).toFixed(1), 'c', 1, 'Right', 0.97, ...img.flat().map((x) => x.toFixed(4)), ...wl.flat().map((x) => x.toFixed(4))].join(','));
}
fs.writeFileSync(out + '_vision.csv', lines.join('\n'));
fs.writeFileSync(out + '.truth.json', JSON.stringify(truth));
fs.writeFileSync(out + '.json', JSON.stringify({ meta: { camera: { width: Wd, height: Hd, frameRate: 30 }, mirror: false, stereoFreqs: [18000, 19500], stereoPair: [18000, 19500], screenAngle: 90 + lean,
  palmWidthCm: +(100 * palm).toFixed(1), phones: PHONES, wav: { t0: 0, capped: false }, synth: { swap, hfov, lean } }, trials }));
console.log(`wrote ${out}: ${T.toFixed(0)} s, hand visible ${Math.round(100 * vis / tot)}%, swap ${swap}, phones ${nPh}, lean ${lean}`);
