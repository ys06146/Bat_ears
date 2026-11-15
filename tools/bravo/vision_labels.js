// Auto-labels from the webcam track (teach sessions): per guided segment (trials) the vision hand path -> a motion label,
// compared with the prompt. These labels are the ground truth for the acoustic detectors / circle tokens.
//   node vision_labels.js <teach base>      env: TILT (screen lean, deg; default from meta.screenAngle or 5), HFOV (70)
// Labels: rest (spread < 1.5 cm), lr / ud / fb (by the main axis x / y / z unless it is a circle),
//         cw_h / ccw_h / cw_v / ccw_v (l2/l1 >= 0.08 and >= 0.8 turn in the best-fit plane; plane by its normal: up -> h, screen -> v;
//         clockwise as the user sees it: horizontal from above with the screen side up, vertical facing the screen)
//         push / pull: a straight z segment whose first big move goes toward (+z) / away from the screen
const fs = require('fs'), V = require('./vision3d.js'), BC = require('../../web/circle.js');
const base = process.argv[2], J = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), meta = J.meta || J;
const cam = meta.camera || meta.video || {}, IW = cam.width || 1280, IH = cam.height || 720;
const scrA = meta.screenAngle ?? meta.screen_angle_deg, tilt = Number(process.env.TILT ?? (Number.isFinite(scrA) ? scrA - 90 : 5)), hfov = Number(process.env.HFOV || 70);
const L = fs.readFileSync(base + '_vision.csv', 'utf8').trim().split(/\r?\n/), h = L[0].split(','), ix = Object.fromEntries(h.map((k, i) => [k, i]));
const fr = L.slice(1).map((l) => { const r = l.split(','), n = (k) => (ix[k] == null ? NaN : Number(r[ix[k]]));
  return { t: Number.isFinite(n('t_cap')) ? n('t_cap') : n('t_ms'), present: n('present') === 1, lm: Array.from({ length: 21 }, (_, j) => [n(`lm${j}_x`), n(`lm${j}_y`), 0]),
    wlm: Number.isFinite(n('wlm5_x')) ? Array.from({ length: 21 }, (_, j) => [n(`wlm${j}_x`), n(`wlm${j}_y`), n(`wlm${j}_z`)]) : null }; }).filter((f) => f.present);
const scale = V.sessionScale(fr, meta.palmWidthCm ?? meta.palm_width_cm ?? meta.palm_cm ?? null), lean = tilt * Math.PI / 180, mirrored = !!(meta.mirror ?? meta.mirrored ?? (meta.vision && meta.vision.mirrored));
const C = [0, 0.19 * Math.cos(lean), 0.10 + 0.19 * Math.sin(lean)];
const tr = fr.map((f) => { const c = V.handCam(f, { W: IW, H: IH, hfov, mirror: mirrored, scale }); return c ? { t: f.t, p: V.toLaptop(c, { tilt, C }) } : null; }).filter(Boolean);
function eig3(S) {
  const A = S.map((r) => r.slice()), Vv = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 50; it++) for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
    if (Math.abs(A[p][q]) < 1e-18) continue;
    const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
    for (let k = 0; k < 3; k++) { const x = A[k][p], y = A[k][q]; A[k][p] = c * x - s * y; A[k][q] = s * x + c * y; }
    for (let k = 0; k < 3; k++) { const x = A[p][k], y = A[q][k]; A[p][k] = c * x - s * y; A[q][k] = s * x + c * y; }
    for (let k = 0; k < 3; k++) { const x = Vv[k][p], y = Vv[k][q]; Vv[k][p] = c * x - s * y; Vv[k][q] = s * x + c * y; }
  }
  const idx = [0, 1, 2].sort((i, j) => A[j][j] - A[i][i]);
  return { val: idx.map((i) => A[i][i]), vec: idx.map((i) => [Vv[0][i], Vv[1][i], Vv[2][i]]) };
}
function label(seg) {
  if (seg.length < 10) return { lab: 'none' };
  let len = 0; for (let i = 1; i < seg.length; i++) len += Math.hypot(...seg[i].p.map((v, k) => v - seg[i - 1].p[k]));
  const m = [0, 1, 2].map((k) => seg.reduce((s, q) => s + q.p[k], 0) / seg.length);
  const S = [0, 1, 2].map((i) => [0, 1, 2].map((j) => seg.reduce((s, q) => s + (q.p[i] - m[i]) * (q.p[j] - m[j]), 0) / seg.length));
  const e = eig3(S), round = e.val[1] / Math.max(1e-12, e.val[0]), main = e.vec[0].map(Math.abs).indexOf(Math.max(...e.vec[0].map(Math.abs)));
  // rest: the hand's spread stays under ~1.5 cm (path length is useless: webcam jitter adds up)
  if (2 * Math.sqrt(Math.max(0, e.val[0])) < 0.015) return { lab: 'rest', len, round };
  // circle: >= 0.8 turn in the best-fit plane and not a straight line (partly visible circles look flat, so l2/l1 >= 0.08)
  if (round >= 0.08) {
    const n = e.vec[2], vertical = Math.abs(n[2]) > Math.abs(n[1]);
    const U = seg.map((q) => q.p[0]), W = seg.map((q) => (vertical ? q.p[1] : q.p[2]));
    const w = BC.analyze(seg.map((q) => q.t), U, W, { maxMs: 1e9, smoothMs: 150, vMin: 0.08 });   // 150 ms smoothing: webcam jitter must not add turns
    if (Math.abs(w.turns) >= 0.8) return { lab: `${w.turns < 0 ? 'cw' : 'ccw'}_${vertical ? 'v' : 'h'}`, turns: w.turns, round, len };
  }
  const ax = ['lr', 'ud', 'fb'][main];
  if (ax === 'fb') {   // first big move along z: toward the screen = push
    const z0 = seg[0].p[2]; let first = 0; for (const q of seg) if (Math.abs(q.p[2] - z0) > 0.03) { first = Math.sign(q.p[2] - z0); break; }
    return { lab: 'fb', dir: first > 0 ? 'push' : first < 0 ? 'pull' : '?', round, len };
  }
  return { lab: ax, round, len };
}
const trials = J.trials || [], conf = {};
// teach.html kinds -> labels; segment end from tEnd / durMs / dur
const KIND = { still: 'rest', hcw: 'cw_h', hccw: 'ccw_h', vcw: 'cw_v', vccw: 'ccw_v' };
const tEndOf = (t) => t.tEnd ?? t.tGo + (t.durMs ?? 1000 * (t.dur || 4));
let ok = 0, n = 0;
console.log(`${base.split(/[\\/]/).pop()}: ${tr.length} vision positions, tilt ${tilt}, scale ${scale.toFixed(3)}`);
for (const t of trials) {
  const seg = tr.filter((q) => q.t >= t.tGo && q.t <= tEndOf(t));
  const r = label(seg), want = KIND[t.kind] || t.kind;
  const got = r.lab === 'fb' && (want === 'push' || want === 'pull') ? r.dir : r.lab;
  const match = got === want || (want === 'still' && got === 'rest');
  (conf[want] ||= {})[got] = (conf[want][got] || 0) + 1;
  if (want !== 'free' && want !== 'wave') { n++; if (match) ok++; }
  if (process.env.V) console.log(`  ${want.padEnd(6)} -> ${got.padEnd(6)} ${r.turns != null ? 'turns ' + r.turns.toFixed(1) : ''} round ${r.round != null ? r.round.toFixed(2) : '-'} path ${r.len != null ? (100 * r.len).toFixed(0) : '-'} cm`);
}
console.log(`vision label = prompt: ${ok}/${n}`);
for (const [k, v] of Object.entries(conf)) console.log(`  ${k.padEnd(6)} ${Object.entries(v).map(([g, c]) => `${g}:${c}`).join(' ')}`);
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(trials.map((t) => { const seg = tr.filter((q) => q.t >= t.tGo && q.t <= tEndOf(t)); return { ...t, tEnd: tEndOf(t), vision: label(seg) }; })));
