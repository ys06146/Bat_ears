// Generic 3-class (left / right / push-pull) shrunk LDA + scoring (leave-one-out and time split), same rule as swipe.js v3.
const isSw = (k) => k === 'left' || k === 'right';
const CLS = ['left', 'right', 'pp'], clsOf = (k) => (isSw(k) ? k : 'pp');
function inv(A) {
  const n = A.length, M = A.map((r, i) => [...r, ...A.map((_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12; for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const q = M[r][c]; for (let j = 0; j < 2 * n; j++) M[r][j] -= q * M[c][j]; }
  }
  return M.map((r) => r.slice(n));
}
function fit(items, keys, lam = 0.3) {
  const by = { left: [], right: [], pp: [] };
  for (const it of items) { const v = keys.map((k) => it.feat[k]); if (v.every(Number.isFinite)) by[clsOf(it.kind)].push(v); }
  if (CLS.some((c) => by[c].length < 2)) return null;
  const n = keys.length, mu = {}; for (const c of CLS) mu[c] = keys.map((_, j) => by[c].reduce((s, x) => s + x[j], 0) / by[c].length);
  const Sg = keys.map(() => keys.map(() => 0)); let dof = -3;
  for (const c of CLS) for (const x of by[c]) { dof++; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Sg[i][j] += (x[i] - mu[c][i]) * (x[j] - mu[c][j]); }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Sg[i][j] = (Sg[i][j] / Math.max(1, dof)) * (i === j ? 1 : 1 - lam) + (i === j ? 1e-12 : 0);
  return { keys, mu, P: inv(Sg) };
}
function decide(m, f, { margin = 0.5, minMs = 350 } = {}) {
  if (!m) return null; const x = m.keys.map((k) => f[k]); if (!x.every(Number.isFinite)) return null;
  const sc = {}; for (const c of CLS) { const d = x.map((v, i) => v - m.mu[c][i]); let q = 0; for (let i = 0; i < d.length; i++) for (let j = 0; j < d.length; j++) q += d[i] * m.P[i][j] * d[j]; sc[c] = -0.5 * q; }
  const best = CLS.slice().sort((a, b) => sc[b] - sc[a])[0], lead = sc[best] - Math.max(...CLS.filter((c) => c !== best).map((c) => sc[c]));
  return best !== 'pp' && lead >= margin && f.ms >= minMs ? best : null;
}
const tally = () => ({ h: 0, w: 0, u: 0, f: 0, n: 0 });
const add = (r, t, d) => { if (isSw(t.kind)) { if (d === t.kind) r.h++; else if (d) r.w++; else r.u++; } else { r.n++; if (d) r.f++; } };
const fmt = (r) => `${r.h}/${r.w}/${r.u} (${Math.round(100 * r.h / Math.max(1, r.h + r.w + r.u))}%) pp→L/R ${r.f}/${r.n}`;
function score(trials, keys, opt = {}) {
  const loo = tally(); trials.forEach((t, i) => add(loo, t, decide(fit(trials.filter((_, j) => j !== i), keys, opt.lam), t.feat, opt)));
  const sp = tally(), A = trials.slice(0, trials.length >> 1), B = trials.slice(trials.length >> 1);
  for (const [a, b] of [[A, B], [B, A]]) { const m = fit(a, keys, opt.lam); for (const t of b) add(sp, t, decide(m, t.feat, opt)); }
  return { loo, sp, line: `LOO ${fmt(loo)}   time split ${fmt(sp)}` };
}
// d' between two groups of one feature
function dprime(a, b) {
  const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
  const va = a.reduce((s, x) => s + (x - ma) ** 2, 0), vb = b.reduce((s, x) => s + (x - mb) ** 2, 0);
  return (mb - ma) / Math.sqrt((va + vb) / Math.max(1, a.length + b.length - 2));
}
module.exports = { fit, decide, score, fmt, dprime, isSw };
