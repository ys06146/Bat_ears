/* BatCircle: circle tokens (clockwise / counter-clockwise) from the I/Q phase track (iq.js trackBetween).
 * The (u, w) path = (sideways (dR - dL)/2, path shortening -(dL + dR)/2). A drawn circle winds the direction of motion
 * around ~1.5 turns; a swipe is an arc (~0.5 turn), push / pull / wave go back and forth (net ~0 turns). So:
 *   turns = net rotation of the velocity direction while the hand moves (speed > vMin), over the last <= maxMs.
 *   fire when |turns| >= needTurns and the path spans >= minSpanCm in both u and w.
 *   direction: turns > 0 (= signed area > 0) -> clockwise for a flat circle over the keyboard seen from above
 *   (sim2d.js; it flips if the hand is behind the mic / speakers, so `cwSign` can be calibrated per session).
 *
 *   const cd = new BatCircle.CircleDetector({ cwSign: 1 });
 *   every ~100 ms:  const ev = cd.update(iq.trackBetween(now - 3000, now, 10), now);   // ev: { kind: 'circle', dir, turns, t, t0 }
 *   cd.busy(now) -> true while a circle is being drawn or just fired (suppress push / pull / wave meanwhile)
 *   BatCircle.analyze(t, u, w, opt) -> { turns, area, iso, ru, rw, t0, t1 }   offline / one segment
 */
(function (root) {
  'use strict';
  const DEFAULTS = { vMin: 0.06, smoothMs: 40, needTurns: 1.1, maxMs: 2600, minSpanCm: 3, refireMs: 1500, cwSign: 1, busyTurns: 0.6 };

  // resample to a uniform 10 ms grid with a moving-average smooth; returns arrays of { t, u, w }
  function grid(t, u, w, smoothMs) {
    const out = { t: [], u: [], w: [] };
    if (t.length < 3) return out;
    const dt = 10, half = smoothMs / 2;
    let j0 = 0, j1 = 0, su = 0, sw = 0;
    for (let tt = t[0] + half; tt <= t[t.length - 1] - half; tt += dt) {
      while (j1 < t.length && t[j1] <= tt + half) { su += u[j1]; sw += w[j1]; j1++; }
      while (j0 < j1 && t[j0] < tt - half) { su -= u[j0]; sw -= w[j0]; j0++; }
      const n = j1 - j0; if (!n) continue;
      out.t.push(tt); out.u.push(su / n); out.w.push(sw / n);
    }
    return out;
  }
  // cumulative winding (turns) of the velocity direction at each grid point; moving samples only
  function winding(g, vMin) {
    const n = g.t.length, th = new Float64Array(n);
    let prev = null, acc = 0;
    for (let k = 1; k < n - 1; k++) {
      const du = g.u[k + 1] - g.u[k - 1], dw = g.w[k + 1] - g.w[k - 1], dt = (g.t[k + 1] - g.t[k - 1]) / 1000;
      if (Math.hypot(du, dw) / dt > vMin) {
        const a = Math.atan2(dw, du);
        if (prev != null) { let d = a - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; acc += d; }
        prev = a;
      } else prev = null;       // a stop breaks the curve: no rotation is carried across it
      th[k] = acc / (2 * Math.PI);
    }
    th[n - 1] = n > 1 ? th[n - 2] : 0;
    return th;
  }
  function analyze(t, u, w, opt = {}) {
    const o = { ...DEFAULTS, ...opt }, g = grid(t, u, w, o.smoothMs);
    if (g.t.length < 5) return { turns: 0, area: 0, iso: 0, ru: 0, rw: 0 };
    const th = winding(g, o.vMin);
    let area = 0, len = 0;
    for (let k = 1; k < g.t.length; k++) { area += (g.u[k - 1] * g.w[k] - g.u[k] * g.w[k - 1]) / 2; len += Math.hypot(g.u[k] - g.u[k - 1], g.w[k] - g.w[k - 1]); }
    // best net winding over any sub-span <= maxMs (a circle inside a longer window)
    let best = 0, b0 = 0, b1 = 0;
    for (let i = 0, j = 0; j < g.t.length; j++) {
      while (g.t[j] - g.t[i] > o.maxMs) i++;
      for (let k = i; k < j; k += 5) { const d = th[j] - th[k]; if (Math.abs(d) > Math.abs(best)) { best = d; b0 = k; b1 = j; } }
    }
    const seg = (A) => A.slice(b0, b1 + 1), rg = (A) => (A.length ? Math.max(...A) - Math.min(...A) : 0);
    return { turns: best, area, iso: len > 0 ? 4 * Math.PI * Math.abs(area) / (len * len) : 0, ru: 100 * rg(seg(g.u)), rw: 100 * rg(seg(g.w)), t0: g.t[b0], t1: g.t[b1] };
  }

  class CircleDetector {
    constructor(opt = {}) { this.o = { ...DEFAULTS, ...opt }; this.lastFire = -1e9; this.drawing = -1e9; }
    update(tr, now) {
      if (!tr || !tr.t || tr.t.length < 50) return null;
      const o = this.o, a = analyze(tr.t, tr.u, tr.w, o);
      if (Math.abs(a.turns) >= o.busyTurns) this.drawing = now;
      if (now - this.lastFire < o.refireMs || a.t0 < this.lastFire) return null;   // don't count the same circle twice
      if (Math.abs(a.turns) < o.needTurns || a.ru < o.minSpanCm || a.rw < o.minSpanCm) return null;
      this.lastFire = now;
      const dir = Math.sign(a.turns) * o.cwSign > 0 ? 'cw' : 'ccw';
      return { kind: 'circle', dir, turns: +a.turns.toFixed(2), span: [+a.ru.toFixed(1), +a.rw.toFixed(1)], t: now, t0: a.t0 };
    }
    busy(now) { return now - this.drawing < 600 || now - this.lastFire < 600; }
    calibrate(sign) { this.o.cwSign = sign >= 0 ? 1 : -1; }
  }

  const api = { CircleDetector, analyze, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BatCircle = api;
})(typeof self !== 'undefined' ? self : this);
