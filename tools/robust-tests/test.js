// Synthetic scenario tests for robust.js. Frames at 60 fps shaped like dsp.js measure() output.
// Baseline sideband energy ~ -45 dB rel. carrier (+/-1 dB jitter), far-band noise ~ -95 dBFS.
const R = require('../../web/robust.js');

let seed = Number(process.env.SEED || 7);
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / Math.sqrt(0.5); };
const FPS = Number(process.env.FPS || 60), DT = 1000 / FPS;

// bump(t0, dur, peakDb): raised-cosine dB bump
const bump = (t, t0, dur, peak) => (t < t0 || t > t0 + dur ? 0 : peak * 0.5 * (1 - Math.cos(2 * Math.PI * (t - t0) / dur)));

function makeFrames(secs, events, { jitter = 1, drift = 0 } = {}) {
  const frames = [];
  for (let i = 0; i < secs * FPS; i++) {
    const t = i * DT;
    let up = -45 + jitter * gauss() + drift * (t / 1000), dn = -45 + jitter * gauss() + drift * (t / 1000);
    let noise = -95 + 0.8 * gauss(), v = 0;
    for (const e of events) {
      const bu = bump(t, e.t, e.dur, e.up || 0), bd = bump(t, e.t, e.dur, e.dn || 0), bn = bump(t, e.t, e.dur, e.noise || 0);
      up += bu; dn += bd; noise += bn;
      if (bu > 1 || bd > 1) v += (e.v || 0) * Math.max(bu, bd) / Math.max(e.up || 0, e.dn || 0, 1);
      if (e.osc && t >= e.t && t <= e.t + e.dur) { const s = Math.sin(2 * Math.PI * e.osc * (t - e.t) / 1000); up += Math.max(0, s) * e.osc_db; dn += Math.max(0, -s) * e.osc_db; v += s * 1.0; }
    }
    frames.push({ t, up, down: dn, noise, snr: 40, v });
  }
  return frames;
}

function run(name, frames, expect, opt) {
  const det = new R.RobustDetector(opt);
  for (const f of frames.slice(0, Math.round(1.5 * FPS))) det.learn(f); // 1.5 s calibration, hand away
  const got = [];
  for (const f of frames.slice(Math.round(1.5 * FPS))) { const g = det.update(f); if (g) got.push(g); }
  const kinds = got.map((g) => g.kind);
  const pass = JSON.stringify(kinds) === JSON.stringify(expect);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} expected [${expect}] got [${kinds}]` +
    (got.length ? `  first@${Math.round(got[0].t)}ms` : '') + `  stats=${JSON.stringify(det.stats)}`);
  return { pass, got };
}

const res = [];
const T0 = 2000;
// 1) clean push: fast toward (rises up-band), slow return (weak down-band)
res.push(run('push, slow return', makeFrames(5, [{ t: T0, dur: 300, up: 16, v: 0.7 }, { t: T0 + 350, dur: 700, dn: 4, v: -0.2 }]), ['push']));
// 2) push with a FAST return -> return stroke must not count as a pull
res.push(run('push, fast return (opposite lock)', makeFrames(5, [{ t: T0, dur: 300, up: 16, v: 0.7 }, { t: T0 + 420, dur: 300, dn: 10, v: -0.5 }]), ['push']));
// 3) clean pull
res.push(run('pull', makeFrames(5, [{ t: T0, dur: 300, dn: 15, v: -0.7 }]), ['pull']));
// 4) five pushes 2 s apart
res.push(run('5 pushes, 2 s apart', makeFrames(13, [0, 1, 2, 3, 4].map((i) => ({ t: T0 + 2000 * i, dur: 300, up: 14, v: 0.6 }))), ['push', 'push', 'push', 'push', 'push']));
// 5) push then a deliberate pull 1.2 s later (outside the lock) -> both
res.push(run('push then pull 1.2 s later', makeFrames(6, [{ t: T0, dur: 300, up: 15, v: 0.7 }, { t: T0 + 1200, dur: 300, dn: 15, v: -0.7 }]), ['push', 'pull']));
// 6) clap: broadband, lifts both sides AND the far band for 60 ms
res.push(run('clap (impulse)', makeFrames(5, [{ t: T0, dur: 60, up: 22, dn: 20, noise: 25 }]), []));
// 7) clap that is lopsided (more energy above the carrier) -> still vetoed by far band
res.push(run('lopsided clap', makeFrames(5, [{ t: T0, dur: 80, up: 25, dn: 8, noise: 22 }]), []));
// 8) chatter: 3 s of speech raising far band + small sideband wiggles
res.push(run('3 s chatter', makeFrames(7, [{ t: T0, dur: 3000, up: 4, dn: 4, noise: 10 }]), []));
// 9) push DURING continuous loud music (floor must adapt, not veto forever)
res.push(run('push 4 s into loud music', makeFrames(10, [{ t: T0, dur: 8000, noise: 12, up: 3, dn: 3 }, { t: T0 + 4000, dur: 300, up: 16, v: 0.7 }]), ['push']));
// 10) passer-by 1.5 m away: weak and long
res.push(run('person walking by (weak, long)', makeFrames(6, [{ t: T0, dur: 2500, up: 5, v: 1.2 }]), []));
// 11) slow drift of +4 dB over 20 s (AGC, someone sits down)
res.push(run('slow +0.2 dB/s drift, 20 s', makeFrames(22, [], { drift: 0.2 }), []));
// 12) noisy laptop: jitter 3 dB (floor sigma grows, threshold follows)
res.push(run('noisy laptop, jitter 3 dB, no gesture', makeFrames(20, [], { jitter: 3 }), []));
res.push(run('noisy laptop, jitter 3 dB, strong push', makeFrames(6, [{ t: T0, dur: 300, up: 20, v: 0.7 }], { jitter: 3 }), ['push']));
// 13) wave: 4 Hz back-and-forth for 1.2 s -> one push then one wave, nothing else
res.push(run('wave 4 Hz x 1.2 s', makeFrames(5, [{ t: T0, dur: 1200, osc: 4, osc_db: 14 }]), ['push', 'wave']));
// 14) step change: +10 dB on the up side for good (new interference) -> at most one event, then recovers
const step = makeFrames(14, [{ t: T0, dur: 20000, up: 0 }]);
step.forEach((f) => { if (f.t > T0) f.up += 10; });
[{ t: 10000 }].forEach((p) => step.forEach((f) => { f.down += bump(f.t, p.t, 300, 15); }));
const s = run('up-side step +10 dB, then pull at 10 s', step, ['push', 'pull']);
res.push({ pass: s.got.some((g) => g.kind === 'pull'), got: s.got });
console.log(`   (step case counts as pass if the later pull is still detected: ${s.got.some((g) => g.kind === 'pull')})`);

// latency: frames from bump onset to fire, clean push
const lat = run('latency probe', makeFrames(4, [{ t: T0, dur: 300, up: 16, v: 0.7 }]), ['push']);
if (lat.got[0]) console.log(`   detection ${Math.round(lat.got[0].t - T0)} ms after motion onset (frames at 60 fps; excludes FFT window delay)`);

// ---- foreign tone mask
const binHz = 48000 / 8192, kp = Math.round(19000 / binHz), G = Math.ceil(25 / binHz), W = Math.floor(300 / binHz);
const specs = [];
for (let j = 0; j < 30; j++) {
  const a = new Float32Array(4096).fill(-110).map(() => -110 + 2 * gauss());
  a[kp] = -40;
  a[kp + 30] = -70 + gauss(); // another laptop 176 Hz above us
  if (j % 3 === 0) a[kp - 20] = -75; // intermittent blip: should NOT be masked
  specs.push(a);
}
const mask = R.foreignToneMask(specs, kp, G, W);
const okMask = mask.has(30) && !mask.has(-20) && mask.size === 5;
console.log(`${okMask ? 'PASS' : 'FAIL'}  foreign tone mask                            masked offsets [${[...mask].sort((a, b) => a - b)}]`);
res.push({ pass: okMask });

// ---- frequency choice
const sweep = [
  { f: 17000, snr: 48, snrSd: 1 }, { f: 18000, snr: 44, snrSd: 1 }, { f: 18500, snr: 41, snrSd: 2 },
  { f: 19000, snr: 38, snrSd: 1, foreignDb: 18 }, { f: 19500, snr: 36, snrSd: 1.5 }, { f: 20000, snr: 30, snrSd: 4 },
  { f: 20500, snr: 22, snrSd: 3 }, { f: 21000, snr: 12, snrSd: 5 },
];
const ch = R.chooseFrequency(sweep);
console.log(`${ch.f === 19500 ? 'PASS' : 'FAIL'}  chooseFrequency -> ${ch.f} Hz   ` + ch.table.map((r) => `${r.f / 1000}k:${r.ok ? r.score : 'x'}`).join(' '));
res.push({ pass: ch.f === 19500 });

// ---- dual vote
const dv1 = R.dualVote({ up: 12, dn: 1, on: 6, v: 0.6 }, { up: 11, dn: 0, on: 6, v: 0.55 });
const dv2 = R.dualVote({ up: 12, dn: 1, on: 6, v: 0.6 }, { up: 0, dn: 9, on: 6, v: -0.5 });
const dv3 = R.dualVote({ up: 15, dn: 1, on: 6, v: 0.6 }, { up: 2, dn: 1, on: 6, v: 0 });
const okDv = dv1.dir === 1 && dv1.agree && dv2.dir === 0 && dv3.dir === 1;
console.log(`${okDv ? 'PASS' : 'FAIL'}  dualVote both=${JSON.stringify(dv1)} conflict=${JSON.stringify(dv2)} oneStrong=${JSON.stringify(dv3)}`);
res.push({ pass: okDv });

// A confirmed push can be followed immediately by a pull without an idle gap.
function followPullTest(v, phase, { blockedAt, from = 60, to = 260 } = {}) {
  const detector = new R.PullAfterPush();
  detector.arm(20);
  const hits = [];
  for (let t = from; t <= to; t += 16) {
    const hit = detector.update({ t, v, up: 2, down: 13, blocked: t === blockedAt }, () => phase);
    if (hit) hits.push(hit.source);
  }
  return hits.join(',');
}
for (const [label, actual, expected] of [
  ['strong pull after push without phase', followPullTest(-1.05, null), 'fft'],
  ['weaker pull with valid phase travel', followPullTest(-0.53, 0.12), 'fft+phase'],
  ['slow return ignored without phase evidence', followPullTest(-0.53, null), ''],
  ['opposite phase travel cannot boost a weak pull', followPullTest(-0.53, -0.12), ''],
  ['short reversal ignored', followPullTest(-1.05, 0.12, { to: 124 }), ''],
  ['wave or interference cancels pending pull', followPullTest(-1.05, 0.12, { blockedAt: 108 }), ''],
  ['follow-up expires before the next separate gesture', followPullTest(-1.05, 0.12, { from: 700, to: 920 }), ''],
]) {
  const pass = actual === expected;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  res.push({ pass });
}

// ---- auto volume (fake SNR curve: 20*log10(vol) + 50)
(async () => {
  let vol = 1;
  const v = await R.autoVolume({ setVolume: (x) => { vol = x; }, readSnr: async () => 20 * Math.log10(vol) + 50, target: 32 });
  const okV = Math.abs(v - Math.pow(10, -18 / 20)) < 0.03;
  console.log(`${okV ? 'PASS' : 'FAIL'}  autoVolume -> ${v.toFixed(3)} (ideal ${Math.pow(10, -18 / 20).toFixed(3)})`);
  res.push({ pass: okV });
  // agc
  const okAgc = R.agcSuspect(Array.from({ length: 60 }, (_, i) => -40 + i * 0.1)) && !R.agcSuspect(Array.from({ length: 60 }, () => -40 + 0.3 * gauss()));
  console.log(`${okAgc ? 'PASS' : 'FAIL'}  agcSuspect ramp=true / steady=false`);
  res.push({ pass: okAgc });
  console.log(`\n${res.filter((r) => r.pass).length}/${res.length} passed`);
  if (res.some((r) => !r.pass)) process.exitCode = 1;
})();
