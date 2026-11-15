// observability (singular values of the path Jacobian) with a phone as a 3rd source, Galaxy Book estimate geometry
const sub = (a, b) => a.map((v, i) => v - b[i]), nrm = (a) => Math.hypot(...a), unit = (a) => { const n = nrm(a); return a.map((v) => v / n); };
const SL = [-0.15, -0.01, -0.08], SR = [0.15, -0.01, -0.08], M = [0, 0.19, 0.17];
const row = (H, S) => { const a = unit(sub(H, S)), b = unit(sub(H, M)); return a.map((v, i) => v + b[i]); };
function sv(rows) { const A = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
  // eigenvalues of 3x3 symmetric via characteristic polynomial (trig form)
  const p1 = A[0][1] ** 2 + A[0][2] ** 2 + A[1][2] ** 2, q = (A[0][0] + A[1][1] + A[2][2]) / 3;
  const p2 = (A[0][0] - q) ** 2 + (A[1][1] - q) ** 2 + (A[2][2] - q) ** 2 + 2 * p1, p = Math.sqrt(p2 / 6);
  const B = A.map((r, i) => r.map((v, j) => (v - (i === j ? q : 0)) / p));
  const r = (B[0][0] * (B[1][1] * B[2][2] - B[1][2] * B[2][1]) - B[0][1] * (B[1][0] * B[2][2] - B[1][2] * B[2][0]) + B[0][2] * (B[1][0] * B[2][1] - B[1][1] * B[2][0])) / 2;
  const phi = Math.acos(Math.max(-1, Math.min(1, r))) / 3, e1 = q + 2 * p * Math.cos(phi), e3 = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3), e2 = 3 * q - e1 - e3;
  return [e1, e2, e3].map((e) => Math.sqrt(Math.max(0, e)).toFixed(2)).join(' / '); }
const hands = [[0, 0.12, 0], [-0.08, 0.10, -0.03], [0.08, 0.15, 0.03]];
const cands = {
  'none (laptop only)': null,
  'flat on desk, in front of keyboard (0,-0.01,-0.25)': [0, -0.01, -0.25],
  'flat on desk, right of laptop (0.30,-0.01,0)': [0.30, -0.01, 0],
  'standing right of screen, speaker 25 cm up (0.25,0.25,0.12)': [0.25, 0.25, 0.12],
  'standing left of screen, 25 cm up (-0.25,0.25,0.12)': [-0.25, 0.25, 0.12],
  'held above the hand area, 35 cm up (0,0.35,0)': [0, 0.35, 0],
  'on top of the screen centre (0,0.22,0.17)': [0, 0.22, 0.17],
  'standing in front, 20 cm up (0,0.20,-0.30)': [0, 0.20, -0.30],
};
for (const [nm, Pp] of Object.entries(cands)) console.log(nm.padEnd(62), hands.map((H) => sv(Pp ? [row(H, SL), row(H, SR), row(H, Pp)] : [row(H, SL), row(H, SR)])).join('  |  '));
