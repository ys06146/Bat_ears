/* BatWave: wave = the hand speed flipping sign quickly several times (toward / away / toward ...), separate from
 * the push/pull burst rule. Mono or stereo (use the forward speed: v, or dep = (vL + vR) / 2 in stereo).
 *
 * Measured on the two recorded wave blocks (153352, 160233) vs 132 cued push/pulls (ml/data, wave_eval.js):
 *   waving: consecutive lobe peaks ~83-170 ms apart (median 117-133 ms)
 *   push/pull: at most wind-up + stroke + return = 3 lobes, spaced wider; 4 fast lobes ~never.
 * A lobe = a run of frames with echo > aOn and |v| >= vLobe of one sign (gaps < gapMs bridged).
 * Wave = `need` alternating lobes whose consecutive peaks are <= maxGapMs apart (and the whole chain <= spanMs).
 *
 *   const w = new BatWave.WaveDetector();
 *   per frame:  const e = w.push({ t, a: max(dUp, dDown), v, vetoed });   // e = { kind: 'wave', lobes, span } | null
 *   w.waving(t) -> true while a wave is going on (and holdMs after): suppress push/pull then (they're its lobes)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BatWave = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DEF = { aOn: 12, vLobe: 0.8, gapMs: 120, need: 4, maxGapMs: 300, spanMs: 1200, refireMs: 1500, holdMs: 400 };

  class WaveDetector {
    constructor(opt = {}) { this.o = { ...DEF, ...opt }; this.reset(); }
    reset() { this.cur = null; this.chain = []; this.lastWave = -1e9; this.lastLobe = -1e9; this.active = false; }
    // chain of alternating, closely spaced lobe peaks ending with lobe l
    _add(l) {
      const o = this.o, c = this.chain, p = c[c.length - 1];
      if (p && (l.s === p.s || l.tp - p.tp > o.maxGapMs)) this.chain = [l]; // same sign or too slow: start over
      else c.push(l);
      while (this.chain.length > 1 && l.tp - this.chain[0].tp > o.spanMs) this.chain.shift();
    }
    push({ t, a, v, vetoed }) {
      const o = this.o;
      const s = !vetoed && a > o.aOn && Math.abs(v) >= o.vLobe ? Math.sign(v) : 0;
      let ev = null;
      // close the running lobe on a sign change or a gap
      if (this.cur && (t - this.cur.last > o.gapMs || (s && s !== this.cur.s))) { this._add(this.cur); this.cur = null; ev = this._check(t); }
      if (s) {
        if (!this.cur) this.cur = { s, t0: t, last: t, pk: 0, tp: t };
        this.cur.last = t; this.lastLobe = t;
        if (Math.abs(v) > this.cur.pk) { this.cur.pk = Math.abs(v); this.cur.tp = t; }
      }
      // the chain may already qualify with the running lobe counted (fire without waiting for it to end)
      if (!ev && this.cur) ev = this._check(t, this.cur);
      return ev;
    }
    _check(t, running) {
      const o = this.o, c = running ? this._with(running) : this.chain;
      if (c.length >= o.need && t - this.lastWave >= o.refireMs) {
        this.lastWave = t; this.active = true;
        // t0 = first lobe of the wave: a push/pull fired after t0 was this wave's first stroke (the game may undo it)
        const ev = { kind: 'wave', t, t0: c[0].t0, lobes: c.length, span: c[c.length - 1].tp - c[0].tp };
        this.chain = [];
        return ev;
      }
      return null;
    }
    _with(l) {
      const c = this.chain, p = c[c.length - 1];
      if (!p || l.s === p.s || l.tp - p.tp > this.o.maxGapMs) return [l];
      return c.concat([l]).filter((x) => l.tp - x.tp <= this.o.spanMs);
    }
    // true from a wave until the lobes stop for holdMs (push/pull fired then are the wave's own strokes)
    waving(t) { if (this.active && t - this.lastLobe > this.o.holdMs) this.active = false; return this.active; }
  }
  return { WaveDetector, DEFAULTS: DEF };
});
