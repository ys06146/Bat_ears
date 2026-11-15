// Static-vector estimate by circle fit (the hand echo traces a circle around the static vector in the I/Q plane):
// every 10 samples a Kasa fit over the last winMs of baseband; when the arc spans >= minArc around the fitted centre
// (and the radius is sane) the static estimate moves to the centre. With no fit (hand still) it follows a slow EMA.
// Fixes the EMA failure after a hold: the EMA swallows the parked hand echo, then echo - static turns at HALF rate.
//   pathStepsFit(bb, f, opt) -> { step, mag, noise, rate }   (drop-in for phase.js pathSteps)
const P = require('./phase.js');
function pathStepsFit(bb, f, { winMs = 200, minArc = 1.6, gate = 1.5, tauS = 1.0, pct = 0.25, medS = 4, every = 10 } = {}) {
  const { I, Q, rate } = bb, n = I.length, lam = 343 / f, W = Math.round(winMs / 1000 * rate), a = 1 / (tauS * rate);
  const step = new Float32Array(n), mag = new Float32Array(n), noise = new Float32Array(n);
  const k0 = Math.min(n - 1, Math.round(0.02 * rate)), k1 = Math.min(n, k0 + Math.round(0.3 * rate));
  let sI = 0, sQ = 0; for (let k = k0; k < k1; k++) { sI += I[k]; sQ += Q[k]; } sI /= Math.max(1, k1 - k0); sQ /= Math.max(1, k1 - k0);
  let pI = 0, pQ = 0, lastFit = -1e9;
  for (let k = 0; k < n; k++) {
    if (k >= W && k % every === 0) {
      // Kasa fit on [k-W, k]: x^2 + y^2 + D x + E y + F = 0
      let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sz = 0, Sxz = 0, Syz = 0, m = 0;
      for (let j = k - W; j <= k; j += 2) { const x = I[j], y = Q[j], z = x * x + y * y; Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y; Sz += z; Sxz += x * z; Syz += y * z; m++; }
      // normal equations [Sxx Sxy Sx; Sxy Syy Sy; Sx Sy m] [D E F] = -[Sxz Syz Sz]
      const A = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, m]], b = [-Sxz, -Syz, -Sz];
      const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
      if (Math.abs(det) > 1e-30) {
        const sol = [0, 1, 2].map((c) => { const M = A.map((r, i) => r.map((v, j) => (j === c ? b[i] : v))); return (M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])) / det; });
        const cx = -sol[0] / 2, cy = -sol[1] / 2, r2 = cx * cx + cy * cy - sol[2];
        if (r2 > 0) {
          // arc covered around the centre (unwrapped angle range)
          let th0 = Math.atan2(Q[k - W] - cy, I[k - W] - cx), acc = 0, lo = 0, hi = 0;
          for (let j = k - W + 2; j <= k; j += 2) { const th = Math.atan2(Q[j] - cy, I[j] - cx); let d = th - th0; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI)); acc += d; th0 = th; lo = Math.min(lo, acc); hi = Math.max(hi, acc); }
          const r = Math.sqrt(r2), spread = Math.hypot(sI - cx, sQ - cy);
          if (hi - lo >= minArc && r < 3 * Math.hypot(cx, cy) + 1e-9) { sI = 0.5 * sI + 0.5 * cx; sQ = 0.5 * sQ + 0.5 * cy; lastFit = k; }
          void spread;
        }
      }
    }
    if (k - lastFit > 0.3 * rate) { sI += a * (I[k] - sI); sQ += a * (Q[k] - sQ); }   // still: slow EMA absorbs drift / a parked hand
    const dI = I[k] - sI, dQ = Q[k] - sQ;
    mag[k] = Math.hypot(dI, dQ);
    if (k) step[k] = -Math.atan2(dQ * pI - dI * pQ, dI * pI + dQ * pQ) * lam / (2 * Math.PI);
    pI = dI; pQ = dQ;
  }
  const win = Math.round(medS * rate);
  for (let k = 0; k < n; k += 100) {
    const lo = Math.max(0, k - win), xs = [];
    for (let j = lo; j <= k; j += Math.max(1, Math.floor((k - lo) / 50))) xs.push(mag[j]);
    xs.sort((u, v) => u - v);
    const m = xs.length ? xs[Math.floor(pct * (xs.length - 1))] : 0;
    for (let j = k; j < Math.min(n, k + 100); j++) noise[j] = m;
  }
  for (let k = 1; k < n; k++) if (!(mag[k] > gate * noise[k] && mag[k - 1] > gate * noise[k])) step[k] = 0;
  return { step, mag, noise, rate };
}
module.exports = { pathStepsFit };
