/* Bat3D: acoustic hand tracking engine (sound only, no camera), extracted from 3d.html v8 (bravo) so pages share one
 * engine and one calibration. Laptop: L 18 kHz, R 19.5 kHz; optional phones as extra tones (own clocks, PLL-corrected).
 * Per tone x mic channel, I/Q phase path length (LLAP-style AudioWorklet 'bat-iq6'); paths -> hand position by a
 * webcam-learned linear map (built-in Galaxy Book calibration, or a teach_fit.js calib.json) or a physics solve;
 * Kalman (constant velocity); motion / stillness; circle tokens.
 * Coordinates (m): x right, y up, z toward the screen; origin H0 = 12 cm above the keyboard deck centre.
 *
 *   const eng = Bat3D.create({ geom: 'galaxy', phones: [{ id: 'A', hz: 17000, x_right_cm: 0, h_cm: 45, z_front_cm: 30 }],
 *                              model: 'learned', calib: null, useDefault: true, stillMode: 'origin' | 'rebase',
 *                              onFrame(f) {...}, onCircle(c) {...}, onStatus(text) {...} });
 *   await eng.start({ mode: 'mic', vol: 0.5 })   or   await eng.start({ mode: 'wav', arrayBuffer, name })
 *   eng.stop(); eng.originReset(); eng.setCalib(json); eng.info()
 *   onFrame every 10 ms: { t (ms of audio), levelDb (laptop tone level vs the teach sittings; < -6 dB: turn the volume up,
 *     the map under-predicts), raw [x,y,z] (solve output + rebase offset), kf [x,y,z], v [vx,vy,vz],
 *     moving, still (ms held still), rebased (true on the frame a rebase / origin reset happened), q[], act[], amp[],
 *     off[] (phone clock offsets, Hz), identical (mic channels equal), mono }
 *   onCircle: { dir 'cw' | 'ccw', turns, ru, rw (cm), plane, t }   (fires once a circle has FINISHED)
 *   info(): { freqs, phone, cal, learned, calName, amp ('half' default | 'matched' | 'mse'), err {rms, motion, corr, size} | null, sv [3], gain [3], swapLR }
 *   opts.amp: size scale after the learned map ('half': ~no error cost, height drawn 0.69 of true instead of 0.47;
 *     'matched': true size, +7-17 % error; 'mse': the raw least-squares map)
 *   Node / tests: Bat3D.create(...).feed(workletMessage) runs the same per-batch code without audio.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Bat3D = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = 1;
  // ------------------------------------------------------------------ worklet: T tones x 2 mic channels (stream t*2+c)
  const PROC = `
class BatIQ6 extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = o.processorOptions || {};
    this.freqs = p.freqs || [18000, 19500]; this.pll = p.pll || this.freqs.map(() => false); this.T = this.freqs.length;
    this.dec = 48; this.lpHz = 250; this.tauS = 0.25; this.gate = p.gate || 1.5;
    this.rate2 = sampleRate / this.dec; this.lam = this.freqs.map((f) => 343 / f);
    const wn = 2 * Math.PI * (p.bwHz || 0.4), dt = 1 / this.rate2; this.kp = 2 * 0.9 * wn * dt; this.ki = wn * wn * dt * dt;
    this.coef = [0.5412, 1.3066].map((Q) => { const w = 2 * Math.PI * this.lpHz / sampleRate, cw = Math.cos(w), al = Math.sin(w) / (2 * Q), a0 = 1 + al;
      return [(1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0, -2 * cw / a0, (1 - al) / a0]; });
    this.win = Math.round(4 * this.rate2); this.n = 0; this.batch = 0; this.st = null; this.reset();
  }
  reset() { const S = 2 * this.T; this.out = Array.from({ length: S }, () => []); this.qs = new Array(S).fill(0); this.qa = new Array(S).fill(0); this.amp = new Array(S).fill(0); this.qn = 0; this.same = 0; this.cnt = 0; }
  newState() {
    return { z: [0, 1].map(() => this.coef.map(() => [0, 0, 0, 0])), mI: 0, mQ: 0, init: 0, iS: 0, qS: 0, pI: 0, pQ: 0, pm: 0,
      ring: new Float32Array(this.win), ri: 0, rn: 0, noise: 0, cnt: 0, th: 0, w: 0, th20: 0 };
  }
  lp(z, x) { for (let j = 0; j < this.coef.length; j++) { const c = this.coef[j], s = z[j];
      const y = c[0] * x + c[1] * s[0] + c[2] * s[1] - c[3] * s[2] - c[4] * s[3]; s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y; x = y; } return x; }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const C = inp.length, N = inp[0].length, T = this.T;
    if (!this.st) this.st = [0, 1].map(() => this.freqs.map(() => this.newState()));
    const a = 1 / (this.tauS * this.rate2), w = this.freqs.map((f) => 2 * Math.PI * f / sampleRate);
    for (let i = 0; i < N; i++) {
      const g = this.n + i, take = g % this.dec === this.dec - 1;
      const cs = w.map((v) => Math.cos(v * g)), sn = w.map((v) => Math.sin(v * g));
      if (C > 1) { this.cnt++; if (inp[0][i] === inp[1][i]) this.same++; }
      for (let c = 0; c < 2; c++) {
        const x = inp[Math.min(c, C - 1)][i];
        for (let t = 0; t < T; t++) {
          const s = this.st[c][t], idx = t * 2 + c;
          let I = this.lp(s.z[0], 2 * x * cs[t]), Q = this.lp(s.z[1], -2 * x * sn[t]);
          if (!take) continue;
          this.amp[idx] += Math.hypot(I, Q);
          if (s.init < 320) {
            if (s.init === 20) s.th20 = Math.atan2(Q, I);
            if (s.init >= 20) { s.iS += I; s.qS += Q; }
            s.init++;
            if (s.init === 320) {
              s.mI = s.iS / 300; s.mQ = s.qS / 300;
              if (this.pll[t]) { s.th = Math.atan2(Q, I); let d = s.th - s.th20; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI)); s.w = d / 300; s.mI = Math.hypot(I, Q); s.mQ = 0; }
            }
            this.out[idx].push(0); continue;
          }
          if (this.pll[t]) {
            const cc = Math.cos(s.th), ss = Math.sin(s.th), i2 = I * cc + Q * ss, q2 = Q * cc - I * ss;
            I = i2; Q = q2;
            const e = Math.atan2(q2, i2); s.w += this.ki * e; s.th += s.w + this.kp * e;
            if (s.th > Math.PI) s.th -= 2 * Math.PI; else if (s.th < -Math.PI) s.th += 2 * Math.PI;
          }
          s.mI += a * (I - s.mI); s.mQ += a * (Q - s.mQ);
          const dI = I - s.mI, dQ = Q - s.mQ, m = Math.hypot(dI, dQ);
          s.ring[s.ri] = m; s.ri = (s.ri + 1) % this.win; s.rn = Math.min(this.win, s.rn + 1);
          if (++s.cnt % 100 === 0) { const k = Math.max(1, Math.floor(s.rn / 50)), xs = []; for (let j = 0; j < s.rn; j += k) xs.push(s.ring[j]); xs.sort((u, v) => u - v); s.noise = xs[Math.floor(0.25 * (xs.length - 1))] || 0; }
          let d = 0;
          if (m > this.gate * s.noise && s.pm > this.gate * s.noise) d = -Math.atan2(dQ * s.pI - dI * s.pQ, dI * s.pI + dQ * s.pQ) * this.lam[t] / (2 * Math.PI);
          s.pI = dI; s.pQ = dQ; s.pm = m;
          this.out[idx].push(d); if (s.noise > 0) this.qs[idx] += m / s.noise; if (d !== 0) this.qa[idx]++;
        }
      }
      if (take) this.qn++;
    }
    this.n += N;
    if (++this.batch >= 8) {
      const qn = Math.max(1, this.qn);
      const off = this.freqs.map((_, t) => (this.pll[t] ? this.st[0][t].w * this.rate2 / (2 * Math.PI) : 0));
      this.port.postMessage({ steps: this.out.map((o) => Float32Array.from(o)), q: this.qs.map((v) => v / qn), act: this.qa.map((v) => v / qn), amp: this.amp.map((v) => v / qn),
        identical: this.cnt ? this.same / this.cnt : 1, mono: C < 2, off });
      this.reset(); this.batch = 0;
    }
    return true;
  }
}
registerProcessor('bat-iq6', BatIQ6);
`;

  // ------------------------------------------------------------------ geometry and calibration
  const GEOMS = {
    // speakers as labelled (webcam teach 035336: 18 kHz path follows a LEFT source). laptopDirSign: the laptop-only
    // circle direction comes out mirrored with the hand over the keyboard (circle WAVs 021834 / 022153)
    galaxy: { SL: [-0.15, -0.01, -0.08], SR: [0.15, -0.01, -0.08], M: [[0.025, 0.19, 0.17], [-0.025, 0.19, 0.17]], swapLR: false, laptopDirSign: -1 },
    macbook: { SL: [-0.14, 0.0, 0.02], SR: [0.14, 0.0, 0.02], M: [[-0.10, 0.0, 0.10], [-0.10, 0.0, 0.10]], swapLR: false },
  };
  const H0 = [0, 0.12, 0.0];
  // built-in Galaxy Book calibration (laptop only): learned on five webcam-taught sittings; error = leave-one-sitting-out
  const DEFAULT_CALIB = { galaxy: {"v":1,"session":"default (5 sittings, leave-one-out)","winMs":250,"nearM":0.45,"cam":{"mirror":false,"tilt":0,"hfov":78},"lagMs":0,"mics":[[0.025,0.19,0.1],[-0.025,0.19,0.1]],"paths":[{"key":"18k","hz":18000,"ch":0,"pll":false,"pos":[-0.3221,-0.0389,-0.0986],"gain":0.18,"r2":0.592},{"key":"18k","hz":18000,"ch":1,"pll":false,"pos":[-0.2247,-0.0824,-0.0623],"gain":0.178,"r2":0.657},{"key":"19.5k","hz":19500,"ch":0,"pll":false,"pos":[0.1865,-0.0093,0.0172],"gain":0.215,"r2":0.683},{"key":"19.5k","hz":19500,"ch":1,"pll":false,"pos":[0.3623,0.1147,-0.0174],"gain":0.226,"r2":0.761}],"learned":{"laptop":{"idx":[0,1,2,3],"W":[[0.856259,0.93255,-0.706279,-0.985171,-0.000048],[0.122328,0.15398,0.199745,0.128281,0.002188],[-0.295803,-0.434315,-0.435055,-0.50236,-0.001569]]},"all":null},"errors":{"learned, laptop only":{"rms":[4.42,2.99,4.33],"motion":[6.96,3.4,6.25],"corr":[0.78,0.48,0.72]}},"truthFloorCm":[0.2,0.09,0.15],"note":"Galaxy Book 61f5, 서진, hand 25-45 cm from the webcam; error = leave-one-sitting-out over 20261115_035336, 20261115_040340, 20261115_040721, 20261115_043301, 20261115_044652","amp":{"method":"leave-one-sitting-out over 5 sittings, scale estimated without the held-out sitting","corr":[0.78,0.47,0.72],"motion":[6.96,3.4,6.25],"modes":{"mse":{"k":[1,1,1],"rms":[4.42,2.99,4.33],"size":[0.7,0.47,0.72]},"half":{"k":[1.2,1.46,1.17],"rms":[4.42,3.08,4.45],"size":[0.85,0.69,0.86]},"matched":{"k":[1.44,2.12,1.38],"rms":[4.75,3.51,4.81],"size":[1.03,1.01,1.03]}}}} };
  // tone level the built-in calibration was learned at (worklet carrier amplitude per laptop stream, median of the teach
  // sittings, tones at 0.6 per channel). A quieter tone -> fewer phase steps pass the gate -> the map under-predicts motion.
  const REF_AMP = { galaxy: [0.0089, 0.0183, 0.0056, 0.0101] };
  const VOLUME_TEACH = 1.2;   // osc 0.5 x volume 1.2 = 0.6 per channel, as in teach.html (dsp.js stereo tones)
  const sub = (a, b) => a.map((v, i) => v - b[i]), nrm = (a) => Math.hypot(...a), unit = (a) => { const n = nrm(a) || 1; return a.map((v) => v / n); };
  function inv3(A) {
    const [a, b, c] = A[0], [d, e, f] = A[1], [g, h, i] = A[2], det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    return [[(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det], [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det], [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]];
  }
  function eig3(S) {
    const A = S.map((r) => r.slice()), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let it = 0; it < 50; it++) for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(A[p][q]) < 1e-18) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const x = A[k][p], y = A[k][q]; A[k][p] = c * x - s * y; A[k][q] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = A[p][k], y = A[q][k]; A[p][k] = c * x - s * y; A[q][k] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = V[k][p], y = V[k][q]; V[k][p] = c * x - s * y; V[k][q] = s * x + c * y; }
    }
    const idx = [0, 1, 2].sort((i, j) => A[j][j] - A[i][i]);
    return { val: idx.map((i) => A[i][i]), vec: idx.map((i) => [V[0][i], V[1][i], V[2][i]]) };
  }
  // phone speaker position from cm fields: right of the laptop centre, height above the desk, in front of the hinge line
  const phonePos = (x, h, zf) => [Number(x) / 100, Number(h) / 100 - 0.015, 0.10 - Number(zf) / 100];

  function create(opts = {}) {
    const o = { geom: 'galaxy', paths: 'avg', model: 'learned', useDefault: true, calib: null, flipDir: false, stillMode: 'origin', autoReset: true, actOn: 0.004, amp: 'half', ...opts };
    let wavMode = false;
    let cfg = null, solver = null, calibInUse = null;
    // ---------------------------------------------------------------- solver (same as 3d.html buildSolver)
    function buildSolver() {
      const G0 = GEOMS[o.geom] || GEOMS.galaxy, swap = o.swapLR ?? G0.swapLR;
      const G = swap ? { ...G0, SL: G0.SR, SR: G0.SL } : G0;
      const phones = (o.phones || []).map((p, i) => ({ id: p.id || String.fromCharCode(65 + i), hz: Number(p.hz) || 17000, P: p.P || phonePos(p.x_right_cm ?? 0, p.h_cm ?? 45, p.z_front_cm ?? 30) }));
      const freqs = [18000, 19500].concat(phones.map((p) => p.hz));
      cfg = { G, phones, phone: phones.length > 0, freqs, swap, pll: freqs.map((_, t) => t >= 2), avg: o.paths === 'avg', model: o.model };
      const { phone, avg } = cfg, S = [G.SL, G.SR].concat(phones.map((p) => p.P)), T = S.length;
      const Mc = G.M[0].map((v, i) => (v + G.M[1][i]) / 2);
      const row = (Sx, M) => { const a = unit(sub(H0, Sx)), b = unit(sub(H0, M)); return a.map((v, i) => v + b[i]); };
      const cand = o.calib || (o.useDefault ? DEFAULT_CALIB[o.geom] : null);
      const cal = cand && cand.paths.length === 2 * T && cand.paths.every((p, i) => Math.abs(p.hz - cfg.freqs[i >> 1]) < 300) ? cand : null;
      const useAvg = avg && !cal;
      const J = cal ? cal.paths.map((p) => row(p.pos, cal.mics[p.ch] || Mc).map((v) => v * (p.gain ?? 1))) : useAvg ? S.map((s) => row(s, Mc)) : S.flatMap((s) => G.M.map((m) => row(s, m)));
      const g2 = cal ? cal.paths.reduce((s, p) => s + (p.gain ?? 1) ** 2, 0) / cal.paths.length : 1;
      const JtJ = [0, 1, 2].map((i) => [0, 1, 2].map((j) => J.reduce((s, r) => s + r[i] * r[j], 0)));
      const E0 = eig3(JtJ), v3 = E0.vec[2], small = 1e-3 * g2 * (cal ? 20 : 1), big = phone ? 0 : 10 * g2;
      const PRIOR = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? small : 0) + big * v3[i] * v3[j] + (phone && i === 1 && j === 1 && !cal ? 0.02 : 0)));
      const Ai = inv3(JtJ.map((r, i) => r.map((v, j) => v + PRIOR[i][j])));
      const K = Ai.map((r) => J.map((_, n) => r.reduce((s, v, j) => s + v * J[n][j], 0)));
      const sv = eig3(JtJ).val.map((v) => Math.sqrt(Math.max(0, v)));
      const gain = [0, 1, 2].map((i) => Math.sqrt(Math.max(0, [0, 1, 2].reduce((s, j) => s + Ai[i][j] * [0, 1, 2].reduce((q, k) => q + JtJ[j][k] * Ai[i][k], 0), 0))));
      const L = cal && cfg.model === 'learned' ? (phone ? cal.learned.all : cal.learned.laptop) : null;
      calibInUse = cal;
      const meas = useAvg ? (D) => Array.from({ length: T }, (_, t) => (D[2 * t] + D[2 * t + 1]) / 2) : (D) => D.slice(0, 2 * T);
      // size scale: a least-squares map draws motion at (correlation) x its true size; 'half' = sqrt correction (almost no
      // error cost), 'matched' = true size (+7-17 % error), 'mse' = none. From the calibration's leave-one-out table.
      const ampMode = cal && cal.amp && cal.amp.modes[o.amp || 'half'] ? (o.amp || 'half') : null, kAmp = ampMode ? cal.amp.modes[ampMode].k : [1, 1, 1];
      const solve = L ? (D) => H0.map((h, i) => h + kAmp[i] * L.idx.reduce((s, p, n) => s + L.W[i][n] * D[p], 0))
        : (D) => { const m = meas(D); return H0.map((h, i) => h + K[i].reduce((s, v, n) => s + v * m[n], 0)); };
      const errKey = cal ? Object.keys(cal.errors).find((k) => k.startsWith(L ? 'learned' : 'physics') && (phone ? /phone/.test(k) : /laptop only/.test(k))) : null;
      const errA = L && ampMode ? { rms: cal.amp.modes[ampMode].rms, motion: cal.amp.motion, corr: cal.amp.corr, size: cal.amp.modes[ampMode].size, amp: ampMode } : null;
      solver = { G, T, K, sv, gain, phone, cal: !!cal, learned: !!L, err: errA || (errKey ? cal.errors[errKey] : null), errName: errKey, solve, calName: cal ? cal.session : null, amp: L ? ampMode || 'mse' : null };
    }
    // ---------------------------------------------------------------- Kalman (constant velocity, per axis)
    const kf = { p: H0.slice(), v: [0, 0, 0], P: [0, 1, 2].map(() => [[1e-4, 0], [0, 1e-2]]) };
    const KF_Q = 4.0, KF_R = 0.015 ** 2;
    function kfStep(z, dt) {
      for (let i = 0; i < 3; i++) {
        const [[a, b], [c, d]] = kf.P[i];
        kf.p[i] += kf.v[i] * dt;
        const q11 = KF_Q * dt ** 3 / 3, q12 = KF_Q * dt ** 2 / 2, q22 = KF_Q * dt;
        const a1 = a + dt * (b + c) + dt * dt * d + q11, b1 = b + dt * d + q12, c1 = c + dt * d + q12, d1 = d + q22;
        const S = a1 + KF_R, k1 = a1 / S, k2 = c1 / S, r = z[i] - kf.p[i];
        kf.p[i] += k1 * r; kf.v[i] += k2 * r;
        kf.P[i] = [[(1 - k1) * a1, (1 - k1) * b1], [c1 - k2 * a1, d1 - k2 * b1]];
      }
    }
    function kfReset(p0 = H0) { kf.p = p0.slice(); kf.v = [0, 0, 0]; kf.P = [0, 1, 2].map(() => [[1e-4, 0], [0, 1e-2]]); }
    // ---------------------------------------------------------------- circle turns in a plane
    function circleTurns(T, U, W, { vMin = 0.06, maxMs = 2600 } = {}) {
      if (T.length < 8) return { turns: 0, ru: 0, rw: 0, t0: 0, t1: 0 };
      const th = [0]; let prev = null, acc = 0;
      for (let k = 1; k < T.length - 1; k++) {
        const du = U[k + 1] - U[k - 1], dw = W[k + 1] - W[k - 1], dt = (T[k + 1] - T[k - 1]) / 1000;
        if (Math.hypot(du, dw) / dt > vMin) { const a = Math.atan2(dw, du); if (prev != null) { let d = a - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; acc += d; } prev = a; } else prev = null;
        th.push(acc / (2 * Math.PI));
      }
      th.push(th[th.length - 1]);
      let best = 0, b0 = 0, b1 = 0;
      for (let i = 0, j = 0; j < T.length; j++) { while (T[j] - T[i] > maxMs) i++; for (let k = i; k < j; k += 3) { const d = th[j] - th[k]; if (Math.abs(d) > Math.abs(best)) { best = d; b0 = k; b1 = j; } } }
      const rg = (A) => 100 * (Math.max(...A.slice(b0, b1 + 1)) - Math.min(...A.slice(b0, b1 + 1)));
      const u = U.slice(b0, b1 + 1), w = W.slice(b0, b1 + 1), mu = u.reduce((s, x) => s + x, 0) / u.length, mw = w.reduce((s, x) => s + x, 0) / w.length;
      let a = 0, b = 0, c = 0; for (let k = 0; k < u.length; k++) { a += (u[k] - mu) ** 2; b += (u[k] - mu) * (w[k] - mw); c += (w[k] - mw) ** 2; }
      const tr = a + c, dt = Math.sqrt(Math.max(0, (a - c) ** 2 + 4 * b * b)), round = tr > 0 ? (tr - dt) / (tr + dt) : 0;
      return { turns: best, ru: rg(U), rw: rg(W), t0: T[b0], t1: T[b1], round };
    }
    function planeCoords(w) {
      if (!solver.phone) return { U: w.map((q) => q.p[0]), W: w.map((q) => q.p[2]), name: '수평(x·z)' };
      const m = [0, 1, 2].map((i) => w.reduce((s, q) => s + q.p[i], 0) / w.length);
      const S = [0, 1, 2].map((i) => [0, 1, 2].map((j) => w.reduce((s, q) => s + (q.p[i] - m[i]) * (q.p[j] - m[j]), 0) / w.length));
      const e = eig3(S), n = e.vec[2], vertical = Math.abs(n[2]) > Math.abs(n[1]);
      let a = e.vec[0], b = e.vec[1];
      if (Math.abs(b[0]) > Math.abs(a[0])) [a, b] = [b, a];
      if (a[0] < 0) a = a.map((v) => -v);
      if ((vertical ? b[1] : b[2]) < 0) b = b.map((v) => -v);
      const pr = (q, ax) => ax.reduce((s, v, i) => s + v * (q.p[i] - m[i]), 0);
      return { U: w.map((q) => pr(q, a)), W: w.map((q) => pr(q, b)), name: vertical ? '수직(화면과 나란히)' : '수평' };
    }
    // ---------------------------------------------------------------- live state and per-batch processing
    const live = { D: [], q: [], act: [], amp: [], off: [], identical: 1, mono: false, t: 0, still: 0, lastAct: [] };
    const trail = [];
    let sub10 = 0, lastCircle = null, circleEnd = -1e9, offset = [0, 0, 0];
    function resetLive() {
      const S = 2 * solver.T;
      Object.assign(live, { D: new Array(S).fill(0), q: new Array(S).fill(0), act: new Array(S).fill(0), amp: new Array(S).fill(0), off: [], still: 0, lastAct: [] });
    }
    function originReset() { live.D = live.D.map(() => 0); offset = [0, 0, 0]; kfReset(); trail.length = 0; circleEnd = live.t; }
    function feed(m) {
      const S = m.steps.length;
      if (live.D.length !== S) return;
      for (let i = 0; i < S; i++) { live.q[i] = 0.8 * live.q[i] + 0.2 * m.q[i]; live.act[i] = 0.8 * live.act[i] + 0.2 * m.act[i]; live.amp[i] = 0.8 * live.amp[i] + 0.2 * m.amp[i]; }
      live.identical = m.identical; live.mono = m.mono; live.off = m.off;
      const n = m.steps[0].length;
      for (let k = 0; k < n; k++) {
        let a = 0;
        for (let i = 0; i < S; i++) { const s = m.steps[i][k]; live.D[i] += s; a += Math.abs(s); }
        live.t += 1; live.lastAct.push(a / S); if (live.lastAct.length > 800) live.lastAct.shift();
        if (++sub10 < 10) continue;
        sub10 = 0;
        const z = solver.solve(live.D).map((v, i) => v + offset[i]); kfStep(z, 0.01);
        const t = live.t, p = kf.p.slice(); trail.push({ t, p }); while (trail.length && trail[0].t < t - 3500) trail.shift();
        const n100 = Math.min(100, live.lastAct.length); let a100 = 0; for (let j = live.lastAct.length - n100; j < live.lastAct.length; j++) a100 += live.lastAct[j];
        const moving = a100 > o.actOn;
        if (!moving) live.still += 10; else live.still = 0;
        let rebased = false;
        if (live.still === 1000 && o.autoReset !== false) {
          if (o.stillMode === 'rebase') {   // keep the position: zero the path sums, carry the current solve as an offset
            offset = z.map((v, i) => v - H0[i]); live.D = live.D.map(() => 0); kf.v = [0, 0, 0];
          } else { live.D = live.D.map(() => 0); offset = [0, 0, 0]; kfReset(); trail.length = 0; }   // held still 1 s: origin again
          rebased = true;
        }
        let circle = null;
        if (t % 100 === 0) {
          const w = trail.filter((q) => q.t >= t - 3200 && q.t > circleEnd);
          if (w.length > 60) {
            const pc = planeCoords(w), r = circleTurns(w.map((q) => q.t), pc.U, pc.W);
            if (Math.abs(r.turns) >= 1.1 && r.ru >= 3 && r.rw >= 3 && r.t1 <= t - 300 && (!solver.phone || r.round >= 0.12)) {
              const sgn = (o.flipDir ? -1 : 1) * (solver.phone ? 1 : solver.G.laptopDirSign || 1);
              circle = lastCircle = { dir: Math.sign(r.turns) * sgn < 0 ? 'cw' : 'ccw', turns: r.turns, ru: r.ru, rw: r.rw, t, plane: pc.name };
              circleEnd = r.t1;
              if (o.onCircle) o.onCircle(circle);
            }
          }
        }
        const ref = REF_AMP[o.geom], levelDb = ref ? 20 * Math.log10(Math.max(1e-9, (live.amp[0] + live.amp[1] + live.amp[2] + live.amp[3]) / (ref[0] + ref[1] + ref[2] + ref[3]))) : null;
        if (o.onFrame) o.onFrame({ t, s: wavMode ? t / 1000 : undefined, levelDb, raw: z, kf: kf.p.slice(), v: kf.v.slice(), moving, still: live.still, reset: rebased, rebased, q: live.q.slice(), act: live.act.slice(), amp: live.amp.slice(), off: live.off, identical: live.identical, mono: live.mono, circle });
      }
    }
    // ---------------------------------------------------------------- audio (browser)
    let ctx = null, node = null, src = null, stream = null, oscs = [], gainNode = null;
    const status = (s) => { if (o.onStatus) o.onStatus(s); };
    async function start({ mode = 'mic', arrayBuffer = null, file = null, name = 'WAV', vol, volume } = {}) {
      vol = volume ?? vol ?? VOLUME_TEACH;
      if (file && !arrayBuffer) { arrayBuffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer(); if (file.name) name = file.name; }
      stop(); buildSolver(); resetLive(); wavMode = mode !== 'mic'; live.t = 0; sub10 = 0;
      ctx = new AudioContext({ sampleRate: 48000 });
      const url = URL.createObjectURL(new Blob([PROC], { type: 'application/javascript' }));
      try { await ctx.audioWorklet.addModule(url); } catch (_) { await ctx.audioWorklet.addModule('data:application/javascript;charset=utf-8,' + encodeURIComponent(PROC)); }
      URL.revokeObjectURL(url);
      node = new AudioWorkletNode(ctx, 'bat-iq6', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete', processorOptions: { freqs: cfg.freqs, pll: cfg.pll } });
      const mute = ctx.createGain(); mute.gain.value = 0; node.connect(mute).connect(ctx.destination);
      node.port.onmessage = (e) => feed(e.data);
      if (mode === 'mic') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000 } });
        src = ctx.createMediaStreamSource(stream); src.connect(node);
        const merger = ctx.createChannelMerger(2); gainNode = ctx.createGain(); gainNode.gain.value = vol;
        [18000, 19500].forEach((f, i) => { const osc = ctx.createOscillator(); osc.frequency.value = f; const g = ctx.createGain(); g.gain.value = 0.5; osc.connect(g).connect(merger, 0, i); osc.start(); oscs.push(osc); });
        merger.connect(gainNode).connect(ctx.destination);
        status((solver.cal ? '듣는 중 · 손은 노트북 앞 모서리 위, 책상에서 18~25cm, 웹캠에서 25~45cm(보정 범위)' : '듣는 중 · 손은 키보드 가운데~앞쪽 위 10~25cm') + (cfg.phone ? ` · 폰 ${cfg.freqs.slice(2).join('/')}Hz` : ''));
      } else {
        const buf = await ctx.decodeAudioData(arrayBuffer);
        src = ctx.createBufferSource(); src.buffer = buf; src.connect(node); src.start();
        src.onended = () => status('WAV 재생 끝');
        status(`WAV 재생 중: ${name} (${buf.numberOfChannels}채널, ${buf.duration.toFixed(0)}초)`);
      }
      originReset();
      return { ctx, source: src };
    }
    function stop() {
      try { oscs.forEach((x) => x.stop()); } catch (_) { /* ignore */ }
      oscs = [];
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (ctx) ctx.close();
      ctx = node = src = stream = gainNode = null;
      status('멈춤');
    }
    buildSolver(); resetLive();
    return {
      start, stop, originReset, feed,
      setCalib(c) { o.calib = c; if (c) o.model = 'learned'; buildSolver(); resetLive(); },
      setOptions(x) { Object.assign(o, x); buildSolver(); resetLive(); },
      setVolume(v) { if (gainNode) gainNode.gain.value = v; },
      info: () => ({ freqs: cfg.freqs.slice(), pll: cfg.pll.slice(), T: solver.T, amp: solver.amp, phone: solver.phone, phones: cfg.phones.map((p) => ({ id: p.id, hz: p.hz, P: p.P })), cal: solver.cal, learned: solver.learned, calName: solver.calName, err: solver.err, sv: solver.sv, gain: solver.gain, swapLR: cfg.swap, H0,
        G: { SL: solver.G.SL, SR: solver.G.SR, M: solver.G.M }, calib: calibInUse ? { paths: calibInUse.paths.map((p) => ({ key: p.key, hz: p.hz, ch: p.ch, pos: p.pos, gain: p.gain })), mics: calibInUse.mics, cam: calibInUse.cam, lagMs: calibInUse.lagMs, truthFloorCm: calibInUse.truthFloorCm } : null }),
      onFrame(fn) { o.onFrame = fn; }, onCircle(fn) { o.onCircle = fn; }, onStatus(fn) { o.onStatus = fn; },
      on(name, fn) { if (name === 'frame') o.onFrame = fn; else if (name === 'circle') o.onCircle = fn; else if (name === 'status') o.onStatus = fn; },
      get live() { return live; }, get kf() { return kf; }, get trail() { return trail; }, get lastCircle() { return lastCircle; },
    };
  }
  return { create, start: async (opts, startOpts) => { const e = create(opts); await e.start(startOpts); return e; }, PROC, GEOMS, H0, DEFAULT_CALIB, REF_AMP, VOLUME_TEACH, phonePos, VERSION };
});
