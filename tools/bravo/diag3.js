// per-path tracking error on a synth3 session: measured cumulative path change vs truth, per trial (end and peak)
const fs = require('fs'), P = require('./phase.js'), PH = require('./phone.js');
const base = process.argv[2], meta = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), truth = JSON.parse(fs.readFileSync(base + '.truth.json', 'utf8'));
const wav = P.readWav(base + '.wav'), F = [18000, 19500, 20500];
const CF = require('./circfit.js');
const track1 = (bb, f, s) => { const o = { gate: Number(process.env.GATE || 1.5), bwHz: Number(process.env.BW || 0.4) }; if (process.env.FIT) { const d = s === 2 ? PH.pll(bb, o) : bb; return CF.pathStepsFit(d, f, o); } return ((s === 2 && !process.env.NOPLL) || process.env.ALLPLL ? PH.pathStepsPLL : P.pathSteps)(bb, f, o); };
const st = F.map((f, s) => [0, 1].map((c) => track1(P.baseband(wav.ch[c], wav.rate, f), f, s)));
const rate = st[0][0].rate, tr = (ms, j) => truth[Math.min(truth.length - 1, Math.round(ms / 10))][1 + j];
const names = ['L→m0', 'L→m1', 'R→m0', 'R→m1', 'P→m0', 'P→m1'];
const err = names.map(() => ({ end: [], pk: [] }));
for (const t of meta.trials) {
  const a = t.tGo - 200, b = t.tGo + 3000, k0 = Math.floor(a / 1000 * rate), k1 = Math.floor(b / 1000 * rate);
  names.forEach((_, j) => {
    const s = st[Math.floor(j / 2)][j % 2]; let cum = 0, pkM = 0, pkT = 0;
    for (let k = k0; k <= k1; k++) { cum += s.step[k]; const tt = tr(k / rate * 1000, j) - tr(a, j); if (Math.abs(cum) > Math.abs(pkM)) pkM = cum; if (Math.abs(tt) > Math.abs(pkT)) pkT = tt; }
    err[j].end.push(100 * (cum - (tr(b, j) - tr(a, j)))); err[j].pk.push([100 * pkM, 100 * pkT]); (err[j][t.kind === 'cw' || t.kind === 'ccw' ? 'circ' : 'move'] ||= []).push(100 * (cum - (tr(b, j) - tr(a, j))));
  });
}
const rms = (A) => Math.sqrt(A.reduce((s, x) => s + x * x, 0) / A.length);
names.forEach((nm, j) => console.log(`${nm}: end-of-trial error rms circles ${rms(err[j].circ).toFixed(1)} cm, up/down ${rms(err[j].move).toFixed(1)} cm; peak measured/true (first 6) ${err[j].pk.slice(0, 6).map(([m, t]) => m.toFixed(1) + '/' + t.toFixed(1)).join(' ')}`));
