/* Bat Ears engine: ultrasonic Doppler push/pull detection in the browser (Web Audio).
 *
 * window.BatEars
 *   start({ freq, raw })   -> Promise<boolean>  open the mic, play the tone, start detecting
 *   stop()                 -> Promise<object>   stop and return a summary
 *   bandCheck()            -> Promise<Array>    short sweep, SNR per frequency
 *   setFreq(hz), setVolume(0..1)
 *   on(type, fn) -> unsubscribe;  off(type, fn)
 *   config                 tunables (threshold, margin, minSnr, ...)
 *   info                   mic / audio-context info after start
 *   drawZoom(canvas), drawWide(canvas)
 *
 * events
 *   'gesture' { kind: 'push' | 'pull', speed (m/s), strength (dB), t (ms), simulated }
 *   'frame'   { t, tone, calibrating, dUp, dDown, up, down, v, snr, carrier, noise, bandsUp[6], bandsDown[6] }
 *   'state'   { running, tone, calibrating, busy }
 *   'error'   { where, name, message }
 *
 * Keyboard simulation (no mic needed): ArrowUp = push, ArrowDown = pull.
 */
(function () {
  'use strict';

  const C = 343; // speed of sound, m/s
  // Sub-band edges (Hz offset from the carrier) used for the per-frame feature vector.
  const SUB_EDGES = [25, 50, 80, 120, 170, 230, 300];

  const config = {
    threshold: 6,        // dB above baseline that counts as motion
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
    calibFrom: 0, calibUntil: 0, calib: null, base: null, wasCalibrating: false,
    cand: null, candFrames: 0, lastFire: 0,
    last: null, agg: null, counts: { push: 0, pull: 0 },
  };

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
  function setTone(on, f) {
    const { ctx, gain, osc } = st;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (f) { st.f0 = f; osc.frequency.setValueAtTime(f, t); }
    gain.gain.cancelScheduledValues(t);
    gain.gain.setTargetAtTime(on ? config.volume : 0, t, 0.03);
    st.tone = on;
    if (on) {
      const now = performance.now();
      st.calibFrom = now + config.settleMs;
      st.calibUntil = now + config.calibMs;
      st.calib = { ups: [], downs: [] };
      st.base = null;
      st.wasCalibrating = true;
      emit('state', snapshot());
    }
  }

  async function start(opt = {}) {
    if (st.running) return true;
    const f0 = Number(opt.freq || st.f0 || 20000);
    const raw = opt.raw !== false;
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
    const binHz = ctx.sampleRate / analyser.fftSize;
    Object.assign(st, {
      ctx, osc, gain, stream, analyser, data: new Float32Array(analyser.frequencyBinCount),
      running: true, tone: false, busy: false, raw, f0, binHz,
      G: Math.ceil(config.guardHz / binHz), W: Math.floor(config.bandHz / binHz),
      base: null, cand: null, candFrames: 0, lastFire: 0, last: null,
      counts: { push: 0, pull: 0 },
      agg: { frames: 0, snrSum: 0, snrMin: Infinity, carrierSum: 0, noiseSum: 0, maxUp: -Infinity, maxDown: -Infinity },
    });
    const s = track.getSettings();
    api.info = {
      f0, raw, ctxRate: ctx.sampleRate, micRate: s.sampleRate, ec: s.echoCancellation, ns: s.noiseSuppression,
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
    try { st.osc.stop(); } catch (_) { /* ignore */ }
    st.stream.getTracks().forEach((t) => t.stop());
    try { await st.ctx.close(); } catch (_) { /* ignore */ }
    st.ctx = null;
    const s = summary();
    emit('state', snapshot());
    return s;
  }

  function summary() {
    const a = st.agg;
    const out = { push: st.counts.push, pull: st.counts.pull };
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
    const m = measure(st.data, st.f0);
    const now = performance.now();
    const calibrating = st.tone && now < st.calibUntil;
    let dUp = 0, dDown = 0;
    if (st.tone) {
      if (calibrating) {
        if (now >= st.calibFrom && Number.isFinite(m.up) && Number.isFinite(m.down)) { st.calib.ups.push(m.up); st.calib.downs.push(m.down); }
      } else {
        if (!st.base && st.calib && st.calib.ups.length) st.base = { up: median(st.calib.ups), down: median(st.calib.downs) };
        if (st.base) {
          dUp = m.up - st.base.up;
          dDown = m.down - st.base.down;
          detect(m, dUp, dDown, now);
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
    emit('frame', {
      t: now, tone: st.tone, calibrating, dUp, dDown, up: m.up, down: m.down, v,
      snr: m.snr, carrier: m.carrier, noise: m.noise, bandsUp: m.bandsUp, bandsDown: m.bandsDown,
    });
  }

  // Push = hand moving toward the laptop, so the echo shifts up. Pull = it shifts down.
  function detect(m, dUp, dDown, now) {
    if (!(m.snr >= config.minSnr)) { st.cand = null; st.candFrames = 0; return; }
    let c = null;
    if (dUp > config.threshold && dUp - dDown > config.margin) c = 'push';
    else if (dDown > config.threshold && dDown - dUp > config.margin) c = 'pull';
    if (c && c === st.cand) st.candFrames++;
    else { st.cand = c; st.candFrames = c ? 1 : 0; }
    if (c && st.candFrames >= config.confirmFrames && now - st.lastFire > config.refractoryMs) {
      st.lastFire = now;
      fire(c, {
        speed: Math.abs(m.centroid * C / (2 * st.f0)),
        strength: Math.max(dUp, dDown),
        simulated: false,
      });
    }
    if (!c && st.base) {
      st.base.up += (m.up - st.base.up) * 0.01;
      st.base.down += (m.down - st.base.down) * 0.01;
    }
  }

  function fire(kind, extra) {
    st.counts[kind] = (st.counts[kind] || 0) + 1;
    emit('gesture', { kind, t: performance.now(), ...extra });
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
    const keepF = st.f0, keepTone = st.tone, nyq = st.ctx.sampleRate / 2;
    setTone(false);
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
    const m = st.last;
    if (!m || !st.data) return;
    const [g, W, H] = fit(canvas);
    const a = st.data, span = Math.ceil(600 / st.binHz), k1 = m.kp - span, k2 = m.kp + span;
    const carrier = m.carrier > -199 ? m.carrier : -60;
    const noise = Number.isFinite(m.noise) ? m.noise : -140;
    const top = carrier + 5, bot = Math.min(noise - 15, top - 50);
    const x = (k) => (k - k1) / (k2 - k1) * W;
    const y = (db) => Math.max(0, Math.min(H, (top - db) / (top - bot) * H));
    g.clearRect(0, 0, W, H);
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
    g.fillText(`${(m.kp * st.binHz / 1000).toFixed(2)} kHz ±600 Hz`, 8, 16);
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
    const kind = e.key === 'ArrowUp' ? 'push' : e.key === 'ArrowDown' ? 'pull' : null;
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
      if (st.ctx && st.tone) st.gain.gain.setTargetAtTime(config.volume, st.ctx.currentTime, 0.03);
    },
    get running() { return st.running; },
    get freq() { return st.f0; },
    get counts() { return { ...st.counts }; },
  };
  window.BatEars = api;
})();
