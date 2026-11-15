// Are the WAV's mic channels distinct?  node chan.js <wav> [f1 f2]
const P = require('./phase.js');
const w = P.readWav(process.argv[2]), f = [Number(process.argv[3] || 18000), Number(process.argv[4] || 19500)];
console.log(`${process.argv[2].split('/').pop()}: ${w.C} ch, ${w.rate} Hz, ${(w.frames / w.rate).toFixed(1)} s`);
if (w.C < 2) process.exit(0);
const [a, b] = w.ch; let sab = 0, saa = 0, sbb = 0, sd = 0, same = 0;
for (let i = 0; i < w.frames; i++) { sab += a[i] * b[i]; saa += a[i] ** 2; sbb += b[i] ** 2; sd += (a[i] - b[i]) ** 2; if (a[i] === b[i]) same++; }
console.log(`raw corr ${(sab / Math.sqrt(saa * sbb)).toFixed(4)}  rms a ${Math.sqrt(saa / w.frames).toExponential(2)} b ${Math.sqrt(sbb / w.frames).toExponential(2)}  rms(a-b) ${Math.sqrt(sd / w.frames).toExponential(2)}  identical samples ${(100 * same / w.frames).toFixed(1)}%`);
for (const fr of f) {
  const A = P.baseband(a, w.rate, fr), B = P.baseband(b, w.rate, fr);
  const pa = P.pathSteps(A, fr, { gate: 1.5 }), pb = P.pathSteps(B, fr, { gate: 1.5 });
  let c = 0, x2 = 0, y2 = 0, mA = 0, mB = 0; const n = pa.step.length;
  for (let k = 0; k < n; k++) { c += pa.step[k] * pb.step[k]; x2 += pa.step[k] ** 2; y2 += pb.step[k] ** 2; mA += Math.hypot(A.I[k], A.Q[k]); mB += Math.hypot(B.I[k], B.Q[k]); }
  // static carrier phase difference between channels (mic spacing shows up as a fixed offset)
  let re = 0, im = 0; for (let k = 500; k < n; k++) { re += A.I[k] * B.I[k] + A.Q[k] * B.Q[k]; im += A.Q[k] * B.I[k] - A.I[k] * B.Q[k]; }
  console.log(`${fr} Hz: carrier |a| ${(mA / n).toExponential(2)} |b| ${(mB / n).toExponential(2)}, static phase a-b ${(Math.atan2(im, re) * 180 / Math.PI).toFixed(1)}°, path-step corr ${(c / Math.sqrt(x2 * y2)).toFixed(3)}`);
}
