// Synthetic multi-view vision for mvcalib.js: a 21-point hand moving along a path, seen by the laptop webcam and two
// phones. Writes <out>_<view>_vision.csv (teach.html columns: t_cap, t_res, present, hand, score, lm*_x/y/z, wlm*_x/y/z)
// and <out>_views.json (truth: camera poses, focal lengths, phone clock offsets, the hand track).
// MediaPipe conventions assumed: image x right, y down (0..1); world landmarks in m around the hand centre with
// camera-aligned axes (x right, y down, z away from the camera), scale = an average hand (here 6 % too small).
//   node mvsynth.js <out base>
const fs = require('fs');
const out = process.argv[2];
let seed = 5; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const g = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const add = (a, b, s = 1) => a.map((v, i) => v + s * b[i]), sub = (a, b) => a.map((v, i) => v - b[i]), dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], unit = (a) => { const n = Math.hypot(...a); return a.map((v) => v / n); };
// hand model (m) in a hand frame: x toward the thumb side, y toward the fingers, z out of the palm (down = -y world when flat)
const HAND = [[0, 0, 0], [0.025, 0.02, 0], [0.04, 0.04, 0], [0.05, 0.06, 0], [0.06, 0.075, 0], [0.03, 0.09, 0], [0.035, 0.12, 0], [0.037, 0.14, 0], [0.038, 0.16, 0],
  [0.01, 0.095, 0], [0.01, 0.13, 0], [0.01, 0.155, 0], [0.01, 0.175, 0], [-0.012, 0.09, 0], [-0.013, 0.12, 0], [-0.014, 0.143, 0], [-0.015, 0.16, 0], [-0.032, 0.08, 0], [-0.036, 0.1, 0], [-0.038, 0.117, 0], [-0.04, 0.13, 0]];
const PALM_W = Math.hypot(...sub(HAND[5], HAND[17]));
// hand path in laptop frame (x right, y up, z toward the screen): circles + up/down + left/right
const H0 = (process.env.H0 || '0,0.18,-0.12').split(',').map(Number);
const handPos = (t) => [0.10 * Math.sin(2 * Math.PI * 0.23 * t), 0.05 * Math.sin(2 * Math.PI * 0.31 * t + 1), 0.07 * Math.sin(2 * Math.PI * 0.17 * t + 2)].map((v, i) => v + H0[i]);
// palm faces down, fingers point toward the screen, small wobble
function handPose(t) {
  const yaw = 0.3 * Math.sin(0.4 * t), pitch = 0.2 * Math.sin(0.3 * t + 1);
  const fy = unit([Math.sin(yaw), Math.sin(pitch), Math.cos(yaw)]), up = [0, 1, 0], fx = unit(cross(fy, up)), fz = cross(fx, fy);
  return { fx, fy, fz };
}
// cameras: position, look-at, image size, horizontal FOV; laptop webcam faces the user (tilted up 20 deg)
function lookAt(C, target, upHint = [0, 1, 0]) { const zc = unit(sub(target, C)), xc = unit(cross(zc, upHint)), yc = cross(zc, xc); return { C, xc, yc, zc }; }
const tilt = Number(process.env.TILT || 5) * Math.PI / 180;
const VIEWS = {
  laptop: { ...lookAt([0, 0.195, 0.17], add([0, 0.195, 0.17], [0, Math.sin(tilt), -Math.cos(tilt)])), W: 1280, H: 720, hfov: 70, off: 0 },
  phoneA: { ...lookAt([0.25, 0.25, 0.12], H0), W: 1280, H: 720, hfov: 66, off: 12345.6 },
  phoneB: { ...lookAt([-0.25, 0.40, 0.12], H0), W: 1280, H: 720, hfov: 74, off: -8020.3 },
};
// laptop camera axes: as the camera sees it, image x right = laptop -x (it faces the user); lookAt gives xc = zc x up
const T = 90, rows = {};
for (const [name, v] of Object.entries(VIEWS)) rows[name] = [];
const track = [];
for (let t = 0; t < T; t += 1 / 30) {
  const P = handPos(t), R = handPose(t), pts = HAND.map((q) => add(add(add(P, R.fx, q[0] - 0.01), R.fy, q[1] - 0.09), R.fz, q[2]));
  track.push([+(t * 1000).toFixed(1), ...P.map((x) => +x.toFixed(4))]);
  for (const [name, v] of Object.entries(VIEWS)) {
    const f = (v.W / 2) / Math.tan(v.hfov * Math.PI / 360);
    const cam = pts.map((p) => { const d = sub(p, v.C); return [dot(d, v.xc), dot(d, v.yc), dot(d, v.zc)]; });   // x right, y down, z forward
    if (cam.some((c) => c[2] < 0.05)) { rows[name].push([t, 0]); continue; }
    const img = cam.map((c) => [0.5 + f * c[0] / c[2] / v.W + 0.0015 * g(), 0.5 + f * c[1] / c[2] / v.H + 0.0015 * g(), 0]);
    if (img.some((p) => p[0] < 0 || p[0] > 1 || p[1] < 0 || p[1] > 1)) { rows[name].push([t, 0]); continue; }
    const cm = cam.reduce((s, c) => add(s, c, 1 / 21), [0, 0, 0]);
    const wl = cam.map((c) => sub(c, cm).map((x) => 0.94 * x + 0.002 * g()));   // average-hand scale (6 % small) + noise
    rows[name].push([t, 1, img, wl]);
  }
}
for (const [name, v] of Object.entries(VIEWS)) {
  const head = ['t_cap', 't_res', 'present', 'hand', 'score', ...Array.from({ length: 21 }, (_, j) => [`lm${j}_x`, `lm${j}_y`, `lm${j}_z`]).flat(), ...Array.from({ length: 21 }, (_, j) => [`wlm${j}_x`, `wlm${j}_y`, `wlm${j}_z`]).flat()];
  const lines = [head.join(',')];
  for (const r of rows[name]) {
    const tc = (r[0] * 1000 - v.off).toFixed(1);   // the phone's own clock: laptop = phone + off
    if (!r[1]) { lines.push([tc, tc, 0, '', '', ...new Array(126).fill('')].join(',')); continue; }
    lines.push([tc, (Number(tc) + 40).toFixed(1), 1, 'Right', 0.97, ...r[2].flat().map((x) => x.toFixed(4)), ...r[3].flat().map((x) => x.toFixed(4))].join(','));
  }
  fs.writeFileSync(`${out}_${name}_vision.csv`, lines.join('\n'));
}
fs.writeFileSync(`${out}_views.json`, JSON.stringify({ views: Object.fromEntries(Object.entries(VIEWS).map(([k, v]) => [k, { C: v.C, W: v.W, H: v.H, hfov: v.hfov, clockOffsetMs: v.off }])), palmWidthCm: +(100 * PALM_W).toFixed(1), track }));
console.log(`wrote ${out}_{laptop,phoneA,phoneB}_vision.csv, palm width ${(100 * PALM_W).toFixed(1)} cm; visible: ${Object.entries(rows).map(([k, r]) => k + ' ' + Math.round(100 * r.filter((x) => x[1]).length / r.length) + '%').join(', ')}`);
