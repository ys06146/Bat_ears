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

  const PAIRS = [[19000, 20500], [18000, 19500], [17500, 19000], [20000, 21000]];
  const NAMES = { left: '◀ 왼쪽', right: '오른쪽 ▶', push: '밀기 ⟶', pull: '⟵ 당기기', wave: '〰 흔들기' };
  const COLORS = { left: '#80deea', right: '#80deea', push: '#4fc3f7', pull: '#ffb74d', wave: '#b388ff' };
  const S = { root: null, cv: null, g: null, W: 0, H: 0, active: false, f: null, x: 0, y: 0, trail: [], last: null, counts: {}, lastT: 0 };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function init(root) {
    S.root = root;
    root.innerHTML = `
      <div class="lr-controls">
        <b>↔ 좌우 테스트</b>
        <label>톤 <select class="lr-pair">${PAIRS.map((p, i) => `<option value="${i}">왼 ${p[0] / 1000}k · 오 ${p[1] / 1000}k</option>`).join('')}</select></label>
        <label><input type="checkbox" class="lr-swap"> 좌우 바꾸기</label>
        <button class="lr-start">▶ 스테레오로 시작</button>
        <button class="secondary lr-reset">숫자 지우기</button>
        <button class="secondary lr-collect">🎯 좌우만 수집 (✅/❌ 기록)</button>
      </div>
      <canvas class="lr-canvas"></canvas>
      <p class="hint lr-hint">키보드 위 10~20cm에서 손바닥을 세우고 왼쪽 ↔ 오른쪽으로 빠르게 쓸어 보세요. 두 톤의 SNR이 모두 20dB 이상이어야 해요. 낮은 쪽이 있으면 다른 톤 쌍을 고르세요. 방향이 반대로 나오면 '좌우 바꾸기'를 켜세요.</p>`;
    S.cv = root.querySelector('.lr-canvas');
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
    g.fillText('◀ 왼쪽', cx - radarW / 2 + 40, cy - 8);
    g.fillText('오른쪽 ▶', cx + radarW / 2 - 40, cy - 8);
    g.fillText('화면 쪽 (밀기)', cx, 34);
    g.fillText('내 쪽 (당기기)', cx, H - 26);
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
      g.fillText('▶ 스테레오로 시작을 눌러 주세요', x0, 40);
    } else {
      const fr = BatEars.config.stereoFreqs;
      const meter = (y, label, v, snr) => {
        g.fillStyle = '#c8cdd6'; g.font = '13px system-ui';
        const ok = snr >= 20;
        g.fillText(`${label}  SNR ${Number.isFinite(snr) ? snr.toFixed(0) : '–'}dB ${ok ? '✅' : '⚠️ 약함'}`, x0, y);
        const bw = colW, mid = x0 + bw / 2;
        g.fillStyle = '#1a1d24'; g.fillRect(x0, y + 8, bw, 14);
        g.fillStyle = v >= 0 ? '#4fc3f7' : '#ffb74d';
        const w = clamp(v / 2, -1, 1) * (bw / 2);
        g.fillRect(Math.min(mid, mid + w), y + 8, Math.abs(w), 14);
        g.fillStyle = '#9aa3b2'; g.fillText(`${v >= 0 ? '+' : ''}${(v || 0).toFixed(2)} m/s`, x0, y + 38);
      };
      meter(40, `왼쪽 스피커 ${fr[0] / 1000}kHz`, st.vL, st.snrL);
      meter(110, `오른쪽 스피커 ${fr[1] / 1000}kHz`, st.vR, st.snrR);
      g.fillStyle = '#c8cdd6';
      g.font = '13px system-ui';
      g.fillText(`옆 속도 ${st.lat >= 0 ? '+' : ''}${st.lat.toFixed(2)}  ·  앞뒤 속도 ${st.dep >= 0 ? '+' : ''}${st.dep.toFixed(2)} m/s`, x0, 180);
      if (f.calibrating) { g.fillStyle = '#ffe082'; g.fillText('기준값 잡는 중… 손 치우기', x0, 204); }
    }
    g.font = '13px system-ui';
    g.fillStyle = '#9aa3b2';
    const c = S.counts;
    g.fillText(`왼쪽 ${c.left || 0} · 오른쪽 ${c.right || 0} · 밀기 ${c.push || 0} · 당기기 ${c.pull || 0}`, x0, H - 60);
    if (S.last && now - S.last.t < 900) {
      g.fillStyle = COLORS[S.last.kind] || '#fff';
      g.font = '800 34px system-ui';
      g.fillText(NAMES[S.last.kind] || S.last.kind, x0, H - 20);
    }
  }

  window.LRTest = {
    init,
    setActive(on) { S.active = !!on; if (on && S.cv) resize(); },
  };
})();
