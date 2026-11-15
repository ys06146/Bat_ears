// Does a short webcam warm-up at the start of a sitting help? For each sitting: prior W0 = ridge on the OTHER sittings
// (what the deployed default does on an unseen sitting); calibration = this sitting's windows in the first T s;
// test = its windows after T + 1 s. Variants fitted on the calibration part only:
//   gain   : per-axis scale a_k (y_k ~ a_k * (W0 x)_k)
//   shrink : ridge pulled toward W0, strength r (relative to the calibration windows' own scatter)
//   alone  : ridge on the calibration windows only (no prior)
// Scored on the test part against W0 as is. Uses auto_train.js's cached windows (needs window times, cache v2).
//   node adapt.js        env: TS (comma list of warm-up seconds, default 15,30,60)
const fs = require('fs'), path = require('path');
const CACHE = path.join(__dirname, 'cache');
const files = fs.readdirSync(CACHE).filter((f) => f.endsWith('.json')).map((f) => ({ f, m: fs.statSync(path.join(CACHE, f)).mtimeMs }));
const byName = new Map();
for (const { f, m } of files.sort((a, b) => a.m - b.m)) { const name = f.replace(/\.[0-9a-f]{12}\.json$/, ''); const d = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')); if (d.ws.length && d.ws[0].t != null) byName.set(name, d); }
const S = [...byName.entries()].filter(([n]) => /_teach_/.test(n)).map(([name, d]) => ({ name: name.slice(8, 23), ws: d.ws }));
console.log(`${S.length} sittings: ${S.map((s) => `${s.name.slice(9)} ${s.ws.length}w ${s.ws[s.ws.length - 1].t.toFixed(0)}s`).join(', ')}`);

function solve(A, b) { const n = A.length, M = A.map((r, i) => [...r, b[i]]); for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c] || 1e-15; for (let j = c; j <= n; j++) M[c][j] /= d; for (let r = 0; r < n; r++) if (r !== c) { const q = M[r][c]; for (let j = c; j <= n; j++) M[r][j] -= q * M[c][j]; } } return M.map((r) => r[n]); }
// ridge toward a prior: min sum (y - w.x)^2 + reg_i (w_i - p_i)^2   (x with intercept 1; reg per coefficient)
function fit(train, prior, reg) {
  const m = 5, A = Array.from({ length: m }, () => new Array(m).fill(0)), B = [0, 1, 2].map(() => new Array(m).fill(0));
  for (const w of train) { const x = [...w.x, 1]; for (let i = 0; i < m; i++) { for (let j = 0; j < m; j++) A[i][j] += x[i] * x[j]; for (let a = 0; a < 3; a++) B[a][i] += x[i] * w.y[a]; } }
  return [0, 1, 2].map((a) => solve(A.map((r, i) => r.map((v, j) => v + (i === j ? reg[i] : 0))), B[a].map((v, i) => v + reg[i] * (prior ? prior[a][i] : 0))));
}
const ridgeAll = (train, lam = 1e-4) => { const n = train.length; return fit(train, null, [lam * n, lam * n, lam * n, lam * n, 0]); };
const apply = (W, w) => W.map((r) => r.reduce((s, v, j) => s + v * (j < 4 ? w.x[j] : 1), 0));
const acc = () => ({ e: [0, 0, 0], v: [0, 0, 0], c: [0, 0, 0], p: [0, 0, 0], n: 0 });
const add = (A, p, y) => { for (let k = 0; k < 3; k++) { A.e[k] += (p[k] - y[k]) ** 2; A.v[k] += y[k] ** 2; A.c[k] += p[k] * y[k]; A.p[k] += p[k] ** 2; } A.n++; };
const fin = (A) => { const corr = A.c.map((x, k) => x / Math.sqrt(A.v[k] * A.p[k] || 1)); return { rms: A.e.map((x) => 100 * Math.sqrt(x / Math.max(1, A.n))), corr, mc: corr.reduce((s, x) => s + x, 0) / 3, n: A.n }; };
const fmt = (r) => `err ${r.rms.map((x) => x.toFixed(2)).join('/')} cm | corr ${r.corr.map((x) => x.toFixed(3)).join('/')} (mean ${r.mc.toFixed(3)})`;

for (const T of (process.env.TS || '15,30,60').split(',').map(Number)) {
  const V = { 'W0 (deployed-style)': acc(), 'gain per axis': acc(), alone: acc() }, R = [0.03, 0.1, 0.3, 1, 3];
  for (const r of R) V['shrink r ' + r] = acc();
  const per = [];
  for (const s of S) {
    const W0 = ridgeAll(S.filter((o) => o !== s).flatMap((o) => o.ws)), cal = s.ws.filter((w) => w.t < T), test = s.ws.filter((w) => w.t >= T + 1);
    if (cal.length < 20 || test.length < 50) { per.push(`${s.name.slice(9)} skip (${cal.length} cal / ${test.length} test)`); continue; }
    // scatter of the calibration features -> reg scale
    const sc = [0, 1, 2, 3].map((i) => cal.reduce((q, w) => q + w.x[i] ** 2, 0)), tr = sc.reduce((a, b) => a + b, 0) / 4;
    const p0 = cal.map((w) => apply(W0, w)), g = [0, 1, 2].map((k) => { let py = 0, pp = 0; cal.forEach((w, i) => { py += p0[i][k] * w.y[k]; pp += p0[i][k] ** 2; }); return Math.max(0.3, Math.min(3, py / Math.max(1e-12, pp))); });
    const Wal = ridgeAll(cal, 1e-3), Wsh = Object.fromEntries(R.map((r) => [r, fit(cal, W0, [r * tr, r * tr, r * tr, r * tr, r * cal.length])]));
    const a0 = acc(), a1 = acc();
    for (const w of test) { const p = apply(W0, w); add(V['W0 (deployed-style)'], p, w.y); add(a0, p, w.y); add(V['gain per axis'], p.map((v, k) => v * g[k]), w.y); add(V.alone, apply(Wal, w), w.y);
      for (const r of R) add(V['shrink r ' + r], apply(Wsh[r], w), w.y); add(a1, apply(Wsh[0.3], w), w.y); }
    per.push(`${s.name.slice(9)} ${fin(a0).mc.toFixed(2)}->${fin(a1).mc.toFixed(2)} (gain ${g.map((x) => x.toFixed(2)).join('/')})`);
  }
  console.log(`\nwarm-up ${T} s (test = rest of each sitting, pooled ${fin(V['W0 (deployed-style)']).n} windows)`);
  for (const [k, A] of Object.entries(V)) console.log(`  ${k.padEnd(20)} ${fmt(fin(A))}`);
  console.log('  per sitting mean corr W0 -> shrink 0.3: ' + per.join(' | '));
}
