/* BatAuth: gesture-password matching for the 🔐 page (web/key.html), kept separate so the matcher can be swapped
 * (bravo, after the 2D spike) without touching the page.
 *
 * Stage 1, order = password: the attempt's gesture kinds must equal the enrolled sequence.
 * Stage 2, style = key: features of how this person does it, compared with the enrollment repetitions.
 *   rhythm   intervals between gesture CENTRES (s)       weight 0.45 (most device-independent)
 *            centre = |v|^2-weighted time of the motion (v2, bravo): the echo-threshold onset moves with the echo
 *            level (onset->peak lead drifts up to ~250 ms between sittings, drift.js); the energy centre does not
 *   speed    log peak hand speed per gesture             weight 0.20
 *   duration motion length per gesture (ms)              weight 0.15
 *   shape    velocity curve per gesture (24 points, / peak) weight 0.20
 * Each part is an RMS of z-scores against the enrollment mean/sd (sd floored so 5 reps can't make it brittle);
 * the score is their weighted ROOT-MEAN-SQUARE, so one aspect that is far off can't be averaged away by the others
 * (a plain weighted mean let 27/40 wrong-rhythm impostors in, tools/auth-tests). The threshold comes from the
 * enrollment spread: leave-one-out scores of the repetitions -> median + 3 x MAD (x1.4826, floored at 0.15),
 * clamped to [1.8, 4.5] - robust to one sloppy repetition (bravo, drift_test_thr.js: a sloppy rep had doubled
 * the impostor pass rate under mean + 2.5 sd).
 *
 * API (window.BatAuth in the browser, module.exports in Node):
 *   segment(frames, te, { lo, hi }) -> { t0, t1, dur, peak, tPeak, tc, trace, n } | null   (tc = energy centre, ms)
 *       frames = [{ t (ms), v (m/s, + toward the screen), a (echo excess dB) }], te = gesture event time;
 *       the active motion run around te (bridging gaps < 140 ms), kept inside [lo, hi]
 *   attemptFeatures(gestures) -> { kinds, onsets, intervals, total, g }   gestures = [{ kind, te, seg }]
 *   buildTemplate(reps) -> template (needs >= 3 reps with the same kinds)
 *   score(template, attempt) -> { orderOk, score, threshold, accepted, parts, reason }
 *       reason: 'ok' | 'order' | 'rhythm' | 'speed' | 'duration' | 'shape'
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BatAuth = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = 2;   // 2: rhythm from motion centres (templates from v1 should be re-enrolled)
  const TRACE_N = 24;
  const W = { rhythm: 0.45, speed: 0.2, duration: 0.15, shape: 0.2 };
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
  const rms = (xs) => (xs.length ? Math.sqrt(mean(xs.map((x) => x * x))) : null);
  const r2 = (x) => (Number.isFinite(x) ? +x.toFixed(2) : x);

  function resample(ys, n) {
    if (!ys.length) return new Array(n).fill(0);
    if (ys.length === 1) return new Array(n).fill(ys[0]);
    const out = [];
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * (ys.length - 1), k = Math.floor(x), f = x - k;
      out.push(k + 1 < ys.length ? ys[k] * (1 - f) + ys[k + 1] * f : ys[k]);
    }
    return out;
  }

  function segment(frames, te, { lo = -Infinity, hi = Infinity, aOn = 12, gapMs = 140, maxBackMs = 1500, maxFwdMs = 900 } = {}) {
    const act = (f) => f.a > aOn && f.t >= lo && f.t <= hi;
    let i = frames.length - 1;
    while (i >= 0 && frames[i].t > te) i--;
    if (i < 0) return null;
    let k = i;
    while (k >= 0 && !act(frames[k]) && te - frames[k].t < 300) k--;   // the burst may have ended just before te
    if (k < 0 || !act(frames[k])) return null;
    let s = k, last = frames[k].t;
    for (let j = k - 1; j >= 0; j--) {
      if (te - frames[j].t > maxBackMs || frames[j].t < lo) break;
      if (act(frames[j])) { s = j; last = frames[j].t; } else if (last - frames[j].t > gapMs) break;
    }
    let e = k;
    last = frames[k].t;
    for (let j = k + 1; j < frames.length; j++) {
      if (frames[j].t - te > maxFwdMs || frames[j].t > hi) break;
      if (act(frames[j])) { e = j; last = frames[j].t; } else if (frames[j].t - last > gapMs) break;
    }
    const seg = frames.slice(s, e + 1);
    if (seg.length < 3) return null;
    const t0 = seg[0].t, t1 = seg[seg.length - 1].t, dur = t1 - t0;
    let pk = 0, ipk = 0, sw = 0, swt = 0;
    seg.forEach((f, j) => { if (Math.abs(f.v) > Math.abs(pk)) { pk = f.v; ipk = j; } const q = f.v * f.v; sw += q; swt += q * f.t; });
    const peak = Math.abs(pk);
    return { t0, t1, dur, peak, tPeak: dur > 0 ? (seg[ipk].t - t0) / dur : 0, tc: sw > 0 ? swt / sw : (t0 + t1) / 2, trace: resample(seg.map((f) => f.v / (peak || 1)), TRACE_N), n: seg.length };
  }

  function attemptFeatures(gestures) {
    const kinds = gestures.map((g) => g.kind);
    const onsets = gestures.map((g) => (g.seg ? (Number.isFinite(g.seg.tc) ? g.seg.tc : g.seg.t0) : g.te));
    const intervals = onsets.slice(1).map((t, i) => (t - onsets[i]) / 1000);
    return {
      kinds, onsets, intervals, total: onsets.length > 1 ? (onsets[onsets.length - 1] - onsets[0]) / 1000 : 0,
      g: gestures.map((x) => (x.seg ? { peak: x.seg.peak, dur: x.seg.dur, tPeak: x.seg.tPeak, trace: x.seg.trace } : null)),
    };
  }

  const sameKinds = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

  // the statistics only (no threshold): used for the template and for its own leave-one-out
  function stats(reps) {
    const kinds = reps[0].kinds;
    const rhythm = kinds.slice(1).map((_, k) => {
      const xs = reps.map((r) => r.intervals[k]).filter(Number.isFinite);
      return { m: mean(xs), sd: sd(xs) };
    });
    const gest = kinds.map((_, j) => {
      const gs = reps.map((r) => r.g[j]).filter(Boolean);
      if (gs.length < 2) return null;
      const lp = gs.map((g) => Math.log(Math.max(0.05, g.peak))), du = gs.map((g) => g.dur);
      const tr = new Array(TRACE_N).fill(0).map((_, i) => mean(gs.map((g) => g.trace[i])));
      const spread = mean(gs.map((g) => rms(g.trace.map((y, i) => y - tr[i]))));
      return { logPeak: { m: mean(lp), sd: sd(lp) }, dur: { m: mean(du), sd: sd(du) }, trace: tr, spread };
    });
    return { kinds, rhythm, gest };
  }

  function parts(st, att) {
    const rz = st.rhythm.map((p, k) => (att.intervals[k] - p.m) / Math.max(p.sd, 0.06, 0.12 * Math.abs(p.m)));
    const sz = [], dz = [], hz = [];
    st.gest.forEach((p, j) => {
      const g = att.g[j];
      if (!p || !g) return;
      sz.push((Math.log(Math.max(0.05, g.peak)) - p.logPeak.m) / Math.max(p.logPeak.sd, 0.12));
      dz.push((g.dur - p.dur.m) / Math.max(p.dur.sd, 60, 0.15 * p.dur.m));
      hz.push(rms(g.trace.map((y, i) => y - p.trace[i])) / Math.max(p.spread, 0.15));
    });
    return { rhythm: rms(rz), speed: rms(sz), duration: rms(dz), shape: rms(hz) };
  }

  function combine(p) {
    let s = 0, w = 0;
    for (const k of Object.keys(W)) if (p[k] != null && Number.isFinite(p[k])) { s += W[k] * p[k] * p[k]; w += W[k]; }
    return w ? Math.sqrt(s / w) : Infinity;
  }

  function buildTemplate(reps) {
    if (!reps || reps.length < 3) throw new Error('need at least 3 repetitions');
    const kinds = reps[0].kinds;
    if (!reps.every((r) => sameKinds(r.kinds, kinds))) throw new Error('all repetitions must have the same gestures');
    const loo = reps.map((r, i) => combine(parts(stats(reps.filter((_, j) => j !== i)), r)));
    const fin = loo.filter(Number.isFinite);
    const med = (xs) => { const x = xs.slice().sort((p, q) => p - q), h = x.length >> 1; return x.length % 2 ? x[h] : (x[h - 1] + x[h]) / 2; };
    const mad = fin.length > 1 ? 1.4826 * med(fin.map((v) => Math.abs(v - med(fin)))) : 0.5;
    const threshold = Math.min(4.5, Math.max(1.8, med(fin) + 3 * Math.max(mad, 0.15)));
    return { v: VERSION, ...stats(reps), n: reps.length, threshold: r2(threshold), loo: loo.map(r2), reps, created: new Date().toISOString() };
  }

  function score(template, att) {
    if (!sameKinds(att.kinds, template.kinds)) {
      return { orderOk: false, score: null, threshold: template.threshold, accepted: false, parts: null, reason: 'order' };
    }
    const p = parts(template, att), sc = combine(p);
    const accepted = sc <= template.threshold;
    let reason = 'ok';
    if (!accepted) {
      let best = -1;
      for (const k of Object.keys(W)) if (p[k] != null && W[k] * p[k] * p[k] > best) { best = W[k] * p[k] * p[k]; reason = k; }
    }
    return { orderOk: true, score: r2(sc), threshold: template.threshold, accepted, reason,
      parts: { rhythm: r2(p.rhythm), speed: r2(p.speed), duration: r2(p.duration), shape: r2(p.shape) } };
  }

  return { segment, attemptFeatures, buildTemplate, score, resample, VERSION, WEIGHTS: W };
});
