// Third source = a phone playing a steady tone (its own clock). Its carrier at the laptop mic is off by a few ppm and
// wanders, so the direct phone->mic vector ROTATES slowly. A 2nd-order PLL on the baseband (dominated by that direct
// path) tracks the offset; the baseband is de-rotated by the PLL phase, then the usual static removal + phase steps give
// the phone->hand->mic path change relative to the direct path.
//   const r = pathStepsPLL(bb, f, { bwHz, gate })   -> { step, mag, noise, rate, offHz }
//   node phone.js --selftest      synthetic: 25 ppm offset + a hand moving 10 cm toward / away from the phone
const P = require('./phase.js');

function pll(bb, { bwHz = 0.4, zeta = 0.9 } = {}) {
  const { I, Q, rate } = bb, n = I.length, dt = 1 / rate;
  const wn = 2 * Math.PI * bwHz, kp = 2 * zeta * wn * dt, ki = wn * wn * dt * dt;
  let th = 0, w = 0; const out = { I: new Float32Array(n), Q: new Float32Array(n), rate, off: new Float32Array(n) };
  // start at the phase / frequency of the first 0.5 s (after the low-pass settles)
  const k0 = Math.round(0.05 * rate), k1 = Math.min(n - 1, k0 + Math.round(0.5 * rate));
  th = Math.atan2(Q[k0], I[k0]);
  if (k1 > k0) { let d = Math.atan2(Q[k1], I[k1]) - th; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI)); w = d / (k1 - k0); }
  for (let k = 0; k < n; k++) {
    const c = Math.cos(th), s = Math.sin(th);
    const i2 = I[k] * c + Q[k] * s, q2 = Q[k] * c - I[k] * s;      // z * e^{-j th}
    out.I[k] = i2; out.Q[k] = q2; out.off[k] = w / (2 * Math.PI * dt);
    const e = Math.atan2(q2, i2);                                    // phase error vs the direct path
    w += ki * e; th += w + kp * e;
    if (th > Math.PI) th -= 2 * Math.PI; else if (th < -Math.PI) th += 2 * Math.PI;
  }
  return out;
}
function pathStepsPLL(bb, f, opt = {}) {
  const d = pll(bb, opt), r = P.pathSteps(d, f, opt);
  r.offHz = d.off;
  return r;
}
module.exports = { pll, pathStepsPLL };

if (require.main === module && process.argv[2] === '--selftest') {
  const rate = 48000, T = 8, n = rate * T, f = 20500, ppm = 25, fOff = f * (1 + ppm * 1e-6);
  const Pp = [0.25, 0.25, 0.12], M = [0, 0.19, 0.17], d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const sm = (s) => { s = Math.min(1, Math.max(0, s)); return s * s * (3 - 2 * s); };
  const hand = (t) => { const a = sm((t - 2) / 0.6) - sm((t - 4) / 0.6) + sm((t - 5.5) / 0.4) - sm((t - 6.5) / 0.4); return [0.05 * a, 0.12 + 0.10 * a, 0]; };   // up 10 cm, back; again faster
  let seed = 3; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const x = new Float32Array(n), truth = [];
  const dDir = d3(Pp, M);
  for (let i = 0; i < n; i++) {
    const t = i / rate, h = hand(t), dH = d3(h, Pp) + d3(h, M);
    x[i] = 0.05 * Math.cos(2 * Math.PI * fOff * (t - dDir / 343)) + 0.004 * Math.cos(2 * Math.PI * fOff * (t - dH / 343)) + 0.002 * rnd();
    if (i % 480 === 0) truth.push({ t, dH });
  }
  const bb = P.baseband(x, rate, f);
  const at = (t) => truth.reduce((b, q) => (Math.abs(q.t - t) < Math.abs(b.t - t) ? q : b)).dH;
  for (const [nm, fn] of [['plain (no PLL)', () => P.pathSteps(bb, f, { gate: 1.5 })], ['PLL 0.4 Hz', () => pathStepsPLL(bb, f, { gate: 1.5 })]]) {
    const r = fn(), cum = (a, b) => { let s = 0; for (let k = Math.round(a * r.rate); k < Math.round(b * r.rate); k++) s += r.step[k]; return s; };
    const segs = [[1.5, 3.0], [3.5, 5.0], [5.2, 6.2], [0.5, 1.8]];
    console.log(nm.padEnd(16) + segs.map(([a, b]) => `${a}-${b}s ${(100 * cum(a, b)).toFixed(1)}/${(100 * (at(b) - at(a))).toFixed(1)}cm`).join('  ') + (r.offHz ? `  offset est ${r.offHz[r.offHz.length - 1].toFixed(2)} Hz (true ${(fOff - f).toFixed(2)})` : ''));
  }
}
