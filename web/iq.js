/* BatIQ: live I/Q phase tracking of the two speaker tones (LLAP-style, charlie notes 5/9) in an AudioWorklet.
 * Same algorithm as phase.js (offline): per tone and mic channel, mix to baseband, 4th-order Butterworth low-pass,
 * decimate to ~1 kHz, remove the static vector (slow complex mean), unwrap -> path length change per sample, gated by
 * the dynamic vector's noise level. Mic channels are averaged. The main thread keeps a 10 s history so a burst can ask
 * for the path change of each speaker's tone over its time span.
 *
 *   const iq = await BatIQ.start(ctx, micSourceNode, [18000, 19500]);   // null if AudioWorklet is unavailable
 *   iq.pathBetween(ta, tb) -> { dL, dR, n }     (m, perf-time ms; dL = change of the speaker L -> hand -> mic path)
 *   pLat = (dR - dL) / 2                         sideways cue for swipe.js (sign learned by the check)
 *   iq.stop()
 */
(function (root) {
  'use strict';
  const PROC = `
class BatIQ extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = o.processorOptions || {};
    this.freqs = p.freqs || [18000, 19500];
    this.dec = p.dec || 48; this.lpHz = p.lpHz || 250; this.tauS = p.tauS || 0.25; this.gate = p.gate || 3;
    this.rate2 = sampleRate / this.dec; this.lam = this.freqs.map((f) => 343 / f);
    this.coef = [0.5412, 1.3066].map((Q) => { const w = 2 * Math.PI * this.lpHz / sampleRate, cw = Math.cos(w), al = Math.sin(w) / (2 * Q), a0 = 1 + al;
      return [(1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0, -2 * cw / a0, (1 - al) / a0]; });
    this.ch = null; this.n = 0; this.out = [[], []]; this.f0 = null; this.batch = 0;
    this.win = Math.round(4 * this.rate2);
  }
  newState() {
    return this.freqs.map(() => ({ z: [0, 1].map(() => this.coef.map(() => [0, 0, 0, 0])), mI: 0, mQ: 0, init: 0, iS: 0, qS: 0,
      pI: 0, pQ: 0, pm: 0, ring: new Float32Array(this.win), ri: 0, rn: 0, noise: 0, cnt: 0 }));
  }
  lp(z, x) { for (let j = 0; j < this.coef.length; j++) { const c = this.coef[j], s = z[j];
      const y = c[0] * x + c[1] * s[0] + c[2] * s[1] - c[3] * s[2] - c[4] * s[3]; s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y; x = y; } return x; }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const C = inp.length, N = inp[0].length;
    if (!this.ch || this.ch.length !== C) this.ch = Array.from({ length: C }, () => this.newState());
    if (this.f0 == null) this.f0 = currentFrame;
    const a = 1 / (this.tauS * this.rate2), w = this.freqs.map((f) => 2 * Math.PI * f / sampleRate);
    for (let i = 0; i < N; i++) {
      const g = this.n + i, take = g % this.dec === this.dec - 1;
      const step = [0, 0];
      for (let c = 0; c < C; c++) {
        const x = inp[c][i];
        for (let t = 0; t < this.freqs.length; t++) {
          const s = this.ch[c][t], ph = w[t] * g;
          const I = this.lp(s.z[0], 2 * x * Math.cos(ph)), Q = this.lp(s.z[1], -2 * x * Math.sin(ph));
          if (!take) continue;
          // static vector: average of 20-320 ms after start, then a slow mean
          if (s.init < 320) { if (s.init >= 20) { s.iS += I; s.qS += Q; } s.init++; if (s.init === 320) { s.mI = s.iS / 300; s.mQ = s.qS / 300; } continue; }
          s.mI += a * (I - s.mI); s.mQ += a * (Q - s.mQ);
          const dI = I - s.mI, dQ = Q - s.mQ, m = Math.hypot(dI, dQ);
          // noise: low percentile (25%) of |dyn| over the last 4 s, refreshed every 100 samples
          s.ring[s.ri] = m; s.ri = (s.ri + 1) % this.win; s.rn = Math.min(this.win, s.rn + 1);
          if (++s.cnt % 100 === 0) { const k = Math.max(1, Math.floor(s.rn / 50)), xs = []; for (let j = 0; j < s.rn; j += k) xs.push(s.ring[j]); xs.sort((u, v) => u - v); s.noise = xs[Math.floor(0.25 * (xs.length - 1))] || 0; }
          let d = 0;
          if (m > this.gate * s.noise && s.pm > this.gate * s.noise) d = -Math.atan2(dQ * s.pI - dI * s.pQ, dI * s.pI + dQ * s.pQ) * this.lam[t] / (2 * Math.PI);
          s.pI = dI; s.pQ = dQ; s.pm = m;
          step[t] += d / C;
        }
      }
      if (take) { this.out[0].push(step[0]); this.out[1].push(step[1]); }
    }
    this.n += N;
    if (++this.batch >= 8) {   // ~21 ms at 48 kHz
      this.port.postMessage({ frame: currentFrame, rate2: this.rate2, L: Float32Array.from(this.out[0]), R: Float32Array.from(this.out[1]) });
      this.out = [[], []]; this.batch = 0;
    }
    return true;
  }
}
registerProcessor('bat-iq', BatIQ);
`;

  async function start(ctx, src, freqs, opt = {}) {
    if (!ctx || !ctx.audioWorklet || !src) return null;
    const blobUrl = URL.createObjectURL(new Blob([PROC], { type: 'application/javascript' }));
    let ok = false;
    for (const u of [blobUrl, 'data:application/javascript;charset=utf-8,' + encodeURIComponent(PROC)]) {
      try { await ctx.audioWorklet.addModule(u); ok = true; break; } catch (_) { /* next */ }
    }
    URL.revokeObjectURL(blobUrl);
    if (!ok) return null;
    const node = new AudioWorkletNode(ctx, 'bat-iq', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2,
      channelCountMode: 'max', channelInterpretation: 'discrete', processorOptions: { freqs, ...opt } });
    const mute = ctx.createGain(); mute.gain.value = 0;
    src.connect(node); node.connect(mute).connect(ctx.destination);
    // history: [perf ms, stepL, stepR] at ~1 kHz, last 10 s
    let T = [], L = [], R = [], h = 0;   // h = first live index (old entries are dropped in bulk)
    node.port.onmessage = (e) => {
      const { frame, rate2, L: a, R: b } = e.data, n = a.length;
      const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
      const endMs = ts && ts.performanceTime > 0 ? ts.performanceTime + (frame / ctx.sampleRate - ts.contextTime) * 1000 : performance.now();
      for (let i = 0; i < n; i++) { T.push(endMs - (n - 1 - i) * 1000 / rate2); L.push(a[i]); R.push(b[i]); }
      while (h < T.length && T[h] < endMs - 10000) h++;
      if (h > 4000) { T = T.slice(h); L = L.slice(h); R = R.slice(h); h = 0; }
    };
    return {
      node,
      pathBetween(ta, tb) { let dL = 0, dR = 0, n = 0; for (let i = h; i < T.length; i++) if (T[i] >= ta && T[i] <= tb) { dL += L[i]; dR += R[i]; n++; } return { dL, dR, n }; },
      stop() { try { src.disconnect(node); node.disconnect(); mute.disconnect(); } catch (_) { /* ignore */ } },
    };
  }
  const api = { start, PROC };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BatIQ = api;
})(typeof self !== 'undefined' ? self : this);
