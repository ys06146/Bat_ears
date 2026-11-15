// Offline I/Q phase tracking (LLAP / Strata style) for the raw mic WAV saved by stereo collection sessions
// (nhng b4167ca: batears_<session>.wav, 16-bit PCM, mic channels unmixed, meta.wav.t0 = performance.now() of sample 0).
//
// Per carrier f (speaker tone) and mic channel: baseband r(t) = LP{ x(t) e^{-j2pi f t} } (4th-order Butterworth, then
// decimate to ~1 kHz). The direct speaker->mic path and static reflections are a constant vector; the hand adds a
// rotating vector A e^{-j2pi d(t)/lambda}. Remove the static part (slow complex mean), unwrap the phase of the rest and
// read the hand's path length change  dd = -dphi * lambda / 2pi  (lambda = c / f, ~1.9 cm at 18 kHz).
// Unlike the FFT centroid this has no rest offset and mm resolution: integrating it over a burst gives the change of
// the speaker->hand->mic path for each speaker (dL, dR), so dR - dL is a direct sideways measure.
const fs = require('fs');
const C_SOUND = 343;

function readWav(path) {
  const b = fs.readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV: ' + path);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), n = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { C: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') { data = { off: p + 8, n: Math.min(n, b.length - p - 8) }; break; }
    p += 8 + n + (n & 1);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error('need 16-bit PCM WAV');
  const frames = Math.floor(data.n / 2 / fmt.C), ch = Array.from({ length: fmt.C }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.C; c++) ch[c][i] = b.readInt16LE(data.off + 2 * (i * fmt.C + c)) / 32768;
  return { rate: fmt.rate, C: fmt.C, ch, frames };
}

// RBJ biquad low-pass, two stages = 4th-order Butterworth
function lpCoefs(fc, fs) {
  return [0.5412, 1.3066].map((Q) => {
    const w = 2 * Math.PI * fc / fs, cw = Math.cos(w), al = Math.sin(w) / (2 * Q), a0 = 1 + al;
    return { b0: (1 - cw) / 2 / a0, b1: (1 - cw) / a0, b2: (1 - cw) / 2 / a0, a1: -2 * cw / a0, a2: (1 - al) / a0 };
  });
}
// complex baseband of carrier f, decimated by `dec`
function baseband(x, rate, f, { lpHz = 250, dec = 48 } = {}) {
  const st = lpCoefs(lpHz, rate), n = Math.floor(x.length / dec);
  const I = new Float32Array(n), Q = new Float32Array(n);
  const s = [0, 1].map(() => st.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 })));  // [I|Q][stage]
  const w = 2 * Math.PI * f / rate;
  let k = 0;
  for (let i = 0; i < x.length; i++) {
    const ph = w * i, v = [x[i] * Math.cos(ph) * 2, -x[i] * Math.sin(ph) * 2];
    for (let q = 0; q < 2; q++) {
      let y = v[q];
      for (let j = 0; j < st.length; j++) {
        const c = st[j], z = s[q][j], o = c.b0 * y + c.b1 * z.x1 + c.b2 * z.x2 - c.a1 * z.y1 - c.a2 * z.y2;
        z.x2 = z.x1; z.x1 = y; z.y2 = z.y1; z.y1 = o; y = o;
      }
      v[q] = y;
    }
    if (i % dec === dec - 1 && k < n) { I[k] = v[0]; Q[k] = v[1]; k++; }
  }
  return { I, Q, rate: rate / dec };
}

// static vector removal (slow complex mean, time constant tauS) + phase -> path length change per sample (m).
// Steps are kept only where the dynamic vector is above `gate` x its running median (noise).
function pathSteps(bb, f, { tauS = 0.25, gate = 3, medS = 4, pct = 0.25 } = {}) {
  const { I, Q, rate } = bb, n = I.length, a = 1 / (tauS * rate), lam = C_SOUND / f;
  const step = new Float32Array(n), mag = new Float32Array(n);
  // start the static mean at the average of the first 0.3 s (after the filter settles), not at sample 0
  const k0 = Math.min(n - 1, Math.round(0.02 * rate)), k1 = Math.min(n, k0 + Math.round(0.3 * rate));
  let mI = 0, mQ = 0; for (let k = k0; k < k1; k++) { mI += I[k]; mQ += Q[k]; } mI /= Math.max(1, k1 - k0); mQ /= Math.max(1, k1 - k0);
  let pI = 0, pQ = 0;
  for (let k = 0; k < n; k++) {
    mI += a * (I[k] - mI); mQ += a * (Q[k] - mQ);
    const dI = I[k] - mI, dQ = Q[k] - mQ;
    mag[k] = Math.hypot(dI, dQ);
    if (k) step[k] = -Math.atan2(dQ * pI - dI * pQ, dI * pI + dQ * pQ) * lam / (2 * Math.PI); // -dphi * lambda / 2pi
    pI = dI; pQ = dQ;
  }
  // noise level: running low percentile of |dyn| over medS seconds (motion fills < ~half of any window)
  const win = Math.round(medS * rate), strideN = 50, noise = new Float32Array(n);
  for (let k = 0; k < n; k += 100) {
    const lo = Math.max(0, k - win), xs = [];
    for (let j = lo; j <= k; j += Math.max(1, Math.floor((k - lo) / strideN))) xs.push(mag[j]);
    xs.sort((u, v) => u - v);
    const m = xs.length ? xs[Math.floor(pct * (xs.length - 1))] : 0;
    for (let j = k; j < Math.min(n, k + 100); j++) noise[j] = m;
  }
  for (let k = 1; k < n; k++) if (!(mag[k] > gate * noise[k] && mag[k - 1] > gate * noise[k])) step[k] = 0;
  return { step, mag, noise, rate };
}

// LEVD (LLAP RangeFinder idea, re-implemented): static part of one component x given a noise scale per sample
function levd(x, noise, { hyst = 2, swing = 4, alpha = 0.3, init = 0 } = {}) {
  const n = x.length, st = new Float32Array(n);
  let s = init, dir = 0, ext = x[0], prevExt = null;
  for (let k = 0; k < n; k++) {
    const h = hyst * Math.max(1e-9, noise[k]);
    if (dir >= 0 && x[k] > ext) ext = x[k];
    else if (dir <= 0 && x[k] < ext) ext = x[k];
    if ((dir >= 0 && x[k] < ext - h) || (dir <= 0 && x[k] > ext + h)) {     // turned: ext was a local extreme
      if (prevExt != null && Math.abs(ext - prevExt) > swing * noise[k]) s += alpha * ((ext + prevExt) / 2 - s);
      prevExt = ext; dir = x[k] < ext ? -1 : 1; ext = x[k];
    }
    st[k] = s;
  }
  return st;
}
function pathStepsLevd(bb, f, opt = {}) {
  const first = pathSteps(bb, f, opt);                 // EMA pass: gives the noise scale of the dynamic part
  const { I, Q, rate } = bb, n = I.length, lam = C_SOUND / f, gate = opt.gate ?? 3;
  const k0 = Math.min(n - 1, Math.round(0.02 * rate)), k1 = Math.min(n, k0 + Math.round(0.3 * rate));
  let i0 = 0, q0 = 0; for (let k = k0; k < k1; k++) { i0 += I[k]; q0 += Q[k]; } i0 /= Math.max(1, k1 - k0); q0 /= Math.max(1, k1 - k0);
  const nz = first.noise.map((v) => v / Math.SQRT2);  // per-component scale
  const sI = levd(I, nz, { init: i0 }), sQ = levd(Q, nz, { init: q0 });
  const step = new Float32Array(n), mag = new Float32Array(n);
  let pI = 0, pQ = 0;
  for (let k = 0; k < n; k++) {
    const dI = I[k] - sI[k], dQ = Q[k] - sQ[k];
    mag[k] = Math.hypot(dI, dQ);
    if (k) step[k] = -Math.atan2(dQ * pI - dI * pQ, dI * pI + dQ * pQ) * lam / (2 * Math.PI);
    pI = dI; pQ = dQ;
  }
  for (let k = 1; k < n; k++) if (!(mag[k] > gate * first.noise[k] && mag[k - 1] > gate * first.noise[k])) step[k] = 0;
  return { step, mag, noise: first.noise, rate };
}

// one session: per tone (fL, fR) and mic channel the per-sample path steps; perf-time of sample k = t0 + k / rate * 1000
function track(wav, freqs, t0, opt = {}) {
  const out = {};
  for (const [key, f] of [['L', freqs[0]], ['R', freqs[1]]]) {
    out[key] = wav.ch.map((x) => (opt.static === 'levd' ? pathStepsLevd : pathSteps)(baseband(x, wav.rate, f, opt), f, opt));
  }
  out.t0 = t0; out.rate = out.L[0].rate;
  return out;
}
// path change of each tone over [ta, tb] (perf ms), averaged over mic channels
function pathChange(tr, ta, tb) {
  const k0 = Math.max(0, Math.floor((ta - tr.t0) / 1000 * tr.rate)), k1 = Math.floor((tb - tr.t0) / 1000 * tr.rate);
  const res = {};
  for (const key of ['L', 'R']) {
    const per = tr[key].map((p) => { let s = 0, sa = 0; for (let k = k0; k <= Math.min(k1, p.step.length - 1); k++) { s += p.step[k]; sa += Math.abs(p.step[k]); } return { d: s, a: sa }; });
    res['d' + key] = per.reduce((s, x) => s + x.d, 0) / per.length;
    res['a' + key] = per.reduce((s, x) => s + x.a, 0) / per.length;
    res['d' + key + 'ch'] = per.map((x) => x.d);
  }
  return res;
}

module.exports = { readWav, baseband, pathSteps, pathStepsLevd, levd, track, pathChange, C_SOUND };

// ---------------------------------------------------------------- self-test on a synthetic recording
if (require.main === module && process.argv[2] === '--selftest') {
  const rate = 48000, T = 5, n = rate * T, fL = 18000, fR = 19500;
  const spk = { L: [-0.12, 0.05, 0], R: [0.12, 0.05, 0] }, mic = [0, -0.03, 0.2];
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const sm = (s) => { s = Math.min(1, Math.max(0, s)); return 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5; };
  // right swipe 1.0-1.45 s at 15 cm, 50 cm wide; push 2.0-2.4 s (12 cm toward the laptop)
  const hand = (t) => {
    if (t < 1.7) { const s = sm((t - 1.0) / 0.45); return [-0.25 + 0.5 * s, 0.15, 0.1]; }
    if (t < 2.6) { const s = sm((t - 2.0) / 0.4); return [0.0, 0.27 - 0.12 * s, 0.1]; }
    const s = sm((t - 3.0) / 1.5); return [0.0, 0.15 + 0.12 * s, 0.1];   // slow pull, ~0.12 m/s
  };
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const x = new Float32Array(n), truth = [];
  for (let i = 0; i < n; i++) {
    const t = i / rate, h = hand(t);
    let v = 0;
    for (const [k, f] of [['L', fL], ['R', fR]]) {
      const dDir = d3(spk[k], mic), dH = d3(h, spk[k]) + d3(h, mic);
      v += 0.3 * Math.cos(2 * Math.PI * f * (t - dDir / C_SOUND)) / (dDir * 10);              // direct path (static, strong)
      v += 0.3 * 0.02 * Math.cos(2 * Math.PI * f * (t - dH / C_SOUND)) / (d3(h, spk[k]) * d3(h, mic) * 20); // hand echo
      if (i % 480 === 0) truth.push({ t, k, dH });
    }
    x[i] = v + 0.002 * rnd();
  }
  const wav = { rate, C: 1, ch: [x], frames: n };
  for (const stat of ['ema', 'levd']) { console.log('static removal: ' + stat);
  const tr = track(wav, [fL, fR], 0, { static: stat });
  const at = (k, t) => truth.filter((q) => q.k === k).reduce((b, q) => (Math.abs(q.t - t) < Math.abs(b.t - t) ? q : b)).dH;
  for (const [nm, a, b] of [['right swipe', 950, 1500], ['push', 1950, 2450], ['slow pull', 2950, 4550]]) {
    const pc = pathChange(tr, a, b);
    console.log(`${nm.padEnd(12)} phase: dL ${(100 * pc.dL).toFixed(1)} cm  dR ${(100 * pc.dR).toFixed(1)} cm   truth: dL ${(100 * (at('L', b / 1000) - at('L', a / 1000))).toFixed(1)} cm  dR ${(100 * (at('R', b / 1000) - at('R', a / 1000))).toFixed(1)} cm`);
  } }
}
