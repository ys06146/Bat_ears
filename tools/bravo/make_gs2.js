// gated_stream.js -> gated_stream2.js with a configurable context: CTX=base (12) | long (+ path change 0.5-1.0 s, 16) |
// q (+ log mean |dyn|/noise over the last 250 ms, 16) | longq (20). Offline research only (engine has the base 12).
const fs = require('fs');
let s = fs.readFileSync(__dirname + '/gated_stream.js', 'utf8');
const rep = (a, b, all = false) => { const n = s.split(a).length - 1; if (!n || (!all && n !== 1)) throw new Error(`${n} matches: ${a}`); s = all ? s.split(a).join(b) : s.replace(a, () => b); };
rep("const NEAR = 0.45,", "const CTX = process.env.CTX || 'base', NC = { base: 12, long: 16, q: 16, longq: 20 }[CTX], NEAR = 0.45,");
rep("new Float64Array(nT * 12)", "new Float64Array(nT * NC)");
rep("  const cact = st.map(", "  const cq = st.map((s) => { const q = new Float64Array(n + 1); for (let k = 0; k < n; k++) q[k + 1] = q[k] + s.mag[k] / Math.max(1e-12, s.noise[k]); return q; });\n  const cact = st.map(");
rep("ctx[k * 12 + p] = D(p, i) - D(p, i - 250); ctx[k * 12 + 4 + p] = D(p, i - 250) - D(p, i - 500); ctx[k * 12 + 8 + p] = (A(p, i) - A(p, i - 250)) / 250;",
    "ctx[k * NC + p] = D(p, i) - D(p, i - 250); ctx[k * NC + 4 + p] = D(p, i - 250) - D(p, i - 500); ctx[k * NC + 8 + p] = (A(p, i) - A(p, i - 250)) / 250; let e = 12; if (CTX === 'long' || CTX === 'longq') { ctx[k * NC + e + p] = D(p, i - 500) - D(p, i - 1000); e += 4; } if (CTX === 'q' || CTX === 'longq') ctx[k * NC + e + p] = Math.log(Math.max(1e-3, (cq[p][Math.min(n, i)] - cq[p][Math.max(0, i - 250)]) / 250));");
rep("const mu = new Float64Array(12), sd = new Float64Array(12)", "const mu = new Float64Array(NC), sd = new Float64Array(NC)");
rep("for (let i = 0; i < 12; i++) { const v = s.ctx[k * 12 + i];", "for (let i = 0; i < NC; i++) { const v = s.ctx[k * NC + i];");
rep("for (let i = 0; i < 12; i++) { mu[i] /= cnt;", "for (let i = 0; i < NC; i++) { mu[i] /= cnt;");
rep("Float64Array.from({ length: H * 12 }, () => rnd() * 2 / Math.sqrt(12))", "Float64Array.from({ length: H * NC }, () => rnd() * 2 / Math.sqrt(NC))");
rep("hid = new Float64Array(H), c = new Float64Array(12)", "hid = new Float64Array(H), c = new Float64Array(NC)");
rep("for (let i = 0; i < 12; i++) c[i] = (s.ctx[k * 12 + i] - mu[i]) / sd[i];", "for (let i = 0; i < NC; i++) c[i] = (s.ctx[k * NC + i] - mu[i]) / sd[i];", true);
rep("for (let i = 0; i < 12; i++) q += W1[h * 12 + i] * c[i];", "for (let i = 0; i < NC; i++) q += W1[h * NC + i] * c[i];");
rep("for (let i = 0; i < 12; i++) g[0][h * 12 + i] += d * c[i];", "for (let i = 0; i < NC; i++) g[0][h * NC + i] += d * c[i];");
rep("return { W0, Sg, mu: Array.from(mu)", "return { NC, W0, Sg, mu: Array.from(mu)");
rep("c = new Float64Array(12), hh = new Float64Array(M.H);", "c = new Float64Array(M.NC), hh = new Float64Array(M.H);");
rep("for (let i = 0; i < 12; i++) c[i] = (s.ctx[k * 12 + i] - M.mu[i]) / M.sd[i];", "for (let i = 0; i < M.NC; i++) c[i] = (s.ctx[k * M.NC + i] - M.mu[i]) / M.sd[i];");
rep("for (let i = 0; i < 12; i++) q += M.W1[h * 12 + i] * c[i];", "for (let i = 0; i < M.NC; i++) q += M.W1[h * M.NC + i] * c[i];");
rep("console.log(`${S.length} sittings", "console.log(`CTX ${CTX} (${NC}) | ${S.length} sittings");
fs.writeFileSync(__dirname + '/gated_stream2.js', s);
console.log('gated_stream2.js written');
