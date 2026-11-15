// Unit test for web/auth.js (gesture password): synthetic users, enrollment, genuine / impostor attempts, segmentation.
//   node tools/auth-tests/test.js
const A = require('../../web/auth.js');
let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const shape = (kind, i, n) => { const x = i / (n - 1); const b = Math.sin(Math.PI * x) ** 2; return kind === 'pull' ? -b : kind === 'wave' ? Math.sin(4 * Math.PI * x) : b; };

// a person = gesture order + rhythm + how each gesture is done
function person({ kinds, intervals, peaks, durs }) {
  return (jit = 1, over = {}) => {
    const iv = (over.intervals || intervals).map((m) => Math.max(0.15, m + gauss() * 0.05 * jit));
    const g = kinds.map((k, j) => ({
      peak: Math.max(0.3, (over.peaks || peaks)[j] * (1 + gauss() * 0.08 * jit)),
      dur: Math.max(120, (over.durs || durs)[j] + gauss() * 25 * jit),
      tPeak: 0.4,
      trace: new Array(24).fill(0).map((_, i) => shape(k, i, 24) + gauss() * 0.05 * jit),
    }));
    return { kinds: over.kinds || kinds, intervals: iv, total: iv.reduce((s, x) => s + x, 0), g };
  };
}
const seo = person({ kinds: ['push', 'pull', 'wave'], intervals: [0.7, 0.9], peaks: [1.4, 1.2, 1.0], durs: [350, 400, 900] });
const res = [];
const check = (name, ok, info) => { res.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); };

const tpl = A.buildTemplate(new Array(6).fill(0).map(() => seo()));
check('template from 6 reps', tpl.kinds.join() === 'push,pull,wave' && tpl.threshold >= 1.8 && tpl.threshold <= 4.5, `threshold ${tpl.threshold}, leave-one-out ${tpl.loo.join(' ')}`);

const rate = (make, n = 40) => { let acc = 0; const reasons = {}; for (let i = 0; i < n; i++) { const r = A.score(tpl, make()); if (r.accepted) acc++; reasons[r.reason] = (reasons[r.reason] || 0) + 1; } return { acc, n, reasons }; };
const gen = rate(() => seo());
check('genuine attempts mostly accepted', gen.acc / gen.n >= 0.85, `${gen.acc}/${gen.n} ${JSON.stringify(gen.reasons)}`);
const rhythm = rate(() => seo(1, { intervals: [0.4, 1.3] }));
check('same gestures, other rhythm -> rejected for rhythm', rhythm.acc / rhythm.n <= 0.05 && rhythm.reasons.rhythm >= 0.8 * rhythm.n, `${rhythm.acc}/${rhythm.n} accepted ${JSON.stringify(rhythm.reasons)}`);
const style = rate(() => seo(1, { peaks: [2.2, 1.9, 1.6], durs: [550, 620, 1300] }));
check('same rhythm, other speed and length -> mostly rejected', style.acc / style.n <= 0.2, `${style.acc}/${style.n} accepted ${JSON.stringify(style.reasons)}`);
const order = A.score(tpl, seo(1, { kinds: ['pull', 'push', 'wave'] }));
check('wrong order -> rejected for order', !order.accepted && order.reason === 'order');
const sloppy = rate(() => seo(2.5));
console.log(`info  the same person, 2.5x as sloppy: ${sloppy.acc}/${sloppy.n} accepted ${JSON.stringify(sloppy.reasons)}`);

// segmentation: a burst with a known onset and length in a 16 ms frame stream
const frames = [];
for (let t = 0; t < 3000; t += 16) {
  const on = t >= 1000 && t <= 1400;
  frames.push({ t, v: on ? 1.5 * Math.sin(Math.PI * (t - 1000) / 400) : 0.02, a: on ? 25 : 2 });
}
const seg = A.segment(frames, 1250);
check('segment finds the burst', seg && Math.abs(seg.t0 - 1008) <= 16 && Math.abs(seg.dur - 384) <= 32 && Math.abs(seg.peak - 1.5) < 0.05, seg ? `t0 ${seg.t0} dur ${seg.dur} peak ${seg.peak.toFixed(2)}` : 'null');
check('segment respects the upper bound', (A.segment(frames, 1250, { hi: 1200 }) || {}).t1 <= 1200);

console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
if (res.some((x) => !x)) process.exitCode = 1;
