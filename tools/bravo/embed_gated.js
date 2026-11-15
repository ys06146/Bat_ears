// node embed_gated.js <gated model json> [module]  -> DEFAULT_CALIB.galaxy.gated in gated/bat3d.js (numbers rounded)
const fs = require('fs'), file = process.argv[3] || __dirname + '/gated/bat3d.js';
const M = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), rd = (x) => (Array.isArray(x) ? x.map(rd) : typeof x === 'number' ? +x.toPrecision(6) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, rd(v)])) : x);
let s = fs.readFileSync(file, 'utf8');
const key = 'const DEFAULT_CALIB = { galaxy: ', a = s.indexOf(key); if (a < 0) throw new Error('DEFAULT_CALIB not found');
let i = a + key.length, d = 0, q = null;
for (; i < s.length; i++) { const ch = s[i]; if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; } if (ch === '"' || ch === "'") q = ch; else if (ch === '{') d++; else if (ch === '}' && --d === 0) break; }
const old = s.slice(a + key.length, i + 1), cal = JSON.parse(old);
cal.gated = rd(M);
s = s.slice(0, a + key.length) + JSON.stringify(cal) + s.slice(i + 1);
fs.writeFileSync(file, s);
delete require.cache[require.resolve(file)]; const B = require(file);
console.log(`embedded: gated ${B.DEFAULT_CALIB.galaxy.gated.kind}, H ${B.DEFAULT_CALIB.galaxy.gated.H}, sittings ${B.DEFAULT_CALIB.galaxy.gated.sittings.length}, file ${(s.length / 1024).toFixed(0)} kB`);
