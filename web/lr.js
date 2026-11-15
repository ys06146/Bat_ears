/* Left/right test view: is stereo sensing working on THIS laptop?
 *
 * Shows each speaker tone's signal strength (SNR) and Doppler speed (vL, vR), the hand's estimated
 * sideways/forward motion (lat = (vR - vL)/2, dep = (vL + vR)/2) as a moving dot, and which gesture fired.
 * Controls: tone pair (some laptop speakers are weak at 20.5 kHz), swap L/R, start/restart in stereo.
 *
 * window.LRTest: init(root), setActive(on)
 */
(function () {
  'use strict';

  const PAIRS = [[18000, 19500], [19000, 20500], [17500, 19000], [20000, 21000]];
  const NAMES = { left: '◀ Left', right: 'Right ▶', push: 'Push ⟶', pull: '⟵ Pull', wave: '〰 Wave' };
  const COLORS = { left: '#80deea', right: '#80deea', push: '#4fc3f7', pull: '#ffb74d', wave: '#b388ff' };
  const S = { root: null, cv: null, g: null, W: 0, H: 0, active: false, f: null, x: 0, y: 0, trail: [], last: null, counts: {}, lastT: 0 };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function init(root) {
    S.root = root;
    root.innerHTML = `
      <div class="lr-controls">
        <b>↔ Left/right test</b>
        <label>Tones <select class="lr-pair">${PAIRS.map((p, i) => `<option value="${i}">L ${p[0] / 1000}k · R ${p[1] / 1000}k</option>`).join('')}</select></label>
        <label><input type="checkbox" class="lr-swap"> Swap left/right</label>
        <button class="lr-start">▶ Start in stereo</button>
        <button class="secondary lr-reset">Reset counts</button>
        <button class="secondary lr-collect" title="6 swipes each way plus 5 pushes and 5 pulls check and learn whether left/right works right here (redo each time you sit down)">🧭 Left/right check (left/right 6+6 · push/pull 5+5)</button>
        <button class="secondary lr-circle" title="10 clockwise, 10 counter-clockwise, 3+3 push/pull (stereo, raw audio saved): recordings for the 2D experiment">🌀 Circle collection (clockwise 10 · counter-clockwise 10)</button>
      </div>
      <div class="lr-stage"><canvas class="lr-canvas"></canvas><div class="lr-coach" title="Sweep like this"></div></div>
      <p class="hint lr-hint">Hold your palm upright 10–15 cm above the keyboard and sweep wide and fast, all the way from the left end ↔ to the right end. Both tones need an SNR of 20 dB or more. If one is low, pick another tone pair. If the direction comes out reversed, turn on 'Swap left/right'. On Windows, sound effects can mix left and right: in Settings &gt; System &gt; Sound &gt; Speakers turn off 'Audio enhancements'·'Spatial sound' ; in Settings &gt; Accessibility &gt; Audio turn off 'Mono audio' ; and turn off Dolby Atmos. People with sharp hearing may faintly hear 18 kHz.</p>`;
    S.cv = root.querySelector('.lr-canvas');
    // a person seen from behind shows the swipe (right, then left) at real speed while this view is open
    S.coach = window.BatCoach ? window.BatCoach.create(root.querySelector('.lr-coach')) : null;
    S.g = S.cv.getContext('2d');
    root.querySelector('.lr-pair').onchange = (e) => {
      const p = PAIRS[Number(e.target.value)];
      BatEars.setStereoFreqs(p[0], p[1]);
    };
    root.querySelector('.lr-swap').onchange = (e) => { BatEars.config.swapLR = e.target.checked; };
    root.querySelector('.lr-start').onclick = async (e) => {
      e.target.blur();
      const p = PAIRS[Number(root.querySelector('.lr-pair').value)];
      BatEars.config.stereoFreqs = p.slice();
      if (BatEars.running) await BatEars.stop();
      await BatEars.start({ freq: BatEars.freq, raw: true, stereo: true });
      const box = document.getElementById('stereo');
      if (box) box.checked = true;
    };
    root.querySelector('.lr-reset').onclick = (e) => { e.target.blur(); S.counts = {}; };
    // guided left/right-only session with the tone pair chosen above (saved like any other session)
    root.querySelector('.lr-circle').onclick = (e) => {
      e.target.blur();
      const p = PAIRS[Number(root.querySelector('.lr-pair').value)];
      if (!BatEars.running || !BatEars.stereo) BatEars.config.stereoFreqs = p.slice();
      if (window.startCollect) window.startCollect('circle');
    };
    root.querySelector('.lr-collect').onclick = (e) => {
      e.target.blur();
      const p = PAIRS[Number(root.querySelector('.lr-pair').value)];
      if (!BatEars.running || !BatEars.stereo) BatEars.config.stereoFreqs = p.slice();
      if (window.startCollect) window.startCollect(true);
    };
    BatEars.on('frame', onFrame);
    BatEars.on('gesture', (e) => {
      if (!S.active) return;
      S.counts[e.kind] = (S.counts[e.kind] || 0) + 1;
      S.last = { kind: e.kind, t: e.t, speed: e.speed || 0 };
    });
    requestAnimationFrame(draw);
  }

  function onFrame(f) {
    S.f = f;
    if (!f.stereo) return;
    const dt = S.lastT ? Math.min(0.05, (f.t - S.lastT) / 1000) : 0;
    S.lastT = f.t;
    const live = f.tone && !f.calibrating;
    const lat = live ? f.stereo.lat : 0, dep = live ? f.stereo.dep : 0;
    // integrate speeds into a dot that drifts back to the middle
    S.x = clamp(S.x + lat * 1.8 * dt - S.x * 0.9 * dt, -1, 1);
    S.y = clamp(S.y + dep * 1.8 * dt - S.y * 0.9 * dt, -1, 1);
    S.trail.push({ x: S.x, y: S.y, t: f.t });
    while (S.trail.length && f.t - S.trail[0].t > 1200) S.trail.shift();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    S.W = S.cv.clientWidth; S.H = S.cv.clientHeight;
    S.cv.width = Math.round(S.W * dpr); S.cv.height = Math.round(S.H * dpr);
    S.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(now) {
    requestAnimationFrame(draw);
    if (!S.active || !S.cv) return;
    if (S.cv.clientWidth !== S.W || S.cv.clientHeight !== S.H) resize();
    const { g, W, H } = S;
    if (!W || !H) return;
    g.fillStyle = '#04060b';
    g.fillRect(0, 0, W, H);
    const f = S.f, st = f && f.stereo;
    const radarW = Math.min(W * 0.6, H * 1.3), cx = radarW / 2 + 10, cy = H / 2;
    // radar: x = sideways, y = toward / away from the laptop
    g.strokeStyle = 'rgba(128,222,234,.25)';
    g.lineWidth = 1;
    for (let r = 1; r <= 3; r++) { g.beginPath(); g.arc(cx, cy, (r / 3) * (radarW / 2 - 20), 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(cx - radarW / 2 + 10, cy); g.lineTo(cx + radarW / 2 - 10, cy); g.moveTo(cx, 20); g.lineTo(cx, H - 20); g.stroke();
    g.fillStyle = '#9aa3b2';
    g.font = '12px system-ui';
    g.textAlign = 'center';
    g.fillText('◀ Left', cx - radarW / 2 + 40, cy - 8);
    g.fillText('Right ▶', cx + radarW / 2 - 40, cy - 8);
    g.fillText('Toward screen (push)', cx, 34);
    g.fillText('Toward you (pull)', cx, H - 26);
    const R = radarW / 2 - 20;
    for (let i = 1; i < S.trail.length; i++) {
      const a = S.trail[i - 1], b = S.trail[i];
      g.strokeStyle = `rgba(128,222,234,${(i / S.trail.length) * 0.8})`;
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(cx + a.x * R, cy - a.y * R); g.lineTo(cx + b.x * R, cy - b.y * R); g.stroke();
    }
    g.fillStyle = '#80deea';
    g.shadowColor = '#80deea'; g.shadowBlur = 16;
    g.beginPath(); g.arc(cx + S.x * R, cy - S.y * R, 10, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0;

    // right column: per-tone meters and counts
    const x0 = radarW + 30, colW = W - x0 - 16;
    g.textAlign = 'left';
    g.fillStyle = '#e8e8e8';
    g.font = '700 15px system-ui';
    if (!f || !st) {
      g.fillText('Press ▶ Start in stereo', x0, 40);
    } else {
      const fr = BatEars.config.stereoFreqs;
      const meter = (y, label, v, snr) => {
        g.fillStyle = '#c8cdd6'; g.font = '13px system-ui';
        const ok = snr >= 20;
        g.fillText(`${label}  SNR ${Number.isFinite(snr) ? snr.toFixed(0) : '–'}dB ${ok ? '✅' : '⚠️ weak'}`, x0, y);
        const bw = colW, mid = x0 + bw / 2;
        g.fillStyle = '#1a1d24'; g.fillRect(x0, y + 8, bw, 14);
        g.fillStyle = v >= 0 ? '#4fc3f7' : '#ffb74d';
        const w = clamp(v / 2, -1, 1) * (bw / 2);
        g.fillRect(Math.min(mid, mid + w), y + 8, Math.abs(w), 14);
        g.fillStyle = '#9aa3b2'; g.fillText(`${v >= 0 ? '+' : ''}${(v || 0).toFixed(2)} m/s`, x0, y + 38);
      };
      meter(40, `Left speaker ${fr[0] / 1000}kHz`, st.vL, st.snrL);
      meter(110, `Right speaker ${fr[1] / 1000}kHz`, st.vR, st.snrR);
      g.fillStyle = '#c8cdd6';
      g.font = '13px system-ui';
      g.fillText(`Sideways speed ${st.lat >= 0 ? '+' : ''}${st.lat.toFixed(2)}  ·  depth speed ${st.dep >= 0 ? '+' : ''}${st.dep.toFixed(2)} m/s`, x0, 180);
      if (f.calibrating) { g.fillStyle = '#ffe082'; g.fillText('Measuring baseline… hand away', x0, 204); }
    }
    g.font = '13px system-ui';
    g.fillStyle = '#9aa3b2';
    const c = S.counts;
    g.fillText(`Left ${c.left || 0} · Right ${c.right || 0} · Push ${c.push || 0} · Pull ${c.pull || 0}`, x0, H - 60);
    // left/right only fires after the check found a usable signal for the tone pair playing now
    const m = BatEars.config.lrModel;
    if (BatEars.running && BatEars.stereo) {
      g.fillStyle = BatEars.hasLrModel ? '#a5d6a7' : '#ffe082';
      const ago = m && m.at ? Math.round((Date.now() - Date.parse(m.at)) / 60000) : null;
      const cue = m && m.keys && m.keys !== 'fft' ? 'phase cues, ' : '';
      g.fillText(BatEars.hasLrModel ? `Left/right detection on (${cue}check cross-validation ${Math.round((m.looAcc || 0) * 100)}%${ago != null ? `, ${ago} min ago check` : ''})`
        : 'Left/right detection off: run 🧭 Left/right check first (redo each time you sit down)', x0, H - 82);
    }
    if (S.last && now - S.last.t < 900) {
      g.fillStyle = COLORS[S.last.kind] || '#fff';
      g.font = '800 34px system-ui';
      g.fillText(NAMES[S.last.kind] || S.last.kind, x0, H - 20);
    }
  }

  window.LRTest = {
    init,
    setActive(on) {
      S.active = !!on;
      if (on && S.cv) resize();
      if (S.coach) { if (on) S.coach.loop(['right', 'left']); else S.coach.stop(); }
    },
  };
})();
