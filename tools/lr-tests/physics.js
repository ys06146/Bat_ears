// What does a sideways swipe look like to two tones (one per speaker) and one mic? Geometry only, no noise.
// Reported v per tone = -(d path / dt) / 2, averaged over the 170 ms FFT window (8192 @ 48 kHz), echo-power weighted.
const win = 0.17, dt = 0.005;
function swipe({ spkX = 0.12, spkY = 0.05, micZ = 0.2, handY = 0.3, handZ = 0.1, x0 = -0.25, x1 = 0.25, dur = 0.45 }) {
  const S = { L: [-spkX, spkY, 0], R: [spkX, spkY, 0] }, M = [0, -0.03, micZ];
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const pos = (t) => { const s = Math.min(1, Math.max(0, t / dur)); return [x0 + (x1 - x0) * (10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5), handY, handZ]; };
  const raw = [];
  for (let t = -0.3; t <= dur + 0.3; t += dt) {
    const h = pos(t), h2 = pos(t + dt), o = {};
    for (const k of ['L', 'R']) {
      const P = d(h, S[k]) + d(h, M), P2 = d(h2, S[k]) + d(h2, M);
      o[k] = { v: -(P2 - P) / dt / 2, e: 1 / (d(h, S[k]) * d(h, M)) ** 2, moving: t > 0 && t < dur };
    }
    raw.push({ t, ...o });
  }
  // FFT window: echo energy only counts while moving (static hand -> carrier bin, not sidebands)
  const out = raw.map((r) => {
    const o = { t: r.t };
    for (const k of ['L', 'R']) {
      let num = 0, den = 0;
      for (const q of raw) if (Math.abs(q.t - r.t) < win / 2 && q[k].moving) {
        const w = 0.5 * (1 + Math.cos(2 * Math.PI * (q.t - r.t) / win)) * q[k].e * Math.min(1, Math.abs(q[k].v) * 5);
        num += w * q[k].v; den += w;
      }
      o['v' + k] = den ? num / den : 0; o['e' + k] = den;
    }
    return o;
  });
  const pk = (f) => out.reduce((m, o) => (Math.abs(f(o)) > Math.abs(m) ? f(o) : m), 0);
  const act = out.filter((o) => o.eL + o.eR > 0.05 * Math.max(...out.map((q) => q.eL + q.eR)));
  const bal = act.map((o) => 10 * Math.log10(o.eL / o.eR));
  const flip = (k) => { const i = out.findIndex((o, j) => j && out[j - 1]['v' + k] > 0 && o['v' + k] <= 0 && o.t > 0); return i > 0 ? out[i].t : NaN; };
  const vmax = 1.875 * Math.abs(x1 - x0) / dur;
  return { vmax, latPk: pk((o) => (o.vR - o.vL) / 2), depPk: pk((o) => (o.vR + o.vL) / 2), balStart: bal[0], balEnd: bal[bal.length - 1], flipLminusR: (flip('L') - flip('R')) * 1000 };
}
const show = (name, r) => console.log(`${name.padEnd(46)} hand ${r.vmax.toFixed(2)} m/s | lat pk ${r.latPk.toFixed(2)}  dep pk ${r.depPk.toFixed(2)}  lat/hand ${(Math.abs(r.latPk) / r.vmax).toFixed(2)} | L-R balance ${r.balStart.toFixed(1)} -> ${r.balEnd.toFixed(1)} dB | flip L-R ${r.flipLminusR.toFixed(0)} ms`);
show('30 cm away, 10 cm up, speakers 24 cm apart', swipe({}));
show('15 cm away, 10 cm up', swipe({ handY: 0.15 }));
show('over the keyboard (y 5 cm), 12 cm up', swipe({ handY: 0.05, handZ: 0.12 }));
show('30 cm away, speakers 8 cm apart (bottom/center)', swipe({ spkX: 0.04 }));
show('30 cm away, mono downmix (both tones both spk)', swipe({ spkX: 0.0 }));
show('15 cm, LEFT swipe', swipe({ handY: 0.15, x0: 0.25, x1: -0.25 }));
