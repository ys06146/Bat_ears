// Synthetic 3-source session for track6.js / 3d.html: laptop L 18k + R 19.5k, phone 20.5 kHz (+25 ppm clock) at PHONE,
// two mics; trials = vertical circles (plane facing the screen), horizontal circles, up / down moves (push = up,
// pull = down, as in protocol B). Writes <out>.wav (2 ch, 16 bit) + <out>.json (stereoPair, wav.t0 = 0, trials with tGo).
//   node synth3.js <out base>   env: PLANE=v|h (circle plane), NOISE (white noise rms), PHONE "x,y,z", SEED
const fs = require('fs');
const out = process.argv[2], rate = 48000;
const SL = [-0.15, -0.01, -0.08], SR = [0.15, -0.01, -0.08], M = [[0.025, 0.19, 0.17], [-0.025, 0.19, 0.17]];
const PH = (process.env.PHONE || '0.25,0.25,0.12').split(',').map(Number), H0 = [0, 0.12, 0];
const plane = process.env.PLANE || 'v', noise = Number(process.env.NOISE || 0.003);
let seed = Number(process.env.SEED || 9); const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const kinds = []; for (let i = 0; i < 6; i++) kinds.push('cw', 'ccw'); for (let i = 0; i < 3; i++) kinds.push('push', 'pull');
kinds.sort(() => rnd() - 0.5);
const trials = kinds.map((k, i) => ({ kind: k, tGo: 2000 + 4500 * i, tStart: 2000 + 4500 * i - 1650, tEnd: 2000 + 4500 * i + 3000 }));
const T = (trials[trials.length - 1].tGo + 4000) / 1000, N = Math.round(T * rate);
const ease = (s) => { s = Math.min(1, Math.max(0, s)); return s * s * (3 - 2 * s); };
// in-plane basis: v = x (right) / y (up), seen from the user facing the screen; h = x / z (toward the screen), seen from above
const basis = plane === 'v' ? [[1, 0, 0], [0, 1, 0]] : [[1, 0, 0], [0, 0, 1]];
const add = (a, b, s = 1) => a.map((v, i) => v + s * b[i]);
function hand(t) {
  const ms = t * 1000; let q = null; for (const x of trials) if (ms >= x.tGo - 200) q = x;
  if (!q) return H0;
  const u = (ms - q.tGo) / 1000;
  if (q.kind === 'cw' || q.kind === 'ccw') {
    // clockwise as the user sees it: v plane (facing the screen) up -> right -> down -> left; h plane (from above)
    // toward the screen -> right -> toward me -> left. Start at the BOTTOM / near side of the circle (= H0) so a
    // vertical circle stays above the deck (y 12..26 cm), 1.5 turns in 1.8 s.
    const s0 = -Math.PI / 2, sg = q.kind === 'cw' ? 1 : -1;
    const r = 0.07, dur = 1.8, turns = 1.5 * ease(u / dur), a = s0 - sg * 2 * Math.PI * turns;
    const c = add(H0, basis[1], r), p = add(add(c, basis[0], r * Math.cos(a)), basis[1], r * Math.sin(a));
    if (u <= dur) return p;
    const end = add(add(c, basis[0], r * Math.cos(s0 - sg * 3 * Math.PI)), basis[1], r * Math.sin(s0 - sg * 3 * Math.PI));
    return add(end, sub(H0, end), ease((u - dur) / 1.0));
  }
  const dy = (q.kind === 'push' ? 1 : -1) * 0.10 * (ease(u / 0.5) - ease((u - 1.0) / 1.0));   // up / down 10 cm, slow return
  return add(H0, [0, dy, 0]);
}
function sub(a, b) { return a.map((v, i) => v - b[i]); }
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const src = [{ S: SL, f: 18000 }, { S: SR, f: 19500 }, { S: PH, f: 20500 * (1 + 25e-6) }];
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
const g = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
for (let i = 0; i < N; i++) {
  const t = i / rate, h = hand(t);
  for (let c = 0; c < 2; c++) {
    let v = 0;
    for (const s of src) {
      const dd = d3(s.S, M[c]), a = d3(h, s.S), b = d3(h, M[c]);
      v += 0.02 / dd * Math.cos(2 * Math.PI * s.f * (t - dd / 343));                     // direct
      v += 0.02 * 0.02 / (a * b) * Math.cos(2 * Math.PI * s.f * (t - (a + b) / 343));     // hand echo
    }
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((v + noise * g()) * 32768))), 44 + 4 * i + 2 * c);
  }
}
fs.writeFileSync(out + '.wav', buf);
// truth: path length per source to each mic every 10 ms
const truth = [];
for (let t = 0; t < T; t += 0.01) { const h = hand(t); truth.push([+(t * 1000).toFixed(0), ...src.flatMap((s) => M.map((m) => +(d3(h, s.S) + d3(h, m)).toFixed(5)))]); }
fs.writeFileSync(out + '.truth.json', JSON.stringify(truth));
fs.writeFileSync(out + '.json', JSON.stringify({ stereoPair: [18000, 19500], wav: { t0: 0 }, trials, synth: { plane, phone: PH, noise } }));
console.log(`wrote ${out}.wav (${T.toFixed(0)} s), plane ${plane}, ${trials.length} trials`);
