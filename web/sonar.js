/* Sonar view: what the laptop "hears", drawn as a holographic hand plus a 5-second motion graph.
 *
 * window.SonarView
 *   init(canvas, video)   start listening to BatEars frames/gestures and drawing into canvas
 *   setActive(on)         draw only while the view is visible
 *   toggleCamera()        optional comparison: show the real webcam next to the hologram -> Promise<boolean>
 *   stopCamera()
 *
 * The hand position is integrated from the Doppler velocity (toward the laptop = closer) with a slow
 * pull back to the rest position, so it shows motion, not an absolute distance. In stereo mode the
 * difference between the left and right tones also moves it sideways.
 */
(function () {
  'use strict';

  const HIST_MS = 5000;
  const TRAIL_MS = 1200;
  const NAMES = { push: '밀기', pull: '당기기', wave: '흔들기', left: '왼쪽', right: '오른쪽' };
  const COLORS = { push: '#4fc3f7', pull: '#ffb74d', wave: '#b388ff', left: '#80deea', right: '#80deea' };
  const S = {
    cv: null, g: null, W: 0, H: 0, active: false, video: null, cam: null,
    z: 0.5, x: 0, trail: [], hist: [], marks: [], lastT: 0, last: null,
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    S.W = S.cv.clientWidth;
    S.H = S.cv.clientHeight;
    S.cv.width = Math.round(S.W * dpr);
    S.cv.height = Math.round(S.H * dpr);
    S.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function init(canvas, video) {
    S.cv = canvas;
    S.g = canvas.getContext('2d');
    S.video = video;
    BatEars.on('frame', onFrame);
    BatEars.on('gesture', (e) => {
      S.marks.push({ t: e.t, kind: e.kind, speed: e.speed || 0, sim: !!e.simulated });
      if (S.marks.length > 40) S.marks.shift();
    });
    requestAnimationFrame(draw);
  }

  function onFrame(f) {
    const now = f.t;
    const dt = S.lastT ? Math.min(0.05, (now - S.lastT) / 1000) : 0;
    S.lastT = now;
    S.last = f;
    const live = f.tone && !f.calibrating;
    let vDepth = 0, vLat = 0;
    if (live) {
      const th = Math.min(f.thUp || 6, f.thDown || 6);
      const moving = f.dUp > th * 0.5 || f.dDown > th * 0.5;
      if (moving && f.stereo) {
        vDepth = (f.stereo.vL + f.stereo.vR) / 2;
        vLat = (f.stereo.vR - f.stereo.vL) / 2;
      } else if (moving) {
        vDepth = f.v;
      }
    }
    // toward the laptop (v > 0) = closer (z -> 0); drift slowly back to the rest position
    S.z = clamp(S.z - vDepth * 1.6 * dt + (0.5 - S.z) * 0.7 * dt, 0, 1);
    S.x = clamp(S.x + vLat * 2.2 * dt - S.x * 0.7 * dt, -1, 1);
    S.trail.push({ x: S.x, z: S.z, t: now });
    while (S.trail.length && now - S.trail[0].t > TRAIL_MS) S.trail.shift();
    S.hist.push({ t: now, up: live ? f.dUp : 0, down: live ? f.dDown : 0, v: live ? f.v : 0, thUp: f.thUp || 6, thDown: f.thDown || 6 });
    while (S.hist.length && now - S.hist[0].t > HIST_MS) S.hist.shift();
  }

  // ------------------------------------------------------------------ drawing
  function draw(now) {
    requestAnimationFrame(draw);
    if (!S.active || !S.cv) return;
    if (S.cv.clientWidth !== S.W || S.cv.clientHeight !== S.H) resize();
    const { g, W, H } = S;
    if (!W || !H) return;
    const graphH = Math.round(H * 0.3), sceneH = H - graphH;
    g.fillStyle = '#04060b';
    g.fillRect(0, 0, W, H);
    drawScene(now, W, sceneH);
    drawGraph(now, sceneH, W, graphH);
  }

  // Map hand state to the screen: z = 0 is right in front of the laptop (bottom), z = 1 is far (horizon).
  function place(x, z, W, sceneH) {
    const horizon = sceneH * 0.18, near = sceneH * 0.8;
    const y = near - (near - horizon) * Math.pow(z, 0.9);
    const scale = 1.25 - 0.85 * z;
    return { px: W / 2 + x * W * 0.32 * scale, py: y, scale };
  }

  function drawScene(now, W, sceneH) {
    const g = S.g, cx = W / 2, horizon = sceneH * 0.18, base = sceneH * 0.9;
    // perspective grid
    g.save();
    g.strokeStyle = 'rgba(0, 229, 255, 0.18)';
    g.lineWidth = 1;
    for (let i = -10; i <= 10; i++) {
      g.beginPath();
      g.moveTo(cx + i * W * 0.09, base);
      g.lineTo(cx + i * W * 0.012, horizon);
      g.stroke();
    }
    for (let j = 0; j <= 12; j++) {
      const k = j / 12, y = horizon + (base - horizon) * k * k;
      g.globalAlpha = 0.15 + 0.6 * k;
      g.beginPath();
      g.moveTo(cx - W * 0.12 - W * 0.8 * k, y);
      g.lineTo(cx + W * 0.12 + W * 0.8 * k, y);
      g.stroke();
    }
    g.globalAlpha = 1;
    // laptop + outgoing sonar arcs
    const lx = cx, ly = base - 6;
    const live = S.last && S.last.tone && !S.last.calibrating;
    for (let i = 0; i < 4; i++) {
      const r = ((now / 12 + i * 60) % 240) + 20;
      g.strokeStyle = `rgba(127, 224, 200, ${live ? (1 - r / 260) * 0.6 : 0.08})`;
      g.beginPath();
      g.arc(lx, ly, r, Math.PI * 1.12, Math.PI * 1.88);
      g.stroke();
    }
    g.fillStyle = '#1f3a4a';
    g.fillRect(lx - 46, ly - 6, 92, 10);
    g.fillStyle = '#7fe0c8';
    g.font = '11px system-ui';
    g.textAlign = 'center';
    g.fillText('💻 노트북 스피커·마이크', lx, ly + 20);

    // trail
    for (let i = 1; i < S.trail.length; i++) {
      const a = place(S.trail[i - 1].x, S.trail[i - 1].z, W, sceneH), b = place(S.trail[i].x, S.trail[i].z, W, sceneH);
      g.strokeStyle = `rgba(0, 229, 255, ${(i / S.trail.length) * 0.5})`;
      g.lineWidth = 3 * b.scale;
      g.beginPath(); g.moveTo(a.px, a.py); g.lineTo(b.px, b.py); g.stroke();
    }

    // holographic hand
    const p = place(S.x, S.z, W, sceneH);
    const lastMark = S.marks[S.marks.length - 1];
    const recent = lastMark && now - lastMark.t < 600 ? lastMark : null;
    const color = recent ? COLORS[recent.kind] || '#00e5ff' : '#00e5ff';
    drawHand(g, p.px, p.py, 46 * p.scale, color, now);

    // gesture pulse + label
    if (recent) {
      const k = (now - recent.t) / 600;
      g.strokeStyle = color;
      g.globalAlpha = 1 - k;
      g.lineWidth = 3;
      g.beginPath(); g.arc(p.px, p.py, 40 * p.scale + k * 120, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = color;
      g.font = '800 26px system-ui';
      g.fillText(`${NAMES[recent.kind] || recent.kind}${recent.sim ? ' (키보드)' : ''}  ${recent.speed ? recent.speed.toFixed(2) + ' m/s' : ''}`, p.px, Math.max(30, p.py - 70 * p.scale));
    }

    // HUD
    g.textAlign = 'left';
    g.fillStyle = '#7fe0c8';
    g.font = '700 15px system-ui';
    g.fillText('🛰️ SONAR VIEW · 카메라 없이 소리로 본 손', 14, 66);
    g.font = '12px system-ui';
    g.fillStyle = '#9aa3b2';
    const f = S.last;
    const status = !f ? '▶ 시작을 누르면 초음파가 켜져요'
      : f.calibrating ? '기준값 잡는 중… 손 치우기'
      : `SNR ${Number.isFinite(f.snr) ? f.snr.toFixed(0) : '–'} dB · 속도 ${(f.v || 0) >= 0 ? '+' : ''}${(f.v || 0).toFixed(2)} m/s${f.stereo ? ' · 스테레오' : ''}`;
    g.fillText(status, 14, 84);
    // depth gauge
    const gx = W - 26, gy0 = 30, gy1 = sceneH - 30;
    g.strokeStyle = 'rgba(0,229,255,0.35)';
    g.strokeRect(gx, gy0, 10, gy1 - gy0);
    const gy = gy1 - (gy1 - gy0) * (1 - S.z);
    g.fillStyle = '#00e5ff';
    g.fillRect(gx - 3, gy - 2, 16, 4);
    g.textAlign = 'right';
    g.fillStyle = '#9aa3b2';
    g.fillText('멀리', gx - 6, gy0 + 10);
    g.fillText('가까이', gx - 6, gy1);
    g.restore();
  }

  function drawHand(g, x, y, s, color, now) {
    g.save();
    g.translate(x, y);
    g.shadowColor = color;
    g.shadowBlur = 24;
    g.fillStyle = hexA(color, 0.22);
    g.strokeStyle = color;
    g.lineWidth = 2;
    const parts = [
      [-0.55, -0.15, 1.1, 0.95, 0.28],          // palm
      [-0.52, -0.95, 0.22, 0.85, 0.11],         // fingers
      [-0.24, -1.12, 0.22, 1.0, 0.11],
      [0.06, -1.08, 0.22, 0.95, 0.11],
      [0.34, -0.9, 0.2, 0.78, 0.1],
      [0.52, 0.0, 0.42, 0.2, 0.1],              // thumb
    ];
    for (const [px, py, w, h, r] of parts) {
      g.beginPath();
      g.roundRect(px * s, py * s, w * s, h * s, r * s);
      g.fill();
      g.stroke();
    }
    // scanlines
    g.shadowBlur = 0;
    g.strokeStyle = hexA(color, 0.25);
    g.lineWidth = 1;
    const off = (now / 40) % 6;
    for (let yy = -1.15 * s + off; yy < 0.85 * s; yy += 6) {
      g.beginPath(); g.moveTo(-0.6 * s, yy); g.lineTo(0.6 * s, yy); g.stroke();
    }
    g.restore();
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  // 5-second strip: echo energy above the tone (blue, up), below it (orange, down), speed (white),
  // thresholds (dashed) and the gestures the detector fired (vertical markers).
  function drawGraph(now, y0, W, H) {
    const g = S.g, mid = y0 + H / 2, half = H / 2 - 14, t0 = now - HIST_MS;
    const x = (t) => 8 + ((t - t0) / HIST_MS) * (W - 16);
    const yUp = (db) => mid - clamp(db, 0, 30) / 30 * half;
    const yDn = (db) => mid + clamp(db, 0, 30) / 30 * half;
    g.fillStyle = '#0a0e16';
    g.fillRect(0, y0, W, H);
    g.strokeStyle = '#222838';
    g.beginPath(); g.moveTo(0, y0 + 0.5); g.lineTo(W, y0 + 0.5); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
    const last = S.hist[S.hist.length - 1];
    if (last) {
      g.setLineDash([4, 4]);
      g.strokeStyle = 'rgba(79,195,247,.5)';
      g.beginPath(); g.moveTo(0, yUp(last.thUp)); g.lineTo(W, yUp(last.thUp)); g.stroke();
      g.strokeStyle = 'rgba(255,183,77,.5)';
      g.beginPath(); g.moveTo(0, yDn(last.thDown)); g.lineTo(W, yDn(last.thDown)); g.stroke();
      g.setLineDash([]);
    }
    const series = (sel, ymap, color) => {
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.beginPath();
      S.hist.forEach((h, i) => { const px = x(h.t), py = ymap(sel(h)); if (i) g.lineTo(px, py); else g.moveTo(px, py); });
      g.stroke();
    };
    series((h) => h.up, yUp, '#4fc3f7');
    series((h) => h.down, yDn, '#ffb74d');
    series((h) => h.v, (v) => mid - clamp(v, -1.5, 1.5) / 1.5 * half, 'rgba(255,255,255,.7)');
    g.font = '11px system-ui';
    g.textAlign = 'center';
    for (const m of S.marks) {
      if (m.t < t0) continue;
      const px = x(m.t);
      g.strokeStyle = COLORS[m.kind] || '#fff';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(px, y0 + 4); g.lineTo(px, y0 + H - 4); g.stroke();
      g.fillStyle = COLORS[m.kind] || '#fff';
      g.fillText(NAMES[m.kind] || m.kind, px, y0 + 14);
    }
    g.textAlign = 'left';
    g.fillStyle = '#9aa3b2';
    g.fillText('지난 5초 · 파랑: 가까워지는 반사음 · 주황: 멀어지는 반사음 · 흰색: 손 속도 · 세로선: 감지된 동작', 10, y0 + H - 6);
  }

  // ------------------------------------------------------------------ optional webcam comparison
  async function toggleCamera() {
    if (S.cam) { stopCamera(); return false; }
    try {
      S.cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 } }, audio: false });
      S.video.srcObject = S.cam;
      await S.video.play().catch(() => {});
      return true;
    } catch (e) {
      console.error('[SonarView] camera', e);
      S.cam = null;
      return false;
    }
  }

  function stopCamera() {
    if (S.cam) S.cam.getTracks().forEach((t) => t.stop());
    S.cam = null;
    if (S.video) S.video.srcObject = null;
  }

  window.SonarView = {
    init, toggleCamera, stopCamera,
    setActive(on) { S.active = !!on; if (on) resize(); },
    get state() { return { z: S.z, x: S.x, marks: S.marks.length, hist: S.hist.length }; },
  };
})();
