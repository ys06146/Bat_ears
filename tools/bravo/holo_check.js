// Why doesn't the hologram follow the hand? Compare a hologram recording (ml/data/holo/<base>.wav + .json) with the teach
// sittings the calibration was learned on:
//  1. worklet stats from the WAV (same code as Bat3D): carrier amplitude per laptop stream (vs REF_AMP, dB), |dyn|/noise,
//     gate pass rate, overall and while the hand moves
//  2. if the json has engine frames: 250 ms displacement size of the raw solve vs the displayed (filtered) position
//  3. path recovery: path change per second while moving, vs the same number on a teach WAV (if given)
//   node holo_check.js <holo base> [teach base for comparison]
const fs = require('fs'), vm = require('vm'), P = require('./phase.js'), Bat3D = require('../../web/bat3d.js');
function workletStats(base, freqs = [18000, 19500]) {
  const wav = P.readWav(base + '.wav'); let Proc = null; const msgs = [];
  const sb = { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => msgs.push(m) }; } }, registerProcessor: (n, c) => { Proc = c; }, sampleRate: wav.rate, Math, Float32Array, Array };
  vm.createContext(sb); vm.runInContext(Bat3D.PROC, sb);
  const proc = new Proc({ processorOptions: { freqs, pll: freqs.map((_, t) => t >= 2) } });
  for (let i = 0; i + 128 <= wav.frames; i += 128) proc.process([wav.ch.map((c) => c.subarray(i, i + 128))]);
  const use = msgs.slice(50), S = 4;
  // moving batches: total |step| over the laptop streams in the batch above 1 mm
  const motion = use.map((m) => { let a = 0; for (let s = 0; s < S; s++) for (const v of m.steps[s]) a += Math.abs(v); return a; });
  const mv = use.filter((_, i) => motion[i] > 0.001);
  const med = (A) => { const x = A.slice().sort((a, b) => a - b); return x.length ? x[x.length >> 1] : NaN; };
  const per = (arr, f) => [0, 1, 2, 3].map((s) => f(arr.map((m) => m[s])));
  const amp = per(use.map((m) => m.amp), med), q = per(use.map((m) => m.q), med), act = per(use.map((m) => m.act), (x) => x.reduce((a, b) => a + b, 0) / x.length);
  const actMv = per(mv.map((m) => m.act), (x) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length));
  const secs = use.length * 8 * 128 / wav.rate, pathPerS = motion.reduce((a, b) => a + b, 0) / 4 / secs;
  const ref = Bat3D.REF_AMP.galaxy, levelDb = 20 * Math.log10(amp.reduce((a, b) => a + b, 0) / ref.reduce((a, b) => a + b, 0));
  return { name: base.split(/[\\/]/).pop(), secs, amp, q, act, actMv, movingShare: mv.length / use.length, pathPerS, levelDb };
}
const show = (r) => console.log(`${r.name}: ${r.secs.toFixed(0)} s | tone level vs teach ${r.levelDb.toFixed(1)} dB | amp ${r.amp.map((v) => v.toExponential(1)).join(' ')} | |dyn|/noise ${r.q.map((v) => v.toFixed(2)).join(' ')} | gate pass ${r.act.map((v) => (100 * v).toFixed(0)).join('/')}% (moving ${r.actMv.map((v) => (100 * v).toFixed(0)).join('/')}%) | moving ${(100 * r.movingShare).toFixed(0)}% of the time | path change ${(100 * r.pathPerS).toFixed(1)} cm/s per stream`);
const holo = process.argv[2], teach = process.argv[3];
show(workletStats(holo));
if (teach) show(workletStats(teach));
// engine log in the json (alpha's hologram recorder): t_s, raw x y z, shown x y z, moving, levelDb, amp[], q[], act[]
const jp = holo + '.json';
if (fs.existsSync(jp)) {
  const J = JSON.parse(fs.readFileSync(jp, 'utf8')), L = J.log;
  const meta = J.meta || J;
  console.log('meta: volume ' + meta.volume + ', filter ' + JSON.stringify(meta.filter) + ', tau ' + JSON.stringify(meta.tau) + ', calib ' + JSON.stringify(meta.engine && meta.engine.calName));
  // rows -> objects with t, raw[3], shown[3], moving, levelDb, amp[], q[], act[]
  let rows = [];
  const fromArr = (hdr, arr) => arr.map((r) => Object.fromEntries(hdr.map((k, i) => [k, r[i]])));
  if (L && Array.isArray(L.rows) && Array.isArray(L.columns)) rows = fromArr(L.columns, L.rows);
  else if (Array.isArray(L) && L.length && Array.isArray(L[0]) && typeof L[0][0] === 'string') rows = fromArr(L[0], L.slice(1));
  else if (Array.isArray(L) && L.length && Array.isArray(L[0])) {
    let hdr = J.logColumns || J.log_columns || meta.logColumns;
    if (!Array.isArray(hdr)) {   // alpha: 't_s, raw x y z, shown x y z, moving, levelDb, amp[streams], q[streams], act[streams]' (a description)
      const S = (L[0].length - 9) / 3, idx = (p) => Array.from({ length: S }, (_, i) => p + i);
      hdr = ['t_s', 'raw_x', 'raw_y', 'raw_z', 'shown_x', 'shown_y', 'shown_z', 'moving', 'levelDb', ...idx(0).map((i) => 'amp' + i), ...idx(0).map((i) => 'q' + i), ...idx(0).map((i) => 'act' + i)];
    }
    rows = fromArr(hdr, L);
  }
  else if (Array.isArray(L)) rows = L;
  if (!rows.length) { console.log('no engine log rows found; json keys: ' + Object.keys(J).join(', ')); process.exit(0); }
  const k0 = Object.keys(rows[0]);
  const pick = (r, base) => { if (Array.isArray(r[base])) return r[base]; const xs = ['x', 'y', 'z'].map((c) => r[base + '_' + c] ?? r[base + c] ?? r[base + ' ' + c]); return xs.every((v) => v != null) ? xs.map(Number) : null; };
  const T = (r) => Number(r.t_s ?? r.t ?? r.time) * (r.t_s != null ? 1 : 0.001);
  console.log('log rows ' + rows.length + ', fields ' + k0.slice(0, 14).join(', ') + (k0.length > 14 ? ', ...' : ''));
  const dt = (T(rows[rows.length - 1]) - T(rows[0])) / Math.max(1, rows.length - 1), step = Math.max(1, Math.round(0.25 / Math.max(1e-4, dt)));
  const disp = (base) => { const s2 = [0, 0, 0]; let n = 0; const dd = []; for (let i = 0; i + step < rows.length; i += step) { const a = pick(rows[i], base), b = pick(rows[i + step], base); if (!a || !b) continue; const d = b.map((v, j) => v - a[j]); dd.push(d); for (let j = 0; j < 3; j++) s2[j] += d[j] ** 2; n++; } return { rms: s2.map((v) => 100 * Math.sqrt(v / Math.max(1, n))), dd }; };
  const R = disp('raw'), S = disp('shown');
  const cor = (j) => { let ab = 0, aa = 0, bb = 0; const n = Math.min(R.dd.length, S.dd.length); for (let i = 0; i < n; i++) { ab += R.dd[i][j] * S.dd[i][j]; aa += R.dd[i][j] ** 2; bb += S.dd[i][j] ** 2; } return ab / Math.sqrt(aa * bb || 1); };
  console.log('250 ms moves: raw rms ' + R.rms.map((v) => v.toFixed(1)).join('/') + ' cm, shown rms ' + S.rms.map((v) => v.toFixed(1)).join('/') + ' cm -> shown keeps ' + R.rms.map((v, j) => (100 * S.rms[j] / Math.max(1e-9, v)).toFixed(0)).join('/') + '% (corr raw-shown ' + [0, 1, 2].map(cor).map((v) => v.toFixed(2)).join('/') + ')');
  const med = (A) => { const x = A.filter(Number.isFinite).sort((p, q) => p - q); return x.length ? x[x.length >> 1] : NaN; };
  console.log('engine levelDb median ' + med(rows.map((r) => Number(r.levelDb))).toFixed(1) + ' dB; moving ' + (100 * rows.filter((r) => r.moving === true || r.moving === 1 || r.moving === '1').length / rows.length).toFixed(0) + '% of rows');
  // the teach-time comparison for the same session span: raw motion per second vs teach (a hand moving like teach gives ~ the teach raw motion)
}
