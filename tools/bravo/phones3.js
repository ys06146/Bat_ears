// per-axis error gain for the REAL hand region (teach sessions: hand ~20 cm above the desk, 15-30 cm in front of the hinge)
const sub = (a, b) => a.map((v, i) => v - b[i]), nrm = (a) => Math.hypot(...a), unit = (a) => { const n = nrm(a); return a.map((v) => v / n); };
const SL = [-0.15, -0.01, -0.08], SR = [0.15, -0.01, -0.08], M = [0, 0.19, 0.117];
const row = (H, S) => { const a = unit(sub(H, S)), b = unit(sub(H, M)); return a.map((v, i) => v + b[i]); };
const inv3 = (A) => { const [a, b, c] = A[0], [d, e, f] = A[1], [g, h, i] = A[2], det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [[(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det], [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det], [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]]; };
const hands = [[0, 0.20, -0.20], [-0.08, 0.18, -0.25], [0.08, 0.24, -0.15], [0, 0.22, -0.30]];
// phone positions in my frame: x, y (above deck), z (toward the screen; hinge at +0.10, z_front 25 cm -> -0.15)
const C = {
  'now: A right 26.5 cm high, B left 16 cm (z_front 25)': [[0.38, 0.25, -0.15], [-0.38, 0.145, -0.15]],
  'A only (right, raised)': [[0.38, 0.25, -0.15]],
  'A flat on the desk UNDER the hand area, speaker up': [[0, -0.015, -0.25]],
  'A held / stood ABOVE the hand area (45 cm up)': [[0, 0.45, -0.22]],
  'A under the hand + B above the hand': [[0, -0.015, -0.25], [0, 0.45, -0.22]],
  'A under the hand + B right raised': [[0, -0.015, -0.25], [0.38, 0.25, -0.15]],
};
for (const [nm, ph] of Object.entries(C)) {
  const out = hands.map((H) => { const J = [row(H, SL), row(H, SR), ...ph.map((p) => row(H, p))]; const A = [0, 1, 2].map((i) => [0, 1, 2].map((j) => J.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? 1e-9 : 0))); const Ai = inv3(A); return ['x', 'y', 'z'].map((a, i) => `${a} ${Math.sqrt(Math.max(0, Ai[i][i])).toFixed(1)}`).join(' '); });
  console.log(nm.padEnd(58), out.join(' | '));
}
