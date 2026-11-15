// Circle direction (CW / CCW) and 2D track from the phase tracker: synthetic hand circles injected into REAL background
// (quiet stretches of a real stereo WAV: its direct path, static echoes, noise and interference), echo scaled so the
// dynamic-vector SNR matches real swipes.   node sim2d.js [gain list]   env: PLANE=xz|xy  SEED
const fs = require('fs');
const R = require('./real.js'), P = require('./phase.js');
const D = (process.env.DATA || require('path').join(__dirname, '../../ml/data')) + '/batears_20261114_', BK = (process.env.WAV_BACKUP || '') + '/batears_20261114_';
const SES = process.env.SES || '231408_anon_d20_quiet_lr_milz';
const s = R.loadSession(D + SES), wp = [D + SES + '.wav', BK + SES + '.wav'].find((p) => fs.existsSync(p));
const wav = P.readWav(wp), x0 = wav.ch[0], fs0 = wav.rate, F = s.meta.stereoPair;
// 1. quiet chunks (0.5 s = 24000 samples, a multiple of 32 so both carriers stay phase-continuous when chunks are joined)
const tr0 = P.track({ ...wav, ch: [x0], C: 1 }, F, 0, { gate: 1.5 });
const CH = 24000, dec = 48, quiet = [];
for (let c = 1; (c + 1) * CH < x0.length; c++) {
  const k0 = c * CH / dec, k1 = (c + 1) * CH / dec; let act = 0;
  for (let k = k0 - 100; k < k1 + 100; k++) act += (tr0.L[0].step[k] !== 0) + (tr0.R[0].step[k] !== 0);
  if (act < Number(process.env.QA || 0.02) * (k1 - k0 + 200)) quiet.push(c);
}
const T = 86, N = T * fs0, bg = new Float32Array(N);
for (let i = 0, j = 0; i < N; i += CH, j++) { const c = quiet[j % quiet.length]; bg.set(x0.subarray(c * CH, c * CH + Math.min(CH, N - i)), i); }
if (process.env.CLEAN) { let sd = 11; for (let i = 0; i < N; i++) { sd = (sd * 1103515245 + 12345) % 2147483648; bg[i] = 4e-4 * Math.cos(2 * Math.PI * F[0] * i / fs0 + 1) + 9e-4 * Math.cos(2 * Math.PI * F[1] * i / fs0 + 2) + Number(process.env.CLEAN) * (sd / 2147483648 - 0.5); } }
// 2. geometry (m): laptop deck z = 0, x right, y toward the hinge. Speakers either side of the keyboard, mic top-left.
const spk = { L: [-0.14, 0.10, 0], R: [0.14, 0.10, 0] }, mic = [-0.10, 0.22, 0.0];
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
let seed = Number(process.env.SEED || 3); const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const plane = process.env.PLANE || 'xz', NT = 20, ARM = Number(process.env.ARM || 0);
const trials = [];
for (let i = 0; i < NT; i++) {
  const dir = i % 2 ? 1 : -1, t0 = 3 + 4 * i, loopS = 0.9 + 0.6 * rnd(), loops = 1.5, r = 0.05 + 0.04 * rnd();
  const c = [0.03 * (rnd() - 0.5) * 2, 0.08 + 0.04 * rnd(), 0.10 + 0.05 * rnd()], ph0 = 2 * Math.PI * rnd();
  trials.push({ dir, t0, dur: loopS * loops, loopS, r, c, ph0 });
}
trials.sort(() => rnd() - 0.5).forEach((q, i) => { q.t0 = 3 + 4 * i; });
const ease = (s) => { s = Math.min(1, Math.max(0, s)); return s * s * (3 - 2 * s); };
function hand(t) {
  let q = trials[0]; for (const p of trials) if (t >= p.t0 - 1.2) q = p;
  hand.c = q.c; const s = ease((t - q.t0) / q.dur) * q.dur / q.loopS;    // loops done (eased start / stop)
  const a = q.ph0 + q.dir * 2 * Math.PI * s;               // dir +1 = counter-clockwise seen from +y (front) or +z (above)
  return plane === 'xz' ? [q.c[0] + q.r * Math.cos(a), q.c[1], q.c[2] + q.r * Math.sin(a)] : [q.c[0] + q.r * Math.cos(a), q.c[1] + q.r * Math.sin(a), q.c[2]];
}
// truth (u, w) per 1 ms: u = (dR - dL)/2, w = -(dL + dR)/2 of the speaker -> hand -> mic paths
const truthAt = (t) => { const h = hand(t), dL = d3(h, spk.L) + d3(h, mic), dR = d3(h, spk.R) + d3(h, mic); return { u: (dR - dL) / 2, w: -(dL + dR) / 2, h }; };
// 3. echo per tone; gain relative to the background carrier amplitude
const bb = F.map((f) => P.baseband(bg, fs0, f)), carrier = bb.map((b) => { let m = 0; for (let k = 500; k < b.I.length; k++) m += Math.hypot(b.I[k], b.Q[k]); return m / (b.I.length - 500); });
function run(gain) {
  const x = Float32Array.from(bg);
  for (let i = 0; i < N; i++) {
    const t = i / fs0, h = hand(t);
    for (const [key, f, ci] of [['L', F[0], 0], ['R', F[1], 1]]) {
      const a = d3(h, spk[key]), b = d3(h, mic);
      x[i] += gain * carrier[ci] * (0.15 * 0.15 / (a * b)) * Math.cos(2 * Math.PI * f * (t - (a + b) / P.C_SOUND));
      if (ARM) { const q = trials[0] && hand.cur, hm = [0.4 * h[0] + 0.6 * hand.c[0], h[1] - 0.15, 0.4 * h[2] + 0.6 * hand.c[2] - 0.05], a2 = d3(hm, spk[key]), b2 = d3(hm, mic);
        x[i] += ARM * gain * carrier[ci] * (0.15 * 0.15 / (a2 * b2)) * Math.cos(2 * Math.PI * f * (t - (a2 + b2) / P.C_SOUND)); }
    }
  }
  if (process.env.OUT) { const o = process.env.OUT, b = Buffer.alloc(44 + 2 * N); b.write("RIFF", 0); b.writeUInt32LE(36 + 2 * N, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(fs0, 24); b.writeUInt32LE(2 * fs0, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(2 * N, 40);
    for (let i = 0; i < N; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32768))), 44 + 2 * i); fs.writeFileSync(o + ".wav", b);
    fs.writeFileSync(o + ".json", JSON.stringify({ stereoPair: F, wav: { t0: 0 }, trials: trials.map((q) => ({ kind: (plane === "xy" ? q.dir < 0 : q.dir > 0) ? "cw" : "ccw", tGo: 1000 * q.t0 - 100, tStart: 1000 * q.t0 - 1750, tEnd: 1000 * q.t0 + 2900 })) })); }
  const tr = P.track({ rate: fs0, C: 1, ch: [x], frames: N }, F, 0, { gate: Number(process.env.GATE || 1.5), tauS: Number(process.env.TAU || 0.25) });
  let ok = 0, abst = 0, wrong = 0, snr = [], err = [], cs = [], r_amp = [];
  const res = trials.map((q) => {
    const k0 = Math.floor((q.t0 - 0.15) * tr.rate), k1 = Math.floor((q.t0 + q.dur + 0.25) * tr.rate);
    let u = 0, w = 0; const U = [], W = [], TU = [], TW = [], H = []; let sn = 0;
    const g0 = truthAt(k0 / tr.rate);
    for (let k = k0; k <= k1; k++) {
      const sL = tr.L[0].step[k], sR = tr.R[0].step[k]; u += (sR - sL) / 2; w += -(sR + sL) / 2; U.push(u); W.push(w);
      const g = truthAt(k / tr.rate); TU.push(g.u - g0.u); TW.push(g.w - g0.w); H.push(g.h);
      sn += Math.min(tr.L[0].mag[k] / tr.L[0].noise[k], tr.R[0].mag[k] / tr.R[0].noise[k]);
    }
    snr.push(sn / (k1 - k0 + 1));
    const area = (A, B) => { let s = 0; for (let i = 1; i < A.length; i++) s += (A[i - 1] * B[i] - A[i] * B[i - 1]) / 2; return s; };
    const am = area(U, W), at = area(TU, TW);
    // shape error in the (u, w) path domain: RMS of measured - truth relative to the truth's RMS radius
    const e = Math.sqrt(U.reduce((s, v, i) => s + (v - TU[i]) ** 2 + (W[i] - TW[i]) ** 2, 0) / U.length);
    const rr = Math.sqrt(TU.reduce((s, v, i) => s + (v - TU.reduce((p, z) => p + z, 0) / TU.length) ** 2 + (TW[i] - TW.reduce((p, z) => p + z, 0) / TW.length) ** 2, 0) / TU.length);
    err.push(e / rr); r_amp.push((Math.max(...U) - Math.min(...U)) / Math.max(1e-9, Math.max(...TU) - Math.min(...TU)));
    if (process.env.TRACE && !run.done) { run.done = 1; for (let i = 0; i < U.length; i += 100) console.log(`   t+${i} u ${(100*U[i]).toFixed(1)} / ${(100*TU[i]).toFixed(1)}   w ${(100*W[i]).toFixed(1)} / ${(100*TW[i]).toFixed(1)}   magL/noise ${(tr.L[0].mag[k0+i]/tr.L[0].noise[k0+i]).toFixed(1)}`); }
    if (process.env.SIGN) console.log(`  dir ${q.dir > 0 ? "ccw(above/front)" : "cw(above/front)"} true area ${Math.sign(at)} measured ${Math.sign(am)}`);
    if (process.env.DIAG) { const rg=(A)=>100*(Math.max(...A)-Math.min(...A)); console.log(`  u ${rg(U).toFixed(1)}/${rg(TU).toFixed(1)} w ${rg(W).toFixed(1)}/${rg(TW).toFixed(1)} end du ${(100*(U[U.length-1]-TU[TU.length-1])).toFixed(1)} dw ${(100*(W[W.length-1]-TW[TW.length-1])).toFixed(1)} cm, mid-lag corr u ${(()=>{let best=0,bl=0;for(let l=-60;l<=60;l+=5){let c=0;for(let i=60;i<U.length-60;i++)c+=U[i]*TU[i+l];if(c>best){best=c;bl=l;}}return bl;})()} ms`); }
    return { am, at, U, W, TU, TW, H, q };
  });
  // abstain when the measured area is < 15% of the median |area|
  const ma = res.map((r) => Math.abs(r.am)).sort((a, b) => a - b)[res.length >> 1];
  for (const r of res) { if (Math.abs(r.am) < 0.15 * ma) abst++; else if (Math.sign(r.am) === Math.sign(r.at)) ok++; else wrong++; }
  // 2D (x, z) track: one linear map (u, w) -> plane coordinates fitted over all circles (= a per-session calibration)
  const pc = plane === 'xz' ? [0, 2] : [0, 1];
  const rows = []; res.forEach((r) => r.U.forEach((u, i) => { if (i % 10 === 0) rows.push([u, r.W[i], r.H[i][pc[0]] - r.H[0][pc[0]], r.H[i][pc[1]] - r.H[0][pc[1]]]); }));
  const lsq = (col) => { let a = 0, b = 0, c = 0, d = 0, e = 0; for (const z of rows) { a += z[0] * z[0]; b += z[0] * z[1]; c += z[1] * z[1]; d += z[0] * z[col]; e += z[1] * z[col]; } const det = a * c - b * b; return [(d * c - e * b) / det, (a * e - b * d) / det]; };
  const mx = lsq(2), mz = lsq(3); let se = 0, sr = 0;
  const posErr = res.map((r) => { let s2 = 0; r.U.forEach((u, i) => { const ex = mx[0] * u + mx[1] * r.W[i] - (r.H[i][pc[0]] - r.H[0][pc[0]]), ez = mz[0] * u + mz[1] * r.W[i] - (r.H[i][pc[1]] - r.H[0][pc[1]]); s2 += ex * ex + ez * ez; }); return 100 * Math.sqrt(s2 / r.U.length); });
  const med = (A) => A.slice().sort((a, b) => a - b)[A.length >> 1];
  console.log(`gain ${String(gain).padEnd(5)} |dyn|/noise ${med(snr).toFixed(1)}  direction right/abstain/wrong ${ok}/${abst}/${wrong}  (u,w) path error ${med(err).toFixed(2)}x radius  2D track error med ${med(posErr).toFixed(1)} cm, u range measured/true ${med(r_amp).toFixed(2)} (radius 5-9 cm)`);
}
console.log(`${SES}: ${quiet.length} quiet 0.5 s chunks, carrier ${carrier.map((c) => c.toExponential(1))}, plane ${plane}, ${NT} circles 1.5 loops 0.9-1.5 s/loop r 5-9 cm at 10-15 cm`);
for (const g of (process.argv[2] || '0.3,0.6,1,2,4').split(',').map(Number)) run(g);
