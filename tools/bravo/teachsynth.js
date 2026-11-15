// Synthetic "teach" session: stereo WAV (L 18k, R 19.5k, optional phone 20.5k, 2 mics) + MediaPipe-like vision frames
// from the same hand track through a pinhole webcam at the top bezel. Tests teach_fit.js end to end.
//   node teachsynth.js <out base>    env: SWAP=1 (18k really from the RIGHT speaker), MIRROR=1 (image x mirrored),
//     TILT (deg, screen leaned back), HFOV (deg), PHONE "x,y,z" m, NOISE
const fs = require('fs');
const out = process.argv[2], rate = 48000;
let seed = Number(process.env.SEED || 21); const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const g = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const SPK = { L: [-0.15, -0.01, -0.08], R: [0.15, -0.01, -0.08] }, M = [[0.025, 0.19, 0.17], [-0.025, 0.19, 0.17]], CAM = [0, 0.195, 0.17];
const swap = process.env.SWAP === '1', mirror = process.env.MIRROR === '1', tilt = Number(process.env.TILT || 20) * Math.PI / 180, hfov = Number(process.env.HFOV || 70) * Math.PI / 180;
const PH = process.env.PHONE ? process.env.PHONE.split(',').map(Number) : null, noise = Number(process.env.NOISE || 0.003);
const H0 = [0, 0.12, 0.0], add = (a, b, s = 1) => a.map((v, i) => v + s * b[i]), sub = (a, b) => a.map((v, i) => v - b[i]);
const ease = (s) => { s = Math.min(1, Math.max(0, s)); return s * s * (3 - 2 * s); };
// guided steps (like teach.html): kind, duration s
const plan = [['rest', 4], ['lr', 6], ['ud', 6], ['fb', 6], ['cw_h', 4], ['ccw_h', 4], ['cw_v', 4], ['ccw_v', 4], ['push', 3], ['pull', 3], ['cw_h', 4], ['ccw_v', 4], ['lr', 6], ['ud', 6]];
const trials = []; let t0 = 1.0; for (const [k, d] of plan) { trials.push({ kind: k, tGo: Math.round(t0 * 1000), dur: d }); t0 += d + 1.5; }
const T = t0 + 1, N = Math.round(T * rate);
function hand(t) {
  let q = null; for (const x of trials) if (t * 1000 >= x.tGo) q = x;
  if (!q) return H0;
  const u = t - q.tGo / 1000, k = q.kind, env = ease(u / 0.4) * (1 - ease((u - q.dur + 0.4) / 0.4));
  const osc = (A, f) => A * Math.sin(2 * Math.PI * f * u) * env;
  if (k === 'lr') return add(H0, [osc(0.12, 0.5), 0, 0]);
  if (k === 'ud') return add(H0, [0, osc(0.07, 0.5) + 0.03 * env, 0]);
  if (k === 'fb') return add(H0, [0, 0, osc(0.08, 0.5)]);
  if (k === 'push' || k === 'pull') return add(H0, [0, 0, (k === 'push' ? 1 : -1) * 0.10 * (ease(u / 0.5) - ease((u - 1.2) / 1.0))]);
  if (k === 'rest') return H0;
  const v = k.endsWith('_v'), sg = k.startsWith('cw') ? 1 : -1, r = 0.07, a = -Math.PI / 2 - sg * 2 * Math.PI * 0.7 * Math.max(0, u - 0.3) * (u < q.dur - 0.5 ? 1 : 0);
  const b0 = [1, 0, 0], b1 = v ? [0, 1, 0] : [0, 0, 1];
  const c = add(H0, b1, r), p = add(add(c, b0, r * Math.cos(a)), b1, r * Math.sin(a));
  return add(H0, sub(p, H0), env);
}
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const src = [{ S: swap ? SPK.R : SPK.L, f: 18000 }, { S: swap ? SPK.L : SPK.R, f: 19500 }];
if (PH) src.push({ S: PH, f: 20500 * (1 + 25e-6) });
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
// vision: pinhole camera at CAM looking toward the user (-z), tilted up by `tilt` (screen leaned back); image 1280x720
const W = 1280, Hh = 720, f = (W / 2) / Math.tan(hfov / 2), palm = 0.08, vision = [];
for (let t = 0; t < T; t += 1 / 30) {
  const h = hand(t), d = sub(h, CAM);
  // camera frame: xc right (as the user sees the laptop), yc up, zc forward (toward the user); tilt about x
  const zc0 = -d[2], yc0 = d[1];
  const zc = zc0 * Math.cos(tilt) + yc0 * Math.sin(tilt), yc = -zc0 * Math.sin(tilt) + yc0 * Math.cos(tilt), xc = -d[0];   // the camera faces the user: user's right = image left
  const u = 0.5 + (mirror ? -1 : 1) * f * xc / zc / W + 0.002 * g(), v = 0.5 - f * yc / zc / Hh + 0.002 * g();
  const wpx = f * palm / zc * (1 + 0.03 * g());
  // minimal landmark set: 0 wrist, 5 index MCP, 9 middle MCP, 13 ring MCP, 17 pinky MCP around the palm centre
  const lm = Array.from({ length: 21 }, () => [u, v, 0]);
  lm[5] = [u - 0.5 * wpx / W, v - 0.02, 0]; lm[17] = [u + 0.5 * wpx / W, v - 0.02, 0]; lm[0] = [u, v + 0.04, 0];
  const wl = Array.from({ length: 21 }, () => [0, 0, 0]); wl[5] = [-palm / 2, 0, 0]; wl[17] = [palm / 2, 0, 0];
  vision.push([+(t * 1000).toFixed(1), +(t * 1000 + 35).toFixed(1), 1, 'Right', 0.98, lm.map((p) => p.map((x) => +x.toFixed(4))), wl]);
}
fs.writeFileSync(out + '.json', JSON.stringify({ meta: { stereoPair: [18000, 19500], wav: { t0: 0, rate, channels: 2 }, video: { width: W, height: Hh, frameRate: 30 }, phone: PH ? { hz: 20500, pos_cm: PH.map((v) => v * 100) } : null,
  synth: { swap, mirror, tilt: tilt * 180 / Math.PI, hfov: hfov * 180 / Math.PI } }, trials, vision, visionFields: ['t_cap', 't_res', 'present', 'handedness', 'score', 'landmarks', 'worldLandmarks'] }));
console.log(`wrote ${out} (${T.toFixed(0)} s, ${vision.length} vision frames, swap ${swap}, mirror ${mirror}, tilt ${process.env.TILT || 20}, phone ${!!PH})`);
