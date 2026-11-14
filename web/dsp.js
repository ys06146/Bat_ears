/* Bat Ears engine: ultrasonic Doppler push/pull detection in the browser (Web Audio).
 *
 * window.BatEars
 *   start({ freq, raw, stereo }) -> Promise<boolean>  open the mic, play the tone, start detecting.
 *                          stereo: true plays a different tone on each speaker (config.stereoFreqs) and adds
 *                          'left' / 'right' swipe gestures (experimental; depends on the laptop's speakers)
 *   stop()                 -> Promise<object>   stop and return a summary
 *   bandCheck()            -> Promise<Array>    short sweep, SNR per frequency
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
 *
 * Keyboard simulation (no mic needed): ArrowUp = push, ArrowDown = pull, ArrowLeft/Right = swipe, W = wave.
 */
(function () {
  'use strict';

  const C = 343; // speed of sound, m/s
  // Sub-band edges (Hz offset from the carrier) used for the per-frame feature vector.
  const SUB_EDGES = [25, 50, 80, 120, 170, 230, 300];

  const config = {
    detector: 'robust',  // 'robust' = bravo's RobustDetector (web/robust.js); 'v2' = the simpler rules below
    threshold: 6,        // dB above baseline that counts as motion (floor; see autoK)
    autoK: 4,            // the threshold also rises to autoK x the measured idle wobble (noisy rooms)
    waveFlips: 4,        // direction flips within waveWindowMs that count as a wave (repeated pushes are slower)
    waveWindowMs: 1000,
    holdFlipMs: 350,     // two flips this close together = fast back-and-forth, so hold push/pull
    stereoFreqs: [19000, 20500], // stereo mode: left speaker tone, right speaker tone (Hz)
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
  };

  // Mono detector from robust.js (adaptive floor, impulse veto, hysteresis, return-stroke lock, wave).
  function makeRobust() {
    if (config.detector !== 'robust' || !window.BatRobust) return null;
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
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: !raw, noiseSuppression: !raw, autoGainControl: !raw, channelCount: { ideal: 1 } },
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
    ctx.createMediaStreamSource(stream).connect(analyser);
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
      ctx, osc, gain, stream, analyser, data: new Float32Array(analyser.frequencyBinCount),
      stereo, oscL, oscR, gainL, gainR, lastR: null, scand: null, scandFrames: 0, scandSince: 0, prevStereoT: 0,
      running: true, tone: false, busy: false, raw, f0, binHz,
      G: Math.ceil(config.guardHz / binHz), W: Math.floor(config.bandHz / binHz),
      base: null, cand: null, candFrames: 0, lastFire: 0, last: null,
      wobble: { up: 1, down: 1 }, vHist: [], flips: [], lastSign: 0, lastWave: 0,
      counts: { push: 0, pull: 0, wave: 0, left: 0, right: 0 },
      agg: { frames: 0, snrSum: 0, snrMin: Infinity, carrierSum: 0, noiseSum: 0, maxUp: -Infinity, maxDown: -Infinity },
    });
    const s = track.getSettings();
    api.info = {
      f0, raw, stereo, stereoFreqs: stereo ? config.stereoFreqs.slice() : null,
      ctxRate: ctx.sampleRate, micRate: s.sampleRate, ec: s.echoCancellation, ns: s.noiseSuppression,
      agc: s.autoGainControl, ch: s.channelCount, fft: analyser.fftSize, binHz: +binHz.toFixed(2), mic: track.label,
    };
    setTone(true);
    st.raf = requestAnimationFrame(loop);
    return true;
  }

  async function stop() {
    if (!st.running) return null;
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
          const g = st.robust.update({ t: now, up: m.up, down: m.down, noise: m.noise, snr: m.snr, v });
          if (g) fire(g.kind, { speed: peak, strength: g.strength != null ? g.strength : Math.max(dUp, dDown), simulated: false });
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
      thUp: th.up, thDown: th.down,
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
    }
    if (st.tone && !calibrating && st.sch.L.base && st.sch.R.base) detectStereo(res, now);
    if (st.wasCalibrating && !calibrating) { st.wasCalibrating = false; emit('state', snapshot(now)); }
    const L = res.L, R = res.R, thL = chanThresholds(st.sch.L);
    st.last = { ...L.m, dUp: L.dUp, dDown: L.dDown, v: L.v };
    st.lastR = { ...R.m, dUp: R.dUp, dDown: R.dDown, v: R.v };
    emit('frame', {
      t: now, tone: st.tone, calibrating, dUp: Math.max(L.dUp, R.dUp), dDown: Math.max(L.dDown, R.dDown),
      up: L.m.up, down: L.m.down, v: (L.v + R.v) / 2, snr: Math.min(L.m.snr, R.m.snr),
      carrier: L.m.carrier, noise: L.m.noise, bandsUp: L.m.bandsUp, bandsDown: L.m.bandsDown,
      thUp: thL.up, thDown: thL.down,
      stereo: { dUpL: L.dUp, dDownL: L.dDown, dUpR: R.dUp, dDownR: R.dDown, vL: L.v, vR: R.v },
    });
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
    if (c && c === st.scand) st.scandFrames++;
    else { st.scand = c; st.scandFrames = c ? 1 : 0; st.scandSince = now; }
    if (c && st.scandFrames >= 2 && now - st.scandSince >= needMs && now - st.lastFire > config.refractoryMs) {
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
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const keys = { ArrowUp: 'push', ArrowDown: 'pull', ArrowLeft: 'left', ArrowRight: 'right', w: 'wave', W: 'wave' };
    const kind = keys[e.key] || null;
    if (!kind) return;
    e.preventDefault();
    fire(kind, { speed: 0.8, strength: 15, simulated: true });
  });

  const api = {
    config, info: null, lastBandCheck: null,
    start, stop, bandCheck, on, off, summary, drawZoom, drawWide,
    setFreq(hz) { if (st.running && !st.busy) setTone(st.tone, Number(hz)); else st.f0 = Number(hz); },
    setVolume(v) {
      config.volume = Number(v);
      if (!st.ctx || !st.tone) return;
      const t = st.ctx.currentTime;
      if (st.stereo) { ramp(st.gainL.gain, config.volume, t); ramp(st.gainR.gain, config.volume, t); }
      else ramp(st.gain.gain, config.volume, t);
    },
    get running() { return st.running; },
    get stereo() { return st.stereo; },
    get freq() { return st.f0; },
    get counts() { return { ...st.counts }; },
  };
  window.BatEars = api;
})();
