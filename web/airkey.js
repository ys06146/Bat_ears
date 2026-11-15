/* AirKey: a gesture password drawn in the air, tracked by the hologram's Bat3D engine (bat3d.js, same tones, calibration
 * and One-Euro smoothing as hologram.html). Set once, confirm once, then unlock.
 *
 * A stroke is the hand path between "still" and "still again": [{ t (ms), p [x, y, z] (m) }].
 *   features(stroke) -> { dur (s), size (m, RMS radius), len (m), shape [N][3] (arc-length resampled, centred, unit RMS radius),
 *                          speed [M] (time resampled |v|, mean 1) } | { error: 'short' | 'small' }
 *   compare(a, b)    -> { score, parts: { shape, size, duration, rhythm } }   each part 1.0 = at its tolerance
 *   makeKey(a, b)    -> key { v, samples: [a, b], self (score between the two), threshold, created }
 *   check(key, f)    -> { score, threshold, accepted, parts, reason: 'ok' | 'shape' | 'size' | 'duration' | 'rhythm' }
 * Tolerances are first guesses (no recorded air-gesture data yet): retune them from the exported attempts.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AirKey = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = 3;   // 2: height x1.33 like the hologram, drift removed; 3: height trusted least (older keys must be set again)
  const N = 48, M = 32;
  // shape: RMS point distance between unit-size paths; size / duration: |ln ratio|; rhythm: RMS gap between speed profiles
  const TOL = { shape: 0.45, size: Math.log(1.7), duration: Math.log(1.7), rhythm: 0.55 };
  const W = { shape: 3, size: 1, duration: 1, rhythm: 1 };
  // per-axis trust (x right, y up, z depth) from the built-in calibration's unseen-sitting correlation 0.73 / 0.57 / 0.70:
  // the two laptop speakers sit side by side, so up-down changes both paths alike and height is the weak axis (README).
  // Scaled to RMS 1 so TOL keeps its meaning
  const AXIS_RAW = [1, 0.6, 1], AXIS_RMS = Math.sqrt(AXIS_RAW.reduce((s, v) => s + v * v, 0) / 3), AXIS = AXIS_RAW.map((v) => v / AXIS_RMS);
  const wdist = (a, b) => Math.hypot(...a.map((v, d) => (v - b[d]) * AXIS[d]));
  const MIN_LEN = 0.04, MIN_DUR = 0.15;   // a path under 4 cm or 150 ms is noise on this engine (3-4 cm rms error)
  const THRESHOLD = 1.0, CONFIRM_MAX = 1.3;

  const sub = (a, b) => a.map((v, i) => v - b[i]), nrm = (a) => Math.hypot(...a);

  function resampleBy(xs, ys, n) {   // ys[i] (arrays) at increasing xs[i] -> n evenly spaced samples over [xs0, xsEnd]
    const out = [], x0 = xs[0], x1 = xs[xs.length - 1];
    let j = 0;
    for (let k = 0; k < n; k++) {
      const x = x0 + (x1 - x0) * k / (n - 1);
      while (j < xs.length - 2 && xs[j + 1] < x) j++;
      const span = xs[j + 1] - xs[j], u = span > 0 ? Math.min(1, Math.max(0, (x - xs[j]) / span)) : 0;
      out.push(ys[j].map((v, d) => v + u * (ys[j + 1][d] - v)));
    }
    return out;
  }

  function features(stroke) {
    if (!stroke || stroke.length < 4) return { error: 'short' };
    const t = stroke.map((s) => s.t / 1000), p = stroke.map((s) => s.p);
    const dur = t[t.length - 1] - t[0];
    if (!(dur >= MIN_DUR)) return { error: 'short' };
    const arc = [0];
    for (let i = 1; i < p.length; i++) arc.push(arc[i - 1] + nrm(sub(p[i], p[i - 1])));
    const len = arc[arc.length - 1];
    if (len < MIN_LEN) return { error: 'small', len };
    // arc-length positions must strictly increase for the resample: nudge flat stretches
    for (let i = 1; i < arc.length; i++) if (arc[i] <= arc[i - 1]) arc[i] = arc[i - 1] + 1e-9;
    const path = resampleBy(arc, p, N);
    const c = [0, 1, 2].map((d) => path.reduce((s, q) => s + q[d], 0) / N);
    const size = Math.sqrt(path.reduce((s, q) => s + nrm(sub(q, c)) ** 2, 0) / N) || 1e-6;
    const shape = path.map((q) => sub(q, c).map((v) => v / size));
    const sp = [];
    for (let i = 1; i < p.length; i++) sp.push([nrm(sub(p[i], p[i - 1])) / Math.max(1e-3, t[i] - t[i - 1])]);
    const prof = resampleBy(t.slice(1), sp, M).map((v) => v[0]), mean = prof.reduce((s, v) => s + v, 0) / M || 1;
    return { dur, size, len, shape, speed: prof.map((v) => v / mean) };
  }

  function compare(a, b) {
    const shape = Math.sqrt(a.shape.reduce((s, q, i) => s + wdist(q, b.shape[i]) ** 2, 0) / N);
    const rhythm = Math.sqrt(a.speed.reduce((s, v, i) => s + (v - b.speed[i]) ** 2, 0) / M);
    const parts = { shape: shape / TOL.shape, size: Math.abs(Math.log(a.size / b.size)) / TOL.size,
      duration: Math.abs(Math.log(a.dur / b.dur)) / TOL.duration, rhythm: rhythm / TOL.rhythm };
    const wsum = Object.values(W).reduce((s, v) => s + v, 0);
    const score = Math.sqrt(Object.keys(W).reduce((s, k) => s + W[k] * parts[k] ** 2, 0) / wsum);
    return { score, parts };
  }

  function makeKey(a, b) {
    const self = compare(a, b);
    return { v: VERSION, samples: [a, b], self: self.score, selfParts: self.parts, threshold: THRESHOLD, ok: self.score <= CONFIRM_MAX, created: new Date().toISOString() };
  }

  function check(key, f) {
    // the closer of the two enrolled samples decides; parts are reported for that sample
    const best = key.samples.map((s) => compare(s, f)).sort((x, y) => x.score - y.score)[0];
    const accepted = best.score <= key.threshold;
    let reason = 'ok';
    if (!accepted) reason = Object.keys(W).reduce((m, k) => (W[k] * best.parts[k] ** 2 > W[m] * best.parts[m] ** 2 ? k : m), 'shape');
    return { score: best.score, threshold: key.threshold, accepted, parts: best.parts, reason };
  }

  return { features, compare, makeKey, check, VERSION, TOL, W, AXIS: AXIS_RAW, THRESHOLD, CONFIRM_MAX, MIN_LEN };
});
