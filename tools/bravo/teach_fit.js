// Webcam as the teacher: fit the acoustic geometry from vision, then score audio -> hand position against vision.
//   node teach_fit.js <session base>      (base.wav + base.json, vision from base_vision.csv (teach.html) or json.vision)
//   env: PHONE=0 to ignore a phone tone, WIN (ms, default 250), SPLIT (train fraction, default 0.5)
// Steps
//  1. vision -> 3D hand (laptop frame x right, y up, z toward the screen): palm centre (landmarks 0,5,9,13,17), depth from
//     the palm width (world landmarks 5-17, m) over its image width (px) through a pinhole with horizontal FOV hfov;
//     camera at the top bezel centre, facing the user, tilted up by the screen lean `tilt`; image maybe mirrored.
//  2. acoustic: per tone x mic channel phase path steps from the WAV (phone tone through the PLL).
//  3. geometry: over sliding windows, path change measured vs |H - S| + |H - M| change predicted from the vision track;
//     per path the source S (3D) by Gauss-Newton; camera (mirror, tilt, hfov) and the vision lag by grid search.
//     -> where each tone really comes from (L / R swap), and how well each path agrees with vision.
//  4. audio -> position: physics (linear solve with the FITTED geometry) and learned (ridge on path changes), trained on
//     the first SPLIT of the session, error in cm against vision on the rest, per axis, for window displacements.
const fs = require('fs');
const P = require('./phase.js'), PH = require('./phone.js');
const base = process.argv[2];
const J = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
const meta = J.meta || J;
const wav = P.readWav(base + '.wav');
const t0 = (meta.wav && meta.wav.t0) ?? (J.wav && J.wav.t0) ?? 0;
const F = meta.stereoPair || meta.stereoFreqs || (meta.engine && meta.engine.stereoFreqs) || [18000, 19500];
const phoneMeta = meta.phone && (meta.phone.on !== false) && process.env.PHONE !== '0' ? meta.phone : null;
const vid = meta.video || meta.camera || {}, IW = vid.width || 1280, IH = vid.height || 720;
const WIN = Number(process.env.WIN || 250), SPLIT = Number(process.env.SPLIT || 0.5);
// ---------------------------------------------------------------- vision frames -> { t, lm[21][3], wlm[21][3] }
function loadVision() {
  const csv = base + '_vision.csv';
  if (fs.existsSync(csv)) {
    const L = fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/), h = L[0].split(','), ix = Object.fromEntries(h.map((k, i) => [k, i]));
    const num = (r, k) => (ix[k] == null ? NaN : Number(r[ix[k]]));
    return L.slice(1).map((l) => { const r = l.split(','); const t = Number.isFinite(num(r, 't_cap')) ? num(r, 't_cap') : num(r, 't_ms');
      const lm = Array.from({ length: 21 }, (_, j) => [num(r, `lm${j}_x`), num(r, `lm${j}_y`), num(r, `lm${j}_z`)]);
      const wlm = Number.isFinite(num(r, 'wlm5_x')) ? Array.from({ length: 21 }, (_, j) => [num(r, `wlm${j}_x`), num(r, `wlm${j}_y`), num(r, `wlm${j}_z`)]) : null;
      return { t, present: num(r, 'present') === 1, lm, wlm }; }).filter((f) => f.present && Number.isFinite(f.lm[5][0]));
  }
  const fields = J.visionFields || ['t_cap', 't_res', 'present', 'handedness', 'score', 'landmarks', 'worldLandmarks'], k = (n) => fields.indexOf(n);
  return (J.vision || []).map((r) => ({ t: r[k('t_cap')], present: !!r[k('present')], lm: r[k('landmarks')], wlm: r[k('worldLandmarks')] })).filter((f) => f.present);
}
const vis = loadVision();
const V = require('./vision3d.js');
const mirrorMeta = meta.mirror ?? meta.mirrored ?? (meta.vision && meta.vision.mirrored) ?? (meta.video && meta.video.mirror) ?? (meta.camera && meta.camera.mirror);
const palmCm = meta.palmWidthCm ?? meta.palm_width_cm ?? meta.palm_cm ?? meta.palmCm ?? null;
const scale = V.sessionScale(vis, palmCm);
// screen: hinge at z = 0.10 m, SCREEN_H tall, leaned back `lean` deg from vertical; webcam 1 cm below the top edge
const scrA = meta.screenAngle ?? meta.screen_angle_deg, SCREEN_H = 0.20, leanMeta = Number.isFinite(scrA) ? scrA - 90 : null;
const camAt = (lean) => { const r = lean * Math.PI / 180; return [0, (SCREEN_H - 0.01) * Math.cos(r), 0.10 + (SCREEN_H - 0.01) * Math.sin(r)]; };
function visionTrack({ mirror, tilt, hfov }) {
  const C = camAt(tilt);
  return vis.map((fr) => { const c = V.handCam(fr, { W: IW, H: IH, hfov, mirror, scale, method: 'pnp' }); return c ? { t: fr.t, H: V.toLaptop(c, { tilt, C }) } : null; }).filter(Boolean);
}
// ---------------------------------------------------------------- acoustic path steps
const chans = wav.C > 1 ? [0, 1] : [0];
const src = [{ key: '18k', f: F[0] }, { key: '19.5k', f: F[1] }];
// phones: meta.phones [{ id, hz, x_right_cm, h_cm (above the desk), z_front_cm (in front of the screen line) }] or meta.phone
const phoneList = process.env.PHONE === '0' ? [] : (meta.phones || (phoneMeta ? [phoneMeta] : [])).filter((p) => p && p.on !== false && p.heard !== false);
const DEFPOS = { A: [25, 25, -2], B: [-25, 40, -2] };   // the agreed placement, when the session didn't record it
for (const p of phoneList) {
  const d = DEFPOS[p.id] || [25, 25, -2], x = p.x_right_cm ?? d[0], hh = p.h_cm ?? d[1], zf = p.z_front_cm ?? d[2];
  const g = p.pos_cm ? p.pos_cm.map((v) => v / 100) : [x / 100, hh / 100 - 0.015, 0.10 - zf / 100];
  if (!Number.isFinite(p.x_right_cm)) console.log(`  (phone ${p.id}: position not recorded, starting from the agreed ${x}/${hh}/${zf} cm)`);
  src.push({ key: `phone ${p.id || ''} ${p.hz || 20500}`.replace(/\s+/g, ' '), f: p.hz || 20500, pll: true, guess: g });
}
const paths = [];
for (const s of src) for (const c of chans) paths.push({ src: s, c, st: (s.pll ? PH.pathStepsPLL : P.pathSteps)(P.baseband(wav.ch[c], wav.rate, s.f), s.f, { gate: 1.5 }) });
const rate = paths[0].st.rate, nS = paths[0].st.step.length;
const cum = paths.map((p) => { const a = new Float64Array(nS + 1); for (let k = 0; k < nS; k++) a[k + 1] = a[k] + p.st.step[k]; return a; });
const Dat = (i, tms) => { const k = Math.max(0, Math.min(nS, Math.round((tms - t0) / 1000 * rate))); return cum[i][k]; };
// mics: horizontal pair at the top bezel next to the webcam (ch0 = right, from the static phase); set per camera tilt
let MIC = [[0.025, 0.19, 0.17], [-0.025, 0.19, 0.17]];
const setMics = (tilt) => { const C = camAt(tilt); MIC = [[0.025, C[1], C[2]], [-0.025, C[1], C[2]]]; };
const sub = (a, b) => a.map((v, i) => v - b[i]), nrm = (a) => Math.hypot(...a);
// ---------------------------------------------------------------- windows (vision pairs WIN apart, both with a hand)
const NEAR = Number(process.env.NEAR || 0.45);   // m from the webcam
let CAMPOS = [0, 0.19, 0.12];
function windows(track, lag) {
  const out = [];
  for (let i = 0, j = 0; i < track.length; i++) {
    while (j < track.length && track[j].t < track[i].t + WIN) j++;
    if (j >= track.length) break;
    if (track[j].t - track[i].t > WIN + 60) continue;     // a gap in the hand track
    const a = track[i], b = track[j], dH = nrm(sub(b.H, a.H));
    if (dH < 0.01 || dH > 0.5) continue;                  // moving (>= 1 cm), not a tracking jump
    if (nrm(sub(a.H, CAMPOS)) > NEAR || nrm(sub(b.H, CAMPOS)) > NEAR) continue;   // hand near the laptop only
    out.push({ a, b, dD: paths.map((_, p) => Dat(p, b.t + lag) - Dat(p, a.t + lag)) });
  }
  return out;
}
// per-path source fit: minimise sum (dD - d(|H-S| + |H-M|))^2 over windows, Huber-weighted, Gauss-Newton on S
function fitSource(ws, p, S0) {
  let S = S0.slice(), G = 1; const M = MIC[paths[p].c];
  const model = (H, S) => nrm(sub(H, S)) + nrm(sub(H, M));
  let cost = 0;
  for (let it = 0; it < 20; it++) {
    // gain in closed form for the current S, then a Gauss-Newton step on S with that gain
    let sxy = 0, sxx = 0; for (const w of ws) { const pr = model(w.b.H, S) - model(w.a.H, S); sxy += w.dD[p] * pr; sxx += pr * pr; }
    G = Math.max(0.05, Math.min(2, sxy / Math.max(1e-12, sxx)));
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], g = [0, 0, 0]; cost = 0;
    for (const w of ws) {
      const pr = G * (model(w.b.H, S) - model(w.a.H, S)), r = w.dD[p] - pr;
      const ua = sub(S, w.a.H).map((v) => v / nrm(sub(S, w.a.H))), ub = sub(S, w.b.H).map((v) => v / nrm(sub(S, w.b.H)));
      const Jr = ub.map((v, i) => G * (v - ua[i]));       // d pr / d S
      const hw = Math.abs(r) < 0.01 ? 1 : 0.01 / Math.abs(r); cost += hw * r * r;
      for (let i = 0; i < 3; i++) { g[i] += hw * Jr[i] * r; for (let j = 0; j < 3; j++) A[i][j] += hw * Jr[i] * Jr[j]; }
    }
    for (let i = 0; i < 3; i++) A[i][i] += 1e-3 * ws.length;    // keep S near the guess where data can't decide
    const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
    if (!det) break;
    const sol = [0, 1, 2].map((c) => { const Mx = A.map((r, i) => r.map((v, j) => (j === c ? g[i] : v))); return (Mx[0][0] * (Mx[1][1] * Mx[2][2] - Mx[1][2] * Mx[2][1]) - Mx[0][1] * (Mx[1][0] * Mx[2][2] - Mx[1][2] * Mx[2][0]) + Mx[0][2] * (Mx[1][0] * Mx[2][1] - Mx[1][1] * Mx[2][0])) / det; });
    S = S.map((v, i) => v + Math.max(-0.05, Math.min(0.05, sol[i])));
  }
  // explained fraction of the path-change variance
  let ss = 0, sr = 0; const M2 = MIC[paths[p].c];
  for (const w of ws) { const pr = G * ((nrm(sub(w.b.H, S)) + nrm(sub(w.b.H, M2))) - (nrm(sub(w.a.H, S)) + nrm(sub(w.a.H, M2)))); ss += w.dD[p] ** 2; sr += (w.dD[p] - pr) ** 2; }
  return { S, G, cost, r2: 1 - sr / Math.max(1e-12, ss) };
}
const GUESS = { '18k': [[-0.15, -0.01, -0.08], [0.15, -0.01, -0.08]], '19.5k': [[0.15, -0.01, -0.08], [-0.15, -0.01, -0.08]] };
function fitAll(cam, lag) {
  setMics(cam.tilt); CAMPOS = camAt(cam.tilt);
  const tr = visionTrack(cam), ws = windows(tr, lag);
  if (ws.length < 30) return null;
  // geometry from the TRAINING part only (the held-out part stays unseen by every fitted number)
  const cutT = ws[Math.floor(SPLIT * ws.length)].a.t, wtr = ws.filter((w) => w.b.t < cutT);
  const res = paths.map((p, i) => {
    const guesses = p.src.guess ? [p.src.guess] : GUESS[p.src.key];
    return guesses.map((g0) => fitSource(wtr, i, g0)).sort((a, b) => a.cost - b.cost)[0];
  });
  return { cam, lag, tr, ws, res, cost: res.reduce((s, r) => s + r.cost, 0), r2: res.reduce((s, r) => s + r.r2, 0) / res.length };
}
console.log(`${base.split(/[\\/]/).pop()}: vision ${vis.length} frames (${(vis.length / Math.max(1, (vis[vis.length - 1].t - vis[0].t) / 1000)).toFixed(0)} fps), WAV ${wav.C} ch ${(wav.frames / wav.rate).toFixed(0)} s, ${paths.length} paths (${src.map((x) => x.key).join(', ')}), palm ${palmCm ?? '?'} cm -> scale ${scale.toFixed(3)}`);
let best = null;
const mirrors = mirrorMeta == null ? [false, true] : [!!mirrorMeta];
const tilts = leanMeta != null ? [leanMeta - 5, leanMeta, leanMeta + 5] : [0, 5, 10, 20];
const hfovs = (process.env.HFOVS || '60,66,72,78').split(',').map(Number);
for (const mirror of mirrors) for (const tilt of tilts) for (const hfov of hfovs) for (const lag of [-60, -30, 0, 30, 60]) {
  const r = fitAll({ mirror, tilt, hfov }, lag);
  if (r && (!best || r.r2 > best.r2)) best = r;
}
if (!best) { console.log('not enough moving vision windows'); process.exit(1); }
for (const lag of [best.lag - 20, best.lag + 20]) { const r = fitAll(best.cam, lag); if (r && r.r2 > best.r2) best = r; }
console.log(`camera fit: mirror ${best.cam.mirror}, tilt ${best.cam.tilt} deg, hfov ${best.cam.hfov} deg, audio lag ${best.lag} ms; ${best.ws.length} windows of ${WIN} ms`);
best.res.forEach((r, i) => console.log(`  path ${paths[i].src.key} -> mic${paths[i].c}: source at (${r.S.map((v) => (100 * v).toFixed(0)).join(', ')}) cm, gain ${(r.G ?? 1).toFixed(2)}, vision explains ${(100 * r.r2).toFixed(0)}% of its path changes`));
const sx = best.res.filter((_, i) => paths[i].src.key === '18k').map((r) => r.S[0]), sxr = best.res.filter((_, i) => paths[i].src.key === '19.5k').map((r) => r.S[0]);
console.log(`  -> 18 kHz comes from the ${sx.reduce((a, b) => a + b, 0) > 0 ? 'RIGHT' : 'LEFT'} side, 19.5 kHz from the ${sxr.reduce((a, b) => a + b, 0) > 0 ? 'RIGHT' : 'LEFT'} side`);
// ---------------------------------------------------------------- audio -> displacement, held out
const ws = best.ws, cut = ws[Math.floor(SPLIT * ws.length)].a.t, train = ws.filter((w) => w.b.t < cut), test = ws.filter((w) => w.a.t >= cut);
const dHv = (w) => sub(w.b.H, w.a.H);
function physics(useIdx) {
  // linear solve at each window's start position with the fitted sources, rows = paths in useIdx
  return (w) => {
    const H = w.a.H, Jm = useIdx.map((p) => { const S = best.res[p].S, M = MIC[paths[p].c], a = sub(H, S), b = sub(H, M), G = best.res[p].G ?? 1; return a.map((v, i) => G * (v / nrm(a) + b[i] / nrm(b))); });
    const A = [0, 1, 2].map((i) => [0, 1, 2].map((j) => Jm.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? 1e-3 : 0)));
    const g = [0, 1, 2].map((i) => Jm.reduce((s, r, n) => s + r[i] * w.dD[useIdx[n]], 0));
    return solve3(A, g);
  };
}
function solve3(A, b) { const M = A.map((r, i) => [...r, b[i]]); for (let c = 0; c < 3; c++) { let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; for (let r = 0; r < 3; r++) if (r !== c) { const q = M[r][c] / M[c][c]; for (let j = c; j < 4; j++) M[r][j] -= q * M[c][j]; } } return M.map((r, i) => r[3] / r[i]); }
function ridge(useIdx, lam = 1e-4) {
  // dH = W^T [dD; 1], fitted on train windows
  const X = train.map((w) => [...useIdx.map((p) => w.dD[p]), 1]), n = X[0].length;
  const XtX = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => X.reduce((s, x) => s + x[i] * x[j], 0) + (i === j && i < n - 1 ? lam * train.length : 0)));
  const inv = (A) => { const m = A.length, Mx = A.map((r, i) => [...r, ...A.map((_, j) => (i === j ? 1 : 0))]); for (let c = 0; c < m; c++) { let p = c; for (let r = c + 1; r < m; r++) if (Math.abs(Mx[r][c]) > Math.abs(Mx[p][c])) p = r; [Mx[c], Mx[p]] = [Mx[p], Mx[c]]; const d = Mx[c][c] || 1e-12; for (let j = 0; j < 2 * m; j++) Mx[c][j] /= d; for (let r = 0; r < m; r++) if (r !== c) { const q = Mx[r][c]; for (let j = 0; j < 2 * m; j++) Mx[r][j] -= q * Mx[c][j]; } } return Mx.map((r) => r.slice(m)); };
  const Ai = inv(XtX), Wt = [0, 1, 2].map((ax) => { const xy = Array.from({ length: n }, (_, i) => X.reduce((s, x, k) => s + x[i] * dHv(train[k])[ax], 0)); return Ai.map((r) => r.reduce((s, v, j) => s + v * xy[j], 0)); });
  const fn = (w) => { const x = [...useIdx.map((p) => w.dD[p]), 1]; return Wt.map((wa) => wa.reduce((s, v, j) => s + v * x[j], 0)); };
  fn.W = Wt; fn.idx = useIdx; return fn;
}
function score(name, pred) {
  const e = [0, 0, 0], v = [0, 0, 0], c = [0, 0, 0], pv = [0, 0, 0], pp = [0, 0, 0];
  for (const w of test) { const p = pred(w), t = dHv(w); for (let i = 0; i < 3; i++) { e[i] += (p[i] - t[i]) ** 2; v[i] += t[i] ** 2; c[i] += p[i] * t[i]; pp[i] += p[i] ** 2; } }
  const n = test.length, rms = e.map((x) => 100 * Math.sqrt(x / n)), sd = v.map((x) => 100 * Math.sqrt(x / n)), r = c.map((x, i) => x / Math.sqrt(v[i] * pp[i] || 1));
  RES[name] = { rms: rms.map((v) => +v.toFixed(2)), motion: sd.map((v) => +v.toFixed(2)), corr: r.map((v) => +v.toFixed(2)), size: pp.map((x, i) => +Math.sqrt(x / Math.max(1e-12, v[i])).toFixed(3)) };
  RES[name]._pairs = test.map((w) => ({ p: pred(w), y: dHv(w) }));
  console.log(`  ${name.padEnd(30)} error x ${rms[0].toFixed(1)} y ${rms[1].toFixed(1)} z ${rms[2].toFixed(1)} cm (vision motion x ${sd[0].toFixed(1)} y ${sd[1].toFixed(1)} z ${sd[2].toFixed(1)}), corr x ${r[0].toFixed(2)} y ${r[1].toFixed(2)} z ${r[2].toFixed(2)}`);
}
const RES = {};
console.log(`audio -> hand displacement over ${WIN} ms windows, train ${train.length} / held-out ${test.length}:`);
const lap = paths.map((p, i) => i).filter((i) => !paths[i].src.pll), all = paths.map((_, i) => i);
score('zero (no audio)', () => [0, 0, 0]);
score('physics, laptop only', physics(lap));
const rLap = ridge(lap); score('learned, laptop only', rLap);
let rAll = null;
if (phoneList.length) { score(`physics, laptop + ${phoneList.length} phone`, physics(all)); rAll = ridge(all); score(`learned, laptop + ${phoneList.length} phone`, rAll); }
// truth floor: vision jitter over WIN while the hand is held still (trials 'rest' / 'still')
const restT = (J.trials || []).filter((t) => /rest|still/.test(t.kind)).map((t) => [t.tGo + 500, (t.tEnd ?? t.tGo + (t.durMs ?? 1000 * (t.dur || 5))) - 300]);
const tr = best.tr, jit = [[], [], []];
for (let i = 0, j = 0; i < tr.length; i++) { while (j < tr.length && tr[j].t < tr[i].t + WIN) j++; if (j >= tr.length) break; if (!restT.some(([a, b]) => tr[i].t >= a && tr[j].t <= b)) continue; sub(tr[j].H, tr[i].H).forEach((v, k) => jit[k].push(v)); }
if (jit[0].length > 5) console.log(`  truth floor (vision jitter at rest, ${jit[0].length} windows): x ${jit.map((a) => (100 * Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)).toFixed(1)).join(' cm, y ').replace(/, y ([^,]*)$/, ', z $1')} cm`);
else console.log('  truth floor: no rest segment in the schedule');

// ---------------------------------------------------------------- calibration file for 3d.html (load with 📥 보정)
const floor = jit[0].length > 5 ? jit.map((a) => +(100 * Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)).toFixed(2)) : null;
// size modes (as in the built-in calibration): k = 1 / sqrt(size) ('half') or 1 / size ('matched'), errors on the held-out half
// (k is taken from the same half it is scored on: slightly optimistic for one sitting)
const ampFrom = (key) => { const R = RES[key]; if (!R) return null; const mode = (k) => { const e = [0, 0, 0], v = [0, 0, 0], p2 = [0, 0, 0]; for (const q of R._pairs) for (let i = 0; i < 3; i++) { const p = k[i] * q.p[i]; e[i] += (p - q.y[i]) ** 2; v[i] += q.y[i] ** 2; p2[i] += p * p; } const n = R._pairs.length; return { k: k.map((x) => +x.toFixed(3)), rms: e.map((x) => +(100 * Math.sqrt(x / n)).toFixed(2)), size: p2.map((x, i) => +Math.sqrt(x / Math.max(1e-12, v[i])).toFixed(2)) }; };
  return { method: 'held-out second half of this sitting', corr: R.corr, motion: R.motion, modes: { mse: mode([1, 1, 1]), half: mode(R.size.map((x) => 1 / Math.sqrt(Math.max(0.05, x)))), matched: mode(R.size.map((x) => 1 / Math.max(0.05, x))) } }; };
const ampKey = Object.keys(RES).find((k) => k.startsWith('learned') && (phoneList.length ? /phone/.test(k) : /laptop only/.test(k)));
const AMP = ampKey ? ampFrom(ampKey) : null;
for (const k of Object.keys(RES)) delete RES[k]._pairs;
const calib = { v: 1, session: base.split(/[\/]/).pop(), created: new Date().toISOString(), winMs: WIN, cam: best.cam, lagMs: best.lag, mics: MIC,
  paths: paths.map((p, i) => ({ key: p.src.key, hz: p.src.f, ch: p.c, pll: !!p.src.pll, pos: best.res[i].S.map((v) => +v.toFixed(4)), gain: +(best.res[i].G ?? 1).toFixed(3), r2: +best.res[i].r2.toFixed(3) })), nearM: NEAR,
  learned: { laptop: { idx: rLap.idx, W: rLap.W }, all: rAll ? { idx: rAll.idx, W: rAll.W } : null }, errors: RES, amp: AMP, ampFor: ampKey, truthFloorCm: floor };
// output goes to bravo's own folder (never next to the input: ml/data and the other members' folders stay untouched)
const calibOut = process.env.CALIB || require('path').join(__dirname, 'out', require('path').basename(base) + '.calib.json');
fs.mkdirSync(require('path').dirname(calibOut), { recursive: true });
fs.writeFileSync(calibOut, JSON.stringify(calib, null, 1));
if (AMP) console.log(`size modes (${ampKey}): ` + Object.entries(AMP.modes).map(([m, v]) => `${m} k ${v.k.join('/')} err ${v.rms.join('/')} size ${v.size.join('/')}`).join(' | '));
console.log(`calibration -> ${calibOut}`);
