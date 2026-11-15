// Engine-equivalent context-gated map. Every 10 ms tick k (as bat3d.js feed()):
//   dD_k   = path change over the tick (4 paths)
//   ctx_k  = [ path change over the last 250 ms (4), over the 250 ms before that (4), share of gated steps over the
//              last 250 ms (4) ]   -- all from the step stream the engine already has
//   dPos_k = G(ctx_k) . dD_k,   G = W0 + S * net(ctx_k)   (3 x 4 gains; net: 12 -> H tanh -> 12, starts at 0 = W0 ridge)
// Trained on the webcam's 250 ms displacements (sum of dPos over the window's ticks), full batch Adam.
// Leave-one-sitting-out; pooled + compare-only scores vs the plain ridge (net = 0). Output: the model on all sittings.
//   node gated_stream.js <base> ...   env: H 8, ITERS 250, LR 0.01, L2 1e-3, SAVE=<json> (final model)
const fs = require('fs'), path = require('path'), V = require('./vision3d.js'), P = require('./phase.js');
const CTX = process.env.CTX || 'base', NC = { base: 12, long: 16, q: 16, longq: 20 }[CTX], NEAR = 0.45, WIN = 250, CACHE = path.join(__dirname, 'cache'), H = Number(process.env.H || 8), ITERS = Number(process.env.ITERS || 250), LR = Number(process.env.LR || 0.01), L2 = Number(process.env.L2 || 1e-3);
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
  const cq = st.map((s) => { const q = new Float64Array(n + 1); for (let k = 0; k < n; k++) q[k + 1] = q[k] + s.mag[k] / Math.max(1e-12, s.noise[k]); return q; });
  const cact = st.map((s) => { const q = new Float64Array(n + 1); for (let k = 0; k < n; k++) q[k + 1] = q[k] + (s.step[k] !== 0 ? 1 : 0); return q; });
  const nT = Math.floor(n / 10), D = (p, i) => cum[p][Math.max(0, Math.min(n, i))], A = (p, i) => cact[p][Math.max(0, Math.min(n, i))];
  const dD = new Float64Array(nT * 4), ctx = new Float64Array(nT * NC);
  for (let k = 1; k < nT; k++) { const i = 10 * k; for (let p = 0; p < 4; p++) { dD[k * 4 + p] = D(p, i) - D(p, i - 10); ctx[k * NC + p] = D(p, i) - D(p, i - 250); ctx[k * NC + 4 + p] = D(p, i - 250) - D(p, i - 500); ctx[k * NC + 8 + p] = (A(p, i) - A(p, i - 250)) / 250; let e = 12; if (CTX === 'long' || CTX === 'longq') { ctx[k * NC + e + p] = D(p, i - 500) - D(p, i - 1000); e += 4; } if (CTX === 'q' || CTX === 'longq') ctx[k * NC + e + p] = Math.log(Math.max(1e-3, (cq[p][Math.min(n, i)] - cq[p][Math.max(0, i - 250)]) / 250)); } }
  const ws = [];
  for (let i = 0, j = 0; i < tr.length; i++) { while (j < tr.length && tr[j].t < tr[i].t + WIN) j++; if (j >= tr.length) break;
    const a = tr[i], b = tr[j]; if (b.t - a.t > WIN + 80) continue; if (Math.hypot(...a.H.map((v, k) => v - C[k])) > NEAR || Math.hypot(...b.H.map((v, k) => v - C[k])) > NEAR) continue;
    const y = b.H.map((v, k) => v - a.H[k]); if (Math.hypot(...y) < 0.01 || Math.hypot(...y) > 0.4) continue;
    const k0 = Math.round((a.t + lag - t0) / 10), k1 = Math.round((b.t + lag - t0) / 10); if (k0 < 50 || k1 >= nT || k1 <= k0) continue;
    ws.push({ k0, k1, y }); }
  return { name: path.basename(base).slice(17, 23) + (isCmp ? 'c' : ''), isCmp, nT, dD, ctx, ws };
}
// ridge on window sums (= the deployed W form, no intercept at use)
function ridgeW(S) {
  const A = Array.from({ length: 4 }, () => new Array(4).fill(0)), B = [0, 1, 2].map(() => new Array(4).fill(0)); let n = 0;
  for (const s of S) for (const w of s.ws) { const x = [0, 1, 2, 3].map((p) => { let q = 0; for (let k = w.k0 + 1; k <= w.k1; k++) q += s.dD[k * 4 + p]; return q; }); for (let i = 0; i < 4; i++) { for (let j = 0; j < 4; j++) A[i][j] += x[i] * x[j]; for (let a = 0; a < 3; a++) B[a][i] += x[i] * w.y[a]; } n++; }
  for (let i = 0; i < 4; i++) A[i][i] += 1e-4 * n;
  const solve = (b) => { const M = A.map((r, i) => [...r, b[i]]); for (let c = 0; c < 4; c++) { let p = c; for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c] || 1e-15; for (let j = c; j <= 4; j++) M[c][j] /= d; for (let r = 0; r < 4; r++) if (r !== c) { const q = M[r][c]; for (let j = c; j <= 4; j++) M[r][j] -= q * M[c][j]; } } return M.map((r) => r[4]); };
  return B.map(solve);
}
function train(S, seed = 1) {
  const W0 = ridgeW(S), Sg = W0.flat().reduce((q, v) => q + Math.abs(v), 0) / 12;
  // ctx normalisation over the ticks that windows use
  const mu = new Float64Array(NC), sd = new Float64Array(NC); let cnt = 0;
  for (const s of S) for (const w of s.ws) for (let k = w.k0 + 1; k <= w.k1; k += 5) { for (let i = 0; i < NC; i++) { const v = s.ctx[k * NC + i]; mu[i] += v; sd[i] += v * v; } cnt++; }
  for (let i = 0; i < NC; i++) { mu[i] /= cnt; sd[i] = Math.sqrt(Math.max(1e-30, sd[i] / cnt - mu[i] ** 2)); }
  const ysd = [0, 1, 2].map((a) => Math.sqrt(S.reduce((q, s) => q + s.ws.reduce((r, w) => r + w.y[a] ** 2, 0), 0) / S.reduce((q, s) => q + s.ws.length, 0)));
  let rs = seed; const rnd = () => ((rs = (rs * 16807) % 2147483647) / 2147483647) - 0.5;
  const W1 = Float64Array.from({ length: H * NC }, () => rnd() * 2 / Math.sqrt(NC)), b1 = new Float64Array(H), W2 = Float64Array.from({ length: 12 * H }, () => rnd() * 0.02), b2 = new Float64Array(12);
  const prm = [W1, b1, W2, b2], m = prm.map((p) => new Float64Array(p.length)), v = prm.map((p) => new Float64Array(p.length));
  // ticks used by any window, per sitting
  const used = S.map((s) => { const u = new Uint8Array(s.nT); for (const w of s.ws) for (let k = w.k0 + 1; k <= w.k1; k++) u[k] = 1; const list = []; for (let k = 0; k < s.nT; k++) if (u[k]) list.push(k); return list; });
  const nW = S.reduce((q, s) => q + s.ws.length, 0), hid = new Float64Array(H), c = new Float64Array(NC);
  for (let it = 1; it <= ITERS; it++) {
    const g = prm.map((p) => new Float64Array(p.length));
    S.forEach((s, si) => {
      // forward per used tick: per-tick contribution to each axis
      const G = new Map(), Hs = new Map(), contrib = new Float64Array(s.nT * 3);
      for (const k of used[si]) { for (let i = 0; i < NC; i++) c[i] = (s.ctx[k * NC + i] - mu[i]) / sd[i];
        const hh = new Float64Array(H); for (let h = 0; h < H; h++) { let q = b1[h]; for (let i = 0; i < NC; i++) q += W1[h * NC + i] * c[i]; hh[h] = Math.tanh(q); }
        const gg = new Float64Array(12); for (let o = 0; o < 12; o++) { let q = b2[o]; for (let h = 0; h < H; h++) q += W2[o * H + h] * hh[h]; gg[o] = q; }
        Hs.set(k, hh); G.set(k, gg);
        for (let a = 0; a < 3; a++) { let q = 0; for (let p = 0; p < 4; p++) q += (W0[a][p] + Sg * gg[a * 4 + p]) * s.dD[k * 4 + p]; contrib[k * 3 + a] = q; } }
      // windows: prediction = sum of tick contributions; error coefficient per tick
      const ek = new Float64Array(s.nT * 3);
      for (const w of s.ws) { for (let a = 0; a < 3; a++) { let q = 0; for (let k = w.k0 + 1; k <= w.k1; k++) q += contrib[k * 3 + a]; const e = (q - w.y[a]) / (ysd[a] ** 2) / nW; for (let k = w.k0 + 1; k <= w.k1; k++) ek[k * 3 + a] += e; } }
      // backprop per tick
      for (const k of used[si]) { const hh = Hs.get(k); for (let i = 0; i < NC; i++) c[i] = (s.ctx[k * NC + i] - mu[i]) / sd[i];
        const gG = new Float64Array(12); for (let a = 0; a < 3; a++) for (let p = 0; p < 4; p++) gG[a * 4 + p] = ek[k * 3 + a] * Sg * s.dD[k * 4 + p];
        const gh = new Float64Array(H);
        for (let o = 0; o < 12; o++) { if (!gG[o]) continue; g[3][o] += gG[o]; for (let h = 0; h < H; h++) { g[2][o * H + h] += gG[o] * hh[h]; gh[h] += gG[o] * W2[o * H + h]; } }
        for (let h = 0; h < H; h++) { const d = gh[h] * (1 - hh[h] ** 2); if (!d) continue; g[1][h] += d; for (let i = 0; i < NC; i++) g[0][h * NC + i] += d * c[i]; } }
    });
    for (let j = 0; j < 4; j++) { const p = prm[j], gj = g[j]; for (let i = 0; i < p.length; i++) { const gi = gj[i] + (j === 0 || j === 2 ? L2 * p[i] : 0); m[j][i] = 0.9 * m[j][i] + 0.1 * gi; v[j][i] = 0.999 * v[j][i] + 0.001 * gi * gi; p[i] -= LR * (m[j][i] / (1 - 0.9 ** it)) / (Math.sqrt(v[j][i] / (1 - 0.999 ** it)) + 1e-8); } }
  }
  return { NC, W0, Sg, mu: Array.from(mu), sd: Array.from(sd), H, W1: Array.from(W1), b1: Array.from(b1), W2: Array.from(W2), b2: Array.from(b2) };
}
function predictor(M, useNet = true) {
  return (s, w) => { const out = [0, 0, 0], c = new Float64Array(M.NC), hh = new Float64Array(M.H);
    for (let k = w.k0 + 1; k <= w.k1; k++) { let gg = null;
      if (useNet) { for (let i = 0; i < M.NC; i++) c[i] = (s.ctx[k * M.NC + i] - M.mu[i]) / M.sd[i]; for (let h = 0; h < M.H; h++) { let q = M.b1[h]; for (let i = 0; i < M.NC; i++) q += M.W1[h * M.NC + i] * c[i]; hh[h] = Math.tanh(q); }
        gg = new Float64Array(12); for (let o = 0; o < 12; o++) { let q = M.b2[o]; for (let h = 0; h < M.H; h++) q += M.W2[o * M.H + h] * hh[h]; gg[o] = q; } }
      for (let a = 0; a < 3; a++) for (let p = 0; p < 4; p++) out[a] += (M.W0[a][p] + (gg ? M.Sg * gg[a * 4 + p] : 0)) * s.dD[k * 4 + p]; }
    return out; };
}
const S = process.argv.slice(2).map(load);
console.log(`CTX ${CTX} (${NC}) | ${S.length} sittings (${S.filter((s) => s.isCmp).length} compare), ${S.reduce((q, s) => q + s.ws.length, 0)} windows; H ${H} iters ${ITERS} lr ${LR} l2 ${L2}`);
const acc = () => ({ e: [0, 0, 0], v: [0, 0, 0], c: [0, 0, 0], p: [0, 0, 0], n: 0 }), add = (A, p, y) => { for (let k = 0; k < 3; k++) { A.e[k] += (p[k] - y[k]) ** 2; A.v[k] += y[k] ** 2; A.c[k] += p[k] * y[k]; A.p[k] += p[k] ** 2; } A.n++; };
const cor = (A) => A.c.map((x, k) => x / Math.sqrt(A.v[k] * A.p[k] || 1)), mc = (A) => cor(A).reduce((a, b) => a + b) / 3;
const fmt = (A) => `err ${A.e.map((x) => (100 * Math.sqrt(x / Math.max(1, A.n))).toFixed(2)).join('/')} corr ${cor(A).map((x) => x.toFixed(3)).join('/')} (mean ${mc(A).toFixed(3)})`;
const R = { base: { all: acc(), cmp: acc() }, net: { all: acc(), cmp: acc() } }, per = [], pairs = [];
const t0 = Date.now();
let MF = null; if (process.env.NOLOSO) { MF = train(S); const pn = predictor(MF, true), pb = predictor(MF, false); for (const s of S) for (const w of s.ws) { const q = pn(s, w); pairs.push({ p: q, y: w.y }); add(R.net.all, q, w.y); add(R.base.all, pb(s, w), w.y); if (s.isCmp) { add(R.net.cmp, q, w.y); add(R.base.cmp, pb(s, w), w.y); } } console.log("NOLOSO: in-sample numbers (amp table from in-sample sizes)"); }
if (!process.env.NOLOSO) for (const s of S) {
  const M = train(S.filter((o) => o !== s)), pb = predictor(M, false), pn = predictor(M, true), ab = acc(), an = acc();
  for (const w of s.ws) { const b = pb(s, w), q = pn(s, w); pairs.push({ p: q, y: w.y }); add(R.base.all, b, w.y); add(R.net.all, q, w.y); add(ab, b, w.y); add(an, q, w.y); if (s.isCmp) { add(R.base.cmp, b, w.y); add(R.net.cmp, q, w.y); } }
  per.push(`${s.name} ${mc(ab).toFixed(2)}>${mc(an).toFixed(2)}`); process.stderr.write(`${s.name} done ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
}
console.log(`ridge (net 0)  all ${fmt(R.base.all)} | compare ${fmt(R.base.cmp)}`);
console.log(`gated net      all ${fmt(R.net.all)} | compare ${fmt(R.net.cmp)}`);
console.log(`per sitting: ${per.join(' ')} | better ${per.filter((x) => { const [a, b] = x.split(' ')[1].split('>').map(Number); return b > a; }).length}/${S.length}`);
// display size table from the held-out predictions (as the linear map's amp table): size = drawn / true per axis
const r2 = (x) => +x.toFixed(2), szA = [0, 1, 2].map((a) => Math.sqrt(pairs.reduce((q, w) => q + w.p[a] ** 2, 0) / Math.max(1e-12, pairs.reduce((q, w) => q + w.y[a] ** 2, 0))));
const modeOf = (k) => { const A = acc(); for (const w of pairs) add(A, w.p.map((v, a) => v * k[a]), w.y); return { k: k.map((v) => +v.toFixed(3)), rms: A.e.map((x) => r2(100 * Math.sqrt(x / A.n))), size: szA.map((v, a) => r2(v * k[a])) }; };
const amp = { method: `leave-one-sitting-out over ${S.length} sittings (pooled size)`, corr: cor(R.net.all).map(r2), motion: R.net.all.v.map((x) => r2(100 * Math.sqrt(x / R.net.all.n))),
  modes: { mse: modeOf([1, 1, 1]), half: modeOf(szA.map((v) => 1 / Math.sqrt(v))), matched: modeOf(szA.map((v) => 1 / v)) } };
console.log('amp: ' + JSON.stringify(amp.modes));
if (process.env.SAVE) { const M = MF || train(S); fs.writeFileSync(process.env.SAVE, JSON.stringify({ kind: 'gated-v1', ticksMs: 10, ctx: 'dD 250 ms (4), dD 250-500 ms (4), gated share 250 ms (4)', sittings: S.map((s) => s.name), amp, loso: { base: { corr: cor(R.base.all).map(r2) }, net: { corr: cor(R.net.all).map(r2) }, cmpBase: { corr: cor(R.base.cmp).map(r2) }, cmpNet: { corr: cor(R.net.cmp).map(r2) } }, ...M })); console.log('saved ' + process.env.SAVE); }
