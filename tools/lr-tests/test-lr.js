// Synthetic (geometry + noise) and real-data (ml/data) checks for swipe.js vs the current stereoBurst rule.
//   node test-lr.js [path/to/session_base_without_ext]
const fs = require('fs');
const S = require('../../web/swipe.js');
let seed = Number(process.env.SEED || 3);
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / Math.sqrt(0.5); };
const U = (a, b) => a + (b - a) * rnd();

// ---------------------------------------------------------------- geometry simulator
// laptop: speakers at (+-spkX, 0.05, 0), mic at screen top (0, -0.03, 0.2). Hand path: sideways (with an elbow arc)
// or straight push/pull. Reported per-tone v = echo-power-weighted mean Doppler speed over the 170 ms FFT window.
function gesture(kind, geo, noise) {
  const { spkX, dist } = geo;
  const spk = { L: [-spkX, 0.05, 0], R: [spkX, 0.05, 0] }, mic = [0, -0.03, 0.2];
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const dur = U(0.3, 0.6), z = U(0.06, 0.15), y0 = dist + U(-0.05, 0.05), xc = U(-0.05, 0.05), half = U(0.18, 0.3), arc = U(-0.06, 0.06);
  const sm = (s) => { s = Math.min(1, Math.max(0, s)); return 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5; };
  const pos = (t) => {
    const s = sm(t / dur);
    if (kind === 'left' || kind === 'right') {
      const dir = kind === 'right' ? 1 : -1;
      return [xc + dir * half * (2 * s - 1), y0 + arc * 4 * s * (1 - s), z];
    }
    const r = U(0, 0) + 0.12 * (kind === 'push' ? s : 1 - s); // push: hand moves 12 cm toward the laptop
    return [xc, y0 + 0.06 - r, z];
  };
  const fine = [], dt = 0.004;
  for (let t = -0.4; t <= dur + 0.4; t += dt) {
    const h = pos(t), h2 = pos(t + dt), o = { t };
    for (const k of ['L', 'R']) {
      const P = d3(h, spk[k]) + d3(h, mic), P2 = d3(h2, spk[k]) + d3(h2, mic);
      const v = -(P2 - P) / dt / 2;
      o[k] = { v, e: Math.abs(v) > 0.02 ? 1 / (d3(h, spk[k]) * d3(h, mic)) ** 2 : 0 };
    }
    fine.push(o);
  }
  const eRef = 1 / (0.3 * 0.35) ** 2 / 200; // ~23 dB excess for a hand ~30 cm away
  const frames = [];
  let nl = 0, nr = 0, t = -0.3;
  while (t < dur + 0.35) {
    const o = { t: t * 1000 };
    for (const k of ['L', 'R']) {
      let num = 0, den = 0;
      for (const q of fine) if (Math.abs(q.t - t) < 0.085) { const w = 0.5 * (1 + Math.cos(2 * Math.PI * (q.t - t) / 0.17)) * q[k].e; num += w * q[k].v; den += w; }
      const eDb = 10 * Math.log10(den / 40 / eRef + 1e-3);
      o['v' + k] = den ? num / den : 0;
      o['e' + k] = eDb;
    }
    // noise: correlated (FFT windows overlap) speed noise per tone + independent level noise
    nl = 0.8 * nl + 0.6 * gauss() * noise.v; nr = 0.8 * nr + 0.6 * gauss() * noise.v;
    o.vL += nl; o.vR += nr; o.eL += noise.e * gauss(); o.eR += noise.e * gauss();
    if (geo.mono) { o.vR = o.vL + (nr - nl); o.eR = o.eL + noise.e * gauss(); }
    frames.push(o);
    t += U(0.016, 0.04);
  }
  return frames;
}

// ---------------------------------------------------------------- burst segmentation (like dsp.js stereoBurst)
function bursts(frames, { aOn = 12, gapMs = 120, maxMs = 1200 } = {}) {
  const out = []; let cur = null;
  for (const f of frames) {
    const active = Math.max(f.eL, f.eR) > aOn;
    if (!cur && active) cur = { start: f.t, last: f.t, fr: [] };
    if (!cur) continue;
    cur.fr.push(f);
    if (active) cur.last = f.t;
    if (f.t - cur.last > gapMs || f.t - cur.start > maxMs) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}
function featOf(fr) { const b = new S.SwipeBurst(); fr.forEach((f) => b.push(f)); return b.features(); }

// current rule (port of dsp.js stereoBurst decisions; early fire, then end-of-burst peaks)
function oldRule(fr) {
  const lf = 1.0, lm = 0.5, dom = 1.3, vF = 1.3, vM = 0.9;
  let la = -1e9, li = 1e9, da = -1e9, di = 1e9;
  for (const f of fr) {
    const lat = (f.vR - f.vL) / 2, dep = (f.vR + f.vL) / 2;
    la = Math.max(la, lat); li = Math.min(li, lat); da = Math.max(da, dep); di = Math.min(di, dep);
    if (Math.abs(lat) > lf && Math.abs(lat) > dom * Math.abs(dep)) return lat > 0 ? 'right' : 'left';
    if (Math.abs(dep) > vF && Math.abs(dep) > dom * Math.abs(lat)) return dep > 0 ? 'push' : 'pull';
  }
  const lp = la >= -li ? la : li, dp = da >= -di ? da : di;
  if (Math.abs(lp) >= lm && Math.abs(lp) >= Math.abs(dp)) return lp > 0 ? 'right' : 'left';
  if (Math.abs(dp) >= vM) return dp > 0 ? 'push' : 'pull';
  return null;
}
const mainBurst = (frames) => bursts(frames).sort((a, b) => b.fr.length - a.fr.length)[0];

// ---------------------------------------------------------------- synthetic
const NOISE = { v: 0.08, e: 2.0 }; // per-frame lat noise ~0.08 m/s and level noise ~2 dB, like the 61f5 push/pull trials
const GEOS = [
  ['speakers 24 cm apart, hand 15 cm away', { spkX: 0.12, dist: 0.15 }],
  ['speakers 24 cm apart, hand 30 cm away', { spkX: 0.12, dist: 0.30 }],
  ['speakers 8 cm apart, hand 15 cm away', { spkX: 0.04, dist: 0.15 }],
  ['mono downmix (both tones both speakers)', { spkX: 0.0, dist: 0.15, mono: true }],
];
console.log('synthetic: 4+4 cued check swipes + 2+2 push/pull, then 200 test swipes + 100 centred push/pull per geometry (x 10 laptops)');
console.log('geometry                                  old L/R ok   check ok  LOO   new L/R ok  (when enabled)  push/pull -> L/R');
for (const [name, geo] of GEOS) {
  let oldOk = 0, oldN = 0, enabled = 0, newOk = 0, newN = 0, fpLR = 0, fpN = 0, looSum = 0;
  for (let lap = 0; lap < 10; lap++) {
    const tr = [];
    for (let i = 0; i < 4; i++) for (const k of ['left', 'right']) { const b = mainBurst(gesture(k, geo, NOISE)); if (b) tr.push({ kind: k, frames: b.fr }); }
    for (const k of ['push', 'pull', 'push', 'pull']) { const b = mainBurst(gesture(k, geo, NOISE)); if (b) tr.push({ kind: k, frames: b.fr }); } // v2 check also cues push/pull
    const model = S.learn(tr), r = { ok: !!model, model };
    looSum += S.learn.last.looAcc;
    if (r.ok) enabled++;
    for (let i = 0; i < 20; i++) {
      const k = i % 2 ? 'left' : 'right', b = mainBurst(gesture(k, geo, NOISE));
      oldN++; newN += r.ok ? 1 : 0;
      if (!b) continue;
      if (oldRule(b.fr) === k) oldOk++;
      if (r.ok && S.decide(b.fr, r.model).kind === k) newOk++;
    }
    for (let i = 0; i < 10; i++) {
      const b = mainBurst(gesture(i % 2 ? 'push' : 'pull', geo, NOISE));
      if (!r.ok) continue;
      fpN++;
      if (b && S.decide(b.fr, r.model).kind) fpLR++;
    }
  }
  const pc = (a, b) => (b ? `${Math.round(100 * a / b)}%` : '  -').padStart(5);
  console.log(`${name.padEnd(42)} ${pc(oldOk, oldN)}        ${String(enabled).padStart(2)}/10   ${(looSum / 10).toFixed(2)}  ${pc(newOk, newN)}                       ${pc(fpLR, fpN)}`);
}

// ---------------------------------------------------------------- real data
const base = process.argv[2];
if (base && fs.existsSync(base + '.csv')) {
  const lines = fs.readFileSync(base + '.csv', 'utf8').trim().split(/\r?\n/), head = lines[0].split(',');
  const col = (n) => head.indexOf(n);
  const rows = lines.slice(1).map((l) => l.split(','));
  const meta = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
  const num = (r, n) => Number(r[col(n)]);
  const lin = (db) => Math.pow(10, Math.max(-30, Math.min(60, db)) / 10);
  const frames = rows.filter((r) => r[col('vL')] !== '').map((r) => ({
    t: num(r, 't_ms'), cue: r[col('cue')], vL: num(r, 'vL'), vR: num(r, 'vR'),
    eL: Math.max(num(r, 'dUpL'), num(r, 'dDownL')), eR: Math.max(num(r, 'dUpR'), num(r, 'dDownR')), // alpha's frame spec
  }));
  const cues = frames.filter((f) => f.cue).map((f) => f.t);
  const trials = meta.trials.map((tr) => {
    const t0 = cues.find((c) => c >= tr.tStart - 100 && c <= tr.tEnd) || tr.tStart;
    const b = mainBurst(frames.filter((f) => f.t >= t0 && f.t <= t0 + 2500));
    return { kind: tr.kind, got: tr.got, feat: b ? featOf(b.fr) : null, old: b ? oldRule(b.fr) : null };
  });
  const sw = trials.filter((t) => (t.kind === 'left' || t.kind === 'right') && t.feat);
  const chk = new S.LRCheck({ need: 1 });
  sw.forEach((t) => chk.add(t.kind, t.feat));
  const r = chk.result();
  console.log(`\nreal: ${meta.session} (${meta.dist} cm, ${meta.engine.mic}, tones ${meta.engine.stereoFreqs})`);
  console.log(`  swipes with a burst ${sw.length}/${trials.filter((t) => t.kind === 'left' || t.kind === 'right').length}; old rule (replayed) L/R correct ${sw.filter((t) => t.old === t.kind).length}/${sw.length}, live engine ${trials.filter((t) => t.got === t.kind && (t.kind === 'left' || t.kind === 'right')).length}`);
  console.log(`  LRCheck over all swipes: ok=${r.ok} LOO=${r.looAcc} d'=${JSON.stringify(r.dprime)} -> ${r.reason}`);
  for (const t of sw) console.log(`    ${t.kind.padEnd(5)} ilat ${t.feat.ilat.toFixed(3).padStart(7)} m  balSlope ${t.feat.balSlope.toFixed(1).padStart(6)} dB/s  latPk ${t.feat.latPk.toFixed(2).padStart(5)}  depPk ${t.feat.depPk.toFixed(2).padStart(5)}  old=${t.old}`);
}
