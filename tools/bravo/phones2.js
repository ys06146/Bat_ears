// geometry with 0 / 1 / 2 phones: singular values and per-axis error gain sqrt(diag((J^T J)^-1)) (cm of hand error per cm of path noise)
const sub = (a, b) => a.map((v, i) => v - b[i]), nrm = (a) => Math.hypot(...a), unit = (a) => { const n = nrm(a); return a.map((v) => v / n); };
const SL = [-0.15, -0.01, -0.08], SR = [0.15, -0.01, -0.08], M = [0, 0.19, 0.17];
const row = (H, S) => { const a = unit(sub(H, S)), b = unit(sub(H, M)); return a.map((v, i) => v + b[i]); };
const inv3 = (A) => { const [a, b, c] = A[0], [d, e, f] = A[1], [g, h, i] = A[2], det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [[(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det], [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det], [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]]; };
const hands = [[0, 0.12, 0], [-0.08, 0.10, -0.04], [0.08, 0.18, 0.03], [0, 0.22, -0.05]];
const C = {
  'laptop only': [],
  '1 phone: right, raised 25 cm': [[0.25, 0.25, 0.12]],
  '2 phones: left + right, raised 25 cm': [[-0.25, 0.25, 0.12], [0.25, 0.25, 0.12]],
  '2 phones: right raised + left low on desk': [[0.25, 0.25, 0.12], [-0.30, 0.0, -0.05]],
  '2 phones: right raised + front low': [[0.25, 0.25, 0.12], [0, 0.0, -0.30]],
  '2 phones: right raised 25 + left raised 40': [[0.25, 0.25, 0.12], [-0.25, 0.40, 0.12]],
  '2 phones: left/right raised 25, forward 10 cm': [[-0.25, 0.25, -0.10], [0.25, 0.25, -0.10]],
};
for (const [nm, ph] of Object.entries(C)) {
  const out = hands.map((H) => {
    const J = [row(H, SL), row(H, SR), ...ph.map((p) => row(H, p))];
    const A = [0, 1, 2].map((i) => [0, 1, 2].map((j) => J.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? 1e-9 : 0)));
    if (J.length < 3) return 'x ' + Math.sqrt(inv3(A.map((r, i) => r.map((v, j) => v + (i === j && i === 1 ? 1e3 : 0))))[0][0]).toFixed(1) + ' y ∞';
    const Ai = inv3(A); return ['x', 'y', 'z'].map((a, i) => `${a} ${Math.sqrt(Ai[i][i]).toFixed(1)}`).join(' ');
  });
  console.log(nm.padEnd(48), out.join(' | '));
}
