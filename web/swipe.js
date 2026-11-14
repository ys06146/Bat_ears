/* BatSwipe: left/right swipe direction from the two-tone stereo mode (fL on the left speaker, fR on the right).
 *
 * Why a new rule: a sideways hand passes TOWARD then AWAY from the mic, which both tones see the same way
 * (dep = (vL+vR)/2). The sideways part lat = (vR-vL)/2 is only ~0.2 x hand speed even with speakers 24 cm
 * apart (physics.js), so "|lat| > 1.3 |dep|" never holds for a real swipe. Two cues that do carry direction:
 *   ilat     = integral of lat over the burst (m)          right swipe > 0  (path to R shrinks, path to L grows)
 *   balDelta = change of the L-R echo balance (dB) = balSlope x burst length   (hand near one speaker first)
 *              (v2: dB, not dB/s - a slope over a 150 ms burst explodes to +-80 dB/s and fooled the rule)
 * Both are ~0 for a centred push/pull. Their size depends on the laptop (speaker spacing, mono downmix,
 * Dolby-type effects), so a short per-laptop check (LRCheck) decides if left/right is usable at all, learns
 * the signs (no need for swapLR) and the scale, and reports honestly when this laptop can't do it.
 *
 * API (window.BatSwipe in the browser, module.exports in Node):
 *   learn(trials) -> model | null      trials = [{ kind: 'left'|'right'|'push'|'pull', frames | feat }], 4+ swipes each
 *                                      way; push/pull optional but recommended (measures false left/right); learn.last
 *   decide(frames, model) -> { kind: 'left'|'right'|null, conf }   frames = one burst [{ t, vL, vR, eL, eR }]
 * lower level:
 *   new SwipeBurst()            .push({ t, vL, vR, eL, eR })  per frame while a stereo burst is active
 *                                (eL/eR = excess over the floor in dB, e.g. max(dUp, dDown) of that tone)
 *                               .features() -> { ilat, balSlope, latPk, depPk, n, ms } | null
 *   new LRCheck({ need: 4 })    .add('left'|'right'|'push'|'pull', feat)
 *                               .result() -> { ok, looAcc, looWrong, looUndecided, fpRate, model, dprime, reason }
 *   classify(feat, model, { zMin: 0.6, minMs: 350 }) -> { dir: 'left'|'right'|null, z }  (null = not clearly sideways)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BatSwipe = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KEYS = ['ilat', 'balDelta'];
  const VERSION = 2;
  const lin = (db) => Math.pow(10, Math.max(-30, Math.min(60, db)) / 10);

  class SwipeBurst {
    constructor() { this.f = []; }
    push(fr) { if ([fr.t, fr.vL, fr.vR, fr.eL, fr.eR].every(Number.isFinite)) this.f.push(fr); }
    features() {
      const f = this.f;
      if (f.length < 3) return null;
      let ilat = 0, latPk = 0, depPk = 0, sw = 0, swt = 0, swb = 0;
      const pts = [];
      for (let i = 0; i < f.length; i++) {
        const dt = i ? Math.min(0.1, (f[i].t - f[i - 1].t) / 1000) : 0;
        const lat = (f[i].vR - f[i].vL) / 2, dep = (f[i].vR + f[i].vL) / 2;
        ilat += lat * dt;
        if (Math.abs(lat) > Math.abs(latPk)) latPk = lat;
        if (Math.abs(dep) > Math.abs(depPk)) depPk = dep;
        // balance only where at least one tone clearly moved; weight = dB above floor (gentler than power)
        const w = Math.max(0, Math.max(f[i].eL, f[i].eR) - 3);
        if (w > 0) {
          const bal = 10 * Math.log10((lin(f[i].eL) + 1) / (lin(f[i].eR) + 1));
          const t = (f[i].t - f[0].t) / 1000;
          pts.push({ t, bal, w }); sw += w; swt += w * t; swb += w * bal;
        }
      }
      let balSlope = 0;
      if (pts.length >= 3 && sw > 0) {
        const tm = swt / sw, bm = swb / sw;
        let num = 0, den = 0;
        for (const p of pts) { num += p.w * (p.t - tm) * (p.bal - bm); den += p.w * (p.t - tm) ** 2; }
        balSlope = den > 1e-9 ? num / den : 0;
      }
      const ms = f[f.length - 1].t - f[0].t;
      return { ilat, balDelta: balSlope * ms / 1000, balSlope, latPk, depPk, n: f.length, ms };
    }
  }

  // per-cue centroids and pooled spread from cued swipes; d' = (right - left) / sd
  function fit(L, R) {
    const m = { v: VERSION };
    for (const k of KEYS) {
      const a = L.map((x) => x[k]).filter(Number.isFinite), b = R.map((x) => x[k]).filter(Number.isFinite);
      if (!a.length || !b.length) continue;
      const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
      const va = a.reduce((s, x) => s + (x - ma) ** 2, 0), vb = b.reduce((s, x) => s + (x - mb) ** 2, 0);
      const sd = Math.max(1e-6, Math.sqrt((va + vb) / Math.max(1, a.length + b.length - 2)));
      m[k] = { mid: (ma + mb) / 2, half: (mb - ma) / 2, sd, d: (mb - ma) / sd };
    }
    return m;
  }
  // combined separation of the cues that count (d' >= 1), as if independent
  const dComb = (model) => Math.sqrt(KEYS.reduce((s, k) => s + (model[k] && Math.abs(model[k].d) >= 1 ? model[k].d ** 2 : 0), 0));

  // v2: d'-weighted sum of unit-spread scores (linear discriminant for independent cues), scaled so the average
  // right swipe sits at z = +1 and the average left at -1. Weak cues just weigh less; no per-cue veto (on real data
  // the two cues complement each other: swipes with ilat ~ 0 had a large balance change and vice versa).
  // Bursts shorter than minMs are never sideways: a ~50 cm swipe plus the 170 ms FFT window lasts >= ~400 ms
  // (all 10 real check swipes were 466-937 ms), while push/pull fragments are often 100-300 ms.
  function classify(feat, model, { zMin = 0.6, minMs = 350 } = {}) {
    if (!feat || !model || model.v !== VERSION) return { dir: null, z: 0 };
    let s = 0, d2 = 0;
    for (const k of KEYS) {
      const p = model[k];
      if (!p || Math.abs(p.d) < 1 || !Number.isFinite(feat[k])) continue; // d' < 1 = noise on this laptop
      s += Math.abs(p.d) * Math.sign(p.half) * (feat[k] - p.mid) / p.sd;
      d2 += p.d ** 2;
    }
    if (!d2) return { dir: null, z: 0 };
    const z = s / (d2 / 2);
    const dir = !(feat.ms >= minMs) ? null : z >= zMin ? 'right' : z <= -zMin ? 'left' : null;
    return { dir, z: +z.toFixed(2) };
  }

  // The check: cued swipes (and ideally a few cued push/pull). Scored with the SAME rule as live use:
  // leave-one-out for swipes (hit / wrong / undecided), push/pull judged by the full model (false left/right rate).
  class LRCheck {
    constructor({ need = 4, minHit = 0.6, maxWrong = 0.1, maxFp = 0.15, minD = 1.5, rule } = {}) {
      Object.assign(this, { need, minHit, maxWrong, maxFp, minD, rule: rule || {} });
      this.L = []; this.R = []; this.N = [];
    }
    add(kind, feat) {
      if (!feat) return;
      if (kind === 'left') this.L.push(feat); else if (kind === 'right') this.R.push(feat); else this.N.push(feat);
    }
    get done() { return this.L.length >= this.need && this.R.length >= this.need; }
    result() {
      const { L, R, N } = this;
      if (L.length < 2 || R.length < 2) return { ok: false, looAcc: 0, model: null, reason: 'not enough swipes' };
      let hit = 0, wrong = 0, n = 0;
      const all = L.map((f) => ['left', f]).concat(R.map((f) => ['right', f]));
      all.forEach(([kind, f], i) => {
        const L2 = all.filter((x, j) => j !== i && x[0] === 'left').map((x) => x[1]);
        const R2 = all.filter((x, j) => j !== i && x[0] === 'right').map((x) => x[1]);
        if (!L2.length || !R2.length) return;
        n++;
        const d = classify(f, fit(L2, R2), this.rule).dir;
        if (d === kind) hit++; else if (d) wrong++;
      });
      const model = fit(L, R), dc = dComb(model);
      const fp = N.length ? N.filter((f) => classify(f, model, this.rule).dir).length / N.length : null;
      const looAcc = n ? hit / n : 0, looWrong = n ? wrong / n : 0;
      const ok = dc >= this.minD && looAcc >= this.minHit && looWrong <= this.maxWrong && (fp == null || fp <= this.maxFp);
      const r2 = (x) => (x == null ? null : +x.toFixed(2));
      return {
        ok, model, looAcc: r2(looAcc), looWrong: r2(looWrong), looUndecided: r2(n ? (n - hit - wrong) / n : 0),
        fpRate: r2(fp), nPushPull: N.length, dComb: r2(dc),
        dprime: Object.fromEntries(KEYS.map((k) => [k, model[k] ? r2(model[k].d) : null])),
        reason: ok ? (N.length ? 'left/right usable' : 'left/right usable (push/pull not checked: false left/right unknown)')
          : dc < 1 ? 'no left/right signal (speakers too close, mono downmix or audio effects?)'
          : fp != null && fp > this.maxFp ? 'push/pull would be read as left/right too often: swipe closer (10-15 cm) and wider'
          : looWrong > this.maxWrong ? 'left/right often reversed: swipe closer (10-15 cm) and wider'
          : 'weak left/right signal: swipe closer (10-15 cm) and wider',
      };
    }
  }

  // per-tone echo level for SwipeBurst.push (power sum of both sidebands over the floor, dB)
  const excessDb = (dUp, dDown) => 10 * Math.log10(lin(dUp) + lin(dDown));

  // ---- alpha's shape. frames = one burst: [{ t (ms), vL, vR (m/s), eL, eR (dB, max(dUp, dDown) of that tone) }]
  const featuresOf = (frames) => { const b = new SwipeBurst(); (frames || []).forEach((f) => b.push(f)); return b.features(); };
  // trials = [{ kind: 'left' | 'right' | 'push' | 'pull', frames (or feat) }] (4+ swipes each way). Returns a model, or null when this laptop shows no
  // usable left/right signal. learn.last keeps the check details for the UI: { ok, looAcc, dprime, reason }.
  function learn(trials, opt) {
    const chk = new LRCheck({ need: 1, ...opt });
    for (const tr of trials || []) chk.add(tr.kind, tr.feat || featuresOf(tr.frames));
    const r = chk.result();
    const { model, ...info } = r;
    learn.last = { ...info, nL: chk.L.length, nR: chk.R.length, nPushPull: chk.N.length };
    return r.ok ? r.model : null;
  }
  // -> { kind: 'left' | 'right' | null, conf }  conf = |z| (1 = as sideways as the average check swipe)
  function decide(frames, model, opt) {
    const c = classify(featuresOf(frames), model, opt);
    return { kind: c.dir, conf: +Math.abs(c.z).toFixed(2) };
  }

  return { decide, learn, featuresOf, SwipeBurst, LRCheck, classify, fit, excessDb, KEYS, VERSION };
});
