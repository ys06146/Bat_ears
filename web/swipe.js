/* BatSwipe v3: left/right swipe direction from the two-tone stereo mode (fL on the left speaker, fR on the right).
 *
 * Physics: a sideways hand passes TOWARD then AWAY from the mic, which both tones see the same way
 * (dep = (vL+vR)/2). The sideways part lat = (vR-vL)/2 is small (~0.2 x hand speed with speakers 24 cm apart,
 * physics.js), so the direction is read from its integral over the burst.
 *
 * v3 (real sessions 171130 / 205859, Galaxy Book, 18/19.5 kHz):
 *   - Each tone's speed has a REST OFFSET: the spectral centroid of the noise floor around the carrier is not 0
 *     (205859: vL -0.69, vR +0.27 m/s at rest; 171130: +0.20 / -0.08, sign flipped). In weak-echo frames the
 *     reported v slides toward that offset, so every motion got a +lat bias: push/pull looked like right swipes
 *     (45% read as left/right) and a model from one session failed on the next. Fix: remove the offset with the
 *     energy ratio (v_meas = (v_mot*M + v0*B)/(M+B), E = (M+B)/B) and use only frames where BOTH tones clearly echo.
 *   - Push/pull are learned as their own class (the check's cued push/pulls), so "not sideways" is a learned
 *     region, not just "z too small". 3-class linear discriminant on [ilatC, idep, bip]:
 *       ilatC = integral of offset-corrected lat over echo-dominant frames (m)   right > 0 after the check learns signs
 *       idep  = integral of dep (m): net depth change, large for push (+) / pull (-), ~0 for a swipe
 *       bip   = min(depth toward, depth away) / max(...): a swipe goes toward AND away (~1), a push one way (~0)
 *     205859, train on the first half of the trials -> test on the second (and back), through this file's API:
 *     swipes 14/0/6 (70%) right / reversed / undecided, push/pull read as left/right 0/20 (v2: 11/1/8, 9/20).
 *     Whole-session check (LOO): 0.75 / 0 / 0.25, false left/right 0.10 -> usable (v2: false 0.45 -> refused).
 *     A model does NOT carry over to another sitting (205859 -> 171130: 2/2/6): redo the check each time.
 *   - balDelta (L-R echo balance change) is no longer used: its sign flipped between the two sessions.
 *
 * API (window.BatSwipe in the browser, module.exports in Node):
 *   learn(trials) -> model | null      trials = [{ kind: 'left'|'right'|'push'|'pull', frames | feat }]: 4+ swipes each
 *                                      way and 2+ push/pull (v3 needs them); learn.last = check details for the UI
 *   decide(frames, model) -> { kind: 'left'|'right'|null, conf }   frames = one burst [{ t, vL, vR, eL, eR, v0L?, v0R? }]
 *     eL/eR = echo excess over the floor (dB) of each tone = excessDb(dUp, dDown); v0L/v0R = that tone's rest speed
 *     (median v over the last ~3 s of quiet frames, see RestSpeed). Without v0 the correction assumes 0 (a bit worse).
 * lower level: SwipeBurst, LRCheck, classify(feat, model), RestSpeed, excessDb, KEYS, VERSION
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BatSwipe = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KEYS = ['ilatC', 'idep', 'bip'];
  const VERSION = 3;
  const lin = (db) => Math.pow(10, Math.max(-30, Math.min(60, db)) / 10);
  const E_MIN = 2;   // use a frame for lat only if both tones' echo is > (E_MIN + 1) x the floor (eL, eR > ~7.8 dB)

  // rest speed of one tone: median v over the last windowMs of quiet frames. Feed every frame of that tone:
  // push(t, v, max(dUp, dDown)); quiet = echo < quietDb over the floor.
  class RestSpeed {
    constructor({ windowMs = 3000, quietDb = 3, minN = 10 } = {}) { Object.assign(this, { windowMs, quietDb, minN }); this.q = []; }
    push(t, v, eDb) {
      if (Number.isFinite(v) && Number.isFinite(eDb) && eDb < this.quietDb) this.q.push([t, v]);
      while (this.q.length && this.q[0][0] < t - this.windowMs) this.q.shift();
    }
    get value() {
      if (this.q.length < this.minN) return 0;
      const s = this.q.map((x) => x[1]).sort((a, b) => a - b);
      return s[s.length >> 1];
    }
  }

  class SwipeBurst {
    constructor() { this.f = []; }
    push(fr) { if ([fr.t, fr.vL, fr.vR, fr.eL, fr.eR].every(Number.isFinite)) this.f.push(fr); }
    features() {
      const f = this.f;
      if (f.length < 3) return null;
      let ilat = 0, ilatC = 0, idep = 0, dPos = 0, dNeg = 0, latPk = 0, depPk = 0, nC = 0;
      for (let i = 0; i < f.length; i++) {
        const x = f[i], dt = i ? Math.min(0.1, (x.t - f[i - 1].t) / 1000) : 0;
        const lat = (x.vR - x.vL) / 2, dep = (x.vR + x.vL) / 2;
        ilat += lat * dt; idep += dep * dt;
        if (dep > 0) dPos += dep * dt; else dNeg -= dep * dt;
        if (Math.abs(lat) > Math.abs(latPk)) latPk = lat;
        if (Math.abs(dep) > Math.abs(depPk)) depPk = dep;
        // offset-corrected lat, echo-dominant frames only. lin(e) = lin(dUp) + lin(dDown) = 2E
        const EL = lin(x.eL) / 2, ER = lin(x.eR) / 2;
        if (EL - 1 > E_MIN && ER - 1 > E_MIN) {
          const v0L = Number.isFinite(x.v0L) ? x.v0L : 0, v0R = Number.isFinite(x.v0R) ? x.v0R : 0;
          const mL = (x.vL * EL - v0L) / (EL - 1), mR = (x.vR * ER - v0R) / (ER - 1);
          ilatC += ((mR - mL) / 2) * dt; nC++;
        }
      }
      const ms = f[f.length - 1].t - f[0].t;
      const bip = Math.min(dPos, dNeg) / Math.max(1e-6, Math.max(dPos, dNeg));
      return { ilatC, idep, bip, ilat, latPk, depPk, nC, n: f.length, ms };
    }
  }

  // ---- 3-class (left / right / pp) linear discriminant, pooled covariance shrunk toward its diagonal
  const CLS = ['left', 'right', 'pp'];
  const clsOf = (kind) => (kind === 'left' || kind === 'right' ? kind : 'pp');
  function inv(A) {
    const n = A.length, M = A.map((r, i) => [...r, ...A.map((_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c] || 1e-12; for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
      for (let r = 0; r < n; r++) if (r !== c) { const k = M[r][c]; for (let j = 0; j < 2 * n; j++) M[r][j] -= k * M[c][j]; }
    }
    return M.map((r) => r.slice(n));
  }
  const vec = (feat) => KEYS.map((k) => feat[k]);
  function fit(items, { lam = 0.3 } = {}) {   // items = [{ kind, feat }]
    const by = { left: [], right: [], pp: [] };
    for (const it of items) if (it.feat && vec(it.feat).every(Number.isFinite)) by[clsOf(it.kind)].push(vec(it.feat));
    if (CLS.some((c) => by[c].length < 2)) return null;
    const n = KEYS.length, mu = {};
    for (const c of CLS) mu[c] = KEYS.map((_, j) => by[c].reduce((s, x) => s + x[j], 0) / by[c].length);
    const S = KEYS.map(() => KEYS.map(() => 0)); let dof = -CLS.length;
    for (const c of CLS) for (const x of by[c]) { dof++; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) S[i][j] += (x[i] - mu[c][i]) * (x[j] - mu[c][j]); }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) S[i][j] = (S[i][j] / Math.max(1, dof)) * (i === j ? 1 : 1 - lam) + (i === j ? 1e-12 : 0);
    return { v: VERSION, keys: KEYS.slice(), mu, P: inv(S) };
  }
  const maha = (m, a, b) => { const d = a.map((x, i) => x - b[i]); let q = 0; for (let i = 0; i < d.length; i++) for (let j = 0; j < d.length; j++) q += d[i] * m.P[i][j] * d[j]; return q; };
  // separation of the left and right centroids in pooled-sd units (like d')
  const dLR = (m) => (m ? Math.sqrt(maha(m, m.mu.left, m.mu.right)) : 0);

  // L/R only if that class beats both others by `margin` (log-likelihood units) and the burst is long enough
  // (a ~50 cm swipe + the 170 ms FFT window lasts >= ~400 ms; push/pull fragments are often 100-300 ms)
  function classify(feat, model, { margin = 0.5, minMs = 350 } = {}) {
    if (!feat || !model || model.v !== VERSION) return { dir: null, z: 0 };
    const x = vec(feat);
    if (!x.every(Number.isFinite)) return { dir: null, z: 0 };
    const s = {}; for (const c of CLS) s[c] = -0.5 * maha(model, x, model.mu[c]);
    const best = CLS.slice().sort((a, b) => s[b] - s[a])[0];
    const lead = s[best] - Math.max(...CLS.filter((c) => c !== best).map((c) => s[c]));
    const z = best === 'pp' ? 0 : (best === 'right' ? 1 : -1) * lead;      // >0 right, <0 left, 0 = push/pull-like
    const dir = best !== 'pp' && lead >= margin && feat.ms >= minMs ? best : null;
    return { dir, z: +z.toFixed(2), cls: best };
  }

  // The check: cued swipes AND cued push/pulls. Everything scored leave-one-out with the live rule.
  class LRCheck {
    constructor({ need = 4, needPP = 2, minHit = 0.6, maxWrong = 0.1, maxFp = 0.15, minD = 1.5, rule, lam = 0.3 } = {}) {
      Object.assign(this, { need, needPP, minHit, maxWrong, maxFp, minD, rule: rule || {}, lam });
      this.items = [];
    }
    add(kind, feat) { if (feat) this.items.push({ kind, feat }); }
    get L() { return this.items.filter((x) => x.kind === 'left'); }
    get R() { return this.items.filter((x) => x.kind === 'right'); }
    get N() { return this.items.filter((x) => clsOf(x.kind) === 'pp'); }
    get done() { return this.L.length >= this.need && this.R.length >= this.need && this.N.length >= this.needPP; }
    result() {
      const it = this.items, nL = this.L.length, nR = this.R.length, nN = this.N.length;
      if (nL < 2 || nR < 2) return { ok: false, looAcc: 0, model: null, reason: 'not enough swipes' };
      if (nN < 2) return { ok: false, looAcc: 0, model: null, reason: 'not enough push/pull in the check (v3 learns them as a class)' };
      let hit = 0, wrong = 0, n = 0, fp = 0, nP = 0;
      it.forEach((x, i) => {
        const m = fit(it.filter((_, j) => j !== i), { lam: this.lam });
        if (!m) return;
        const d = classify(x.feat, m, this.rule).dir;
        if (clsOf(x.kind) === 'pp') { nP++; if (d) fp++; }
        else { n++; if (d === x.kind) hit++; else if (d) wrong++; }
      });
      const model = fit(it, { lam: this.lam }), dc = dLR(model);
      const looAcc = n ? hit / n : 0, looWrong = n ? wrong / n : 0, fpRate = nP ? fp / nP : null;
      const ok = !!model && dc >= this.minD && looAcc >= this.minHit && looWrong <= this.maxWrong && fpRate != null && fpRate <= this.maxFp;
      const r2 = (v) => (v == null ? null : +v.toFixed(2));
      return {
        ok, model, looAcc: r2(looAcc), looWrong: r2(looWrong), looUndecided: r2(n ? (n - hit - wrong) / n : 0),
        fpRate: r2(fpRate), nPushPull: nN, dComb: r2(dc), dprime: { lr: r2(dc) },
        reason: ok ? 'left/right usable'
          : dc < 1 ? 'no left/right signal (speakers too close, mono downmix or audio effects?)'
          : fpRate > this.maxFp ? 'push/pull would be read as left/right too often: swipe closer (10-15 cm) and wider'
          : looWrong > this.maxWrong ? 'left/right often reversed: swipe closer (10-15 cm) and wider'
          : 'weak left/right signal: swipe closer (10-15 cm) and wider',
      };
    }
  }

  // per-tone echo level for SwipeBurst.push (power sum of both sidebands over the floor, dB)
  const excessDb = (dUp, dDown) => 10 * Math.log10(lin(dUp) + lin(dDown));

  const featuresOf = (frames) => { const b = new SwipeBurst(); (frames || []).forEach((f) => b.push(f)); return b.features(); };
  function learn(trials, opt) {
    const chk = new LRCheck({ need: 1, ...opt });
    for (const tr of trials || []) chk.add(tr.kind, tr.feat || featuresOf(tr.frames));
    const r = chk.result();
    const { model, ...info } = r;
    learn.last = { ...info, nL: chk.L.length, nR: chk.R.length, nPushPull: chk.N.length };
    return r.ok ? r.model : null;
  }
  // -> { kind: 'left' | 'right' | null, conf }  conf = lead over the next class (log-likelihood units)
  function decide(frames, model, opt) {
    const c = classify(featuresOf(frames), model, opt);
    return { kind: c.dir, conf: +Math.abs(c.z).toFixed(2) };
  }

  return { decide, learn, featuresOf, SwipeBurst, LRCheck, RestSpeed, classify, fit, excessDb, KEYS, VERSION };
});
