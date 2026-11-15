// Plan A headroom: richer maps from sound to the 250 ms hand displacement, leave-one-sitting-out over teach + compare
// sittings (compare: audio lag from auto_train's cache, full vision re-extraction when present).
//   M0 ridge(x)                       deployed form (x = 4 path changes over the window)
//   M1 ridge(x, x[-250..0])           + the previous 250 ms of path change (momentum, an FIR the engine can run)
//   M2 ridge(x, x[-250..0], x[-500..-250])
//   M3 ridge(x, x * log q)            signal-quality gating (q = |dynamic| / noise per path)
//   M4 MLP 16 tanh on (x, x[-250..0], log q)   nonlinear headroom
// Scored pooled over all held-out sittings and over the compare sittings only.
//   node feat_loso.js <base> ...      env: SEEDS (MLP restarts, 2)
const fs = require('fs'), path = require('path'), V = require('./vision3d.js'), P = require('./phase.js');
const NEAR = 0.45, WIN = 250, CACHE = path.join(__dirname, 'cache');
function cachedLag(base) { const n = path.basename(base); const f = fs.readdirSync(CACHE).filter((x) => x.startsWith(n + '.')).map((x) => path.join(CACHE, x)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]; if (!f) return 0; const d = JSON.parse(fs.readFileSync(f, 'utf8')); return d.lag ? d.lag.audioMs : 0; }
function load(base) {
  const isCmp = /_cmp_/.test(base), vf = isCmp && fs.existsSync(base + '_vision_full.csv') ? base + '_vision_full.csv' : base + '_vision.csv';
  const J = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), cam = J.camera || {}, lean = (J.screen_angle_deg ?? 95) - 90, r = lean * Math.PI / 180, C = [0, 0.19 * Math.cos(r), 0.10 + 0.19 * Math.sin(r)];
  const L = fs.readFileSync(vf, 'utf8').trim().split('\n').map((l) => l.replace(/\r$/, '')), h = L[0].split(','), ix = Object.fromEntries(h.map((k, i) => [k, i]));
  const tr = L.slice(1).map((l) => { const q = l.split(','), n = (k) => Number(q[ix[k]]); if (n('present') !== 1) return null;
    const f = { lm: Array.from({ length: 21 }, (_, j) => [n(`lm${j}_x`), n(`lm${j}_y`), 0]), wlm: Array.from({ length: 21 }, (_, j) => [n(`wlm${j}_x`), n(`wlm${j}_y`), n(`wlm${j}_z`)]) };
    const c = V.handCam(f, { W: cam.width || 1280, H: cam.height || 720, hfov: 66 }); return c ? { t: n('t_cap'), H: V.toLaptop(c, { tilt: lean, C }) } : null; }).filter(Boolean);
  const lag = isCmp ? cachedLag(base) : 0, wav = P.readWav(base + '.wav'), t0 = J.wav.t0, F = J.stereoFreqs || [18000, 19500];
  const st = F.flatMap((f) => [0, 1].map((c) => P.pathSteps(P.baseband(wav.ch[c], wav.rate, f), f, { gate: 1.0, tauS: 0.1, pct: 0.25 })));
  const n = st[0].step.length, cum = st.map((s) => { const q = new Float64Array(n + 1); for (let k = 0; k < n; k++) q[k + 1] = q[k] + s.step[k]; return q; });
  const cq = st.map((s) => { const q = new Float64Array(n + 1); for (let k = 0; k < n; k++) q[k + 1] = q[k] + Math.log(Math.max(1e-3, s.mag[k] / Math.max(1e-12, s.noise[k]))); return q; });
  const I = (tms) => Math.max(0, Math.min(n, Math.round(tms + lag - t0)));   // 1 kHz
  const ws = [];
  for (let i = 0, j = 0; i < tr.length; i++) { while (j < tr.length && tr[j].t < tr[i].t + WIN) j++; if (j >= tr.length) break;
    const a = tr[i], b = tr[j]; if (b.t - a.t > WIN + 80) continue; if (Math.hypot(...a.H.map((v, k) => v - C[k])) > NEAR || Math.hypot(...b.H.map((v, k) => v - C[k])) > NEAR) continue;
    const y = b.H.map((v, k) => v - a.H[k]); if (Math.hypot(...y) < 0.01 || Math.hypot(...y) > 0.4) continue;
    const ia = I(a.t), ib = I(b.t), d = (q, u, v) => q[Math.max(0, v)] - q[Math.max(0, u)];
    ws.push({ c: isCmp, y, x: cum.map((q) => d(q, ia, ib)), p1: cum.map((q) => d(q, ia - 250, ia)), p2: cum.map((q) => d(q, ia - 500, ia - 250)), lq: cq.map((q) => d(q, ia, ib) / Math.max(1, ib - ia)) }); }
  return { name: path.basename(base).slice(8, 23) + (isCmp ? ' cmp' : ''), isCmp, ws };
}
const FEATS = {
  M0: (w) => w.x,
  M1: (w) => [...w.x, ...w.p1],
  M2: (w) => [...w.x, ...w.p1, ...w.p2],
  M3: (w) => [...w.x, ...w.x.map((v, i) => v * w.lq[i])],
};
function solve(A, b) { const m = A.length, M = A.map((r, i) => [...r, b[i]]); for (let c = 0; c < m; c++) { let p = c; for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c] || 1e-15; for (let j = c; j <= m; j++) M[c][j] /= d; for (let r = 0; r < m; r++) if (r !== c) { const q = M[r][c]; for (let j = c; j <= m; j++) M[r][j] -= q * M[c][j]; } } return M.map((r) => r[m]); }
function ridge(train, fx, lam = 1e-4, cw = 1) {
  const X = train.map((w) => [...fx(w), 1]), m = X[0].length, A = Array.from({ length: m }, () => new Array(m).fill(0)), B = [0, 1, 2].map(() => new Array(m).fill(0));
  let wsum = 0; X.forEach((x, n) => { const wt = train[n].c ? cw : 1; wsum += wt; for (let i = 0; i < m; i++) { for (let j = 0; j < m; j++) A[i][j] += wt * x[i] * x[j]; for (let a = 0; a < 3; a++) B[a][i] += wt * x[i] * train[n].y[a]; } });
  const sc = A.slice(0, 4).reduce((s, r, i) => s + r[i], 0) / 4; for (let i = 0; i < m - 1; i++) A[i][i] += lam * wsum * (i < 4 ? 1 : Math.max(1e-12, A[i][i] / Math.max(1e-12, sc)));
  const W = B.map((b) => solve(A, b)); return (w) => { const x = [...fx(w), 1]; return W.map((r) => r.reduce((s, v, j) => s + v * x[j], 0)); };
}
// small MLP (tanh hidden, linear out), standardized inputs and outputs, Adam, L2, fixed epochs
function mlp(train, fx, { H = 16, epochs = 60, lr = 3e-3, l2 = 1e-4, seed = 1 } = {}) {
  let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const X0 = train.map(fx), d = X0[0].length, mu = Array.from({ length: d }, (_, i) => X0.reduce((q, x) => q + x[i], 0) / X0.length), sd = mu.map((u, i) => Math.sqrt(X0.reduce((q, x) => q + (x[i] - u) ** 2, 0) / X0.length) || 1);
  const ysd = [0, 1, 2].map((a) => Math.sqrt(train.reduce((q, w) => q + w.y[a] ** 2, 0) / train.length) || 1);
  const X = X0.map((x) => x.map((v, i) => (v - mu[i]) / sd[i])), Y = train.map((w) => w.y.map((v, a) => v / ysd[a]));
  const W1 = Array.from({ length: H }, () => Array.from({ length: d }, () => rnd() * 2 / Math.sqrt(d))), b1 = new Array(H).fill(0), W2 = Array.from({ length: 3 }, () => Array.from({ length: H }, () => rnd() * 2 / Math.sqrt(H))), b2 = [0, 0, 0];
  const params = [W1, b1, W2, b2], flat = () => [...W1.flat(), ...b1, ...W2.flat(), ...b2];
  const np = flat().length, m1 = new Float64Array(np), v1 = new Float64Array(np); let step = 0;
  const idx = X.map((_, i) => i), B = 64;
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor((rnd() + 0.5) * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    for (let k0 = 0; k0 < idx.length; k0 += B) {
      const gW1 = W1.map((r) => r.map(() => 0)), gb1 = b1.map(() => 0), gW2 = W2.map((r) => r.map(() => 0)), gb2 = [0, 0, 0], bs = Math.min(B, idx.length - k0);
      for (let q = k0; q < k0 + bs; q++) { const x = X[idx[q]], y = Y[idx[q]];
        const hdn = W1.map((r, h) => Math.tanh(r.reduce((s2, w, i) => s2 + w * x[i], b1[h]))), out = W2.map((r, a) => r.reduce((s2, w, h) => s2 + w * hdn[h], b2[a])), e = out.map((o, a) => (o - y[a]) / bs);
        for (let a = 0; a < 3; a++) { gb2[a] += e[a]; for (let h = 0; h < H; h++) gW2[a][h] += e[a] * hdn[h]; }
        for (let h = 0; h < H; h++) { const g = (1 - hdn[h] ** 2) * e.reduce((s2, ea, a) => s2 + ea * W2[a][h], 0); gb1[h] += g; for (let i = 0; i < d; i++) gW1[h][i] += g * x[i]; } }
      const grads = [...gW1.flat().map((g, i) => g + l2 * W1.flat()[i]), ...gb1, ...gW2.flat().map((g, i) => g + l2 * W2.flat()[i]), ...gb2];
      step++; const p = flat(), b1c = 1 - 0.9 ** step, b2c = 1 - 0.999 ** step;
      for (let i = 0; i < np; i++) { m1[i] = 0.9 * m1[i] + 0.1 * grads[i]; v1[i] = 0.999 * v1[i] + 0.001 * grads[i] ** 2; p[i] -= lr * (m1[i] / b1c) / (Math.sqrt(v1[i] / b2c) + 1e-8); }
      let o = 0; for (const r of W1) for (let i = 0; i < d; i++) r[i] = p[o++]; for (let h = 0; h < H; h++) b1[h] = p[o++]; for (const r of W2) for (let h = 0; h < H; h++) r[h] = p[o++]; for (let a = 0; a < 3; a++) b2[a] = p[o++];
    }
  }
  return (w) => { const x = fx(w).map((v, i) => (v - mu[i]) / sd[i]), hdn = W1.map((r, h) => Math.tanh(r.reduce((s2, ww, i) => s2 + ww * x[i], b1[h]))); return W2.map((r, a) => r.reduce((s2, ww, h) => s2 + ww * hdn[h], b2[a]) * ysd[a]); };
}
const S = process.argv.slice(2).map(load);
console.log(`${S.length} sittings (${S.filter((s) => s.isCmp).length} compare), ${S.reduce((q, s) => q + s.ws.length, 0)} windows`);
const acc = () => ({ e: [0, 0, 0], v: [0, 0, 0], c: [0, 0, 0], p: [0, 0, 0], n: 0 });
const add = (A, p, y) => { for (let k = 0; k < 3; k++) { A.e[k] += (p[k] - y[k]) ** 2; A.v[k] += y[k] ** 2; A.c[k] += p[k] * y[k]; A.p[k] += p[k] ** 2; } A.n++; };
const fmt = (A) => { const corr = A.c.map((x, k) => x / Math.sqrt(A.v[k] * A.p[k] || 1)); return `err ${A.e.map((x) => (100 * Math.sqrt(x / Math.max(1, A.n))).toFixed(2)).join('/')} corr ${corr.map((x) => x.toFixed(3)).join('/')} (mean ${(corr.reduce((a, b) => a + b) / 3).toFixed(3)})`; };
const mcorr = (A) => A.c.reduce((s, x, k) => s + x / Math.sqrt(A.v[k] * A.p[k] || 1), 0) / 3;
// M5: context-gated linear map, deployable in the engine (dPos = G(ctx) . dD every step): G (3 x 4 gains) comes from a
// small tanh net on the context (log q over the window, path change over the previous 250 ms), initialised at the ridge W
function gmlp(train, { H = 8, epochs = 40, lr = 2e-3, l2 = 1e-3, seed = 1, ctxOf = (w) => [...w.lq, ...w.p1] } = {}) {
  let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const C0 = train.map(ctxOf), d = C0[0].length, mu = Array.from({ length: d }, (_, i) => C0.reduce((q, x) => q + x[i], 0) / C0.length), sd = mu.map((u, i) => Math.sqrt(C0.reduce((q, x) => q + (x[i] - u) ** 2, 0) / C0.length) || 1);
  const sx = Math.sqrt(train.reduce((q, w) => q + w.x.reduce((r, v) => r + v * v, 0), 0) / (4 * train.length)) || 1, ysd = [0, 1, 2].map((a) => Math.sqrt(train.reduce((q, w) => q + w.y[a] ** 2, 0) / train.length) || 1);
  const C = C0.map((c) => c.map((v, i) => (v - mu[i]) / sd[i])), X = train.map((w) => w.x.map((v) => v / sx)), Y = train.map((w) => w.y.map((v, a) => v / ysd[a]));
  const R = ridge(train, (w) => w.x), Wr = [0, 1, 2].map((a) => [0, 1, 2, 3].map((p) => { const e = { x: [0, 0, 0, 0] }; e.x[p] = 1; const z = { x: [0, 0, 0, 0] }; return (R(e)[a] - R(z)[a]) * sx / ysd[a]; }));
  const W1 = Array.from({ length: H }, () => Array.from({ length: d }, () => rnd() * 2 / Math.sqrt(d))), b1 = new Array(H).fill(0), W2 = Array.from({ length: 12 }, () => Array.from({ length: H }, () => rnd() * 0.1)), b2 = Wr.flat();
  const flat = () => [...W1.flat(), ...b1, ...W2.flat(), ...b2], np = flat().length, m1 = new Float64Array(np), v1 = new Float64Array(np); let step = 0;
  const idx = X.map((_, i) => i), B = 64;
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor((rnd() + 0.5) * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    for (let k0 = 0; k0 < idx.length; k0 += B) {
      const bs = Math.min(B, idx.length - k0), gW1 = W1.map((r) => r.map(() => 0)), gb1 = b1.map(() => 0), gW2 = W2.map((r) => r.map(() => 0)), gb2 = b2.map(() => 0);
      for (let q = k0; q < k0 + bs; q++) { const c = C[idx[q]], x = X[idx[q]], y = Y[idx[q]];
        const hdn = W1.map((r, h) => Math.tanh(r.reduce((s2, w, i) => s2 + w * c[i], b1[h]))), G = W2.map((r, o) => r.reduce((s2, w, h) => s2 + w * hdn[h], b2[o]));
        const e = [0, 1, 2].map((a) => (x.reduce((s2, v, p) => s2 + v * G[a * 4 + p], 0) - y[a]) / bs), gG = G.map((_, o) => e[Math.floor(o / 4)] * x[o % 4]);
        for (let o = 0; o < 12; o++) { gb2[o] += gG[o]; for (let h = 0; h < H; h++) gW2[o][h] += gG[o] * hdn[h]; }
        for (let h = 0; h < H; h++) { const g = (1 - hdn[h] ** 2) * gG.reduce((s2, go, o) => s2 + go * W2[o][h], 0); gb1[h] += g; for (let i = 0; i < d; i++) gW1[h][i] += g * c[i]; } }
      const grads = [...gW1.flat().map((g, i) => g + l2 * W1.flat()[i]), ...gb1, ...gW2.flat().map((g, i) => g + l2 * W2.flat()[i]), ...gb2];
      step++; const p = flat(), b1c = 1 - 0.9 ** step, b2c = 1 - 0.999 ** step;
      for (let i = 0; i < np; i++) { m1[i] = 0.9 * m1[i] + 0.1 * grads[i]; v1[i] = 0.999 * v1[i] + 0.001 * grads[i] ** 2; p[i] -= lr * (m1[i] / b1c) / (Math.sqrt(v1[i] / b2c) + 1e-8); }
      let o = 0; for (const r of W1) for (let i = 0; i < d; i++) r[i] = p[o++]; for (let h = 0; h < H; h++) b1[h] = p[o++]; for (const r of W2) for (let h = 0; h < H; h++) r[h] = p[o++]; for (let k = 0; k < 12; k++) b2[k] = p[o++];
    }
  }
  return (w) => { const c = ctxOf(w).map((v, i) => (v - mu[i]) / sd[i]), hdn = W1.map((r, h) => Math.tanh(r.reduce((s2, ww, i) => s2 + ww * c[i], b1[h]))), G = W2.map((r, o) => r.reduce((s2, ww, h) => s2 + ww * hdn[h], b2[o]));
    return [0, 1, 2].map((a) => w.x.reduce((s2, v, p) => s2 + (v / sx) * G[a * 4 + p], 0) * ysd[a]); };
}
const ens = (fit, n) => (tr) => { const fs2 = Array.from({ length: n }, (_, i) => fit(tr, 11 + i)); return (w) => { const ps = fs2.map((f) => f(w)); return [0, 1, 2].map((a) => ps.reduce((q, p) => q + p[a], 0) / ps.length); }; };
const M5 = { 'M5 gated': ens((tr, seed) => gmlp(tr, { seed }), Number(process.env.SEEDS || 2)), 'M5 gated q-only': ens((tr, seed) => gmlp(tr, { seed, ctxOf: (w) => w.lq }), Number(process.env.SEEDS || 2)) };
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const models0 = { 'M0 cmp x3': (tr) => ridge(tr, FEATS.M0, 1e-4, 3), 'M0 cmp x10': (tr) => ridge(tr, FEATS.M0, 1e-4, 10), 'M1 cmp x3': (tr) => ridge(tr, FEATS.M1, 1e-4, 3), ...Object.fromEntries(Object.entries(FEATS).map(([k, f]) => [k, (tr) => ridge(tr, f)])), M4: (tr) => { const fs2 = Array.from({ length: Number(process.env.SEEDS || 2) }, (_, i) => mlp(tr, (w) => [...w.x, ...w.p1, ...w.lq], { seed: 11 + i })); return (w) => { const ps = fs2.map((f) => f(w)); return [0, 1, 2].map((a) => ps.reduce((q, p) => q + p[a], 0) / ps.length); }; } };
const base0 = {};
const models = Object.fromEntries(Object.entries({ M0: models0.M0 || ((tr) => ridge(tr, FEATS.M0)), ...models0, ...M5 }).filter(([k]) => !ONLY.length || k === 'M0' || ONLY.includes(k)));
for (const [name, fit] of Object.entries(models)) {
  const all = acc(), cmp = acc(), per = [];
  for (const s of S) { const pr = fit(S.filter((o) => o !== s).flatMap((o) => o.ws)), a = acc(); for (const w of s.ws) { const p = pr(w); add(all, p, w.y); add(a, p, w.y); if (s.isCmp) add(cmp, p, w.y); } per.push(mcorr(a)); }
  if (name === 'M0') base0.per = per;
  const better = per.filter((v, i) => v > base0.per[i] + 1e-9).length;
  console.log(`${name} all: ${fmt(all)} | compare: ${fmt(cmp)} | better than M0 on ${better}/${S.length}`);
}
