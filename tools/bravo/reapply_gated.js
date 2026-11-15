// Re-applies the gated-engine changes onto the repo's current web/bat3d.js (any language version), writes gated/bat3d.js.
//   node reapply_gated.js [repo bat3d.js]   then: node embed_gated.js out/gated_h8_card.json && node gated_check.js <base>
const fs = require('fs');
const src = process.argv[2] || require('path').join(__dirname, '../../web/bat3d.js');
let s = fs.readFileSync(src, 'utf8'); const CR = String.fromCharCode(13), LF = String.fromCharCode(10), crlf = s.includes(CR + LF); s = s.split(CR + LF).join(LF);
const rep = (a, b) => { const n = s.split(a).length - 1; if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${a.slice(0, 80)}`); s = s.replace(a, () => b); };
rep(" *   Node / tests: Bat3D.create(...).feed(workletMessage) runs the same per-batch code without audio.",
` *   opts.model: 'gated' (default, bravo 11:45: the linear map's gains set every 10 ms by a small
 *     net from the last 0.5 s of path change and gate activity; webcam-trained on teach + hologram compare sittings;
 *     falls back to 'learned' when the calibration carries no gated model) | 'learned' (v15 linear map) | 'physics'. info().model says which runs.
 *   Node / tests: Bat3D.create(...).feed(workletMessage) runs the same per-batch code without audio.`);
rep("const o = { geom: 'galaxy', paths: 'avg', model: 'learned', useDefault: true,", "const o = { geom: 'galaxy', paths: 'avg', model: 'gated', useDefault: true,");
rep("      const L = cal && cfg.model === 'learned' ? (phone ? cal.learned.all : cal.learned.laptop) : null;",
    "      const L = cal && (cfg.model === 'learned' || cfg.model === 'gated') ? (phone ? cal.learned.all : cal.learned.laptop) : null;   // 'gated' falls back to this");
rep("      solver = { G, T, K, sv, gain, phone, cal: !!cal, learned: !!L, err: errA || (errKey ? cal.errors[errKey] : null), errName: errKey, solve, calName: cal ? cal.session : null, amp: L ? ampMode || 'mse' : null };",
`      // context-gated map (bravo 11:45, model 'gated'): every 10 ms dPos = k .* G(ctx) . dD, G = W0 + Sg * net(ctx), ctx from the
      // last 0.5 s of path change and gate activity; laptop only. Falls back to the linear map when the calibration has none.
      const GM = cal && !phone && o.model === 'gated' && cal.gated && cal.gated.kind === 'gated-v1' ? cal.gated : null;
      const gAmpMode = GM && GM.amp && GM.amp.modes[o.amp || 'half'] ? (o.amp || 'half') : null, gK = gAmpMode ? GM.amp.modes[gAmpMode].k : [1, 1, 1];
      const errG = GM && gAmpMode ? { rms: GM.amp.modes[gAmpMode].rms, motion: GM.amp.motion, corr: GM.amp.corr, size: GM.amp.modes[gAmpMode].size, amp: gAmpMode } : null;
      solver = { G, T, K, sv, gain, phone, cal: !!cal, learned: !!L || !!GM, err: errG || errA || (errKey ? cal.errors[errKey] : null), errName: errKey, solve, calName: cal ? cal.session : null, amp: GM ? gAmpMode || 'mse' : L ? ampMode || 'mse' : null, gated: GM, gK, model: GM ? 'gated' : L ? 'learned' : 'physics' };`);
rep(`    let sub10 = 0, lastCircle = null, circleEnd = -1e9, offset = [0, 0, 0];
    function resetLive() {
      const S = 2 * solver.T;
      Object.assign(live, { D: new Array(S).fill(0), q: new Array(S).fill(0), act: new Array(S).fill(0), amp: new Array(S).fill(0), off: [], still: 0, lastAct: [] });
    }
    function originReset() { live.D = live.D.map(() => 0); offset = [0, 0, 0]; kfReset(); trail.length = 0; circleEnd = live.t; }`,
`    let sub10 = 0, lastCircle = null, circleEnd = -1e9, offset = [0, 0, 0];
    // gated model state: integrated position P (m, relative to H0), per-path gated-step counts, 10 ms snapshots (51 = 0.5 s)
    const gs = { P: [0, 0, 0], A: [0, 0, 0, 0], hD: [], hA: [] };
    function gReset() { gs.P = [0, 0, 0]; gs.hD = []; gs.hA = []; }
    function gTick() {   // one 10 ms tick of the gated map; returns H0 + P
      const M = solver.gated, D = live.D.slice(0, 4), Ac = gs.A.slice();
      gs.hD.push(D); gs.hA.push(Ac); if (gs.hD.length > 51) { gs.hD.shift(); gs.hA.shift(); }
      const n = gs.hD.length, at = (h, back) => h[Math.max(0, n - 1 - back)];
      const prev = at(gs.hD, 1), d25 = at(gs.hD, 25), d50 = at(gs.hD, 50), a25 = at(gs.hA, 25);
      const dD = D.map((v, p) => v - prev[p]);
      const c = [...D.map((v, p) => v - d25[p]), ...d25.map((v, p) => v - d50[p]), ...Ac.map((v, p) => (v - a25[p]) / 250)].map((v, i) => (v - M.mu[i]) / M.sd[i]);
      const hh = []; for (let h = 0; h < M.H; h++) { let q = M.b1[h]; for (let i = 0; i < 12; i++) q += M.W1[h * 12 + i] * c[i]; hh.push(Math.tanh(q)); }
      for (let a = 0; a < 3; a++) { let q = 0; for (let p = 0; p < 4; p++) { let g = M.b2[a * 4 + p]; for (let h = 0; h < M.H; h++) g += M.W2[(a * 4 + p) * M.H + h] * hh[h]; q += (M.W0[a][p] + M.Sg * g) * dD[p]; } gs.P[a] += solver.gK[a] * q; }
      return H0.map((h, i) => h + gs.P[i]);
    }
    function resetLive() {
      const S = 2 * solver.T;
      Object.assign(live, { D: new Array(S).fill(0), q: new Array(S).fill(0), act: new Array(S).fill(0), amp: new Array(S).fill(0), off: [], still: 0, lastAct: [] });
      gs.A = new Array(S).fill(0); gReset();
    }
    function originReset() { live.D = live.D.map(() => 0); offset = [0, 0, 0]; kfReset(); trail.length = 0; circleEnd = live.t; gReset(); }`);
rep("        for (let i = 0; i < S; i++) { const s = m.steps[i][k]; live.D[i] += s; a += Math.abs(s); }",
    "        for (let i = 0; i < S; i++) { const s = m.steps[i][k]; live.D[i] += s; a += Math.abs(s); if (s !== 0) gs.A[i]++; }");
rep("        const z = solver.solve(live.D).map((v, i) => v + offset[i]); kfStep(z, 0.01);",
    "        const z = (solver.gated ? gTick() : solver.solve(live.D)).map((v, i) => v + offset[i]); kfStep(z, 0.01);");
rep("            offset = z.map((v, i) => v - H0[i]); live.D = live.D.map(() => 0); kf.v = [0, 0, 0];",
    "            offset = z.map((v, i) => v - H0[i]); live.D = live.D.map(() => 0); kf.v = [0, 0, 0]; gReset();");
rep("          } else { live.D = live.D.map(() => 0); offset = [0, 0, 0]; kfReset(); trail.length = 0; }",
    "          } else { live.D = live.D.map(() => 0); offset = [0, 0, 0]; kfReset(); trail.length = 0; gReset(); }");
rep("      info: () => ({ freqs: cfg.freqs.slice(), pll: cfg.pll.slice(), T: solver.T, amp: solver.amp,",
    "      info: () => ({ freqs: cfg.freqs.slice(), pll: cfg.pll.slice(), T: solver.T, amp: solver.amp, model: solver.model,");
fs.mkdirSync(__dirname + '/gated', { recursive: true });
fs.writeFileSync(__dirname + '/gated/bat3d.js', crlf ? s.split(LF).join(CR + LF) : s);
console.log('gated/bat3d.js written from ' + src);
