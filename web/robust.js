/* Bat Ears robustness helpers (bravo). Drop-in for web/dsp.js; also loads in Node for tests.
 *
 * window.BatRobust
 *   AdaptiveFloor        rolling median + MAD of a dB value, learned only from quiet frames
 *   RobustDetector       adaptive thresholds + impulse veto + hysteresis state machine (+ wave)
 *   foreignToneMask()    find other laptops' / other teams' tones inside our Doppler band
 *   chooseFrequency()    pick the carrier from a sweep: SNR, stability, foreign tones, audibility
 *   autoVolume()         lowest volume that still reaches the target SNR (quieter, less distortion)
 *   audibleLeak()        speaker distortion check: does the tone create audible components?
 *   dualVote()           two-tone agreement: real motion shifts both carriers the same way
 *   clipFraction(), agcSuspect()
 *
 * Frame input for RobustDetector.update() (all from dsp.js measure()):
 *   { t: ms, up: dB rel. carrier, down: dB rel. carrier, noise: dB (far band), snr: dB, v: m/s (+ = toward) }
 */
(function (root) {
  'use strict';

  const sortNum = (a) => Float64Array.from(a).sort();
  const medianOf = (s) => (s.length ? s[s.length >> 1] : NaN);
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  // ------------------------------------------------------------ 1. adaptive floor
  // Median/MAD over the last `size` QUIET frames. Robust to the occasional spike, follows slow drift
  // (people sitting down, laptop moved, mic gain changes) without learning the gestures themselves.
  // Window is limited both by count (`size`) and by time (`windowMs`), so it spans ~4 s at any frame rate.
  class AdaptiveFloor {
    constructor({ size = 300, windowMs = 4000, keep = 20, minSpread = 0.4 } = {}) {
      this.size = size; this.windowMs = windowMs; this.keep = keep; this.minSpread = minSpread;
      this.xs = []; this.ts = []; this.dirty = true;
      this._level = NaN; this._spread = minSpread;
    }
    get n() { return this.xs.length; }
    push(x, t) {
      if (!Number.isFinite(x)) return;
      this.xs.push(x); this.ts.push(Number.isFinite(t) ? t : -Infinity);
      while (this.xs.length > this.size) { this.xs.shift(); this.ts.shift(); }
      if (Number.isFinite(t)) {
        while (this.xs.length > this.keep && this.ts[0] < t - this.windowMs) { this.xs.shift(); this.ts.shift(); }
      }
      this.dirty = true;
    }
    _update() {
      if (!this.dirty) return;
      const s = sortNum(this.xs);
      const med = medianOf(s);
      const dev = sortNum(Array.from(s, (x) => Math.abs(x - med)));
      this._level = med;
      this._spread = Math.max(this.minSpread, 1.4826 * medianOf(dev));
      this.dirty = false;
    }
    get ready() { return this.n >= 20; }
    get level() { this._update(); return this._level; }
    get spread() { this._update(); return this._spread; } // ~ standard deviation
    // dB rise needed to count as "above the floor": at least minDb, or k sigma on a noisy laptop.
    rise(k, minDb) { return Math.max(minDb, k * this.spread); }
  }

  // ------------------------------------------------------------ 2+3. detector
  const DEFAULTS = {
    onDb: 6,            // rise over the adaptive floor that starts a gesture (floor if the laptop is quiet)
    offDb: 3,           // must fall below this to re-arm (hysteresis: on > off)
    kOn: 4, kOff: 2,    // ...or k * sigma of the floor, whichever is larger
    margin: 3,          // winning side must beat the other side by this (dB)
    // Timing is in ms so 30 / 60 / 120 Hz screens (requestAnimationFrame rate) behave the same.
    confirm: 2,         // candidate frames before firing (at least)...
    confirmMs: 15,      // ...and the candidate must have lasted this long
    release: 2,         // quiet frames before re-arming (at least)...
    releaseMs: 50,      // ...and quiet for this long
    learnEveryMs: 15,   // floors learn at most one sample per 15 ms (240 samples ~ 3.6 s at any fps)
    refractoryMs: 450,
    oppositeLockMs: 600, // the hand coming back after a push looks like a pull: ignore it...
    oppositeOverrideDb: 6, // ...unless it is clearly stronger than an ordinary return
    maxEventMs: 1500,   // longer than this = a body moving / someone walking by, not a gesture
    minSnr: 15,
    impulseRiseDb: 6,   // far band (600-1200 Hz away) rising this much = clap, speech, music hit
    impulseHoldMs: 250,
    waveFlips: 2,       // direction changes inside one event that make it a 'wave'
    stuckMs: 4000,      // still 'active' after this long: re-learn the floor so we cannot lock up
    onsetDb: 4,         // must have risen this much within the last onsetMs (fast onset = intent)
    onsetMs: 150,
    floorSize: 300,     // max samples per floor
    floorMs: 4000,      // ...and at most this much history
  };

  class RobustDetector {
    constructor(opt = {}) {
      this.o = { ...DEFAULTS, ...opt };
      this.fUp = new AdaptiveFloor({ size: this.o.floorSize, windowMs: this.o.floorMs });
      this.fDn = new AdaptiveFloor({ size: this.o.floorSize, windowMs: this.o.floorMs });
      this.fNoise = new AdaptiveFloor({ size: this.o.floorSize, windowMs: this.o.floorMs });
      this.reset();
    }
    reset() {
      this.state = 'idle'; this.cand = null; this.candN = 0; this.quietN = 0;
      this.lastFire = -1e9; this.lastKind = null; this.vetoUntil = -1e9;
      this.evStart = 0; this.evKind = null; this.disp = 0; this.flips = 0; this.side = 0; this.waved = false;
      this.prevT = null; this.stats = { vetoes: 0, longEvents: 0, oppositeBlocked: 0 };
      this.hist = []; this.candSince = 0; this.quietSince = null; this.lastLearn = -1e9; this.lastNoiseLearn = -1e9;
    }
    // Feed calibration frames (hand away). Never fires. Pass `t` (ms, same clock as update) if you can;
    // otherwise performance.now() is used, which matches dsp.js.
    learn(f) { const t = Number.isFinite(f.t) ? f.t : nowMs(); this._learnUpDn(f, t); this._learnNoise(f, t); }
    _learnUpDn(f, t) {
      if (t - this.lastLearn < this.o.learnEveryMs) return;
      this.lastLearn = t;
      this.fUp.push(f.up, t); this.fDn.push(f.down, t);
    }
    _learnNoise(f, t) {
      if (t - this.lastNoiseLearn < this.o.learnEveryMs) return;
      this.lastNoiseLearn = t;
      this.fNoise.push(f.noise, t);
    }

    excess(f) {
      return { up: f.up - this.fUp.level, dn: f.down - this.fDn.level, noise: f.noise - this.fNoise.level };
    }

    update(f) {
      const o = this.o;
      const dt = this.prevT == null ? 0 : Math.min(100, f.t - this.prevT) / 1000;
      this.prevT = f.t;
      if (!this.fUp.ready) { this.learn(f); return null; }
      const e = this.excess(f);
      const onUp = this.fUp.rise(o.kOn, o.onDb), onDn = this.fDn.rise(o.kOn, o.onDb);
      const offUp = this.fUp.rise(o.kOff, o.offDb), offDn = this.fDn.rise(o.kOff, o.offDb);

      // impulse veto: broadband events also lift the far band, hand Doppler does not
      if (this.fNoise.ready && e.noise > this.fNoise.rise(3, o.impulseRiseDb)) {
        if (f.t >= this.vetoUntil) this.stats.vetoes++;
        this.vetoUntil = f.t + o.impulseHoldMs;
      }
      const vetoed = f.t < this.vetoUntil;
      const snrOk = !(f.snr < o.minSnr);
      // The far-band floor always learns: a 60 ms clap barely moves a 4 s median, but continuous
      // music or chatter becomes the new normal after ~2 s instead of vetoing forever.
      this._learnNoise(f, f.t);

      // onset sharpness: a deliberate push/pull rises within ~150 ms; a person walking by or a slow
      // body sway creeps up over seconds. Compare with the minimum over the last onsetMs.
      this.hist.push({ t: f.t, up: e.up, dn: e.dn });
      while (this.hist.length > 1 && this.hist[0].t < f.t - o.onsetMs) this.hist.shift();
      let minUp = Infinity, minDn = Infinity;
      for (const h of this.hist) { if (h.up < minUp) minUp = h.up; if (h.dn < minDn) minDn = h.dn; }
      const riseUp = e.up - minUp, riseDn = e.dn - minDn;

      let c = null;
      if (!vetoed && snrOk) {
        if (e.up > onUp && e.up - e.dn > o.margin && riseUp >= o.onsetDb) c = 'push';
        else if (e.dn > onDn && e.dn - e.up > o.margin && riseDn >= o.onsetDb) c = 'pull';
        // once a candidate is running, keep it alive without re-checking the onset
        else if (this.cand === 'push' && e.up > onUp && e.up - e.dn > o.margin) c = 'push';
        else if (this.cand === 'pull' && e.dn > onDn && e.dn - e.up > o.margin) c = 'pull';
      }
      const quiet = e.up < offUp && e.dn < offDn;
      let out = null;

      if (this.state === 'idle') {
        if (c && c === this.cand) this.candN++; else { this.cand = c; this.candN = c ? 1 : 0; this.candSince = f.t; }
        if (c && this.candN >= o.confirm && f.t - this.candSince >= o.confirmMs && f.t - this.lastFire >= o.refractoryMs) {
          const strength = c === 'push' ? e.up : e.dn;
          const opposite = this.lastKind && c !== this.lastKind && f.t - this.lastFire < o.oppositeLockMs;
          if (opposite && strength < (c === 'push' ? onUp : onDn) + o.oppositeOverrideDb) {
            this.stats.oppositeBlocked++;
            this.state = 'active'; this.evStart = f.t; this.evKind = null; // swallow the return stroke
          } else {
            out = { kind: c, t: f.t, strength: +strength.toFixed(1), speed: +Math.abs(f.v || 0).toFixed(2) };
            this.lastFire = f.t; this.lastKind = c;
            this.state = 'active'; this.evStart = f.t; this.evKind = c;
            this.disp = 0; this.flips = 0; this.side = c === 'push' ? 1 : -1; this.waved = false;
          }
          this.cand = null; this.candN = 0; this.quietN = 0; this.quietSince = null;
        } else if (!c && !vetoed) {
          // idle, non-candidate frames teach the up/down floors (the median shrugs off gesture tails)
          this._learnUpDn(f, f.t);
        }
      } else { // active: one event per burst; wait for quiet frames to re-arm
        this.disp += (f.v || 0) * dt;
        const s = e.up > onUp && e.up - e.dn > o.margin ? 1 : e.dn > onDn && e.dn - e.up > o.margin ? -1 : 0;
        if (s && this.side && s !== this.side) { this.flips++; this.side = s; }
        if (this.evKind && !this.waved && this.flips >= o.waveFlips) {
          this.waved = true;
          out = { kind: 'wave', t: f.t, flips: this.flips };
        }
        if (f.t - this.evStart > o.maxEventMs && this.evKind !== 'long') { this.evKind = 'long'; this.stats.longEvents++; }
        // stuck (level stepped up for good, e.g. a new reflector or interference): let the floor follow
        if (f.t - this.evStart > o.stuckMs) this._learnUpDn(f, f.t);
        if (quiet) { this.quietN++; if (this.quietSince == null) this.quietSince = f.t; } else { this.quietN = 0; this.quietSince = null; }
        if (this.quietN >= o.release && f.t - this.quietSince >= o.releaseMs) {
          this.state = 'idle'; this.quietN = 0; this.quietSince = null;
        }
      }
      return out;
    }
  }

  // ------------------------------------------------------------ 4. foreign tones
  // spectra: dB arrays (getFloatFrequencyData) captured during calibration. Returns a Set of signed bin
  // offsets from the carrier bin kp that hold a persistent narrow peak (another device's tone).
  function foreignToneMask(spectra, kp, G, W, { prominenceDb = 10, persist = 0.6, widen = 2 } = {}) {
    const hits = new Map();
    for (const a of spectra) {
      for (let i = G; i <= W; i++) {
        for (const sgn of [1, -1]) {
          const k = kp + sgn * i, v = a[k];
          if (!Number.isFinite(v)) continue;
          const nb = [];
          for (let j = 3; j <= 6; j++) { if (Number.isFinite(a[k - j])) nb.push(a[k - j]); if (Number.isFinite(a[k + j])) nb.push(a[k + j]); }
          nb.sort((x, y) => x - y);
          const ref = nb.length ? nb[nb.length >> 1] : v;
          if (v - ref > prominenceDb) hits.set(sgn * i, (hits.get(sgn * i) || 0) + 1);
        }
      }
    }
    const mask = new Set();
    for (const [off, n] of hits) {
      if (n / spectra.length >= persist) for (let d = -widen; d <= widen; d++) mask.add(off + d);
    }
    return mask;
  }

  // ------------------------------------------------------------ 5. frequency choice
  // cands: [{ f, snr, snrSd?, foreignDb?, leakDb? }]   (from a sweep; foreignDb measured with OUR tone off)
  function audibilityPenalty(f) {
    if (f < 17500) return 12;  // clearly audible to most students
    if (f < 18500) return 6;
    if (f < 19500) return 3;
    if (f < 20000) return 1;
    return 0;
  }
  // snrCap: above ~35 dB more SNR buys little, so audibility decides (students hear 18 kHz).
  // foreignDb: strongest peak within +/-700 Hz (our tone OFF) over the local noise median. Plain noise
  // already gives a few dB here (max of many bins), so only the part above 6 dB is penalized.
  function chooseFrequency(cands, { minSnr = 25, maxForeignDb = 12, snrCap = 35 } = {}) {
    const table = cands.map((c) => {
      const ok = c.snr >= minSnr && !((c.foreignDb || 0) > maxForeignDb) && !((c.leakDb || 0) > 10);
      const score = Math.min(c.snr, snrCap) - 2 * (c.snrSd || 0) - 0.5 * Math.max(0, (c.foreignDb || 0) - 6)
        - audibilityPenalty(c.f) - 0.5 * Math.max(0, c.leakDb || 0);
      return { ...c, ok, score: +score.toFixed(1) };
    });
    const pool = table.filter((r) => r.ok).sort((a, b) => b.score - a.score || b.f - a.f);
    return { f: pool.length ? pool[0].f : null, table, reason: pool.length ? 'best score' : 'no frequency passes minSnr / foreign-tone checks' };
  }

  // ------------------------------------------------------------ 6. auto volume
  // setVolume(v); readSnr() -> Promise<number> (median SNR over ~300 ms after the change)
  async function autoVolume({ setVolume, readSnr, target = 32, lo = 0.05, hi = 1.0, steps = 6 }) {
    let best = hi;
    for (let s = 0; s < steps; s++) {
      const mid = (lo + hi) / 2;
      setVolume(mid);
      const snr = await readSnr();
      if (snr >= target) { best = mid; hi = mid; } else lo = mid;
    }
    setVolume(best);
    return best;
  }

  // ------------------------------------------------------------ 7. audible leak
  // Cheap speakers make audible distortion (clicks, sub-harmonics, two-tone difference tones).
  // Compare tone-on vs tone-off spectra below fMax; report narrow components that appear.
  function audibleLeak(onDb, offDb, binHz, { fMin = 200, fMax = 15000, riseDb = 10 } = {}) {
    const out = [];
    for (let k = Math.ceil(fMin / binHz); k <= Math.floor(fMax / binHz) && k < onDb.length; k++) {
      const d = onDb[k] - offDb[k];
      if (d > riseDb && onDb[k] >= onDb[k - 1] && onDb[k] >= onDb[k + 1]) out.push({ f: Math.round(k * binHz), riseDb: +d.toFixed(1) });
    }
    return { leaks: out.slice(0, 10), worstDb: out.reduce((m, x) => Math.max(m, x.riseDb), 0) };
  }

  // ------------------------------------------------------------ 8. dual-tone vote
  // a, b: per-tone excess { up, dn, on (threshold), v } computed like RobustDetector.excess().
  // Real motion shifts BOTH carriers in the same direction with the same speed v = df*c/(2f).
  function dualVote(a, b, { strongDb = 6, speedTol = 0.5 } = {}) {
    const dir = (x) => (x.up > x.on && x.up > x.dn ? 1 : x.dn > x.on && x.dn > x.up ? -1 : 0);
    const da = dir(a), db = dir(b);
    if (da && da === db) {
      const vs = [Math.abs(a.v), Math.abs(b.v)];
      const agree = Math.min(...vs) / Math.max(1e-6, Math.max(...vs)) >= speedTol;
      return { dir: da, agree, rule: agree ? 'both' : 'both-dir' };
    }
    if (da && !db) { const e = da > 0 ? a.up : a.dn; if (e > a.on + strongDb) return { dir: da, agree: false, rule: 'a-strong' }; }
    if (db && !da) { const e = db > 0 ? b.up : b.dn; if (e > b.on + strongDb) return { dir: db, agree: false, rule: 'b-strong' }; }
    return { dir: 0, agree: false, rule: da && db ? 'conflict' : 'none' };
  }

  // ------------------------------------------------------------ 9. input sanity
  function clipFraction(timeData, lim = 0.98) {
    let n = 0;
    for (let i = 0; i < timeData.length; i++) if (Math.abs(timeData[i]) >= lim) n++;
    return n / Math.max(1, timeData.length);
  }
  // carrier dB during calibration: AGC on -> level wanders or ramps
  function agcSuspect(carrierDb, { sdDb = 1.5, rampDb = 3 } = {}) {
    const x = carrierDb.filter(Number.isFinite);
    if (x.length < 10) return false;
    const m = x.reduce((s, v) => s + v, 0) / x.length;
    const sd = Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / x.length);
    const q = Math.max(1, Math.floor(x.length / 4));
    const head = x.slice(0, q).reduce((s, v) => s + v, 0) / q, tail = x.slice(-q).reduce((s, v) => s + v, 0) / q;
    return sd > sdDb || Math.abs(tail - head) > rampDb;
  }

  const api = { AdaptiveFloor, RobustDetector, DEFAULTS, foreignToneMask, chooseFrequency, audibilityPenalty,
    autoVolume, audibleLeak, dualVote, clipFraction, agcSuspect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BatRobust = api;
})(typeof window !== 'undefined' ? window : globalThis);
