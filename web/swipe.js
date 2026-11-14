/* BatSwipe: left/right swipe direction from the two-tone stereo mode (fL on the left speaker, fR on the right).
 *
 * Why a new rule: a sideways hand passes TOWARD then AWAY from the mic, which both tones see the same way
 * (dep = (vL+vR)/2). The sideways part lat = (vR-vL)/2 is only ~0.2 x hand speed even with speakers 24 cm
 * apart (physics.js), so "|lat| > 1.3 |dep|" never holds for a real swipe. Two cues that do carry direction:
 *   ilat     = integral of lat over the burst (m)   right swipe > 0  (path to R shrinks, path to L grows)
 *   balSlope = slope of the L-R echo balance (dB/s)  right swipe < 0  (hand near L speaker first, then near R)
 * Both are ~0 for a centred push/pull. Their size depends on the laptop (speaker spacing, mono downmix,
 * Dolby-type effects), so a short per-laptop check (LRCheck) decides if left/right is usable at all, learns
 * the signs (no need for swapLR) and the scale, and reports honestly when this laptop can't do it.
 *
 * API (window.BatSwipe in the browser, module.exports in Node):
 *   learn(trials) -> model | null      trials = [{ kind: 'left'|'right', frames }], 4+ each; learn.last = check details
 *   decide(frames, model) -> { kind: 'left'|'right'|null, conf }   frames = one burst [{ t, vL, vR, eL, eR }]
 * lower level:
 *   new SwipeBurst()            .push({ t, vL, vR, eL, eR })  per frame while a stereo burst is active
 *                                (eL/eR = excess over the floor in dB, e.g. max(dUp, dDown) of that tone)
 *                               .features() -> { ilat, balSlope, latPk, depPk, n, ms } | null
 *   new LRCheck({ need: 4 })    .add('left'|'right', feat)    cued swipes, `need` of each
 *                               .result() -> { ok, looAcc, model, reason }
 *   classify(feat, model, { zMin: 0.6, each: 0.3 }) -> { dir: 'left'|'right'|null, z }  (null = not clearly sideways)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BatSwipe = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KEYS = ['ilat', 'balSlope'];
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
      return { ilat, balSlope, latPk, depPk, n: f.length, ms: f[f.length - 1].t - f[0].t };
    }
  }

  // nearest-centroid on z-scored features; `use` = features whose sign is consistent
  function fit(L, R) {
    const m = {};
    for (const k of KEYS) {
      const a = L.map((x) => x[k]), b = R.map((x) => x[k]);
      const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
      const va = a.reduce((s, x) => s + (x - ma) ** 2, 0), vb = b.reduce((s, x) => s + (x - mb) ** 2, 0);
      const sd = Math.max(1e-6, Math.sqrt((va + vb) / Math.max(1, a.length + b.length - 2)));
      m[k] = { mid: (ma + mb) / 2, half: (mb - ma) / 2, sd, d: (mb - ma) / sd }; // d' (right minus left)
    }
    return m;
  }
  // z is in units of the left-right half distance: +1 = typical right swipe, -1 = typical left, 0 = centred push/pull.
  // Every usable cue must point the same way (a push that drifts sideways rarely fools both).
  function classify(feat, model, { zMin = 0.6, each = 0.3 } = {}) {
    if (!feat || !model) return { dir: null, z: 0 };
    let z = 0, wsum = 0, lo = Infinity, hi = -Infinity;
    for (const k of KEYS) {
      const p = model[k];
      if (!p || Math.abs(p.d) < 1) continue;            // a cue with d' < 1 is noise on this laptop
      const w = Math.abs(p.d), zk = (feat[k] - p.mid) / p.half; // half carries the sign (right minus left)
      z += w * zk; wsum += w; lo = Math.min(lo, zk); hi = Math.max(hi, zk);
    }
    if (!wsum) return { dir: null, z: 0 };
    z /= wsum;
    const dir = z >= zMin && lo >= each ? 'right' : z <= -zMin && hi <= -each ? 'left' : null;
    return { dir, z: +z.toFixed(2) };
  }

  class LRCheck {
    constructor({ need = 4, minLoo = 0.8 } = {}) { this.need = need; this.minLoo = minLoo; this.L = []; this.R = []; }
    add(kind, feat) { if (feat) (kind === 'left' ? this.L : this.R).push(feat); }
    get done() { return this.L.length >= this.need && this.R.length >= this.need; }
    result() {
      const { L, R } = this;
      if (L.length < 2 || R.length < 2) return { ok: false, looAcc: 0, model: null, reason: 'not enough swipes' };
      // leave-one-out: each swipe judged by a model that never saw it (honest small-sample accuracy)
      let hit = 0, n = 0;
      const all = L.map((f) => ['left', f]).concat(R.map((f) => ['right', f]));
      all.forEach(([kind, f], i) => {
        const L2 = all.filter((x, j) => j !== i && x[0] === 'left').map((x) => x[1]);
        const R2 = all.filter((x, j) => j !== i && x[0] === 'right').map((x) => x[1]);
        if (L2.length < 1 || R2.length < 1) return;
        n++;
        if (classify(f, fit(L2, R2), { zMin: 0, each: -Infinity }).dir === kind) hit++;
      });
      const model = fit(L, R), looAcc = n ? hit / n : 0;
      const best = Math.max(...KEYS.map((k) => Math.abs(model[k].d)));
      const ok = looAcc >= this.minLoo && best >= 1.5;
      return {
        ok, looAcc: +looAcc.toFixed(2), model,
        dprime: Object.fromEntries(KEYS.map((k) => [k, +model[k].d.toFixed(2)])),
        reason: ok ? 'left/right usable' : best < 1 ? 'no left/right signal (speakers too close, mono downmix or audio effects?)' : 'weak left/right signal: swipe closer (10-15 cm) and wider',
      };
    }
  }

  // per-tone echo level for SwipeBurst.push (power sum of both sidebands over the floor, dB)
  const excessDb = (dUp, dDown) => 10 * Math.log10(lin(dUp) + lin(dDown));

  // ---- alpha's shape. frames = one burst: [{ t (ms), vL, vR (m/s), eL, eR (dB, max(dUp, dDown) of that tone) }]
  const featuresOf = (frames) => { const b = new SwipeBurst(); (frames || []).forEach((f) => b.push(f)); return b.features(); };
  // trials = [{ kind: 'left' | 'right', frames }] (4+ of each). Returns a model, or null when this laptop shows no
  // usable left/right signal. learn.last keeps the check details for the UI: { ok, looAcc, dprime, reason }.
  function learn(trials, opt) {
    const chk = new LRCheck({ need: 1, ...opt });
    for (const tr of trials || []) chk.add(tr.kind, featuresOf(tr.frames));
    const r = chk.result();
    learn.last = { ok: r.ok, looAcc: r.looAcc, dprime: r.dprime, reason: r.reason, nL: chk.L.length, nR: chk.R.length };
    return r.ok ? r.model : null;
  }
  // -> { kind: 'left' | 'right' | null, conf }  conf = |z| (1 = as sideways as the average check swipe)
  function decide(frames, model, opt) {
    const c = classify(featuresOf(frames), model, opt);
    return { kind: c.dir, conf: +Math.abs(c.z).toFixed(2) };
  }

  return { decide, learn, featuresOf, SwipeBurst, LRCheck, classify, fit, excessDb, KEYS };
});
