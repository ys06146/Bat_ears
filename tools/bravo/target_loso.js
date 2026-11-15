// Which point of the hand does the sound follow best? For each candidate point (21-landmark centroid, palm centre,
// MCP knuckles, fingertips, wrist) the 250 ms displacement of that point (webcam, PnP + world landmarks) is predicted
// from the laptop path changes; leave-one-sitting-out correlation / error per axis. Path steps are computed once per
// sitting and shared by all targets.
//   node target_loso.js <teach base> ...        env: NEAR (m, 0.45), WIN (ms, 250)
const fs = require('fs'), V = require('./vision3d.js'), P = require('./phase.js');
const WIN = Number(process.env.WIN || 250), NEAR = Number(process.env.NEAR || 0.45);
const TARGETS = { centroid: null, palm: [0, 5, 9, 13, 17], mcp: [5, 9, 13, 17], tips: [4, 8, 12, 16, 20], wrist: [0], index_tip: [8] };
function load(base) {
  const J = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), cam = J.camera || {}, lean = (J.screen_angle_deg ?? 95) - 90, r = lean * Math.PI / 180, C = [0, 0.19 * Math.cos(r), 0.10 + 0.19 * Math.sin(r)];
  const L = fs.readFileSync(base + (process.env.VSUFFIX || '_vision') + '.csv', 'utf8').trim().split('\n').map((l) => l.replace(/\r$/, '')), h = L[0].split(','), ix = Object.fromEntries(h.map((k, i) => [k, i]));
  const W = cam.width || 1280, H = cam.height || 720, opt = { W, H, hfov: 66 };
  const tr = [];
  for (const l of L.slice(1)) {
    const q = l.split(','), n = (k) => Number(q[ix[k]]); if (n('present') !== 1) continue;
    const f = { lm: Array.from({ length: 21 }, (_, j) => [n(`lm${j}_x`), n(`lm${j}_y`), 0]), wlm: Array.from({ length: 21 }, (_, j) => [n(`wlm${j}_x`), n(`wlm${j}_y`), n(`wlm${j}_z`)]) };
    const c = V.handCam(f, opt); if (!c) continue;
    const pts = {};
    for (const [name, ids] of Object.entries(TARGETS)) {
      if (!ids) { pts[name] = V.toLaptop(c, { tilt: lean, C }); continue; }
      const m = [0, 1, 2].map((k) => ids.reduce((s, i) => s + f.wlm[i][k], 0) / ids.length);
      pts[name] = V.toLaptop([c[0] + m[0], c[1] + m[1], c[2] + m[2]], { tilt: lean, C });
    }
    tr.push({ t: n('t_cap'), pts });
  }
  const wav = P.readWav(base + '.wav'), t0 = J.wav.t0, F = J.stereoFreqs || [18000, 19500];
  const st = F.flatMap((f) => [0, 1].map((c) => P.pathSteps(P.baseband(wav.ch[c], wav.rate, f), f, { gate: 1.5 })));
  const rate = st[0].rate, nS = st[0].step.length, cum = st.map((s) => { const q = new Float64Array(nS + 1); for (let k = 0; k < nS; k++) q[k + 1] = q[k] + s.step[k]; return q; });
  const D = (p, tms) => cum[p][Math.max(0, Math.min(nS, Math.round((tms - t0) / 1000 * rate)))];
  const ws = [];
  for (let i = 0, j = 0; i < tr.length; i++) { while (j < tr.length && tr[j].t < tr[i].t + WIN) j++; if (j >= tr.length) break;
    const a = tr[i], b = tr[j]; if (b.t - a.t > WIN + 80) continue;
    const ca = a.pts.centroid, cb = b.pts.centroid;
    if (Math.hypot(...ca.map((v, k) => v - C[k])) > NEAR || Math.hypot(...cb.map((v, k) => v - C[k])) > NEAR) continue;
    const dC = cb.map((v, k) => v - ca[k]); if (Math.hypot(...dC) < 0.01 || Math.hypot(...dC) > 0.4) continue;
    const y = {}; for (const name of Object.keys(TARGETS)) y[name] = b.pts[name].map((v, k) => v - a.pts[name][k]);
    ws.push({ x: st.map((_, p) => D(p, b.t) - D(p, a.t)), y });
  }
  return { name: base.split(/[\\/]/).pop().slice(8, 23), ws };
}
function ridge(train, target, lam = 1e-4) {
  const X = train.map((w) => [...w.x, 1]), m = X[0].length;
  const A = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => X.reduce((s, x) => s + x[i] * x[j], 0) + (i === j && i < m - 1 ? lam * X.length : 0)));
  const inv = (M0) => { const k = M0.length, M = M0.map((r, i) => [...r, ...M0.map((_, j) => (i === j ? 1 : 0))]); for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c] || 1e-12; for (let j = 0; j < 2 * k; j++) M[c][j] /= d; for (let r = 0; r < k; r++) if (r !== c) { const q = M[r][c]; for (let j = 0; j < 2 * k; j++) M[r][j] -= q * M[c][j]; } } return M.map((r) => r.slice(k)); };
  const Ai = inv(A), Wt = [0, 1, 2].map((ax) => { const xy = Array.from({ length: m }, (_, i) => X.reduce((s, x, n) => s + x[i] * train[n].y[target][ax], 0)); return Ai.map((r) => r.reduce((s, v, j) => s + v * xy[j], 0)); });
  return (w) => Wt.map((wa) => wa.reduce((s, v, j) => s + v * [...w.x, 1][j], 0));
}
const S = process.argv.slice(2).map(load);
console.log(`${S.length} sittings, ${S.reduce((s, x) => s + x.ws.length, 0)} windows`);
for (const target of Object.keys(TARGETS)) {
  const e = [0, 0, 0], v = [0, 0, 0], c = [0, 0, 0], pp = [0, 0, 0]; let n = 0;
  S.forEach((s, i) => { const pr = ridge(S.filter((_, j) => j !== i).flatMap((x) => x.ws), target); for (const w of s.ws) { const p = pr(w), y = w.y[target]; for (let k = 0; k < 3; k++) { e[k] += (p[k] - y[k]) ** 2; v[k] += y[k] ** 2; c[k] += p[k] * y[k]; pp[k] += p[k] ** 2; } n++; } });
  console.log(`  ${target.padEnd(9)} err ${e.map((x) => (100 * Math.sqrt(x / n)).toFixed(2)).join('/')} cm | corr ${c.map((x, k) => (x / Math.sqrt(v[k] * pp[k] || 1)).toFixed(3)).join('/')} | motion ${v.map((x) => (100 * Math.sqrt(x / n)).toFixed(1)).join('/')} cm`);
}
