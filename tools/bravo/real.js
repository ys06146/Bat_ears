// Replay a stereo session CSV through a port of dsp.js stereoBurst segmentation and collect.js per-trial burst choice,
// then dump per-trial features (swipe.js + extra candidates) for left/right vs push/pull analysis.
//   node real.js <session base path without extension> [--dump]
const fs = require('fs');
const S = require('../../web/swipe.js');

function loadSession(base) {
  const lines = fs.readFileSync(base + '.csv', 'utf8').trim().split(/\r?\n/), head = lines[0].split(',');
  const ix = Object.fromEntries(head.map((h, i) => [h, i]));
  const meta = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
  const frames = [];
  for (const l of lines.slice(1)) {
    const r = l.split(',');
    if (r[ix.vL] === '' || r[ix.vL] === undefined) continue;
    const n = (k) => Number(r[ix[k]]);
    frames.push({ t: n('t_ms'), cue: r[ix.cue], label: r[ix.label], snr: n('snr_db'), vL: n('vL'), vR: n('vR'),
      dUpL: n('dUpL'), dDownL: n('dDownL'), dUpR: n('dUpR'), dDownR: n('dDownR') });
  }
  return { frames, meta };
}

// dsp.js stereoBurst (segmentation only): active = any sideband of either tone > aOn; end after gapMs quiet or maxMs
function segment(frames, B = { aOn: 12, gapMs: 120, maxMs: 900, lockMs: 150 }, minSnr = 0) {
  const out = []; let ev = null, lock = -1e9;
  const rL = new S.RestSpeed(), rR = new S.RestSpeed();
  for (const f of frames) {
    rL.push(f.t, f.vL, Math.max(f.dUpL, f.dDownL)); rR.push(f.t, f.vR, Math.max(f.dUpR, f.dDownR));
    if (!(f.snr >= minSnr)) continue;
    const active = Math.max(f.dUpL, f.dDownL, f.dUpR, f.dDownR) > B.aOn;
    if (!ev) { if (!active || f.t < lock) continue; ev = { start: f.t, last: f.t, fr: [] }; }
    if (active) ev.last = f.t;
    ev.fr.push({ t: f.t, vL: f.vL, vR: f.vR, eL: S.excessDb(f.dUpL, f.dDownL), eR: S.excessDb(f.dUpR, f.dDownR), v0L: rL.value, v0R: rR.value,
      dUpL: f.dUpL, dDownL: f.dDownL, dUpR: f.dUpR, dDownR: f.dDownR });
    const capped = f.t - ev.start > B.maxMs;
    if (f.t - ev.last > B.gapMs || capped) { ev.end = f.t; ev.capped = capped; out.push(ev); ev = null; lock = f.t + B.lockMs; }
  }
  return out;
}

// collect.js: per trial keep the burst with most frames that ends after GO and starts before GO + 1800 ms
function trialsOf({ frames, meta }, bursts) {
  const cues = frames.filter((f) => f.cue).map((f) => f.t);
  return meta.trials.map((tr) => {
    const t0 = cues.find((c) => c >= tr.tStart - 50 && c <= tr.tEnd) ?? tr.tStart;
    let best = null;
    for (const b of bursts) if (b.end >= t0 && b.start <= t0 + 1800 && (!best || b.fr.length > best.fr.length)) best = b;
    return { kind: tr.kind, got: tr.got, live: tr.swipe || null, t0, burst: best };
  });
}

// extra candidate features on one burst's frames
function extra(fr) {
  const f = S.featuresOf(fr);
  if (!f) return null;
  let idep = 0, dPos = 0, dNeg = 0, aLat = 0, aDep = 0, wl = 0, wr = 0, tl = 0, tr = 0, iL = 0, iR = 0;
  const t0 = fr[0].t;
  for (let i = 0; i < fr.length; i++) {
    const dt = i ? Math.min(0.1, (fr[i].t - fr[i - 1].t) / 1000) : 0;
    const lat = (fr[i].vR - fr[i].vL) / 2, dep = (fr[i].vR + fr[i].vL) / 2;
    idep += dep * dt; aLat += Math.abs(lat) * dt; aDep += Math.abs(dep) * dt;
    if (dep > 0) dPos += dep * dt; else dNeg -= dep * dt;
    iL += fr[i].vL * dt; iR += fr[i].vR * dt;
    // energy-weighted time centroid of each tone's echo (linear power above the floor)
    const el = Math.pow(10, Math.min(60, fr[i].eL) / 10), er = Math.pow(10, Math.min(60, fr[i].eR) / 10);
    const tt = (fr[i].t - t0) / 1000;
    wl += el; tl += el * tt; wr += er; tr += er * tt;
  }
  return { ...f, idep, dPos, dNeg, bip: Math.min(dPos, dNeg) / Math.max(1e-6, Math.max(dPos, dNeg)),
    aLat, aDep, latFrac: aLat / Math.max(1e-6, aLat + aDep), tLR: (tr / wr - tl / wl) * 1000, iL, iR };
}

module.exports = { loadSession, segment, trialsOf, extra };

if (require.main === module) {
  const base = process.argv[2];
  const sess = loadSession(base);
  const bursts = segment(sess.frames, sess.meta.burst || undefined);
  const trials = trialsOf(sess, bursts);
  console.log(`${sess.meta.session}: ${sess.frames.length} frames, ${bursts.length} bursts, ${trials.length} trials`);
  const keys = ['ilat', 'balDelta', 'idep', 'dPos', 'dNeg', 'bip', 'latFrac', 'tLR', 'depPk', 'latPk', 'ms'];
  console.log('kind  got    ' + keys.map((k) => k.padStart(8)).join('') + '   live ilat/ms');
  for (const t of trials) {
    const x = t.burst ? extra(t.burst.fr) : null;
    t.x = x;
    if (process.argv.includes('--dump')) console.log(`${t.kind.padEnd(5)} ${String(t.got).padEnd(5)} ` + (x ? keys.map((k) => x[k].toFixed(k === 'ms' || k === 'tLR' ? 0 : 3).padStart(8)).join('') : '   (no burst)') +
      (t.live ? `   ${t.live.ilat.toFixed(3)}/${t.live.ms.toFixed(0)}` : ''));
  }
}
