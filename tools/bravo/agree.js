// Do the acoustic paths follow the webcam hand at all? For windows with the hand near the laptop, correlate each
// measured path change (tone x mic) with the change predicted from the vision track (default geometry, both L/R
// hypotheses), over a range of audio lags. Also the size ratio measured / predicted.
//   node agree.js <teach base>   env: NEAR (max camera distance m, default 0.45), WIN (ms, 250)
const fs = require('fs'), V = require('./vision3d.js'), P = require('./phase.js');
const base = process.argv[2], J = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), meta = J.meta || J;
const NEAR = Number(process.env.NEAR || 0.45), WIN = Number(process.env.WIN || 250);
const L = fs.readFileSync(base + '_vision.csv', 'utf8').trim().split(/\r?\n/), h = L[0].split(','), ix = Object.fromEntries(h.map((k, i) => [k, i]));
const fr = L.slice(1).map((l) => { const r = l.split(','), n = (k) => Number(r[ix[k]]); return { t: n('t_cap'), present: n('present') === 1, lm: Array.from({ length: 21 }, (_, j) => [n(`lm${j}_x`), n(`lm${j}_y`), 0]), wlm: Array.from({ length: 21 }, (_, j) => [n(`wlm${j}_x`), n(`wlm${j}_y`), n(`wlm${j}_z`)]) }; }).filter((f) => f.present);
const cam = meta.camera || {}, lean = ((meta.screen_angle_deg ?? 95) - 90), r = lean * Math.PI / 180, C = [0, 0.19 * Math.cos(r), 0.10 + 0.19 * Math.sin(r)];
const tr = fr.map((f) => { const c = V.handCam(f, { W: cam.width || 1280, H: cam.height || 720, hfov: 70 }); return c ? { t: f.t, d: c[2], H: V.toLaptop(c, { tilt: lean, C }) } : null; }).filter(Boolean);
const wav = P.readWav(base + '.wav'), t0 = meta.wav.t0, F = meta.stereoFreqs || [18000, 19500];
const st = F.map((f) => [0, 1].map((c) => P.pathSteps(P.baseband(wav.ch[c], wav.rate, f), f, { gate: 1.5 })));
const rate = st[0][0].rate, n = st[0][0].step.length;
const cum = st.map((a) => a.map((s) => { const q = new Float64Array(n + 1); for (let k = 0; k < n; k++) q[k + 1] = q[k] + s.step[k]; return q; }));
const D = (ti, c, tms) => cum[ti][c][Math.max(0, Math.min(n, Math.round((tms - t0) / 1000 * rate)))];
const M = [[0.025, C[1], C[2]], [-0.025, C[1], C[2]]], SPK = { L: [-0.15, -0.01, -0.08], R: [0.15, -0.01, -0.08] };
const sub = (a, b) => a.map((v, i) => v - b[i]), nrm = (a) => Math.hypot(...a), path = (H, S, m) => nrm(sub(H, S)) + nrm(sub(H, m));
// windows
const ws = [];
for (let i = 0, j = 0; i < tr.length; i++) { while (j < tr.length && tr[j].t < tr[i].t + WIN) j++; if (j >= tr.length) break;
  const a = tr[i], b = tr[j]; if (b.t - a.t > WIN + 80 || a.d > NEAR || b.d > NEAR) continue; const dh = nrm(sub(b.H, a.H)); if (dh < 0.01 || dh > 0.4) continue; ws.push({ a, b }); }
console.log(`${ws.length} windows with the hand within ${NEAR * 100} cm of the webcam (of ${tr.length} frames)`);
const corr = (x, y) => { const mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length; let sxy = 0, sxx = 0, syy = 0; x.forEach((v, i) => { sxy += (v - mx) * (y[i] - my); sxx += (v - mx) ** 2; syy += (y[i] - my) ** 2; }); return sxy / Math.sqrt(sxx * syy || 1); };
for (const swap of [false, true]) {
  const S = [swap ? SPK.R : SPK.L, swap ? SPK.L : SPK.R];
  const rows = [];
  for (const lag of [-400, -300, -200, -100, -50, 0, 50, 100, 200, 300, 400]) {
    const out = [];
    for (let ti = 0; ti < 2; ti++) for (let c = 0; c < 2; c++) {
      const meas = ws.map((w) => D(ti, c, w.b.t + lag) - D(ti, c, w.a.t + lag)), pred = ws.map((w) => path(w.b.H, S[ti], M[c]) - path(w.a.H, S[ti], M[c]));
      const ratio = Math.sqrt(meas.reduce((s, v) => s + v * v, 0) / Math.max(1e-12, pred.reduce((s, v) => s + v * v, 0)));
      out.push({ r: corr(meas, pred), ratio });
    }
    rows.push({ lag, out, mean: out.reduce((s, o) => s + o.r, 0) / 4 });
  }
  const best = rows.slice().sort((a, b) => b.mean - a.mean)[0];
  console.log(`speakers ${swap ? 'SWAPPED (18k right)' : 'as labelled (18k left)'}: corr by lag ${rows.map((r) => `${r.lag}:${r.mean.toFixed(2)}`).join(' ')}`);
  console.log(`   best lag ${best.lag} ms: per path corr ${best.out.map((o) => o.r.toFixed(2)).join(' / ')}, size measured/predicted ${best.out.map((o) => o.ratio.toFixed(2)).join(' / ')}`);
}
