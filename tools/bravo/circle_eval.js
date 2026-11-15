// Circle direction + 2D track on a real _circle session (alpha 1ab0a75: cw / ccw x10, push/pull 3+3, WAV, trial.tGo).
//   node circle_eval.js <session base path without extension, or the name after batears_>
// Per trial: cumulative u = (dR - dL)/2 (sideways) and w = -(dL + dR)/2 (path shortening) from the phase tracker over
// [tGo - 200 ms, tGo + window], window 3000 ms for circles (1800 for push/pull). Direction = sign of the signed area
// of the (u, w) path. Physics prior (sim2d.js, flat circle over the keyboard, mic near the hinge): clockwise seen from
// above (screen side -> right -> me -> left) gives area > 0. The fair number is LOO: the sign is learned from the
// other trials (the mapping flips if the hand sits behind the mic / speakers, so a session calibrates it).
const fs = require('fs');
const P = require('./phase.js');
const D = (process.env.DATA || require('path').join(__dirname, '../../ml/data')) + '/', BK = (process.env.WAV_BACKUP || '') + '/';
let base = process.argv[2];
if (!fs.existsSync(base + '.json')) base = [D, BK].map((d) => d + 'batears_' + process.argv[2]).find((p) => fs.existsSync(p + '.json') || fs.existsSync(p + '.wav'));
const metaP = [base + '.json', D + base.split('/').pop() + '.json'].find((p) => fs.existsSync(p));
const meta = JSON.parse(fs.readFileSync(metaP, 'utf8'));
const wavP = [base + '.wav', D + base.split('/').pop() + '.wav', BK + base.split('/').pop() + '.wav'].find((p) => fs.existsSync(p));
if (!wavP) { console.log('no WAV for ' + base); process.exit(1); }
const wav = P.readWav(wavP), freqs = meta.stereoPair || meta.engine.stereoFreqs, gate = Number(process.env.GATE || 1.5);
// mic channels: are they distinct? (MacBooks: bit-identical)
let same = 0; if (wav.C > 1) for (let i = 0; i < wav.frames; i += 7) if (wav.ch[0][i] === wav.ch[1][i]) same++;
console.log(`${base.split('/').pop()}: ${wav.C} ch ${wav.C > 1 ? `(identical samples ${(100 * same / Math.ceil(wav.frames / 7)).toFixed(0)}%)` : ''}, ${(wav.frames / wav.rate).toFixed(0)} s, tones ${freqs}, gate ${gate}`);
const chans = process.env.CHN ? process.env.CHN.split('').map(Number) : wav.C > 1 && same / Math.ceil(wav.frames / 7) < 0.99 ? [0, 1] : [0];
const tr = P.track({ ...wav, ch: chans.map((c) => wav.ch[c]), C: chans.length }, freqs, meta.wav.t0, { gate });
const kOf = (t) => Math.floor((t - tr.t0) / 1000 * tr.rate);
const isC = (k) => k === 'cw' || k === 'ccw';
const rows = meta.trials.filter((t) => Number.isFinite(t.tGo)).map((t) => {
  const a = t.tGo - 200, b = t.tGo + (isC(t.kind) ? 3000 : 1800);
  let u = 0, w = 0, area = 0, pu = 0, pw = 0; const U = [], W = []; let sn = 0, nn = 0;
  for (let k = Math.max(1, kOf(a)); k <= Math.min(tr.L[0].step.length - 1, kOf(b)); k++) {
    let sL = 0, sR = 0; for (let c = 0; c < chans.length; c++) { sL += tr.L[c].step[k] / chans.length; sR += tr.R[c].step[k] / chans.length; }
    u += (sR - sL) / 2; w += -(sR + sL) / 2; area += (pu * w - u * pw) / 2; pu = u; pw = w; U.push(u); W.push(w);
    sn += Math.min(tr.L[0].mag[k] / tr.L[0].noise[k], tr.R[0].mag[k] / tr.R[0].noise[k]); nn++;
  }
  const rg = (A) => (A.length ? Math.max(...A) - Math.min(...A) : 0);
  return { kind: t.kind, area: area * 1e4, ru: 100 * rg(U), rw: 100 * rg(W), U, W, snr: sn / Math.max(1, nn) };
});
const med = (A) => { const x = A.slice().sort((p, q) => p - q); return x.length ? x[x.length >> 1] : NaN; };
for (const k of ['cw', 'ccw', 'push', 'pull']) {
  const x = rows.filter((r) => r.kind === k); if (!x.length) continue;
  console.log(`${k.padEnd(4)} n${x.length}  area cm² [${x.map((r) => r.area.toFixed(0)).join(' ')}]  range u ${med(x.map((r) => r.ru)).toFixed(1)} w ${med(x.map((r) => r.rw)).toFixed(1)} cm  |dyn|/noise ${med(x.map((r) => r.snr)).toFixed(1)}`);
}
const C = rows.filter((r) => isC(r.kind));
const tally = (decide) => { const r = { ok: 0, ab: 0, bad: 0 }; C.forEach((x, i) => { const d = decide(x, i); if (!d) r.ab++; else if (d === x.kind) r.ok++; else r.bad++; }); return `${r.ok}/${r.ab}/${r.bad} (${Math.round(100 * r.ok / C.length)}%)`; };
const abst = (x, others) => Math.abs(x.area) < 0.15 * med(others.map((o) => Math.abs(o.area)));
console.log('direction right/abstain/wrong over ' + C.length + ' circles:');
console.log('  physics prior (cw = area > 0)       ' + tally((x) => (abst(x, C) ? null : x.area > 0 ? 'cw' : 'ccw')));
console.log('  LOO (sign learned from the others)  ' + tally((x, i) => { const o = C.filter((_, j) => j !== i), s = Math.sign(med(o.filter((y) => y.kind === 'cw').map((y) => y.area)) - med(o.filter((y) => y.kind === 'ccw').map((y) => y.area))) || 1;
  return abst(x, o) ? null : Math.sign(x.area) === s ? 'cw' : 'ccw'; }));
// circle vs push/pull: |area| above the abstain threshold
const pp = rows.filter((r) => !isC(r.kind));
if (pp.length) console.log(`push/pull with a circle-sized |area| (≥ 30% of the circles' median): ${pp.filter((r) => Math.abs(r.area) >= 0.3 * med(C.map((c) => Math.abs(c.area)))).length}/${pp.length}`);
// repeatability of the 2D shape: 32-point resampled (u, w), correlation within cw, within ccw, and cw vs ccw
const rs = (A, m = 32) => Array.from({ length: m }, (_, i) => (A.length ? A[Math.round(i * (A.length - 1) / (m - 1))] - A[0] : 0));
const vec = (r) => [...rs(r.U), ...rs(r.W)];
const corr = (a, b) => { const ma = a.reduce((x, y) => x + y) / a.length, mb = b.reduce((x, y) => x + y) / b.length; let ab = 0, aa = 0, bb = 0; a.forEach((x, i) => { ab += (x - ma) * (b[i] - mb); aa += (x - ma) ** 2; bb += (b[i] - mb) ** 2; }); return ab / Math.sqrt(aa * bb || 1); };
const pair = (A, B, same) => { const c = []; A.forEach((x, i) => B.forEach((y, j) => { if (!same || i < j) c.push(corr(vec(x), vec(y))); })); return med(c); };
const cw = C.filter((r) => r.kind === 'cw'), ccw = C.filter((r) => r.kind === 'ccw');
if (cw.length > 1 && ccw.length > 1) console.log(`shape correlation median: cw-cw ${pair(cw, cw, true).toFixed(2)}  ccw-ccw ${pair(ccw, ccw, true).toFixed(2)}  cw-ccw ${pair(cw, ccw, false).toFixed(2)}`);

// ---- winding (circle.js) and shape-template direction, per trial
const BC = require('../../web/circle.js');
const tOf = (r) => r.U.map((_, i) => i);   // 1 kHz samples -> ms
const wind = rows.map((r) => ({ kind: r.kind, ...BC.analyze(tOf(r), r.U, r.W) }));
const fmtT = (k) => wind.filter((x) => x.kind === k).map((x) => x.turns.toFixed(1)).join(' ');
console.log(`winding turns  cw [${fmtT('cw')}]  ccw [${fmtT('ccw')}]  push [${fmtT('push')}]  pull [${fmtT('pull')}]`);
const WC = wind.filter((x) => isC(x.kind));
for (const s of [1, -1]) console.log(`  winding sign ${s > 0 ? '+' : '-'} = cw: right ${WC.filter((x) => (Math.sign(x.turns) * s > 0 ? 'cw' : 'ccw') === x.kind).length}/${WC.length}` +
  `, with |turns| >= 1.1: right ${WC.filter((x) => Math.abs(x.turns) >= 1.1 && (Math.sign(x.turns) * s > 0 ? 'cw' : 'ccw') === x.kind).length} wrong ${WC.filter((x) => Math.abs(x.turns) >= 1.1 && (Math.sign(x.turns) * s > 0 ? 'cw' : 'ccw') !== x.kind).length}`);
console.log(`  winding LOO (sign from the others): ${WC.filter((x, i) => { const o = WC.filter((_, j) => j !== i), s = Math.sign(o.filter((y) => y.kind === 'cw').reduce((a, y) => a + y.turns, 0) - o.filter((y) => y.kind === 'ccw').reduce((a, y) => a + y.turns, 0)) || 1; return (Math.sign(x.turns) * s > 0 ? 'cw' : 'ccw') === x.kind; }).length}/${WC.length}`);
// shape template: LOO nearest of the mean cw / mean ccw 64-d shape (correlation); push/pull scored against both
const mvec = (A) => { const v = A.map(vec), m = v[0].map((_, i) => v.reduce((s, x) => s + x[i], 0) / v.length); return m; };
let tOk = 0; C.forEach((x, i) => { const o = C.filter((_, j) => j !== i), a = corr(vec(x), mvec(o.filter((y) => y.kind === 'cw'))), b = corr(vec(x), mvec(o.filter((y) => y.kind === 'ccw'))); if ((a > b ? 'cw' : 'ccw') === x.kind) tOk++; });
const mcw = mvec(cw), mccw = mvec(ccw);
console.log(`  shape template LOO: right ${tOk}/${C.length};  push/pull best |corr| with a circle template: ${pp.map((r) => Math.max(corr(vec(r), mcw), corr(vec(r), mccw)).toFixed(2)).join(' ')}`);
if (process.env.TRACE) for (const r of rows) console.log(`  ${r.kind.padEnd(4)} u ${rs(r.U, 8).map((v) => (100 * v).toFixed(0).padStart(4)).join('')}   w ${rs(r.W, 8).map((v) => (100 * v).toFixed(0).padStart(4)).join('')}`);
