// Auto retrain + evaluate as hologram compare-mode sittings arrive (bravo, MadHacks 2026-11-15).
//
// Sittings
//   old : the deployed training set (dates parsed from DEFAULT_CALIB.note of the deployed bat3d.js), from TEACH_DIR
//   new : every complete sitting in COMPARE_DIR (<base>.json is written last; needs <base>.wav + <base>_vision.csv)
//         + teach sittings newer than the newest old one
// Baseline = what the deployed hologram does on a sitting it never saw:
//   new sitting -> the deployed W as is;   old sitting -> W trained on the other old sittings (the deployed LOSO)
// Candidate = W trained on every other sitting (old + new), same ridge / windows / tracker as the deployed one.
// The candidate is written (calib.json + a patched copy of the deployed bat3d.js in OUTDIR) only when it is
// clearly better on unseen sittings:
//   >= MIN_NEW new sittings, pooled mean corr on the new sittings up by >= GAIN, no axis rms worse by > RMS_TOL,
//   >= 2/3 of the new sittings better, pooled mean corr on the old sittings not down by > OLD_TOL.
//
//   node auto_train.js             run once
//   node auto_train.js --watch     poll COMPARE_DIR every POLL s, rerun when the set of complete sittings changes
//   env: COMPARE_DIR, TEACH_DIR, DEPLOYED (bat3d.js), OUTDIR, GATE 1.0, TAU 0.1, NEAR 0.45, WIN 250, JOBS, POLL 20
//        FORCE_NEW=<comma list of old dates to treat as new> (dry run of the logic on existing data)
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { execFile } = require('child_process');
const ROOT = path.join(__dirname, '../..');
const COMPARE_DIR = process.env.COMPARE_DIR || ROOT + '/ml/data/compare', TEACH_DIR = process.env.TEACH_DIR || ROOT + '/ml/data/teach';
const DEPLOYED = process.env.DEPLOYED || ROOT + '/web/bat3d.js', OUTDIR = process.env.OUTDIR || path.join(__dirname, 'out', 'auto');
const CACHE = path.join(__dirname, 'cache');
const PRM = { gate: Number(process.env.GATE || 1.0), tauS: Number(process.env.TAU || 0.1), near: Number(process.env.NEAR || 0.45), win: Number(process.env.WIN || 250), hfov: 66, lpHz: Number(process.env.LPHZ || 250), pct: Number(process.env.PCT || 0.25), lam: 1e-4 };
// CAND_TRACKER="tau=0.05,pct=0.1" (gate / tau / pct / lp): the candidate also changes the worklet's tracker settings;
// the baseline stays the deployed tracker + deployed map
const CAND = process.env.CAND_TRACKER ? Object.fromEntries(process.env.CAND_TRACKER.split(',').map((kv) => kv.split('=')).map(([k, v]) => [{ tau: 'tauS', lp: 'lpHz' }[k] || k, Number(v)])) : null;
const PRMC = CAND ? { ...PRM, ...CAND } : PRM;
const MIN_NEW = 2, GAIN = Number(process.env.GAIN ?? 0.02), RMS_TOL = 0.03, OLD_TOL = 0.01, MIN_WIN = 40;

// ---------- feature extraction (same as loso.js; run in a child process per sitting, cached)
const isCmpBase = (base) => /_cmp_/.test(path.basename(base));
const visionFile = (base) => (isCmpBase(base) && fs.existsSync(base + '_vision_full.csv') ? base + '_vision_full.csv' : base + '_vision.csv');
function extract(base) {
  const V = require('./vision3d.js'), P = require('./phase.js');
  const J = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), cam = J.camera || {}, lean = (J.screen_angle_deg ?? 95) - 90, r = lean * Math.PI / 180, C = [0, 0.19 * Math.cos(r), 0.10 + 0.19 * Math.sin(r)];
  const L = fs.readFileSync(visionFile(base), 'utf8').trim().split('\n').map((l) => l.replace(/\r$/, '')), h = L[0].split(','), ix = Object.fromEntries(h.map((k, i) => [k, i]));
  let present = 0;
  const tr = L.slice(1).map((l) => { const q = l.split(','), n = (k) => Number(q[ix[k]]); if (n('present') !== 1) return null; present++;
    const f = { lm: Array.from({ length: 21 }, (_, j) => [n(`lm${j}_x`), n(`lm${j}_y`), 0]), wlm: Array.from({ length: 21 }, (_, j) => [n(`wlm${j}_x`), n(`wlm${j}_y`), n(`wlm${j}_z`)]) };
    const c = V.handCam(f, { W: cam.width || 1280, H: cam.height || 720, hfov: PRM.hfov }); return c ? { t: n('t_cap'), H: V.toLaptop(c, { tilt: lean, C }) } : null; }).filter(Boolean);
  const wav = P.readWav(base + '.wav'), t0 = J.wav.t0, F = J.stereoFreqs || [18000, 19500];
  const st = F.flatMap((f) => [0, 1].map((c) => P.pathSteps(P.baseband(wav.ch[c], wav.rate, f, { lpHz: PRM.lpHz }), f, { gate: PRM.gate, tauS: PRM.tauS, pct: PRM.pct })));
  const rate = st[0].rate, n = st[0].step.length, cum = st.map((s) => { const q = new Float64Array(n + 1); for (let k = 0; k < n; k++) q[k + 1] = q[k] + s.step[k]; return q; });
  const Dl = (p, tms, lag) => cum[p][Math.max(0, Math.min(n, Math.round((tms + lag - t0) / 1000 * rate)))];
  const WIN = PRM.win, NEAR = PRM.near, ws = [];
  // vision windows (independent of the audio clock)
  const pairs = [];
  for (let i = 0, j = 0; i < tr.length; i++) { while (j < tr.length && tr[j].t < tr[i].t + WIN) j++; if (j >= tr.length) break;
    const a = tr[i], b = tr[j]; if (b.t - a.t > WIN + 80) continue; if (Math.hypot(...a.H.map((v, k) => v - C[k])) > NEAR || Math.hypot(...b.H.map((v, k) => v - C[k])) > NEAR) continue;
    const dH = b.H.map((v, k) => v - a.H[k]); if (Math.hypot(...dH) < 0.01 || Math.hypot(...dH) > 0.4) continue; pairs.push({ a, b, dH }); }
  const mcorr = (pr) => { const c = [0, 0, 0], v = [0, 0, 0], p2 = [0, 0, 0]; for (const { p, y } of pr) for (let k = 0; k < 3; k++) { c[k] += p[k] * y[k]; v[k] += y[k] ** 2; p2[k] += p[k] ** 2; } return c.reduce((s, x, k) => s + x / Math.sqrt(v[k] * p2[k] || 1), 0) / 3; };
  const best = (f, lo, hi, step) => { let bl = 0, bs = -Infinity; for (let L = lo; L <= hi; L += step) { const s = f(L); if (s > bs) { bs = s; bl = L; } } for (let L = bl - step + 5; L < bl + step; L += 5) { const s = f(L); if (s > bs) { bs = s; bl = L; } } return { lag: bl, corr: bs, corr0: f(0) }; };
  // compare sittings: wav.t0 is approximate (ScriptProcessor callback time) -> audio lag that best fits the deployed map
  const isCmp = J.mode === 'compare' || /_cmp_/.test(path.basename(base));
  let lagA = 0, lagInfo = null;
  if (isCmp && pairs.length >= 40) {
    const Wd = readDeployed().calib.learned.laptop.W, pred = (x) => Wd.map((r) => r.reduce((s, w, j) => s + w * (j < 4 ? x[j] : 1), 0));
    const f = (lag) => mcorr(pairs.map(({ a, b, dH }) => ({ p: pred(st.map((_, q) => Dl(q, b.t, lag) - Dl(q, a.t, lag))), y: dH })));
    const r = best(f, -2500, 2500, 20); lagA = r.lag; lagInfo = { audioMs: r.lag, corrBest: +r.corr.toFixed(3), corrAt0: +r.corr0.toFixed(3) };
    // alpha 30e0bd8: both wav start estimates (wav.t0 = the earlier); the lag implied by each, to see which one is right
    if (Number.isFinite(J.wav.t0_first_callback) && Number.isFinite(J.wav.t0_end_anchored)) Object.assign(lagInfo, { firstCbMs: +(J.wav.t0_first_callback - t0).toFixed(1), endAnchMs: +(J.wav.t0_end_anchored - t0).toFixed(1) });
  }
  const D = (p, tms) => Dl(p, tms, lagA);
  // compare mode: what the hologram drew live (<base>_holo.csv, t_ms on the t_cap clock) over the same windows
  let holo = null, hAt = null;
  if (fs.existsSync(base + '_holo.csv')) {
    const HL = fs.readFileSync(base + '_holo.csv', 'utf8').trim().split('\n').map((l) => l.replace(/\r$/, '')), hh = HL[0].split(','), hi = Object.fromEntries(hh.map((k, i) => [k.trim(), i]));
    if (hi.t_ms != null && hi.raw_x != null && hi.shown_x != null) {
      let rows = HL.slice(1).map((l) => l.split(',').map(Number)).filter((q) => Number.isFinite(q[hi.t_ms]));
      // t_ms is stamped when a batch is processed (rows come in bursts); t_s is the engine's regular audio clock ->
      // time = 1000 t_s + offset, offset = low percentile of (t_ms - 1000 t_s) (earliest delivery = least delayed)
      if (hi.t_s != null) { const off = rows.map((q) => q[hi.t_ms] - 1000 * q[hi.t_s]).filter(Number.isFinite).sort((a, b) => a - b), o = off[Math.floor(0.05 * (off.length - 1))];
        rows = rows.map((q) => { const c = q.slice(); c[hi.t_ms] = 1000 * q[hi.t_s] + o; return c; }); }
      rows.sort((a, b) => a[hi.t_ms] - b[hi.t_ms]);
      const T = rows.map((q) => q[hi.t_ms]);
      hAt = (t) => { let lo = 0, hi2 = T.length - 1; while (lo < hi2) { const m = (lo + hi2) >> 1; if (T[m] < t) lo = m + 1; else hi2 = m; } const k = lo > 0 && Math.abs(T[lo - 1] - t) < Math.abs(T[lo] - t) ? lo - 1 : lo; return Math.abs(T[k] - t) <= 30 ? rows[k] : null; };
      holo = { rows: rows.length, raw: { e: [0, 0, 0], v: [0, 0, 0], c: [0, 0, 0], p: [0, 0, 0], n: 0 }, shown: { e: [0, 0, 0], v: [0, 0, 0], c: [0, 0, 0], p: [0, 0, 0], n: 0 } };
      holo.cols = { raw: ['raw_x', 'raw_y', 'raw_z'].map((k) => hi[k]), shown: ['shown_x', 'shown_y', 'shown_z'].map((k) => hi[k]) };
    } else holo = { error: 'no t_ms / raw_x / shown_x column in _holo.csv' };
  }
  for (const { a, b, dH } of pairs) ws.push({ t: +((a.t - tr[0].t) / 1000).toFixed(2), x: st.map((_, p) => +(D(p, b.t) - D(p, a.t)).toFixed(7)), y: dH.map((v) => +v.toFixed(6)) });
  if (hAt) {   // the drawn position lags the hand (audio buffers + engine + display filter): score at the best display lag
    const g = (lag, key) => pairs.map(({ a, b, dH }) => { const ra = hAt(a.t + lag), rb = hAt(b.t + lag); return ra && rb ? { p: holo.cols[key].map((c) => rb[c] - ra[c]), y: dH } : null; }).filter(Boolean);
    const r = best((lag) => { const q = g(lag, 'shown'); return q.length >= 0.5 * pairs.length ? mcorr(q) : -Infinity; }, -300, 800, 20); holo.lagMs = r.lag; holo.corrAt0 = +r.corr0.toFixed(3);
    for (const key of ['raw', 'shown']) { const A = holo[key]; for (const { p, y } of g(r.lag, key)) { for (let k = 0; k < 3; k++) { A.e[k] += (p[k] - y[k]) ** 2; A.v[k] += y[k] ** 2; A.c[k] += p[k] * y[k]; A.p[k] += p[k] * p[k]; } A.n++; } }
  }
  return { vision: visionFile(base).endsWith('_vision_full.csv') ? 'full re-extraction' : 'live', frames: L.length - 1, present, durS: +(wav.ch[0].length / wav.rate).toFixed(1), volume: J.volume ?? null, page: J.page || null, cam: [cam.width || 1280, cam.height || 720], lag: lagInfo, holo, ws };
}
if (process.argv[2] === '--extract') { fs.writeFileSync(process.argv[4], JSON.stringify(extract(process.argv[3]))); process.exit(0); }

const stamp = (f) => { const s = fs.statSync(f); return s.size + ':' + Math.round(s.mtimeMs); };
const keyOf = (base, prm = PRM) => crypto.createHash('sha1').update(JSON.stringify({ v: 7, PRM: prm, w: stamp(base + '.wav'), j: stamp(base + '.json'), c: stamp(visionFile(base)), vf: path.basename(visionFile(base)), h: fs.existsSync(base + '_holo.csv') ? stamp(base + '_holo.csv') : null })).digest('hex').slice(0, 12);
async function features(bases, prm = PRM) {
  fs.mkdirSync(CACHE, { recursive: true });
  const todo = bases.filter((b) => !fs.existsSync(path.join(CACHE, path.basename(b) + '.' + keyOf(b, prm) + '.json')));
  const jobs = Number(process.env.JOBS || Math.max(1, Math.min(4, require('os').cpus().length - 2)));
  if (todo.length) console.log(`extracting ${todo.length} sitting(s), ${jobs} at a time ...`);
  let next = 0;
  const run = async () => { while (next < todo.length) { const b = todo[next++], out = path.join(CACHE, path.basename(b) + '.' + keyOf(b, prm) + '.json');
    await new Promise((res, rej) => execFile(process.execPath, [__filename, '--extract', b, out], { maxBuffer: 1 << 26, env: { ...process.env, GATE: String(prm.gate), TAU: String(prm.tauS), PCT: String(prm.pct), LPHZ: String(prm.lpHz) } }, (e, so, se) => (e ? rej(new Error(path.basename(b) + ': ' + (se || e.message))) : res()))); } };
  await Promise.all(Array.from({ length: jobs }, run));
  return bases.map((b) => ({ base: b, name: path.basename(b).replace(/^batears_/, ''), date: (path.basename(b).match(/\d{8}_\d{6}/) || [''])[0], ...JSON.parse(fs.readFileSync(path.join(CACHE, path.basename(b) + '.' + keyOf(b, prm) + '.json'), 'utf8')) }));
}

// ---------- model
function inv(M0) { const k = M0.length, M = M0.map((r, i) => [...r, ...M0.map((_, j) => (i === j ? 1 : 0))]); for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; const d = M[c][c] || 1e-12; for (let j = 0; j < 2 * k; j++) M[c][j] /= d; for (let r = 0; r < k; r++) if (r !== c) { const q = M[r][c]; for (let j = 0; j < 2 * k; j++) M[r][j] -= q * M[c][j]; } } return M.map((r) => r.slice(k)); }
function fitW(train, lam = PRM.lam) {   // ridge with intercept, as loso.js (W: 3 x 5)
  const m = 5, A = Array.from({ length: m }, () => new Array(m).fill(0)), B = [0, 1, 2].map(() => new Array(m).fill(0));
  for (const w of train) { const x = [...w.x, 1]; for (let i = 0; i < m; i++) { for (let j = 0; j < m; j++) A[i][j] += x[i] * x[j]; for (let a = 0; a < 3; a++) B[a][i] += x[i] * w.y[a]; } }
  for (let i = 0; i < m - 1; i++) A[i][i] += lam * train.length;
  const Ai = inv(A); return [0, 1, 2].map((a) => Ai.map((r) => r.reduce((s, v, j) => s + v * B[a][j], 0)));
}
const apply = (W, w) => W.map((r) => r.reduce((s, v, j) => s + v * (j < 4 ? w.x[j] : 1), 0));
function stats(pairs, k = [1, 1, 1]) {
  const e = [0, 0, 0], v = [0, 0, 0], c = [0, 0, 0], p2 = [0, 0, 0], n = pairs.length;
  for (const q of pairs) for (let a = 0; a < 3; a++) { const p = k[a] * q.p[a]; e[a] += (p - q.y[a]) ** 2; v[a] += q.y[a] ** 2; c[a] += p * q.y[a]; p2[a] += p * p; }
  const corr = c.map((x, a) => x / Math.sqrt(v[a] * p2[a] || 1));
  return { n, rms: e.map((x) => 100 * Math.sqrt(x / Math.max(1, n))), motion: v.map((x) => 100 * Math.sqrt(x / Math.max(1, n))), corr, mc: corr.reduce((s, x) => s + x, 0) / 3, amp: p2.map((x, a) => Math.sqrt(x / Math.max(1e-12, v[a]))) };
}

function readDeployed() {
  const s = fs.readFileSync(DEPLOYED, 'utf8'), key = 'const DEFAULT_CALIB = { galaxy: ', a = s.indexOf(key);
  if (a < 0) throw new Error('DEFAULT_CALIB not found in ' + DEPLOYED);
  let i = a + key.length, d = 0, q = null;      // balanced-brace scan that skips strings
  for (; i < s.length; i++) { const ch = s[i];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch; else if (ch === '{') d++; else if (ch === '}' && --d === 0) break; }
  const json = s.slice(a + key.length, i + 1), calib = JSON.parse(json);
  return { text: s, json, calib, dates: (calib.note.match(/\d{8}_\d{6}/g) || []) };
}

function listSittings(dep) {
  const ok = (b) => ['.json', '.wav', '_vision.csv'].every((x) => fs.existsSync(b + x) && Date.now() - fs.statSync(b + x).mtimeMs > 10000);   // all files there and not written to for 10 s
  const teach = fs.existsSync(TEACH_DIR) ? fs.readdirSync(TEACH_DIR).filter((f) => /^batears_\d{8}_\d{6}_teach_\w+\.json$/.test(f)).map((f) => path.join(TEACH_DIR, f.slice(0, -5)).replace(/\\/g, '/')) : [];
  const cmp = fs.existsSync(COMPARE_DIR) ? fs.readdirSync(COMPARE_DIR).filter((f) => /^batears_\d{8}_\d{6}_cmp_\w+\.json$/.test(f)).map((f) => path.join(COMPARE_DIR, f.slice(0, -5)).replace(/\\/g, '/')) : [];
  const dOf = (b) => (path.basename(b).match(/\d{8}_\d{6}/) || [''])[0], last = dep.dates.slice().sort().pop() || '';
  const force = (process.env.FORCE_NEW || '').split(',').filter(Boolean);
  const old = teach.filter((b) => dep.dates.includes(dOf(b)) && !force.includes(dOf(b)));
  const nw = [...teach.filter((b) => (dOf(b) > last && !dep.dates.includes(dOf(b))) || force.includes(dOf(b))), ...cmp].filter(ok);
  const missing = dep.dates.filter((d) => !old.some((b) => dOf(b) === d) && !force.includes(d));
  return { old, nw, missing, force };
}

const f2 = (x) => x.toFixed(2), cm = (r) => r.rms.map((x) => x.toFixed(1)).join('/'), co = (r) => r.corr.map(f2).join('/');
async function runOnce() {
  const dep = readDeployed(), L = listSittings(dep);
  if (L.missing.length) console.log('WARNING: deployed training sittings not found in TEACH_DIR: ' + L.missing.join(', '));
  const all = await features([...L.old, ...L.nw]), allC = CAND ? await features([...L.old, ...L.nw], PRMC) : all, wsC = new Map(all.map((s, i) => [s, allC[i].ws]));
  if (CAND) all.forEach((s, i) => { if (allC[i].ws.length !== s.ws.length) throw new Error('window mismatch ' + s.name); });
  const old = all.filter((s) => L.old.includes(s.base)), nwAll = all.filter((s) => L.nw.includes(s.base));
  const nw = nwAll.filter((s) => s.ws.length >= MIN_WIN), thin = nwAll.filter((s) => s.ws.length < MIN_WIN);
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/Chicago' });
  console.log(`\n=== ${time} CST${CAND ? ' | CANDIDATE TRACKER ' + JSON.stringify(CAND) : ''} | deployed: ${dep.calib.session} | old ${old.length} | new ${nw.length}${thin.length ? ` (+${thin.length} too short: ${thin.map((s) => `${s.name} ${s.ws.length} windows`).join(', ')})` : ''}${L.force.length ? ' | FORCE_NEW ' + L.force.join(',') : ''}`);
  const Wdep = dep.calib.learned.laptop.W;
  // sanity: the deployed W must be what ridge on the old sittings gives (else the deployed set / params differ)
  const Wre = fitW(old.flatMap((s) => s.ws)), dW = Math.max(...Wdep.flatMap((r, a) => r.map((v, j) => Math.abs(v - Wre[a][j]))));
  if (!L.force.length) console.log(`check: refit on the old sittings vs deployed W, max |diff| ${dW.toExponential(1)}${dW > 2e-4 ? '  <-- MISMATCH (tracker params or data changed)' : ' (same)'}`);
  // predictions
  const pool = [...old, ...nw], base = new Map(), cand = new Map();
  for (const s of pool) {
    const isNew = nw.includes(s);
    const Wb = isNew && !L.force.length ? Wdep : fitW(old.filter((o) => o !== s).flatMap((o) => o.ws));
    const Wc = fitW(pool.filter((o) => o !== s).flatMap((o) => wsC.get(o)));
    base.set(s, s.ws.map((w) => ({ p: apply(Wb, w), y: w.y }))); cand.set(s, wsC.get(s).map((w) => ({ p: apply(Wc, w), y: w.y })));
  }
  for (const s of nwAll) if (!base.has(s)) { const pr = s.ws.map((w) => ({ p: apply(Wdep, w), y: w.y })); if (pr.length) console.log(`  ${s.name.padEnd(28)} (too short) deployed: err ${cm(stats(pr))} cm corr ${co(stats(pr))}`); }
  console.log('per sitting (held out)                 baseline err cm | corr            candidate err cm | corr       windows');
  for (const s of pool) { const b = stats(base.get(s)), c = stats(cand.get(s));
    console.log(`  ${(nw.includes(s) ? 'NEW ' : 'old ') + s.name.padEnd(30)} ${cm(b).padEnd(14)} | ${co(b).padEnd(15)}  ${cm(c).padEnd(14)} | ${co(c).padEnd(15)} ${String(s.ws.length).padStart(5)}${c.mc > b.mc + 1e-9 ? '  +' : c.mc < b.mc - 1e-9 ? '  -' : '  ='}${nw.includes(s) && s.volume != null && Math.abs(s.volume - 0.6) > 0.05 ? `  volume ${s.volume}` : ''}`);
    if (s.lag && s.lag.firstCbMs != null) console.log(`      wav start estimates vs wav.t0: first callback +${s.lag.firstCbMs} ms, end-anchored +${s.lag.endAnchMs} ms (lag found ${s.lag.audioMs} ms)`);
    if (s.lag) console.log(`      audio clock: lag ${s.lag.audioMs} ms fits best (deployed map corr ${s.lag.corrAt0} at 0 ms -> ${s.lag.corrBest})${Math.abs(s.lag.audioMs) >= 300 ? '  <-- large, check wav.t0' : ''}`);
    if (s.holo && s.holo.error) console.log(`      live hologram: ${s.holo.error}`);
    else if (s.holo && s.holo.raw.n) { const g = (A) => { const corr = A.c.map((x, k) => x / Math.sqrt(A.v[k] * A.p[k] || 1)); return `err ${A.e.map((x) => (100 * Math.sqrt(x / A.n)).toFixed(1)).join('/')} cm | corr ${corr.map(f2).join('/')} | size ${A.p.map((x, k) => Math.sqrt(x / Math.max(1e-12, A.v[k])).toFixed(2)).join('/')}`; };
      console.log(`      live hologram (what it drew, ${s.holo.raw.n} windows, display lag ${s.holo.lagMs} ms; corr at 0 ms ${s.holo.corrAt0}): raw ${g(s.holo.raw)} || shown ${g(s.holo.shown)}`); } }
  const P = (set, m) => set.flatMap((s) => m.get(s));
  const bO = stats(P(old, base)), cO = stats(P(old, cand));
  console.log(`pooled old: baseline ${cm(bO)} cm, corr ${co(bO)} (mean ${f2(bO.mc)}) -> candidate ${cm(cO)} cm, corr ${co(cO)} (mean ${f2(cO.mc)})`);
  let verdict = 'no new sittings yet', ok = false;
  if (nw.length) {
    const bN = stats(P(nw, base)), cN = stats(P(nw, cand)), better = nw.filter((s) => stats(cand.get(s)).mc > stats(base.get(s)).mc).length;
    console.log(`pooled NEW: baseline ${cm(bN)} cm, corr ${co(bN)} (mean ${f2(bN.mc)}) -> candidate ${cm(cN)} cm, corr ${co(cN)} (mean ${f2(cN.mc)}), better on ${better}/${nw.length}`);
    console.log(`  deployed on new sittings vs its own LOSO: corr ${co(bN)} vs ${dep.calib.errors['learned, laptop only'].corr.join('/')} (domain shift check)`);
    const why = [];
    if (nw.length < MIN_NEW) why.push(`need >= ${MIN_NEW} new sittings (with 1, the candidate = deployed on it)`);
    if (cN.mc - bN.mc < GAIN) why.push(`new mean corr +${f2(cN.mc - bN.mc)} < +${GAIN}`);
    cN.rms.forEach((x, a) => { if (x > bN.rms[a] * (1 + RMS_TOL)) why.push(`${'xyz'[a]} rms worse ${bN.rms[a].toFixed(2)} -> ${x.toFixed(2)}`); });
    if (better < Math.ceil(nw.length * 2 / 3)) why.push(`better on only ${better}/${nw.length}`);
    if (bO.mc - cO.mc > OLD_TOL) why.push(`old mean corr down ${f2(bO.mc - cO.mc)}`);
    ok = !why.length; verdict = ok ? 'CLEARLY BETTER -> candidate written' : 'keep deployed: ' + why.join('; ');
  }
  console.log('verdict: ' + verdict);
  const summary = { time, deployed: dep.calib.session, old: old.length, new: nw.map((s) => ({ name: s.name, windows: s.ws.length, base: stats(base.get(s)), cand: stats(cand.get(s)) })), pooledOld: { base: bO, cand: cO }, verdict, ok };
  fs.mkdirSync(OUTDIR, { recursive: true }); fs.writeFileSync(path.join(OUTDIR, 'last.json'), JSON.stringify(summary, null, 1));
  if (ok) writeCandidate(dep, pool, cand, wsC);
  return summary;
}

function writeCandidate(dep, pool, cand, wsC) {
  const W = fitW(pool.flatMap((s) => wsC.get(s))), preds = pool.map((s) => cand.get(s)), allP = preds.flat(), r2 = (x) => +x.toFixed(2);
  // display scale, nested: the scale for sitting i comes from the other sittings' LOSO predictions (as scale_loso.js)
  const ampOf = (pairs) => stats(pairs).amp, sz = ampOf(allP);
  const nested = (fk) => pool.flatMap((_, i) => { const a = ampOf(preds.filter((__, j) => j !== i).flat()); return preds[i].map((q) => ({ p: q.p.map((v, k) => v * fk(a[k])), y: q.y })); });
  const st0 = stats(allP), sh = stats(nested((a) => 1 / Math.sqrt(a))), sm = stats(nested((a) => 1 / a));
  const pack = (st, k) => ({ k: k.map((v) => +v.toFixed(3)), rms: st.rms.map(r2), size: st.amp.map(r2) });
  const names = pool.map((s) => s.date || s.name);
  const c = { ...dep.calib, session: `default (${pool.length} sittings, leave-one-out)`, learned: { laptop: { idx: [0, 1, 2, 3], W: W.map((r) => r.map((x) => +x.toFixed(6))) }, all: null },
    errors: { 'learned, laptop only': { rms: st0.rms.map(r2), motion: st0.motion.map(r2), corr: st0.corr.map(r2) } },
    note: dep.calib.note.replace(/leave-one-sitting-out over .*$/, 'leave-one-sitting-out over ' + names.join(', ')),   // keeps the repo's wording (Korean or English)
    amp: { method: `leave-one-sitting-out over ${pool.length} sittings, scale estimated without the held-out sitting`, corr: st0.corr.map(r2), motion: st0.motion.map(r2),
      modes: { mse: pack(st0, [1, 1, 1]), half: pack(sh, sz.map((v) => 1 / Math.sqrt(v))), matched: pack(sm, sz.map((v) => 1 / v)) } } };
  fs.writeFileSync(path.join(OUTDIR, 'candidate.calib.json'), JSON.stringify(c, null, 1));
  let t = dep.text.replace(dep.json, () => JSON.stringify(c));
  if (CAND) {   // tracker settings in the worklet (must match what the map was trained on)
    const before = t;
    t = t.replace(/this\.lpHz = \d+(\.\d+)?; this\.tauS = p\.tauS \|\| [\d.]+; this\.gate = p\.gate \|\| [\d.]+;/,`this.lpHz = ${PRMC.lpHz}; this.tauS = p.tauS || ${PRMC.tauS}; this.gate = p.gate || ${PRMC.gate};`)
      .replace('s.noise = xs[Math.floor(0.25 * (xs.length - 1))]', `s.noise = xs[Math.floor(${PRMC.pct} * (xs.length - 1))]`);
    if (t === before || (PRMC.pct !== 0.25 && !t.includes(`xs[Math.floor(${PRMC.pct} *`))) throw new Error('worklet tracker line not found / not patched');
  }
  t = t.replace(/label: ?'Laptop only \([^)]*\)'/, `label: 'Laptop only (${pool.length} sittings)'`).replace(/leave-one-sitting-out over \d+ sittings'/, `leave-one-sitting-out over ${pool.length} sittings'`).replace(/learned on \w+ webcam-taught sittings/g, `learned on ${pool.length} webcam-taught sittings`);
  const out = path.resolve(OUTDIR, 'bat3d.js'); fs.writeFileSync(out, t);
  delete require.cache[require.resolve(out)]; const B = require(out);   // the patched module must load and carry the new W
  const ok = JSON.stringify(B.DEFAULT_CALIB.galaxy.learned.laptop.W) === JSON.stringify(c.learned.laptop.W);
  console.log(`candidate: ${out} (${ok ? 'loads, W matches' : 'LOAD CHECK FAILED'}) | half k ${c.amp.modes.half.k.join('/')} | rms ${c.amp.modes.half.rms.join('/')} cm | corr ${c.amp.corr.join('/')}`);
}

module.exports = { listSittings, readDeployed, features, fitW, stats, PRM, PRMC };
if (require.main !== module) { /* used as a library */ } else if (process.argv.includes('--watch')) {
  const POLL = Number(process.env.POLL || 20) * 1000; let sig = null, busy = false;
  const tick = async () => { if (busy) return; busy = true;
    try { const L = listSittings(readDeployed()), s = L.nw.map((b) => b + ['.json', '.wav', '_vision.csv', '_vision_full.csv', '_holo.csv'].map((x) => (fs.existsSync(b + x) ? stamp(b + x) : '-')).join(',')).join('|'); if (s !== sig) { sig = s; await runOnce(); } }
    catch (e) { console.log('error: ' + e.message); } finally { busy = false; } };
  console.log(`watching ${COMPARE_DIR} every ${POLL / 1000} s`); tick(); setInterval(tick, POLL);
} else runOnce().catch((e) => { console.error(e); process.exit(1); });
