// Score fixed maps on given sittings (same windows / ticks as gated_stream.js): the v15 linear W (8 sittings) and gated
// models (calib json files with .gated or bare gated json). Truly unseen sittings only make sense here.
//   node gated_eval.js <gated json> [more gated json ...] -- <base> ...
const fs = require('fs'), path = require('path');
// reuse gated_stream.js's load() / predictor() without running its main part
const src = fs.readFileSync(path.join(__dirname, 'gated_stream.js'), 'utf8'), cut = src.indexOf('const S = process.argv.slice(2).map(load);');
const mod = { exports: {} }; new Function('require', 'module', '__dirname', 'process', src.slice(0, cut) + '\nmodule.exports = { load, predictor };')(require, mod, __dirname, { ...process, env: { ...process.env } });
const { load, predictor } = mod.exports;
const args = process.argv.slice(2), k = args.indexOf('--'), models = args.slice(0, k).map((f) => ({ name: path.basename(f), M: JSON.parse(fs.readFileSync(f, 'utf8')) })), bases = args.slice(k + 1);
const B15 = require('../../web/bat3d_v15.js');   // the frozen v15 engine file (linear W, half k)
const Wl = B15.DEFAULT_CALIB.galaxy.learned.laptop.W, kl = B15.DEFAULT_CALIB.galaxy.amp.modes.half.k;
const acc = () => ({ e: [0, 0, 0], v: [0, 0, 0], c: [0, 0, 0], p: [0, 0, 0], n: 0 }), add = (A, p, y) => { for (let a = 0; a < 3; a++) { A.e[a] += (p[a] - y[a]) ** 2; A.v[a] += y[a] ** 2; A.c[a] += p[a] * y[a]; A.p[a] += p[a] ** 2; } A.n++; };
const fmt = (A) => { const c = A.c.map((x, a) => x / Math.sqrt(A.v[a] * A.p[a] || 1)); return `corr ${c.map((x) => x.toFixed(2)).join('/')} (mean ${(c.reduce((q, x) => q + x) / 3).toFixed(3)}) err ${A.e.map((x) => (100 * Math.sqrt(x / A.n)).toFixed(1)).join('/')} cm size ${A.p.map((x, a) => Math.sqrt(x / A.v[a]).toFixed(2)).join('/')}`; };
for (const b of bases) {
  const s = load(b), lin = acc(), G = models.map(() => acc());
  for (const w of s.ws) {
    const x = [0, 1, 2, 3].map((p) => { let q = 0; for (let t = w.k0 + 1; t <= w.k1; t++) q += s.dD[t * 4 + p]; return q; });
    add(lin, [0, 1, 2].map((a) => kl[a] * x.reduce((q, v, p) => q + Wl[a][p] * v, 0)), w.y);
    models.forEach((m, i) => { const M = m.M.gated || m.M, kk = M.amp ? M.amp.modes.half.k : [1, 1, 1], p = predictor(M, true)(s, w); add(G[i], p.map((v, a) => v * kk[a]), w.y); });
  }
  console.log(`${s.name} (${s.ws.length} windows)\n  v15 linear       ${fmt(lin)}`);
  models.forEach((m, i) => console.log(`  ${m.name.padEnd(16)} ${fmt(G[i])}`));
}
