// within-session (time split) and cross-session scores for the phase / fft cue sets, WAV from ml/data or alpha's backup
//   node xsess.js <session> <session> ...      (session = name after batears_20261114_)
const fs = require('fs');
const R = require('./real.js'), S = require('../../web/swipe.js'), P = require('./phase.js'), E = require('./ldaeval.js');
const D = (process.env.DATA || require('path').join(__dirname, '../../ml/data')) + '/batears_20261114_', BK = (process.env.WAV_BACKUP || '') + '/batears_20261114_';
function load(n) {
  const s = R.loadSession(D + n), wp = [D + n + '.wav', BK + n + '.wav'].find((p) => fs.existsSync(p));
  let tr = null;
  if (wp) { const w = P.readWav(wp); tr = P.track({ ...w, ch: [w.ch[0]], C: 1 }, s.meta.stereoPair, s.meta.wav ? s.meta.wav.t0 : 0, { gate: 1.5 }); }
  const trials = R.trialsOf(s, R.segment(s.frames, s.meta.burst || undefined)).filter((t) => t.burst).map((t) => {
    const a = t.burst.start - 300, b = t.burst.end ?? t.burst.fr[t.burst.fr.length - 1].t;
    let f = { ...S.featuresOf(t.burst.fr) };
    if (tr) {
      const k0 = Math.max(0, Math.floor((a - tr.t0) / 1000 * tr.rate)), k1 = Math.floor((b - tr.t0) / 1000 * tr.rate);
      let x = 0, y = 0, xp = 0, yp = 0, xmin = 0, xmax = 0, imin = -1, imax = -1;
      for (let k = k0; k <= k1; k++) { const sL = tr.L[0].step[k] || 0, sR = tr.R[0].step[k] || 0; x += (sR - sL) / 2; y += -(sR + sL) / 2;
        if (Math.abs(x) > Math.abs(xp)) xp = x; if (Math.abs(y) > Math.abs(yp)) yp = y; if (x < xmin) { xmin = x; imin = k; } if (x > xmax) { xmax = x; imax = k; } }
      f = { ...f, pPk: xp, pDPk: yp, pStroke: imax > imin ? xmax - xmin : xmin - xmax };
    } else if (t.live && Number.isFinite(t.live.pStroke)) f = { ...f, pPk: t.live.pPk, pDPk: t.live.pDPk, pStroke: t.live.pStroke };
    return { kind: t.kind, feat: f };
  });
  return { n, trials, wav: !!wp };
}
const sess = process.argv.slice(2).map(load);
const SETS = { stroke: ['pStroke', 'pDPk'], fft: S.KEYS, phaseFft: ['pPk', 'idep', 'bip'] };
for (const x of sess) {
  const bc = S.bestCheck(x.trials, { need: 1 });
  console.log(`${x.n.slice(0, 6)} (${x.wav ? 'WAV' : 'no WAV'}): ` + Object.entries(SETS).map(([k, keys]) => `${k} ${E.fmt(E.score(x.trials, keys).sp)}`).join(' | ') + `  || check picks ${bc.keys} ok=${bc.ok} LOO ${bc.looAcc}/${bc.looWrong}/${bc.looUndecided} fp ${bc.fpRate}`);
}
for (const a of sess) for (const b of sess) if (a !== b) {
  const out = Object.entries(SETS).map(([k, keys]) => { const m = E.fit(a.trials, keys), r = { h: 0, w: 0, u: 0, f: 0, n: 0 };
    for (const t of b.trials) { const d = E.decide(m, t.feat); if (E.isSw(t.kind)) { if (d === t.kind) r.h++; else if (d) r.w++; else r.u++; } else { r.n++; if (d) r.f++; } }
    return `${k} ${E.fmt(r)}`; });
  console.log(`cross ${a.n.slice(0, 6)} → ${b.n.slice(0, 6)}: ${out.join(' | ')}`);
}
