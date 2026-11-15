/* Bat Ears engine: ultrasonic Doppler push/pull detection in the browser (Web Audio).
 *
 * window.BatEars
 *   start({ freq, raw, stereo }) -> Promise<boolean>  open the mic, play the tone, start detecting.
 *                          stereo: true plays a different tone on each speaker (config.stereoFreqs) and adds
 *                          'left' / 'right' swipe gestures (experimental; depends on the laptop's speakers)
 *   stop()                 -> Promise<object>   stop and return a summary
 *   bandCheck()            -> Promise<Array>    short sweep, SNR per frequency
 *   captureStart() -> Promise<boolean>; captureStop() -> Promise<{ blob, rate, channels, seconds, t0, capped } | null>
 *                          raw mic recording (16-bit WAV, every mic channel; t0 = performance.now() of sample 0)
 *   setFreq(hz), setVolume(0..1)
 *   on(type, fn) -> unsubscribe;  off(type, fn)
 *   config                 tunables (threshold, margin, minSnr, ...)
 *   info                   mic / audio-context info after start
 *   drawZoom(canvas), drawWide(canvas)
 *
 * events
 *   'gesture' { kind: 'push' | 'pull' | 'wave' | 'left' | 'right', speed (m/s, recent peak), strength (dB), t (ms), simulated }
 *   'frame'   { t, tone, calibrating, dUp, dDown, up, down, v, snr, carrier, noise, bandsUp[6], bandsDown[6],
 *               thUp, thDown }   thUp/thDown = current thresholds (rise automatically in noisy rooms)
 *   'state'   { running, tone, calibrating, busy }
 *   'error'   { where, name, message }
 *   'burst'   { t, start, feat, capped }  stereo only: a motion burst ended; feat = swipe.js features
 *               (v3: { ilatC, idep, bip, ilat, latPk, depPk, nC, n, ms }; the left/right check learns from these)
 *   'foreign' { t, tones: [kHz, ...] }  another ultrasonic tone (e.g. a second laptop running Bat Ears) has been
 *               audible for 1 s, or the list changed / cleared ([]). Also readable as BatEars.foreign.
 *
 * Keyboard simulation (no mic needed): ArrowUp = push, ArrowDown = pull, ArrowLeft/Right = swipe, W = wave.
 */
(function () {
  'use strict';

  const C = 343; // speed of sound, m/s
  // Sub-band edges (Hz offset from the carrier) used for the per-frame feature vector.
  const SUB_EDGES = [25, 50, 80, 120, 170, 230, 300];

  const config = {
    // 'burst' (default): bravo's adaptive floors + decide each burst by its LARGEST hand speed. Real recordings
    //   showed people wind up before a pull and swing back after a push; first-crossing rules got 15% of
    //   prompts right, this rule 80% (ml/replay_burst.py). 'robust' = RobustDetector's own decisions; 'v2' = old rules.
    detector: 'burst',
    // rejectCapped: a burst that runs into maxMs without an early fire is body motion, not a gesture
    //   (robust.js's long-event idea; on real data it cut false triggers 4.5 -> 3.0 per minute, hits unchanged)
    // vetoSnrDb: robust.js's impulse veto only counts while the far band is within this many dB of the tone. In a
    //   very quiet room the far band sits 60-80 dB under the tone and a fast hand's own spill "lifts" it 6 dB, which
    //   vetoed real gestures (a 35 cm session: 0/20 -> 17/20 without it; all sessions 52% -> 73%, ml/replay_burst.py)
    // slowGuard (bravo): a push/pull decided only at the end of a WEAK burst (peak < peak dB) fires only if the echo was
    //   quiet in the second before (activity < preAct; typing keeps it busy) and the bulk of the echo moved (energy-weighted
    //   |v| >= wv). Recordings: false triggers 2.0 -> 1.2 per minute, hits and wrong unchanged (ml/replay_burst.py)
    burst: { aOn: 12, vFire: 1.3, vMin: 0.9, gapMs: 120, maxMs: 900, waveFlips: 3, lockMs: 150, rejectCapped: true, vetoSnrDb: 50,
      slowGuard: { peak: 15, preAct: 0.3, wv: 0.4 } },
    // wave: bravo's BatWave.WaveDetector (wave.js) when loaded: 4 alternating fast lobes (|v| >= 0.8, peaks <= 300 ms
    //   apart) within 1.2 s. It replaces the burst rule's 3-flips wave; push/pull while waving are its own strokes and are
    //   dropped. Recordings: 3/3 wave episodes (was 2/3), 0 false waves on 135 push/pulls, 44 swipes, 2.5 quiet min.
    //   null = BatWave.DEFAULTS
    wave: null,
    threshold: 6,        // dB above baseline that counts as motion (floor; see autoK)
    autoK: 4,            // the threshold also rises to autoK x the measured idle wobble (noisy rooms)
    waveFlips: 4,        // direction flips within waveWindowMs that count as a wave (repeated pushes are slower)
    waveWindowMs: 1000,
    holdFlipMs: 350,     // two flips this close together = fast back-and-forth, so hold push/pull
    // stereo mode: left speaker tone, right speaker tone (Hz). 18/19.5 kHz: laptop speakers are louder there than at
    // 20.5 kHz, and the 1.5 kHz gap keeps both Doppler skirts (+-300 Hz) apart
    stereoFreqs: [18000, 19500],
    // stereo decisions: 'velocity' (default) = per burst: push/pull by forward speed (vL + vR)/2 like the mono
    // burst rule, left/right by swipe.js + config.lrModel; 'energy' = the older threshold rule
    stereoDetector: 'velocity',
    // left/right: a sideways hand barely changes the instantaneous sideways speed (lat ~0.2 x hand speed, bravo's
    // physics model), so each burst is judged as a whole by window.BatSwipe (swipe.js: ilat = integral of lat,
    // v3: offset-corrected ilatC, net depth idep, two-way share bip; push/pull learned as a class) with a model from the
    // left/right check of this sitting:
    // { pair: [fl, fr], model }. null (or another tone pair) = no usable left/right here, so none fire.
    lrModel: null,
    swapLR: false,       // flip left/right if a laptop's channels are wired the other way
    stereoConfirmMs: 30, // stereo: a candidate must last this long (both tones agree)...
    oneSidedMs: 80,      // ...or this long when only one tone moved (lets the other side catch up)
    waveMinV: 0.12,      // m/s; slower wiggles don't count toward a wave
    margin: 3,           // dB the winning side must beat the other side by
    minSnr: 15,          // dB; below this the echo is too weak to trust
    confirmFrames: 2,    // consecutive frames before a gesture fires
    refractoryMs: 450,   // minimum gap between two gestures
    settleMs: 300,       // ignore this long after the tone starts (fade-in)
    calibMs: 1500,       // baseline window after the tone starts
    guardHz: 25,         // skip the carrier's own skirt
    bandHz: 300,         // Doppler window on each side of the carrier
    noiseNearHz: 600,    // SNR reference band
    noiseFarHz: 1200,
    fftSize: 8192,
    foreignDb: 30,       // a narrow peak this far above the 15-23 kHz floor that isn't ours = another device's tone
    volume: 0.6,
    keyboard: true,      // ArrowUp / ArrowDown simulate gestures
  };

  const listeners = {};
  const st = {
    ctx: null, osc: null, gain: null, stream: null, analyser: null, data: null,
    raf: 0, running: false, tone: false, busy: false, raw: true,
    f0: 20000, binHz: 0, G: 0, W: 0,
    calibFrom: 0, calibUntil: 0, calib: null, base: null, noiseBase: null, wasCalibrating: false,
    cand: null, candFrames: 0, lastFire: 0,
    wobble: { up: 1, down: 1 }, vHist: [], flips: [], lastSign: 0, lastWave: 0,
    last: null, agg: null, counts: { push: 0, pull: 0, wave: 0 },
    // stereo mode (left/right swipes): one tone per speaker, analysed separately
    stereo: false, oscL: null, oscR: null, gainL: null, gainR: null, sch: null, lastR: null, scand: null, scandFrames: 0,
    scandSince: 0, prevStereoT: 0,
    burst: null, burstLock: 0, sburst: null, sburstLock: 0,
  };

  // Mono detector from robust.js (adaptive floor, impulse veto, hysteresis, return-stroke lock, wave).
  function makeRobust() {
    if (config.detector === 'v2' || !window.BatRobust) return null;
    return new window.BatRobust.RobustDetector({
      onDb: config.threshold, margin: config.margin, minSnr: config.minSnr,
      confirm: config.confirmFrames, refractoryMs: config.refractoryMs,
    });
  }

  function newChan(f) { return { f, ups: [], downs: [], noises: [], base: null, wobble: { up: 1, down: 1 }, noiseBase: null }; }
  function chanThresholds(ch) {
    return { up: Math.max(config.threshold, config.autoK * ch.wobble.up), down: Math.max(config.threshold, config.autoK * ch.wobble.down) };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dbv = (a, k) => (k >= 0 && k < a.length && Number.isFinite(a[k])) ? a[k] : -200;
  const lin = (db) => Math.pow(10, db / 10);
  const toDb = (x) => 10 * Math.log10(x);

  function median(vals) {
    if (!vals.length) return NaN;
    const s = Float64Array.from(vals).sort();
    return s[s.length >> 1];
  }

  function on(type, fn) {
    (listeners[type] = listeners[type] || []).push(fn);
    return () => off(type, fn);
  }
  function off(type, fn) {
    const a = listeners[type];
    if (!a) return;
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  function emit(type, payload) {
    (listeners[type] || []).slice().forEach((fn) => {
      try { fn(payload); } catch (e) { console.error('[BatEars] listener error', e); }
    });
  }

  function snapshot(now = performance.now()) {
    return { running: st.running, tone: st.tone, calibrating: st.tone && now < st.calibUntil, busy: st.busy };
  }

  // ---------------------------------------------------------------- analysis
  function peakNear(a, k0, span) {
    let kp = k0, best = -Infinity;
    for (let k = k0 - span; k <= k0 + span; k++) {
      const v = dbv(a, k);
      if (v > best) { best = v; kp = k; }
    }
    return kp;
  }

  function localNoise(a, kp) {
    const near = Math.ceil(config.noiseNearHz / st.binHz), far = Math.ceil(config.noiseFarHz / st.binHz), vals = [];
    for (let k = kp - far; k <= kp - near; k++) { const v = dbv(a, k); if (v > -199) vals.push(v); }
    for (let k = kp + near; k <= kp + far; k++) { const v = dbv(a, k); if (v > -199) vals.push(v); }
    return median(vals);
  }

  // Another laptop running Bat Ears (or any ultrasonic beacon) puts its tone, and its Doppler echoes off our hand,
  // into our bands; a real session where that seems to have happened scored 1/20. Look for narrow peaks between
  // 15 and 23 kHz that are not ours (our tones, their Doppler skirt, and the stereo pair's intermodulation).
  function ownTones() {
    if (st.stereo && st.sch) {
      const a = st.sch.L.f, b = st.sch.R.f;
      return [a, b, 2 * a - b, 2 * b - a];
    }
    return [st.f0];
  }
  function scanForeign(a, now) {
    const lo = Math.ceil(15000 / st.binHz), hi = Math.min(a.length - 5, Math.floor(23000 / st.binHz));
    if (hi <= lo + 10) return;
    const vals = [];
    for (let k = lo; k <= hi; k++) vals.push(dbv(a, k));
    const floor = median(vals), own = ownTones(), seen = st.foreignSeen;
    for (let k = lo + 4; k <= hi - 4; k++) {
      const v = dbv(a, k);
      if (v < floor + config.foreignDb || v < dbv(a, k - 1) || v < dbv(a, k + 1)) continue; // tall local max
      if (v - dbv(a, k - 4) < 10 || v - dbv(a, k + 4) < 10) continue;                      // narrow = a tone
      const f = k * st.binHz;
      if (own.some((o) => Math.abs(f - o) < 450)) continue;
      const key = Math.round(f / 100) / 10;
      const e = seen.get(key) || { first: now, last: now };
      e.last = now;
      seen.set(key, e);
    }
    const list = [];
    seen.forEach((e, key) => {
      if (now - e.last > 1500) seen.delete(key);
      else if (e.last - e.first >= 1000) list.push(key);
    });
    list.sort((x, y) => x - y);
    if (list.join() !== api.foreign.join()) {
      api.foreign = list;
      emit('foreign', { t: now, tones: list.slice() });
    }
  }

  // Room loudness: mean power 300-4000 Hz (speech and music), for metadata / "noisy room" detection.
  function ambientLevel(a) {
    const k1 = Math.round(300 / st.binHz), k2 = Math.round(4000 / st.binHz);
    let p = 0;
    for (let k = k1; k <= k2; k++) p += lin(dbv(a, k));
    return toDb(p / Math.max(1, k2 - k1 + 1));
  }

  // Carrier level, noise floor, and echo energy just above / below the carrier (dB relative to the carrier).
  function measure(a, f0) {
    const { binHz, G, W } = st;
    const kp = peakNear(a, Math.round(f0 / binHz), 3);
    const carrier = dbv(a, kp), noise = localNoise(a, kp);
    const cL = lin(carrier);
    const subUp = new Array(SUB_EDGES.length - 1).fill(0), subDn = new Array(SUB_EDGES.length - 1).fill(0);
    let upL = 0, dnL = 0, num = 0, den = 0;
    for (let i = G; i <= W; i++) {
      const hz = i * binHz;
      const pu = lin(dbv(a, kp + i)), pd = lin(dbv(a, kp - i));
      upL += pu; dnL += pd; num += hz * (pu - pd); den += pu + pd;
      for (let b = 0; b < SUB_EDGES.length - 1; b++) {
        if (hz >= SUB_EDGES[b] && hz < SUB_EDGES[b + 1]) { subUp[b] += pu; subDn[b] += pd; break; }
      }
    }
    return {
      kp, carrier, noise, snr: carrier - noise,
      up: toDb(upL / cL), down: toDb(dnL / cL),
      bandsUp: subUp.map((p) => toDb(p / cL)), bandsDown: subDn.map((p) => toDb(p / cL)),
      centroid: den > 0 ? num / den : 0,
    };
  }

  // ---------------------------------------------------------------- audio
  function ramp(param, value, t) {
    param.cancelScheduledValues(t);
    param.setTargetAtTime(value, t, 0.03);
  }

  function setTone(on, f) {
    const { ctx, gain, osc } = st;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (f) { st.f0 = f; osc.frequency.setValueAtTime(f, t); }
    const vol = on ? config.volume : 0;
    ramp(gain.gain, st.stereo ? 0 : vol, t);
    if (st.gainL) { ramp(st.gainL.gain, st.stereo ? vol : 0, t); ramp(st.gainR.gain, st.stereo ? vol : 0, t); }
    st.tone = on;
    if (on) {
      const now = performance.now();
      st.calibFrom = now + config.settleMs;
      st.calibUntil = now + config.calibMs;
      st.calib = { ups: [], downs: [], noises: [] };
      st.noiseBase = null;
      st.base = null;
      st.sch = { L: newChan(config.stereoFreqs[0]), R: newChan(config.stereoFreqs[1]) };
      st.robust = makeRobust(); // fresh floors for every new calibration
      st.burst = null;
      st.burstLock = 0;
      st.burstVetoUntil = 0;
      st.vetoSeen = null;
      st.sburst = null;
      st.sburstLock = 0;
      st.wave = null;
      st.act = null;
      st.wasCalibrating = true;
      emit('state', snapshot());
    }
  }

  async function start(opt = {}) {
    if (st.running) return true;
    const f0 = Number(opt.freq || st.f0 || 20000);
    const raw = opt.raw !== false;
    const stereo = !!opt.stereo;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      emit('error', { where: 'start', name: 'NoMediaDevices', message: 'getUserMedia is not available here' });
      return false;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    try { await ctx.resume(); } catch (_) { /* ignore */ }
    let stream;
    try {
      // stereo (experimental) asks for both mics of a dual-mic laptop, for the raw capture; the analyser mixes them
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: !raw, noiseSuppression: !raw, autoGainControl: !raw, channelCount: { ideal: stereo ? 2 : 1 } },
        video: false,
      });
    } catch (e) {
      emit('error', { where: 'getUserMedia', name: e.name, message: e.message });
      try { await ctx.close(); } catch (_) { /* ignore */ }
      return false;
    }
    const track = stream.getAudioTracks()[0];
    const analyser = ctx.createAnalyser();
    analyser.fftSize = config.fftSize;
    analyser.smoothingTimeConstant = 0.2;
    const src = ctx.createMediaStreamSource(stream);
    src.connect(analyser);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f0;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    // stereo pair: a different tone on each speaker (silent unless stereo mode is on)
    const merger = ctx.createChannelMerger(2);
    const oscL = ctx.createOscillator(), oscR = ctx.createOscillator();
    oscL.frequency.value = config.stereoFreqs[0];
    oscR.frequency.value = config.stereoFreqs[1];
    const gainL = ctx.createGain(), gainR = ctx.createGain();
    gainL.gain.value = 0;
    gainR.gain.value = 0;
    oscL.connect(gainL).connect(merger, 0, 0);
    oscR.connect(gainR).connect(merger, 0, 1);
    merger.connect(ctx.destination);
    oscL.start();
    oscR.start();
    const binHz = ctx.sampleRate / analyser.fftSize;
    Object.assign(st, {
      ctx, src, osc, gain, stream, analyser, data: new Float32Array(analyser.frequencyBinCount), tapLoaded: false, cap: null, iq: null,
      stereo, oscL, oscR, gainL, gainR, lastR: null, scand: null, scandFrames: 0, scandSince: 0, prevStereoT: 0,
      running: true, tone: false, busy: false, raw, f0, binHz,
      G: Math.ceil(config.guardHz / binHz), W: Math.floor(config.bandHz / binHz),
      base: null, cand: null, candFrames: 0, lastFire: 0, last: null,
      wobble: { up: 1, down: 1 }, vHist: [], flips: [], lastSign: 0, lastWave: 0,
      counts: { push: 0, pull: 0, wave: 0, left: 0, right: 0 },
      agg: { frames: 0, snrSum: 0, snrMin: Infinity, carrierSum: 0, noiseSum: 0, maxUp: -Infinity, maxDown: -Infinity },
      foreignSeen: new Map(), foreignT: 0,
    });
    api.foreign = [];
    const s = track.getSettings();
    api.info = {
      f0, raw, stereo, stereoFreqs: stereo ? config.stereoFreqs.slice() : null,
      ctxRate: ctx.sampleRate, micRate: s.sampleRate, ec: s.echoCancellation, ns: s.noiseSuppression,
      agc: s.autoGainControl, ch: s.channelCount, fft: analyser.fftSize, binHz: +binHz.toFixed(2), mic: track.label,
    };
    setTone(true);
    st.raf = requestAnimationFrame(loop);
    if (stereo) startIq();
    return true;
  }

  // bravo's live I/Q phase tracker (iq.js, LLAP-style path length per speaker tone). Logging only for now: every
  // stereo burst gets feat.pLat = (dR - dL) / 2 and feat.pDep, so the check data can compare it with v3's ilatC.
  function startIq() {
    const ctx = st.ctx, src = st.src;
    if (!window.BatIQ || !ctx || !src || st.iq) return;
    window.BatIQ.start(ctx, src, config.stereoFreqs.slice()).then((iq) => {
      if (iq && st.ctx === ctx && st.running && st.stereo && !st.iq) st.iq = iq; else if (iq) iq.stop();
    }).catch((e) => emit('error', { where: 'iq', name: e.name, message: e.message }));
  }
  function stopIq() {
    if (!st.iq) return;
    try { st.iq.stop(); } catch (_) { /* ignore */ }
    st.iq = null;
  }

  // ---- raw microphone capture: a 16-bit WAV of every mic channel, for offline work on left/right (phase tracking
  // of each tone, the second mic). t0 = performance.now() time of the first sample, so the WAV lines up with the
  // CSV rows and the trial times (tStart/tEnd) in the session JSON. Capped at CAPTURE_MAX_S.
  const CAPTURE_MAX_S = 420;
  const TAP_SRC = `class BatTap extends AudioWorkletProcessor {
  constructor() { super(); this.on = true; this.buf = null; this.n = 0; this.start = 0;
    this.port.onmessage = (e) => { if (e.data === 'stop') { this.flush(); this.on = false; } }; }
  flush() { if (this.buf && this.n) { const C = this.C; this.port.postMessage({ C, frame: this.start, data: this.buf.slice(0, this.n * C) }); } this.buf = null; this.n = 0; }
  process(inputs) {
    if (!this.on) return false;
    const ch = inputs[0];
    if (!ch || !ch.length) return true;
    const C = ch.length, N = ch[0].length;
    if (this.buf && C !== this.C) this.flush();
    if (!this.buf) { this.C = C; this.buf = new Float32Array(4096 * C); this.n = 0; this.start = currentFrame; }
    const b = this.buf, o = this.n * C;
    for (let c = 0; c < C; c++) { const x = ch[c]; for (let i = 0; i < N; i++) b[o + i * C + c] = x[i]; }
    this.n += N;
    if (this.n + N > 4096) { this.port.postMessage({ C, frame: this.start, data: b.subarray(0, this.n * C) }, [b.buffer]); this.buf = null; this.n = 0; }
    return true;
  }
}
registerProcessor('bat-tap', BatTap);`;

  // The worklet module comes from a blob: URL (https pages) or a data: URL; a page opened from a file:// path can
  // load neither, so it falls back to a ScriptProcessorNode (deprecated but still in Chrome).
  async function loadTap(ctx) {
    if (!ctx.audioWorklet) return false;
    const blobUrl = URL.createObjectURL(new Blob([TAP_SRC], { type: 'application/javascript' }));
    for (const u of [blobUrl, 'data:application/javascript;charset=utf-8,' + encodeURIComponent(TAP_SRC)]) {
      try { await ctx.audioWorklet.addModule(u); URL.revokeObjectURL(blobUrl); return true; } catch (_) { /* next */ }
    }
    URL.revokeObjectURL(blobUrl);
    return false;
  }

  async function captureStart() {
    if (!st.running || st.cap) return false;
    const ctx = st.ctx;
    try {
      if (st.tapLoaded === false) st.tapLoaded = (await loadTap(ctx)) ? true : 'no';
      const mute = ctx.createGain();
      mute.gain.value = 0;
      const cap = { node: null, mute, chunks: [], frames: 0, C: 0, rate: ctx.sampleRate, t0: null, full: false, via: '' };
      // one chunk of interleaved samples; frame = context frame of its first sample (null if unknown)
      const take = (C, frame, data) => {
        if (!cap.C) cap.C = C;
        if (C !== cap.C || cap.full || !st.cap) return;
        if (cap.t0 == null) {
          const ts = frame != null && ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
          cap.t0 = ts && ts.performanceTime > 0 ? ts.performanceTime + (frame / ctx.sampleRate - ts.contextTime) * 1000
            : performance.now() - (data.length / C / ctx.sampleRate) * 1000;
        }
        const out = new Int16Array(data.length);
        for (let i = 0; i < data.length; i++) { const x = data[i] < -1 ? -1 : data[i] > 1 ? 1 : data[i]; out[i] = x < 0 ? x * 0x8000 : x * 0x7fff; }
        cap.chunks.push(out);
        cap.frames += data.length / C;
        if (cap.frames >= CAPTURE_MAX_S * cap.rate) cap.full = true;
      };
      if (st.tapLoaded === true) {
        // channelCountMode 'max' + 'discrete': as many channels as the mic delivers, never mixed
        cap.node = new AudioWorkletNode(ctx, 'bat-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'max', channelInterpretation: 'discrete' });
        cap.node.port.onmessage = (e) => take(e.data.C, e.data.frame, e.data.data);
        cap.via = 'worklet';
      } else {
        const C = Math.max(1, Math.min(2, Number(api.info && api.info.ch) || 1));
        cap.node = ctx.createScriptProcessor(4096, C, 1);
        cap.node.channelInterpretation = 'discrete';
        cap.node.onaudioprocess = (e) => {
          const ib = e.inputBuffer, n = ib.length, k = ib.numberOfChannels, buf = new Float32Array(n * k);
          for (let c = 0; c < k; c++) { const x = ib.getChannelData(c); for (let i = 0; i < n; i++) buf[i * k + c] = x[i]; }
          take(k, null, buf);
        };
        cap.via = 'script';
      }
      st.src.connect(cap.node);
      cap.node.connect(mute).connect(ctx.destination); // keeps the tap pulled by the graph; it outputs silence
      st.cap = cap;
      return true;
    } catch (e) {
      emit('error', { where: 'capture', name: e.name, message: e.message });
      return false;
    }
  }

  // -> { blob (audio/wav), rate, channels, seconds, t0, capped } | null
  async function captureStop() {
    const cap = st.cap;
    if (!cap) return null;
    try { if (cap.node.port) cap.node.port.postMessage('stop'); } catch (_) { /* ignore */ }
    await sleep(120); // let the last partial chunk arrive
    st.cap = null;
    try { st.src && st.src.disconnect(cap.node); } catch (_) { /* ignore */ }
    try { cap.node.disconnect(); cap.mute.disconnect(); } catch (_) { /* ignore */ }
    if (!cap.frames || !cap.C) return null;
    const bytes = cap.frames * cap.C * 2;
    const h = new DataView(new ArrayBuffer(44));
    const tag = (o, s) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, s.charCodeAt(i)); };
    tag(0, 'RIFF'); h.setUint32(4, 36 + bytes, true); tag(8, 'WAVE'); tag(12, 'fmt ');
    h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, cap.C, true); h.setUint32(24, cap.rate, true);
    h.setUint32(28, cap.rate * cap.C * 2, true); h.setUint16(32, cap.C * 2, true); h.setUint16(34, 16, true);
    tag(36, 'data'); h.setUint32(40, bytes, true);
    return {
      blob: new Blob([h.buffer, ...cap.chunks], { type: 'audio/wav' }), rate: cap.rate, channels: cap.C,
      seconds: +(cap.frames / cap.rate).toFixed(2), t0: cap.t0 == null ? null : +cap.t0.toFixed(1), capped: cap.full, via: cap.via,
    };
  }

  async function stop() {
    if (!st.running) return null;
    stopIq();
    setTone(false);
    st.running = false;
    cancelAnimationFrame(st.raf);
    await sleep(150);
    try { st.osc.stop(); st.oscL.stop(); st.oscR.stop(); } catch (_) { /* ignore */ }
    st.stream.getTracks().forEach((t) => t.stop());
    try { await st.ctx.close(); } catch (_) { /* ignore */ }
    st.ctx = null;
    const s = summary();
    emit('state', snapshot());
    return s;
  }

  function summary() {
    const a = st.agg;
    const out = { push: st.counts.push, pull: st.counts.pull, wave: st.counts.wave || 0 };
    if (st.stereo) Object.assign(out, { left: st.counts.left || 0, right: st.counts.right || 0 });
    if (a && a.frames) {
      Object.assign(out, {
        frames: a.frames, snrAvg: +(a.snrSum / a.frames).toFixed(1), snrMin: +a.snrMin.toFixed(1),
        carrierDb: +(a.carrierSum / a.frames).toFixed(1), noiseDb: +(a.noiseSum / a.frames).toFixed(1),
        maxUp: +a.maxUp.toFixed(1), maxDown: +a.maxDown.toFixed(1),
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- detection
  function loop() {
    if (!st.running) return;
    st.raf = requestAnimationFrame(loop);
    if (st.busy) return;
    st.analyser.getFloatFrequencyData(st.data);
    const tScan = performance.now();
    if (tScan - st.foreignT > 250) { st.foreignT = tScan; scanForeign(st.data, tScan); }
    if (st.stereo) { stereoStep(performance.now()); return; }
    const m = measure(st.data, st.f0);
    const now = performance.now();
    const calibrating = st.tone && now < st.calibUntil;
    let dUp = 0, dDown = 0;
    if (st.tone) {
      if (calibrating) {
        if (now >= st.calibFrom && Number.isFinite(m.up) && Number.isFinite(m.down)) {
          st.calib.ups.push(m.up); st.calib.downs.push(m.down);
          if (Number.isFinite(m.noise)) st.calib.noises.push(m.noise);
          if (st.robust) st.robust.learn({ t: now, up: m.up, down: m.down, noise: m.noise });
        }
      } else {
        if (!st.base && st.calib && st.calib.ups.length) {
          st.base = { up: median(st.calib.ups), down: median(st.calib.downs) };
          // robust spread (MAD x 1.48 ~ std) of the idle echo, used to raise the threshold in noisy rooms
          const mad = (xs, med) => median(xs.map((x) => Math.abs(x - med))) * 1.4826;
          st.wobble = { up: Math.max(0.5, mad(st.calib.ups, st.base.up)), down: Math.max(0.5, mad(st.calib.downs, st.base.down)) };
          st.noiseBase = st.calib.noises.length ? median(st.calib.noises) : null;
        }
        if (st.robust && st.robust.fUp.ready) {
          const v = m.centroid * C / (2 * st.f0);
          const peak = recentPeak(now, v);
          st.robust.o.onDb = config.threshold; // follow the sensitivity control
          const ex = st.robust.excess(m);
          dUp = ex.up;
          dDown = ex.dn;
          const g = st.robust.update({ t: now, up: m.up, down: m.down, noise: m.noise, snr: m.snr, v }); // keeps the floors learning
          if (config.detector === 'burst') {
            // claps, speech or music hits lift the far band too (robust.js impulse veto): drop the burst.
            // Only trust a veto raised while the far band was loud next to the tone (see config.burst.vetoSnrDb).
            if (st.robust.vetoUntil !== st.vetoSeen) {
              st.vetoSeen = st.robust.vetoUntil;
              if (!(m.snr >= config.burst.vetoSnrDb)) st.burstVetoUntil = st.robust.vetoUntil;
            }
            const vetoed = now < st.burstVetoUntil;
            trackAct(st, now, Math.max(dUp, dDown));
            if (vetoed && st.burst) { st.burst = null; st.burstLock = now + config.burst.lockMs; }
            const waving = waveStep(now, Math.max(dUp, dDown), v, vetoed || !(m.snr >= config.minSnr), peak);
            const b = !vetoed && m.snr >= config.minSnr ? burstStep(now, dUp, dDown, v) : null;
            if (b && !waving) b.kinds.filter((k) => !(st.wave && k === 'wave'))
              .forEach((k) => fire(k, { speed: b.speed, strength: Math.max(dUp, dDown), simulated: false }));
          } else if (g) {
            fire(g.kind, { speed: peak, strength: g.strength != null ? g.strength : Math.max(dUp, dDown), simulated: false });
          }
        } else if (st.base) {
          // Broadband noise (claps, crowd) lifts the far noise floor as much as the sidebands; a hand echo
          // only lifts the sidebands. Subtract the noise-floor rise so loud rooms don't look like gestures.
          const rise = st.noiseBase != null && Number.isFinite(m.noise) ? Math.max(0, m.noise - st.noiseBase) : 0;
          dUp = m.up - st.base.up - rise;
          dDown = m.down - st.base.down - rise;
          detect(m, dUp, dDown, now);
        }
        if (st.base || (st.robust && st.robust.fUp.ready)) {
          if (Number.isFinite(m.snr)) {
            const a = st.agg;
            a.frames++; a.snrSum += m.snr; a.snrMin = Math.min(a.snrMin, m.snr);
            a.carrierSum += m.carrier; a.noiseSum += m.noise;
            a.maxUp = Math.max(a.maxUp, dUp); a.maxDown = Math.max(a.maxDown, dDown);
          }
        }
      }
    }
    if (st.wasCalibrating && !calibrating) { st.wasCalibrating = false; emit('state', snapshot(now)); }
    const v = m.centroid * C / (2 * st.f0);
    st.last = { ...m, dUp, dDown, v };
    const th = thresholds();
    emit('frame', {
      t: now, tone: st.tone, calibrating, dUp, dDown, up: m.up, down: m.down, v,
      snr: m.snr, carrier: m.carrier, noise: m.noise, bandsUp: m.bandsUp, bandsDown: m.bandsDown,
      thUp: th.up, thDown: th.down, ambient: ambientLevel(st.data),
    });
  }

  function thresholds() {
    if (st.robust && st.robust.fUp.ready) {
      const o = st.robust.o;
      return { up: st.robust.fUp.rise(o.kOn, o.onDb), down: st.robust.fDn.rise(o.kOn, o.onDb) };
    }
    return {
      up: Math.max(config.threshold, config.autoK * st.wobble.up),
      down: Math.max(config.threshold, config.autoK * st.wobble.down),
    };
  }

  // Push = hand moving toward the laptop, so the echo shifts up. Pull = it shifts down.
  // Wave = the direction flips back and forth several times within about a second.
  function detect(m, dUp, dDown, now) {
    if (!(m.snr >= config.minSnr)) { st.cand = null; st.candFrames = 0; return; }
    const th = thresholds();
    const v = m.centroid * C / (2 * st.f0);
    const recentSpeed = recentPeak(now, v);

    const moving = dUp > th.up * 0.6 || dDown > th.down * 0.6;
    const sign = moving && Math.abs(v) > config.waveMinV ? Math.sign(v) : 0;
    if (sign && st.lastSign && sign !== st.lastSign) st.flips.push(now);
    if (sign) st.lastSign = sign;
    st.flips = st.flips.filter((t) => now - t < config.waveWindowMs);
    if (st.flips.length >= config.waveFlips && now - st.lastWave > 1200) {
      st.lastWave = now;
      st.lastFire = now;
      st.flips = [];
      st.cand = null;
      st.candFrames = 0;
      fire('wave', { speed: recentSpeed, strength: Math.max(dUp, dDown), simulated: false });
      return;
    }

    const recentFlips = st.flips.filter((t) => now - t < config.holdFlipMs).length;
    if (recentFlips >= 2) { st.cand = null; st.candFrames = 0; return; } // a wave is probably forming

    let c = null;
    if (dUp > th.up && dUp - dDown > config.margin) c = 'push';
    else if (dDown > th.down && dDown - dUp > config.margin) c = 'pull';
    if (c && c === st.cand) st.candFrames++;
    else { st.cand = c; st.candFrames = c ? 1 : 0; }
    if (c && st.candFrames >= config.confirmFrames && now - st.lastFire > config.refractoryMs) {
      st.lastFire = now;
      fire(c, { speed: recentSpeed, strength: Math.max(dUp, dDown), simulated: false });
    }
    if (!c && !moving && st.base) {
      // follow slow drift of the baseline and of the idle wobble
      st.base.up += (m.up - st.base.up) * 0.01;
      st.base.down += (m.down - st.base.down) * 0.01;
      st.wobble.up = Math.max(0.5, st.wobble.up * 0.995 + Math.abs(dUp) * 1.25 * 0.005);
      st.wobble.down = Math.max(0.5, st.wobble.down * 0.995 + Math.abs(dDown) * 1.25 * 0.005);
    }
  }

  function fire(kind, extra) {
    st.counts[kind] = (st.counts[kind] || 0) + 1;
    emit('gesture', { kind, t: performance.now(), ...extra });
  }

  // Burst rule (same logic as ml/replay_burst.py, so offline tuning on recordings carries over).
  // A burst starts when the echo rises aOn dB over the adaptive floor and ends after gapMs of quiet (or maxMs).
  // Fire early when the hand speed passes vFire; otherwise, at the end, fire the direction of the larger speed
  // peak if it reached vMin. waveFlips direction changes (|v| > vMin) inside one burst = a wave.
  function burstStep(now, up, dn, v) {
    const B = config.burst;
    const active = Math.max(up, dn) > B.aOn;
    let ev = st.burst;
    if (!ev) {
      if (!active || now < st.burstLock) return null;
      ev = st.burst = { start: now, last: now, vmax: v, vmin: v, fired: false, waved: false, flips: 0, sign: 0, ...guardStart(st) };
    }
    if (active) ev.last = now;
    guardFrame(ev, Math.max(up, dn), v);
    ev.vmax = Math.max(ev.vmax, v);
    ev.vmin = Math.min(ev.vmin, v);
    const s = v > B.vMin ? 1 : v < -B.vMin ? -1 : 0;
    if (s && ev.sign && s !== ev.sign) ev.flips++;
    if (s) ev.sign = s;
    const kinds = [];
    if (!ev.waved && ev.flips >= B.waveFlips) { kinds.push('wave'); ev.waved = ev.fired = true; }
    else if (!ev.fired && v > B.vFire) { kinds.push('push'); ev.fired = true; }
    else if (!ev.fired && v < -B.vFire) { kinds.push('pull'); ev.fired = true; }
    const maxMs = ev.flips >= 2 ? 3000 : B.maxMs; // a wave keeps going; don't chop it into extra pushes/pulls
    const capped = now - ev.start > maxMs;
    if (now - ev.last > B.gapMs || capped) {
      if (!ev.fired && !(B.rejectCapped && capped) && Math.max(ev.vmax, -ev.vmin) >= B.vMin && guardOk(ev)) {
        kinds.push(ev.vmax >= -ev.vmin ? 'push' : 'pull');
      }
      st.burst = null;
      st.burstLock = now + B.lockMs;
    }
    return kinds.length ? { kinds, speed: Math.max(ev.vmax, -ev.vmin) } : null;
  }

  // ---- bravo's slow-burst guard (see config.burst.slowGuard); same logic in ml/replay_burst.py
  // echo activity (a > aOn) over the last second, recorded every frame (vetoed ones too)
  function trackAct(o, now, a) {
    const act = o.act || (o.act = []);
    act.push([now, a > config.burst.aOn]);
    while (act.length && act[0][0] < now - 1000) act.shift();
  }
  function guardStart(o) {
    const pre = o.act ? o.act.slice(0, -1) : [];
    return { peak: -Infinity, preAct: pre.length ? pre.filter((p) => p[1]).length / pre.length : 0, wvN: 0, wvD: 0 };
  }
  function guardFrame(ev, a, v) {
    ev.peak = Math.max(ev.peak, a);
    const w = Math.pow(10, Math.max(0, a - config.burst.aOn) / 10) - 1;
    ev.wvN += w * Math.abs(v); ev.wvD += w;
  }
  function guardOk(ev) {
    const g = config.burst.slowGuard;
    return !g || ev.peak >= g.peak || (ev.preAct < g.preAct && ev.wvD > 0 && ev.wvN / ev.wvD >= g.wv);
  }
  // bravo's wave detector (wave.js), fed every frame; returns true while a wave is going on
  function waveStep(now, a, v, vetoed, speed) {
    if (!window.BatWave) return false;
    if (!st.wave) st.wave = new window.BatWave.WaveDetector(config.wave || {});
    const we = st.wave.push({ t: now, a, v, vetoed });
    if (we) fire('wave', { speed, strength: a, simulated: false, t0: we.t0 }); // t0 = its first stroke
    return st.wave.waving(now);
  }

  // Peak |v| over the last 150 ms (time-based, so 60 / 120 / 144 Hz screens behave the same).
  function recentPeak(now, v) {
    st.vHist.push({ t: now, v: Math.abs(v) });
    while (st.vHist.length > 1 && st.vHist[0].t < now - 150) st.vHist.shift();
    let p = 0;
    for (const h of st.vHist) p = Math.max(p, h.v);
    return p;
  }

  // ---------------------------------------------------------------- stereo mode (left / right swipes)
  // Left speaker plays fL, right speaker plays fR. A hand moving right gets farther from the left speaker
  // (fL echo shifts down) and closer to the right one (fR echo shifts up); moving left is the opposite.
  // Both tones shifting the same way is a push (up) or a pull (down).
  function stereoStep(now) {
    const calibrating = st.tone && now < st.calibUntil;
    const res = {};
    for (const key of ['L', 'R']) {
      const ch = st.sch[key];
      const m = measure(st.data, ch.f);
      let dUp = 0, dDown = 0;
      if (st.tone) {
        if (calibrating) {
          if (now >= st.calibFrom && Number.isFinite(m.up) && Number.isFinite(m.down)) {
            ch.ups.push(m.up); ch.downs.push(m.down);
            if (Number.isFinite(m.noise)) ch.noises.push(m.noise);
          }
        } else {
          if (!ch.base && ch.ups.length) {
            ch.base = { up: median(ch.ups), down: median(ch.downs) };
            const mad = (xs, med) => median(xs.map((x) => Math.abs(x - med))) * 1.4826;
            ch.wobble = { up: Math.max(0.5, mad(ch.ups, ch.base.up)), down: Math.max(0.5, mad(ch.downs, ch.base.down)) };
            ch.noiseBase = ch.noises.length ? median(ch.noises) : null;
          }
          if (ch.base) {
            const rise = ch.noiseBase != null && Number.isFinite(m.noise) ? Math.max(0, m.noise - ch.noiseBase) : 0;
            dUp = m.up - ch.base.up - rise;
            dDown = m.down - ch.base.down - rise;
          }
        }
      }
      res[key] = { m, dUp, dDown, v: m.centroid * C / (2 * ch.f) };
      // rest speed of this tone (median v of quiet frames, last 3 s): swipe.js v3 removes it from the sideways speed.
      // The noise floor around each carrier is lopsided, so v is not 0 at rest (205859: -0.69 / +0.27 m/s)
      if (window.BatSwipe && window.BatSwipe.RestSpeed) {
        if (!ch.rest) ch.rest = new window.BatSwipe.RestSpeed();
        ch.rest.push(now, res[key].v, Math.max(dUp, dDown));
      }
    }
    const ready = st.tone && !calibrating && st.sch.L.base && st.sch.R.base;
    if (ready) detectStereo(res, now); // energy rule (fires only in 'energy' mode) + baseline drift
    if (ready && config.stereoDetector === 'velocity') {
      const a4 = Math.max(res.L.dUp, res.L.dDown, res.R.dUp, res.R.dDown), ok = res.L.m.snr >= config.minSnr && res.R.m.snr >= config.minSnr;
      trackAct(st.sch, now, a4);
      const dep = (res.L.v + res.R.v) / 2;
      const waving = waveStep(now, a4, dep, !ok, Math.abs(dep));
      const b = ok ? stereoBurst(now, res.L, res.R) : null;
      if (b && !(waving && (b.kind === 'push' || b.kind === 'pull'))) fire(b.kind, { speed: b.speed, strength: a4, simulated: false });
    }
    if (st.wasCalibrating && !calibrating) { st.wasCalibrating = false; emit('state', snapshot(now)); }
    const L = res.L, R = res.R, thL = chanThresholds(st.sch.L);
    const sw = config.swapLR ? -1 : 1;
    st.last = { ...L.m, dUp: L.dUp, dDown: L.dDown, v: L.v };
    st.lastR = { ...R.m, dUp: R.dUp, dDown: R.dDown, v: R.v };
    emit('frame', {
      t: now, tone: st.tone, calibrating, dUp: Math.max(L.dUp, R.dUp), dDown: Math.max(L.dDown, R.dDown),
      up: L.m.up, down: L.m.down, v: (L.v + R.v) / 2, snr: Math.min(L.m.snr, R.m.snr),
      carrier: L.m.carrier, noise: L.m.noise, bandsUp: L.m.bandsUp, bandsDown: L.m.bandsDown,
      thUp: thL.up, thDown: thL.down, ambient: ambientLevel(st.data),
      stereo: {
        dUpL: L.dUp, dDownL: L.dDown, dUpR: R.dUp, dDownR: R.dDown, vL: L.v, vR: R.v,
        lat: sw * (R.v - L.v) / 2, dep: (L.v + R.v) / 2, snrL: L.m.snr, snrR: R.m.snr,
      },
    });
  }

  // the left/right model, if one was learned for the tone pair now playing
  function lrModelNow() {
    const m = config.lrModel;
    if (!m || !m.model || !Array.isArray(m.pair) || !st.sch) return null;
    if (!window.BatSwipe || m.model.v !== window.BatSwipe.VERSION) return null; // learned by an older swipe.js
    return m.pair[0] === st.sch.L.f && m.pair[1] === st.sch.R.f ? m.model : null;
  }

  // Velocity burst for stereo. Push/pull: like burstStep, by the forward speed dep. Left/right: judged once per
  // burst by window.BatSwipe with the learned model (see config.lrModel); without a model none fire. Every burst
  // end emits 'burst' { t, start, feat } so the left/right check can learn from cued swipes.
  function stereoBurst(now, L, R) {
    const B = config.burst, SW = window.BatSwipe, model = SW ? lrModelNow() : null;
    const lat = (R.v - L.v) / 2;  // + = hand moving right (the model learns this laptop's signs)
    const dep = (L.v + R.v) / 2;  // + = toward the laptop
    const active = Math.max(L.dUp, L.dDown, R.dUp, R.dDown) > B.aOn;
    let ev = st.sburst;
    if (!ev) {
      if (!active || now < st.sburstLock) return null;
      ev = st.sburst = { start: now, last: now, latMax: lat, latMin: lat, depMax: dep, depMin: dep, fired: false, sb: SW ? new SW.SwipeBurst() : null, ...guardStart(st.sch) };
    }
    if (active) ev.last = now;
    guardFrame(ev, Math.max(L.dUp, L.dDown, R.dUp, R.dDown), dep);
    ev.latMax = Math.max(ev.latMax, lat); ev.latMin = Math.min(ev.latMin, lat);
    ev.depMax = Math.max(ev.depMax, dep); ev.depMin = Math.min(ev.depMin, dep);
    if (ev.sb) ev.sb.push({ t: now, vL: L.v, vR: R.v, eL: SW.excessDb(L.dUp, L.dDown), eR: SW.excessDb(R.dUp, R.dDown),
      v0L: st.sch.L.rest ? st.sch.L.rest.value : 0, v0R: st.sch.R.rest ? st.sch.R.rest.value : 0 });
    let kind = null;
    // early push/pull only when left/right can't happen: a swipe also moves toward then away from the mic, so with
    // a model the whole burst has to be seen first (costs ~gapMs of latency)
    if (!ev.fired && !model && Math.abs(dep) > B.vFire) { kind = dep > 0 ? 'push' : 'pull'; ev.fired = true; }
    const capped = now - ev.start > B.maxMs;
    if (now - ev.last > B.gapMs || capped) {
      const feat = ev.sb ? ev.sb.features() : null;
      if (feat && st.iq) {
        const pc = st.iq.pathBetween(ev.start - 150, now); // the FFT frames lag the sound by about half a window
        if (pc.n > 20) { feat.pLat = (pc.dR - pc.dL) / 2; feat.pDep = -(pc.dL + pc.dR) / 2; feat.pN = pc.n; }
        // signed peaks of the running sideways / depth path change: return strokes cancel the net change, not the
        // peak (bravo, 214602 MacBook WAV). From 300 ms before the burst: the FFT burst starts late
        const pk = st.iq.peaksBetween ? st.iq.peaksBetween(ev.start - 300, now) : null;
        if (pk && pk.n > 20) { feat.pPk = pk.pPk; feat.pDPk = pk.pDPk; }
      }
      emit('burst', { t: now, start: ev.start, feat, capped });
      if (!ev.fired && !(B.rejectCapped && capped)) {
        if (model && feat) {
          const c = SW.classify(feat, model);
          if (c.dir) kind = c.dir;
        }
        if (!kind) {
          const depPk = ev.depMax >= -ev.depMin ? ev.depMax : ev.depMin;
          if (Math.abs(depPk) >= B.vMin && guardOk(ev)) kind = depPk > 0 ? 'push' : 'pull';
        }
      }
      st.sburst = null;
      st.sburstLock = now + B.lockMs;
    }
    return kind ? { kind, speed: Math.max(Math.abs(ev.latMax), Math.abs(ev.latMin), Math.abs(ev.depMax), Math.abs(ev.depMin)) } : null;
  }

  function detectStereo(res, now) {
    const L = res.L, R = res.R;
    if (!(L.m.snr >= config.minSnr) || !(R.m.snr >= config.minSnr)) { st.scand = null; st.scandFrames = 0; return; }
    const dirOf = (r, th) => {
      if (r.dUp > th.up && r.dUp - r.dDown > config.margin) return 1;
      if (r.dDown > th.down && r.dDown - r.dUp > config.margin) return -1;
      return 0;
    };
    const dL = dirOf(L, chanThresholds(st.sch.L)), dR = dirOf(R, chanThresholds(st.sch.R));
    let c = null, needMs = config.stereoConfirmMs;
    if (dL && dR) c = dL === dR ? (dL > 0 ? 'push' : 'pull') : (dL < 0 ? 'right' : 'left');
    else if (dL || dR) { c = (dL || dR) > 0 ? 'push' : 'pull'; needMs = config.oneSidedMs; }
    if (c && config.swapLR && (c === 'left' || c === 'right')) c = c === 'left' ? 'right' : 'left';
    if (c && c === st.scand) st.scandFrames++;
    else { st.scand = c; st.scandFrames = c ? 1 : 0; st.scandSince = now; }
    if (config.stereoDetector === 'energy' && c && st.scandFrames >= 2 && now - st.scandSince >= needMs && now - st.lastFire > config.refractoryMs) {
      st.lastFire = now;
      fire(c, {
        speed: Math.max(Math.abs(L.v), Math.abs(R.v)),
        strength: Math.max(L.dUp, L.dDown, R.dUp, R.dDown),
        simulated: false,
      });
    }
    // follow slow drift while nothing is happening (time constants in seconds, so the frame rate doesn't matter)
    const dt = st.prevStereoT ? Math.min(0.1, (now - st.prevStereoT) / 1000) : 0;
    st.prevStereoT = now;
    if (!c && dt > 0) {
      const aBase = 1 - Math.exp(-dt / 1.7), aWob = 1 - Math.exp(-dt / 3.3);
      for (const [key, r] of [['L', L], ['R', R]]) {
        const ch = st.sch[key];
        if (!ch.base) continue;
        ch.base.up += (r.m.up - ch.base.up) * aBase;
        ch.base.down += (r.m.down - ch.base.down) * aBase;
        ch.wobble.up = Math.max(0.5, ch.wobble.up * (1 - aWob) + Math.abs(r.dUp) * 1.25 * aWob);
        ch.wobble.down = Math.max(0.5, ch.wobble.down * (1 - aWob) + Math.abs(r.dDown) * 1.25 * aWob);
      }
    }
  }

  // ---------------------------------------------------------------- band check
  async function grab(ms) {
    const n = st.analyser.frequencyBinCount, acc = new Float64Array(n), tmp = new Float32Array(n);
    let frames = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      st.analyser.getFloatFrequencyData(tmp);
      for (let k = 0; k < n; k++) acc[k] += lin(Number.isFinite(tmp[k]) ? tmp[k] : -200);
      frames++;
      await sleep(30);
    }
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) out[k] = toDb(acc[k] / Math.max(1, frames));
    return out;
  }

  async function bandCheck() {
    if (!st.running || st.busy) return null;
    st.busy = true;
    emit('state', snapshot());
    const keepF = st.f0, keepTone = st.tone, keepStereo = st.stereo, nyq = st.ctx.sampleRate / 2;
    setTone(false);
    st.stereo = false; // the sweep always uses the single (both-speaker) tone
    await sleep(250);
    const steps = [15000, 16000, 17000, 18000, 19000, 19500, 20000, 20500, 21000, 21500, 22000, 23000].filter((f) => f <= nyq - 500);
    const sweep = [];
    for (const f of steps) {
      setTone(true, f);
      await sleep(220);
      const spec = await grab(260);
      setTone(false);
      await sleep(60);
      const kp = peakNear(spec, Math.round(f / st.binHz), 3);
      const peak = dbv(spec, kp), noise = localNoise(spec, kp);
      sweep.push({ f, snr: +(peak - noise).toFixed(1), peak: +peak.toFixed(1) });
    }
    setTone(false);
    st.stereo = keepStereo;
    setTone(keepTone, keepF);
    st.busy = false;
    emit('state', snapshot());
    api.lastBandCheck = sweep;
    return sweep;
  }

  // ---------------------------------------------------------------- drawing helpers
  function fit(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [g, c.clientWidth, c.clientHeight];
  }

  function drawZoom(canvas) {
    if (!st.last || !st.data) return;
    const [g, W, H] = fit(canvas);
    g.clearRect(0, 0, W, H);
    if (st.stereo && st.lastR) {
      drawPanel(g, st.last, 0, W / 2 - 4, H, 'L');
      drawPanel(g, st.lastR, W / 2 + 4, W / 2 - 4, H, 'R');
    } else {
      drawPanel(g, st.last, 0, W, H, '');
    }
  }

  function drawPanel(g, m, x0, W, H, tag) {
    const a = st.data, span = Math.ceil(600 / st.binHz), k1 = m.kp - span, k2 = m.kp + span;
    const carrier = m.carrier > -199 ? m.carrier : -60;
    const noise = Number.isFinite(m.noise) ? m.noise : -140;
    const top = carrier + 5, bot = Math.min(noise - 15, top - 50);
    const x = (k) => x0 + (k - k1) / (k2 - k1) * W;
    const y = (db) => Math.max(0, Math.min(H, (top - db) / (top - bot) * H));
    g.fillStyle = 'rgba(79,195,247,.16)';
    g.fillRect(x(m.kp + st.G), 0, x(m.kp + st.W) - x(m.kp + st.G), H);
    g.fillStyle = 'rgba(255,183,77,.16)';
    g.fillRect(x(m.kp - st.W), 0, x(m.kp - st.G) - x(m.kp - st.W), H);
    g.strokeStyle = '#7fe0c8';
    g.lineWidth = 1.5;
    g.beginPath();
    for (let k = k1; k <= k2; k++) {
      const px = x(k), py = y(dbv(a, k));
      if (k === k1) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.stroke();
    g.fillStyle = '#9aa3b2';
    g.font = '12px system-ui';
    g.fillText(`${tag ? tag + ' ' : ''}${(m.kp * st.binHz / 1000).toFixed(2)} kHz ±600 Hz`, x0 + 8, 16);
  }

  function drawWide(canvas) {
    if (!st.data || !st.ctx) return;
    const [g, W, H] = fit(canvas);
    const a = st.data, nyq = st.ctx.sampleRate / 2;
    const k1 = Math.floor(10000 / st.binHz), k2 = a.length - 1, top = -20, bot = -150;
    const x = (k) => (k - k1) / (k2 - k1) * W;
    const y = (db) => Math.max(0, Math.min(H, (top - db) / (top - bot) * H));
    g.clearRect(0, 0, W, H);
    g.strokeStyle = '#2a2f3a';
    g.fillStyle = '#9aa3b2';
    g.font = '11px system-ui';
    g.lineWidth = 1;
    for (let f = 10000; f <= nyq; f += 2000) {
      const px = x(f / st.binHz);
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
      g.fillText(f / 1000 + 'k', px + 2, H - 4);
    }
    g.strokeStyle = '#ff7043';
    const fx = x(st.f0 / st.binHz);
    g.beginPath(); g.moveTo(fx, 0); g.lineTo(fx, H); g.stroke();
    g.strokeStyle = '#c8cdd6';
    g.beginPath();
    for (let k = k1; k <= k2; k++) {
      const px = x(k), py = y(dbv(a, k));
      if (k === k1) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.stroke();
  }

  // ---------------------------------------------------------------- keyboard simulation
  window.addEventListener('keydown', (e) => {
    if (!config.keyboard || e.repeat) return;
    if (window.BatCollect && window.BatCollect.active) return; // typing during data collection must not fake gestures
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const keys = { ArrowUp: 'push', ArrowDown: 'pull', ArrowLeft: 'left', ArrowRight: 'right', w: 'wave', W: 'wave' };
    const kind = keys[e.key] || null;
    if (!kind) return;
    e.preventDefault();
    fire(kind, { speed: 0.8, strength: 15, simulated: true });
  });

  const api = {
    config, info: null, lastBandCheck: null, foreign: [],
    start, stop, bandCheck, on, off, summary, drawZoom, drawWide,
    captureStart, captureStop,                      // raw mic WAV (all channels) for offline analysis
    setFreq(hz) { if (st.running && !st.busy) setTone(st.tone, Number(hz)); else st.f0 = Number(hz); },
    setVolume(v) {
      config.volume = Number(v);
      if (!st.ctx || !st.tone) return;
      const t = st.ctx.currentTime;
      if (st.stereo) { ramp(st.gainL.gain, config.volume, t); ramp(st.gainR.gain, config.volume, t); }
      else ramp(st.gain.gain, config.volume, t);
    },
    // change the stereo tone pair (e.g. when a laptop's speakers are weak at 20.5 kHz); recalibrates
    setStereoFreqs(fl, fr) {
      config.stereoFreqs = [Number(fl), Number(fr)];
      if (st.ctx && st.oscL) {
        const t = st.ctx.currentTime;
        st.oscL.frequency.setValueAtTime(config.stereoFreqs[0], t);
        st.oscR.frequency.setValueAtTime(config.stereoFreqs[1], t);
        if (st.stereo && st.tone) setTone(true);
        if (st.stereo && st.iq) { stopIq(); startIq(); } // the tracker mixes down at fixed tone frequencies
      }
    },
    get running() { return st.running; },
    get stereo() { return st.stereo; },
    get stereoPair() { return st.stereo && st.sch ? [st.sch.L.f, st.sch.R.f] : null; }, // tones playing now
    get hasLrModel() { return !!lrModelNow(); },     // left/right usable with the tone pair playing now
    get capturing() { return !!st.cap; },
    get freq() { return st.f0; },
    get counts() { return { ...st.counts }; },
  };
  window.BatEars = api;
})();
