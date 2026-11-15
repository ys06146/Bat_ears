// do the two mic channels agree on the hand's path change? binned (50 ms) path changes ch0 vs ch1 per tone, circle windows
const fs = require('fs'), P = require('./phase.js');
const name = process.argv[2], D = (process.env.DATA || require('path').join(__dirname, '../../ml/data')) + '/batears_';
const meta = JSON.parse(fs.readFileSync(D + name + '.json', 'utf8')), wav = P.readWav(D + name + '.wav'), F = meta.stereoPair;
for (const [ti, f] of F.entries()) {
  const tr = [0, 1].map((c) => P.pathSteps(P.baseband(wav.ch[c], wav.rate, f), f, { gate: Number(process.env.GATE || 1.5) }));
  const rate = tr[0].rate, kOf = (t) => Math.floor((t - meta.wav.t0) / 1000 * rate);
  for (const bin of [50, 200]) {
    const a = [], b = [], q = [[], []];
    for (const t of meta.trials.filter((x) => x.kind === 'cw' || x.kind === 'ccw')) {
      for (let k = kOf(t.tGo); k + bin <= kOf(t.tGo + 3000); k += bin) {
        let s0 = 0, s1 = 0; for (let j = k; j < k + bin; j++) { s0 += tr[0].step[j]; s1 += tr[1].step[j]; } a.push(s0); b.push(s1);
      }
      for (const c of [0, 1]) { let m = 0, n = 0, act = 0; for (let k = kOf(t.tGo); k < kOf(t.tGo + 3000); k++) { m += tr[c].mag[k] / tr[c].noise[k]; act += tr[c].step[k] !== 0; n++; } q[c].push([m / n, act / n]); }
    }
    const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
    let ab = 0, aa = 0, bb = 0; a.forEach((x, i) => { ab += (x - ma) * (b[i] - mb); aa += (x - ma) ** 2; bb += (b[i] - mb) ** 2; });
    const qq = (c) => `|dyn|/noise ${(q[c].reduce((s, x) => s + x[0], 0) / q[c].length).toFixed(2)} active ${(100 * q[c].reduce((s, x) => s + x[1], 0) / q[c].length).toFixed(0)}%`;
    console.log(`${f} Hz (${ti ? 'R' : 'L'} speaker) ${bin} ms bins: ch0-ch1 correlation ${(ab / Math.sqrt(aa * bb)).toFixed(2)}, rms ch0 ${(100 * Math.sqrt(aa / a.length)).toFixed(2)} ch1 ${(100 * Math.sqrt(bb / b.length)).toFixed(2)} cm | ch0 ${qq(0)} | ch1 ${qq(1)}`);
  }
}
