// Does a learned audio -> displacement map transfer between sessions (no per-sitting calibration)?
// Train ridge on all near-hand windows of session A, test on session B (and within-B second half for reference).
//   node xfer.js <teach base A> <teach base B>   (laptop paths only: 18k, 19.5k x 2 mics)   env: WIN, NEAR
const fs = require('fs'), V = require('./vision3d.js'), P = require('./phase.js');
const WIN = Number(process.env.WIN || 250), NEAR = Number(process.env.NEAR || 0.45);
function load(base) {
  const J = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), cam = J.camera || {}, lean = (J.screen_angle_deg ?? 95) - 90, r = lean * Math.PI / 180, C = [0, 0.19 * Math.cos(r), 0.10 + 0.19 * Math.sin(r)];
  const L = fs.readFileSync(base + (process.env.VSUFFIX || '_vision') + '.csv', 'utf8').trim().split('\n').map((l) => l.replace(/\r$/, '')), h = L[0].split(','), ix = Object.fromEntries(h.map((k, i) => [k, i]));
  const tr = L.slice(1).map((l) => { const q = l.split(','), n = (k) => Number(q[ix[k]]); if (n('present') !== 1) return null;
    const f = { lm: Array.from({ length: 21 }, (_, j) => [n(`lm${j}_x`), n(`lm${j}_y`), 0]), wlm: Array.from({ length: 21 }, (_, j) => [n(`wlm${j}_x`), n(`wlm${j}_y`), n(`wlm${j}_z`)]) };
    const c = V.handCam(f, { W: cam.width || 1280, H: cam.height || 720, hfov: 66 }); return c ? { t: n('t_cap'), H: V.toLaptop(c, { tilt: lean, C }) } : null; }).filter(Boolean);
  const wav = P.readWav(base + '.wav'), t0 = J.wav.t0, F = J.stereoFreqs || [18000, 19500];
  const st = F.flatMap((f) => [0, 1].map((c) => P.pathSteps(P.baseband(wav.ch[c], wav.rate, f), f, { gate: Number(process.env.GATE || 1.5), tauS: Number(process.env.TAU || 0.25) })));
  const rate = st[0].rate, n = st[0].step.length, cum = st.map((s) => { const q = new Float64Array(n + 1); for (let k = 0; k < n; k++) q[k + 1] = q[k] + s.step[k]; return q; });
  const D = (p, tms) => cum[p][Math.max(0, Math.min(n, Math.round((tms - t0) / 1000 * rate)))];
  const ws = [];
  for (let i = 0, j = 0; i < tr.length; i++) { while (j < tr.length && tr[j].t < tr[i].t + WIN) j++; if (j >= tr.length) break;
    const a = tr[i], b = tr[j]; if (b.t - a.t > WIN + 80) continue; if (Math.hypot(...a.H.map((v, k) => v - C[k])) > NEAR || Math.hypot(...b.H.map((v, k) => v - C[k])) > NEAR) continue;
    const dH = b.H.map((v, k) => v - a.H[k]); if (Math.hypot(...dH) < 0.01 || Math.hypot(...dH) > 0.4) continue;
    ws.push({ t: a.t, x: st.map((_, p) => D(p, b.t) - D(p, a.t)), y: dH }); }
  return { name: base.split(/[\\/]/).pop(), ws };
}
function ridge(train, lam = 1e-4) {
  const X = train.map((w) => [...w.x, 1]), m = X[0].length;
  const A = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => X.reduce((s, x) => s + x[i] * x[j], 0) + (i === j && i < m - 1 ? lam * X.length : 0)));
  const inv = (A) => { const k = A.length, M = A.map((r, i) => [...r, ...A.map((_, j) => (i === j ? 1 : 0))]); for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c] || 1e-12; for (let j = 0; j < 2 * k; j++) M[c][j] /= d; for (let r = 0; r < k; r++) if (r !== c) { const q = M[r][c]; for (let j = 0; j < 2 * k; j++) M[r][j] -= q * M[c][j]; } } return M.map((r) => r.slice(k)); };
  const Ai = inv(A), W = [0, 1, 2].map((ax) => { const xy = Array.from({ length: m }, (_, i) => X.reduce((s, x, n) => s + x[i] * train[n].y[ax], 0)); return Ai.map((r) => r.reduce((s, v, j) => s + v * xy[j], 0)); });
  return (w) => W.map((wa) => wa.reduce((s, v, j) => s + v * [...w.x, 1][j], 0));
}
function score(name, pred, test) {
  const e = [0, 0, 0], v = [0, 0, 0], c = [0, 0, 0], pp = [0, 0, 0];
  for (const w of test) { const p = pred(w); for (let k = 0; k < 3; k++) { e[k] += (p[k] - w.y[k]) ** 2; v[k] += w.y[k] ** 2; c[k] += p[k] * w.y[k]; pp[k] += p[k] ** 2; } }
  const n = test.length;
  console.log(`  ${name.padEnd(34)} ${[0, 1, 2].map((k) => `${'xyz'[k]} ${(100 * Math.sqrt(e[k] / n)).toFixed(1)} cm (corr ${(c[k] / Math.sqrt(v[k] * pp[k] || 1)).toFixed(2)})`).join(' | ')}  [${n} windows, motion ${[0, 1, 2].map((k) => (100 * Math.sqrt(v[k] / n)).toFixed(1)).join('/')}]`);
}

// per-axis amplitude: regression of the TRUE displacement on the predicted one (slope s) from leave-one-sitting-out
// predictions; s > 1 = the map draws the motion too small (ridge / noise shrinkage). A display wants slope 1 -> scale k = s.
const S = process.argv.slice(2).map(load);
const preds = S.map((s, i) => { const pr = ridge(S.filter((_, j) => j !== i).flatMap((x) => x.ws)); return s.ws.map((w) => ({ p: pr(w), y: w.y })); });
const slope = (pairs) => [0, 1, 2].map((k) => { let py = 0, pp = 0; for (const q of pairs) { py += q.p[k] * q.y[k]; pp += q.p[k] ** 2; } return py / Math.max(1e-12, pp); });
const stats = (pairs, kk = [1, 1, 1]) => { const e = [0, 0, 0], v = [0, 0, 0], c = [0, 0, 0], p2 = [0, 0, 0]; for (const q of pairs) for (let k = 0; k < 3; k++) { const p = kk[k] * q.p[k]; e[k] += (p - q.y[k]) ** 2; v[k] += q.y[k] ** 2; c[k] += p * q.y[k]; p2[k] += p * p; }
  const n = pairs.length; return { rms: e.map((x) => 100 * Math.sqrt(x / n)), amp: p2.map((x, k) => Math.sqrt(x / Math.max(1e-12, v[k]))), corr: c.map((x, k) => x / Math.sqrt(v[k] * p2[k] || 1)) }; };
const f = (r) => 'err ' + r.rms.map((v) => v.toFixed(2)).join('/') + ' cm, drawn/true size ' + r.amp.map((v) => v.toFixed(2)).join('/') + ', corr ' + r.corr.map((v) => v.toFixed(2)).join('/');
S.forEach((s, i) => console.log('  ' + s.name.slice(8, 23) + ' slope true~pred ' + slope(preds[i]).map((v) => v.toFixed(2)).join('/')));
const all = preds.flat(), sAll = slope(all);
console.log('pooled slope true~pred: ' + sAll.map((v) => v.toFixed(2)).join('/'));
console.log('as is          : ' + f(stats(all)));
// nested: the scale for sitting i comes from the other sittings' LOSO predictions only
const nested = S.flatMap((_, i) => { const k = slope(preds.filter((__, j) => j !== i).flat()); return preds[i].map((q) => ({ p: q.p.map((v, a) => k[a] * v), y: q.y })); });
console.log('scaled (nested): ' + f(stats(nested)));
for (const cap of [1.5, 2.0]) { const nc = S.flatMap((_, i) => { const k = slope(preds.filter((__, j) => j !== i).flat()).map((v) => Math.min(cap, Math.max(1 / cap, v))); return preds[i].map((q) => ({ p: q.p.map((v, a) => k[a] * v), y: q.y })); }); console.log('scaled, cap ' + cap + ': ' + f(stats(nc))); }
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ slope: sAll }));
// size-matched: scale k = 1 / (drawn/true size) so the drawn motion is as big as the real one (costs some MSE);
// nested again (k for sitting i from the other sittings' LOSO predictions)
const ampOf = (pairs) => stats(pairs).amp;
const matched = S.flatMap((_, i) => { const a = ampOf(preds.filter((__, j) => j !== i).flat()); return preds[i].map((q) => ({ p: q.p.map((v, k) => v / a[k]), y: q.y })); });
console.log('size-matched (nested): ' + f(stats(matched)) + '   k = ' + ampOf(all).map((v) => (1 / v).toFixed(2)).join('/'));
const half = S.flatMap((_, i) => { const a = ampOf(preds.filter((__, j) => j !== i).flat()); return preds[i].map((q) => ({ p: q.p.map((v, k) => v / Math.sqrt(a[k])), y: q.y })); });
console.log('half-way (sqrt)      : ' + f(stats(half)) + '   k = ' + ampOf(all).map((v) => (1 / Math.sqrt(v)).toFixed(2)).join('/'));
if (process.env.OUT) {
  const r2 = (x) => +x.toFixed(2), pack = (st, k) => ({ k: k.map((v) => +v.toFixed(3)), rms: st.rms.map(r2), size: st.amp.map(r2) });
  const base = stats(all), sz = ampOf(all);
  const amp = { method: 'leave-one-sitting-out over ' + S.length + ' sittings, scale estimated without the held-out sitting', corr: base.corr.map(r2),
    motion: [0, 1, 2].map((k) => r2(100 * Math.sqrt(all.reduce((s, q) => s + q.y[k] ** 2, 0) / all.length))),
    modes: { mse: pack(base, [1, 1, 1]), half: pack(stats(half), sz.map((v) => 1 / Math.sqrt(v))), matched: pack(stats(matched), sz.map((v) => 1 / v)) } };
  fs.writeFileSync(process.env.OUT, JSON.stringify({ slope: sAll, sizeRatio: sz, amp }));
}
