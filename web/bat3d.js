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
 *   opts.model: 'gated' (default, bravo 11:45: the linear map's gains set every 10 ms by a small
 *     net from the last 0.5 s of path change and gate activity; webcam-trained on teach + hologram compare sittings;
 *     falls back to 'learned' when the calibration carries no gated model) | 'learned' (v15 linear map) | 'physics'. info().model says which runs.
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
    this.dec = 48; this.lpHz = 250; this.tauS = p.tauS || 0.1; this.gate = p.gate || 1.0;   // v2 tracker (bravo 10:00): gate 1.5 -> 1.0, tau 0.25 -> 0.1 s, unseen-sitting corr +0.06/+0.03/+0.01
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
  // built-in Galaxy Book calibration (laptop only): learned on 8 webcam-taught sittings; error = leave-one-sitting-out
  const DEFAULT_CALIB = { galaxy: {"v":1,"session":"default (8 sittings, leave-one-out)","winMs":250,"nearM":0.45,"cam":{"mirror":false,"tilt":0,"hfov":78},"lagMs":0,"mics":[[0.025,0.19,0.1],[-0.025,0.19,0.1]],"paths":[{"key":"18k","hz":18000,"ch":0,"pll":false,"pos":[-0.3221,-0.0389,-0.0986],"gain":0.18,"r2":0.592},{"key":"18k","hz":18000,"ch":1,"pll":false,"pos":[-0.2247,-0.0824,-0.0623],"gain":0.178,"r2":0.657},{"key":"19.5k","hz":19500,"ch":0,"pll":false,"pos":[0.1865,-0.0093,0.0172],"gain":0.215,"r2":0.683},{"key":"19.5k","hz":19500,"ch":1,"pll":false,"pos":[0.3623,0.1147,-0.0174],"gain":0.226,"r2":0.761}],"learned":{"laptop":{"idx":[0,1,2,3],"W":[[0.707955,0.600407,-0.385781,-0.680277,0.000195],[0.101656,0.128168,0.14253,0.125858,0.001],[-0.163739,-0.281395,-0.309395,-0.410128,0.000068]]},"all":null},"errors":{"learned, laptop only":{"rms":[3.74,2.42,4.18],"motion":[5.48,2.95,5.81],"corr":[0.73,0.57,0.7]}},"truthFloorCm":[0.2,0.09,0.15],"note":"Galaxy Book 61f5, Seojin, hand 25-45 cm from the webcam; error = leave-one-sitting-out over 20261115_035336, 20261115_040340, 20261115_040721, 20261115_043301, 20261115_044652, 20261115_082736, 20261115_090503, 20261115_092315","amp":{"method":"leave-one-sitting-out over 8 sittings, scale estimated without the held-out sitting","corr":[0.73,0.57,0.7],"motion":[5.48,2.95,5.81],"modes":{"mse":{"k":[1,1,1],"rms":[3.74,2.42,4.18],"size":[0.68,0.57,0.69]},"half":{"k":[1.217,1.33,1.201],"rms":[3.76,2.48,4.26],"size":[0.83,0.75,0.83]},"matched":{"k":[1.481,1.77,1.442],"rms":[4.04,2.74,4.56],"size":[1.01,1,1]}}},"gated":{"kind":"gated-v1","ticksMs":10,"ctx":"dD 250 ms (4), dD 250-500 ms (4), gated share 250 ms (4)","sittings":["035336","040340","040721","043301","044652","082736","090503","092315","110640c","111016c","111911c","112252c","112658c"],"amp":{"method":"corr / rms: leave-one-sitting-out over 13 sittings (8 teach + 5 hologram compare, engine-equivalent 10 ms ticks); size / k: in-sample (k slightly conservative)","corr":[0.78,0.6,0.7],"motion":[5.27,3.59,5.77],"modes":{"mse":{"k":[1,1,1],"rms":[3.31,2.77,4.13],"size":[0.81,0.69,0.71]},"half":{"k":[1.111,1.207,1.185],"rms":[3.35,2.82,4.2],"size":[0.9,0.83,0.84]},"matched":{"k":[1.234,1.457,1.404],"rms":[3.47,3.02,4.46],"size":[1,1,1]}}},"loso":{"all":{"ridge":[0.746,0.573,0.703],"gated":[0.782,0.603,0.703]},"compare":{"ridge":[0.81,0.583,0.736],"gated":[0.804,0.636,0.739]},"betterSittings":"11/13"},"W0":[[0.68748,0.541524,-0.343766,-0.674127],[0.115075,0.151035,0.135127,0.177029],[-0.117277,-0.226187,-0.346431,-0.378828]],"Sg":0.324491,"mu":[-0.00641501,-0.00616621,-0.00575098,-0.00620227,-0.00967944,-0.00969375,-0.00960631,-0.0103624,0.744447,0.749104,0.720879,0.737546],"sd":[0.0373735,0.0384048,0.0388313,0.0403669,0.0380066,0.0394395,0.038944,0.0407696,0.184911,0.183441,0.203841,0.195999],"H":8,"W1":[0.247866,0.554991,0.531509,0.822482,-0.492482,-0.0869633,-0.205203,-0.332563,-0.0366244,-0.0977166,-0.284394,0.00702831,0.15145,0.256114,0.681345,0.152683,0.167252,0.453633,-0.130318,-0.423736,0.118114,-0.184741,0.28915,0.156942,0.440241,0.390961,-0.477078,-0.414644,-0.111248,0.0304922,0.207969,-0.233302,-0.0395858,-0.466641,0.277659,0.495953,-0.477315,-0.0948929,0.74109,0.444048,0.136577,0.33249,0.209629,0.399267,-0.657853,0.54556,0.325497,0.283973,-0.152907,0.261811,0.38721,0.395826,-0.0141032,-0.159619,-0.718947,-0.569683,0.274536,0.18168,-0.279513,-0.119558,0.345107,0.595609,0.073203,-0.25088,-0.0331236,0.179765,-0.301964,-0.310077,-0.281553,0.0966768,-0.154575,0.159031,0.0140926,-0.331272,0.0117021,0.269928,-0.407156,0.417889,0.065142,0.0307554,-0.243429,-0.191049,-0.495514,-0.744227,0.742008,0.409791,0.440011,-0.129939,0.667277,-0.0275177,-0.323991,-0.313616,0.409742,-0.0690899,0.2673,-0.296248],"b1":[-1.72137,-1.17387,0.508891,0.824891,-0.231915,0.676093,0.344018,-0.0875237],"W2":[-1.04171,0.0321342,0.0717133,0.0162511,-0.182187,0.850633,0.808377,-0.236833,-0.777726,-0.146431,0.354716,-0.326411,-0.315666,0.293199,-0.013218,-0.0451345,0.320836,0.101271,0.165026,0.164081,-0.475345,0.295846,-0.392439,0.204724,0.60938,0.00866068,0.2052,0.0514251,0.0172593,0.341786,-0.378707,0.407537,0.446201,-0.584816,0.766012,0.6005,0.0704912,-0.39017,0.137547,-0.0588314,0.4555,-0.72181,0.570596,0.00851985,0.00808464,-0.603771,0.405738,0.546327,-0.155189,-0.587614,0.0393382,0.404303,0.296686,0.290549,-0.077906,0.477779,-0.300143,-0.521284,0.204982,0.35198,0.14478,0.0416662,0.494535,0.444035,-0.233314,-0.378533,0.60383,0.17894,0.313269,0.0931395,0.0960495,0.233258,-0.0147175,-0.226153,0.228211,0.344379,0.089694,-0.490421,0.0751517,0.0924848,-0.0340986,0.0908473,-0.0516218,0.415621,0.125228,-0.111022,-0.0207254,0.0960605,0.0926505,-0.0063004,0.0800386,-0.0788893,-0.125957,-0.242187,-0.28004,-0.205593],"b2":[-0.785571,-0.611528,0.222032,0.00149897,-0.235826,0.0448718,-0.561081,-0.389513,-0.388611,-0.174079,-0.114985,0.0720954]}} };
  // tone level the built-in calibration was learned at (worklet carrier amplitude per laptop stream, median of the teach
  // sittings, tones at 0.6 per channel). A quieter tone -> fewer phase steps pass the gate -> the map under-predicts motion.
  const REF_AMP = { galaxy: [0.0089, 0.0183, 0.0056, 0.0101] };
  const VOLUME_TEACH = 1.2;   // osc 0.5 x volume 1.2 = 0.6 per channel, as in teach.html (dsp.js stereo tones)
  // named calibrations: { calib, phones (the tone set it was learned with), label, scope } -- pass calib: CALIBS[name].calib
  // and phones: CALIBS[name].phones (or create({ calibName: name }) which sets both)
  const CALIBS = {
    galaxy: { label: 'Laptop only (eight sittings)', scope: 'leave-one-sitting-out over 8 sittings', phones: [], calib: DEFAULT_CALIB.galaxy },
  };
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
    const o = { geom: 'galaxy', paths: 'avg', model: 'gated', useDefault: true, calib: null, flipDir: false, stillMode: 'origin', autoReset: true, actOn: 0.004, amp: 'half', ...opts };
    if (o.calibName && CALIBS[o.calibName]) { const C = CALIBS[o.calibName]; o.calib = C.calib; if (!opts.phones) o.phones = C.phones; }
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
      const L = cal && (cfg.model === 'learned' || cfg.model === 'gated') ? (phone ? cal.learned.all : cal.learned.laptop) : null;   // 'gated' falls back to this
      calibInUse = cal;
      const meas = useAvg ? (D) => Array.from({ length: T }, (_, t) => (D[2 * t] + D[2 * t + 1]) / 2) : (D) => D.slice(0, 2 * T);
      // size scale: a least-squares map draws motion at (correlation) x its true size; 'half' = sqrt correction (almost no
      // error cost), 'matched' = true size (+7-17 % error), 'mse' = none. From the calibration's leave-one-out table.
      const ampMode = cal && cal.amp && cal.amp.modes[o.amp || 'half'] ? (o.amp || 'half') : null, kAmp = ampMode ? cal.amp.modes[ampMode].k : [1, 1, 1];
      const solve = L ? (D) => H0.map((h, i) => h + kAmp[i] * L.idx.reduce((s, p, n) => s + L.W[i][n] * D[p], 0))
        : (D) => { const m = meas(D); return H0.map((h, i) => h + K[i].reduce((s, v, n) => s + v * m[n], 0)); };
      const errKey = cal ? Object.keys(cal.errors).find((k) => k.startsWith(L ? 'learned' : 'physics') && (phone ? /phone/.test(k) : /laptop only/.test(k))) : null;
      const errA = L && ampMode ? { rms: cal.amp.modes[ampMode].rms, motion: cal.amp.motion, corr: cal.amp.corr, size: cal.amp.modes[ampMode].size, amp: ampMode } : null;
      // context-gated map (bravo 11:45, model 'gated'): every 10 ms dPos = k .* G(ctx) . dD, G = W0 + Sg * net(ctx), ctx from the
      // last 0.5 s of path change and gate activity; laptop only. Falls back to the linear map when the calibration has none.
      const GM = cal && !phone && o.model === 'gated' && cal.gated && cal.gated.kind === 'gated-v1' ? cal.gated : null;
      const gAmpMode = GM && GM.amp && GM.amp.modes[o.amp || 'half'] ? (o.amp || 'half') : null, gK = gAmpMode ? GM.amp.modes[gAmpMode].k : [1, 1, 1];
      const errG = GM && gAmpMode ? { rms: GM.amp.modes[gAmpMode].rms, motion: GM.amp.motion, corr: GM.amp.corr, size: GM.amp.modes[gAmpMode].size, amp: gAmpMode } : null;
      solver = { G, T, K, sv, gain, phone, cal: !!cal, learned: !!L || !!GM, err: errG || errA || (errKey ? cal.errors[errKey] : null), errName: errKey, solve, calName: cal ? cal.session : null, amp: GM ? gAmpMode || 'mse' : L ? ampMode || 'mse' : null, gated: GM, gK, model: GM ? 'gated' : L ? 'learned' : 'physics' };
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
      if (!solver.phone) return { U: w.map((q) => q.p[0]), W: w.map((q) => q.p[2]), name: 'horizontal (x·z)' };
      const m = [0, 1, 2].map((i) => w.reduce((s, q) => s + q.p[i], 0) / w.length);
      const S = [0, 1, 2].map((i) => [0, 1, 2].map((j) => w.reduce((s, q) => s + (q.p[i] - m[i]) * (q.p[j] - m[j]), 0) / w.length));
      const e = eig3(S), n = e.vec[2], vertical = Math.abs(n[2]) > Math.abs(n[1]);
      let a = e.vec[0], b = e.vec[1];
      if (Math.abs(b[0]) > Math.abs(a[0])) [a, b] = [b, a];
      if (a[0] < 0) a = a.map((v) => -v);
      if ((vertical ? b[1] : b[2]) < 0) b = b.map((v) => -v);
      const pr = (q, ax) => ax.reduce((s, v, i) => s + v * (q.p[i] - m[i]), 0);
      return { U: w.map((q) => pr(q, a)), W: w.map((q) => pr(q, b)), name: vertical ? 'vertical (parallel to the screen)' : 'horizontal' };
    }
    // ---------------------------------------------------------------- live state and per-batch processing
    const live = { D: [], q: [], act: [], amp: [], off: [], identical: 1, mono: false, t: 0, still: 0, lastAct: [] };
    const trail = [];
    let sub10 = 0, lastCircle = null, circleEnd = -1e9, offset = [0, 0, 0];
    // gated model state: integrated position P (m, relative to H0), per-path gated-step counts, 10 ms snapshots (51 = 0.5 s)
    const gs = { P: [0, 0, 0], A: [0, 0, 0, 0], hD: [], hA: [] };
    function gReset() { gs.P = [0, 0, 0]; gs.hD = []; gs.hA = []; }
    function gTick() {   // one 10 ms tick of the gated map; returns H0 + P
      const M = solver.gated, D = live.D.slice(0, 4), Ac = gs.A.slice();
      gs.hD.push(D); gs.hA.push(Ac); if (gs.hD.length > 51) { gs.hD.shift(); gs.hA.shift(); }
      const n = gs.hD.length, at = (h, back) => h[Math.max(0, n - 1 - back)];
      const prev = at(gs.hD, 1), d25 = at(gs.hD, 25), d50 = at(gs.hD, 50), a25 = at(gs.hA, 25);
      const dD = D.map((v, p) => v - prev[p]);
      const c = [...D.map((v, p) => v - d25[p]), ...d25.map((v, p) => v - d50[p]), ...Ac.map((v, p) => (v - a25[p]) / 250)].map((v, i) => (v - M.mu[i]) / M.sd[i]);
      const hh = []; for (let h = 0; h < M.H; h++) { let q = M.b1[h]; for (let i = 0; i < 12; i++) q += M.W1[h * 12 + i] * c[i]; hh.push(Math.tanh(q)); }
      for (let a = 0; a < 3; a++) { let q = 0; for (let p = 0; p < 4; p++) { let g = M.b2[a * 4 + p]; for (let h = 0; h < M.H; h++) g += M.W2[(a * 4 + p) * M.H + h] * hh[h]; q += (M.W0[a][p] + M.Sg * g) * dD[p]; } gs.P[a] += solver.gK[a] * q; }
      return H0.map((h, i) => h + gs.P[i]);
    }
    function resetLive() {
      const S = 2 * solver.T;
      Object.assign(live, { D: new Array(S).fill(0), q: new Array(S).fill(0), act: new Array(S).fill(0), amp: new Array(S).fill(0), off: [], still: 0, lastAct: [] });
      gs.A = new Array(S).fill(0); gReset();
    }
    function originReset() { live.D = live.D.map(() => 0); offset = [0, 0, 0]; kfReset(); trail.length = 0; circleEnd = live.t; gReset(); }
    function feed(m) {
      const S = m.steps.length;
      if (live.D.length !== S) return;
      for (let i = 0; i < S; i++) { live.q[i] = 0.8 * live.q[i] + 0.2 * m.q[i]; live.act[i] = 0.8 * live.act[i] + 0.2 * m.act[i]; live.amp[i] = 0.8 * live.amp[i] + 0.2 * m.amp[i]; }
      live.identical = m.identical; live.mono = m.mono; live.off = m.off;
      const n = m.steps[0].length;
      for (let k = 0; k < n; k++) {
        let a = 0;
        for (let i = 0; i < S; i++) { const s = m.steps[i][k]; live.D[i] += s; a += Math.abs(s); if (s !== 0) gs.A[i]++; }
        live.t += 1; live.lastAct.push(a / S); if (live.lastAct.length > 800) live.lastAct.shift();
        if (++sub10 < 10) continue;
        sub10 = 0;
        const z = (solver.gated ? gTick() : solver.solve(live.D)).map((v, i) => v + offset[i]); kfStep(z, 0.01);
        const t = live.t, p = kf.p.slice(); trail.push({ t, p }); while (trail.length && trail[0].t < t - 3500) trail.shift();
        const n100 = Math.min(100, live.lastAct.length); let a100 = 0; for (let j = live.lastAct.length - n100; j < live.lastAct.length; j++) a100 += live.lastAct[j];
        const moving = a100 > o.actOn;
        if (!moving) live.still += 10; else live.still = 0;
        let rebased = false;
        if (live.still === 1000 && o.autoReset !== false) {
          if (o.stillMode === 'rebase') {   // keep the position: zero the path sums, carry the current solve as an offset
            offset = z.map((v, i) => v - H0[i]); live.D = live.D.map(() => 0); kf.v = [0, 0, 0]; gReset();
          } else { live.D = live.D.map(() => 0); offset = [0, 0, 0]; kfReset(); trail.length = 0; gReset(); }   // held still 1 s: origin again
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
        status((solver.cal ? 'Listening · hand above the laptop’s front edge, 18–25 cm above the desk, 25–45 cm from the webcam (the calibrated range)' : 'Listening · hand 10–25 cm above the middle-to-front of the keyboard') + (cfg.phone ? ` · phones ${cfg.freqs.slice(2).join('/')}Hz` : ''));
      } else {
        const buf = await ctx.decodeAudioData(arrayBuffer);
        src = ctx.createBufferSource(); src.buffer = buf; src.connect(node); src.start();
        src.onended = () => status('WAV playback finished');
        status(`Playing WAV: ${name} (${buf.numberOfChannels} channels, ${buf.duration.toFixed(0)}s)`);
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
      status('Stopped');
    }
    buildSolver(); resetLive();
    return {
      start, stop, originReset, feed,
      setCalib(c) { o.calib = c; if (c) o.model = 'learned'; buildSolver(); resetLive(); },
      setOptions(x) { Object.assign(o, x); if (x.calibName && CALIBS[x.calibName]) { o.calib = CALIBS[x.calibName].calib; if (!x.phones) o.phones = CALIBS[x.calibName].phones; } buildSolver(); resetLive(); },
      setVolume(v) { if (gainNode) gainNode.gain.value = v; },
      info: () => ({ freqs: cfg.freqs.slice(), pll: cfg.pll.slice(), T: solver.T, amp: solver.amp, model: solver.model, calibName: o.calibName || null, calibScope: o.calibName && CALIBS[o.calibName] ? CALIBS[o.calibName].scope : null, phone: solver.phone, phones: cfg.phones.map((p) => ({ id: p.id, hz: p.hz, P: p.P })), cal: solver.cal, learned: solver.learned, calName: solver.calName, err: solver.err, sv: solver.sv, gain: solver.gain, swapLR: cfg.swap, H0,
        G: { SL: solver.G.SL, SR: solver.G.SR, M: solver.G.M }, calib: calibInUse ? { paths: calibInUse.paths.map((p) => ({ key: p.key, hz: p.hz, ch: p.ch, pos: p.pos, gain: p.gain })), mics: calibInUse.mics, cam: calibInUse.cam, lagMs: calibInUse.lagMs, truthFloorCm: calibInUse.truthFloorCm } : null }),
      onFrame(fn) { o.onFrame = fn; }, onCircle(fn) { o.onCircle = fn; }, onStatus(fn) { o.onStatus = fn; },
      on(name, fn) { if (name === 'frame') o.onFrame = fn; else if (name === 'circle') o.onCircle = fn; else if (name === 'status') o.onStatus = fn; },
      get live() { return live; }, get kf() { return kf; }, get trail() { return trail; }, get lastCircle() { return lastCircle; },
    };
  }
  return { create, start: async (opts, startOpts) => { const e = create(opts); await e.start(startOpts); return e; }, PROC, GEOMS, H0, DEFAULT_CALIB, CALIBS, REF_AMP, VOLUME_TEACH, phonePos, VERSION };
});
