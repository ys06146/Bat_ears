/* Force Push: a tiny game driven by BatEars gestures (starting point for the game/UI part).
 *
 * Push = blast the nearest incoming meteor (a harder push scores more).
 * Pull = grab the nearest star for bonus points.
 * Push while the game is not running = start a new 30-second round.
 *
 * window.ForcePush: init(canvas), start(), get state
 */
(function () {
  'use strict';

  const ROUND_MS = 30000;
  const S = {
    cv: null, g: null, W: 0, H: 0,
    running: false, over: false, t0: 0, score: 0, lives: 3, best: 0,
    objs: [], parts: [], stars: [], nextSpawn: 0, flash: null, shake: 0,
  };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    S.W = S.cv.clientWidth; S.H = S.cv.clientHeight;
    S.cv.width = Math.round(S.W * dpr); S.cv.height = Math.round(S.H * dpr);
    S.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function init(canvas) {
    S.cv = canvas;
    S.g = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    for (let i = 0; i < 120; i++) S.stars.push({ x: Math.random(), y: Math.random(), s: Math.random() * 1.5 + 0.3 });
    BatEars.on('gesture', onGesture);
    requestAnimationFrame(frame);
  }

  function start() {
    Object.assign(S, { running: true, over: false, t0: performance.now(), score: 0, lives: 3, objs: [], parts: [], nextSpawn: 0 });
    say('START!', '#7fe0c8');
  }

  function end() {
    S.running = false;
    S.over = true;
    S.best = Math.max(S.best, S.score);
  }

  function say(text, color) { S.flash = { text, color, until: performance.now() + 700 }; }

  // Objects live in a simple 3D space: z = 1 far away, z = 0 at the player.
  function spawn(now) {
    const elapsed = (now - S.t0) / 1000;
    const isStar = Math.random() < 0.22;
    S.objs.push({
      x: (Math.random() - 0.5) * 1.4, y: (Math.random() - 0.5) * 0.9, z: 1,
      vz: 0.16 + Math.random() * 0.08 + elapsed * 0.006, star: isStar, spin: Math.random() * 6,
    });
    S.nextSpawn = now + Math.max(450, 1300 - elapsed * 25);
  }

  function project(o) {
    const s = 1 / (0.12 + o.z * 1.8);
    return { px: S.W / 2 + o.x * S.W * 0.35 * s, py: S.H / 2 + o.y * S.H * 0.35 * s, r: Math.max(3, 22 * s) };
  }

  function burst(o, color, n, power) {
    const p = project(o);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = (60 + Math.random() * 240) * power;
      S.parts.push({ x: p.px, y: p.py, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.6 + Math.random() * 0.5, color });
    }
  }

  function nearest(wantStar) {
    let best = null;
    for (const o of S.objs) if (!o.dead && o.star === wantStar && (!best || o.z < best.z)) best = o;
    return best;
  }

  function onGesture(e) {
    if (!S.running) { if (e.kind === 'push') start(); return; }
    const power = Math.min(2, 0.6 + (e.speed || 0.5));
    if (e.kind === 'push') {
      const o = nearest(false);
      if (!o) { say('PUSH', '#4fc3f7'); return; }
      o.dead = true;
      burst(o, '#ff8a50', 40, power);
      const pts = 10 + Math.round(15 * power);
      S.score += pts;
      say(`FORCE PUSH +${pts}`, '#4fc3f7');
    } else {
      const o = nearest(true);
      if (!o) { say('PULL', '#ffb74d'); return; }
      o.dead = true;
      burst(o, '#ffe082', 24, 0.6);
      S.score += 25;
      say('GRAB ★ +25', '#ffe082');
    }
  }

  function update(now, dt) {
    if (S.running) {
      if (now >= S.nextSpawn) spawn(now);
      for (const o of S.objs) {
        if (o.dead) continue;
        o.z -= o.vz * dt;
        o.spin += dt * 2;
        if (o.z <= 0.02) {
          o.dead = true;
          if (!o.star) { S.lives--; S.shake = 0.35; say('OUCH', '#ff5252'); }
        }
      }
      if (S.lives <= 0 || now - S.t0 >= ROUND_MS) end();
    }
    S.objs = S.objs.filter((o) => !o.dead);
    for (const p of S.parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.97; p.vy *= 0.97; p.life -= dt; }
    S.parts = S.parts.filter((p) => p.life > 0);
    S.shake = Math.max(0, S.shake - dt);
  }

  function draw(now) {
    const { g, W, H } = S;
    g.save();
    if (S.shake > 0) g.translate((Math.random() - 0.5) * 16 * S.shake, (Math.random() - 0.5) * 16 * S.shake);
    const bg = g.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, Math.max(W, H) * 0.7);
    bg.addColorStop(0, '#1b2140'); bg.addColorStop(1, '#07080d');
    g.fillStyle = bg;
    g.fillRect(-20, -20, W + 40, H + 40);
    g.fillStyle = '#ffffff';
    for (const s of S.stars) { g.globalAlpha = 0.25 + 0.5 * s.s / 1.8; g.fillRect(s.x * W, s.y * H, s.s, s.s); }
    g.globalAlpha = 1;

    const objs = S.objs.slice().sort((a, b) => b.z - a.z);
    for (const o of objs) {
      const p = project(o);
      if (o.star) {
        g.fillStyle = '#ffe082';
        g.shadowColor = '#ffe082'; g.shadowBlur = 18;
        starPath(g, p.px, p.py, p.r, o.spin);
        g.fill();
      } else {
        const grd = g.createRadialGradient(p.px - p.r / 3, p.py - p.r / 3, p.r / 5, p.px, p.py, p.r);
        grd.addColorStop(0, '#ffb07a'); grd.addColorStop(1, '#8a3b1c');
        g.fillStyle = grd;
        g.shadowColor = '#ff7043'; g.shadowBlur = 14;
        g.beginPath(); g.arc(p.px, p.py, p.r, 0, Math.PI * 2); g.fill();
      }
      g.shadowBlur = 0;
    }
    for (const p of S.parts) {
      g.globalAlpha = Math.max(0, Math.min(1, p.life));
      g.fillStyle = p.color;
      g.fillRect(p.x, p.y, 3, 3);
    }
    g.globalAlpha = 1;
    g.restore();

    g.fillStyle = '#e8e8e8';
    g.font = '600 18px system-ui';
    g.textAlign = 'left';
    g.fillText(`점수 ${S.score}`, 16, 28);
    g.fillText('❤'.repeat(Math.max(0, S.lives)), 16, 52);
    if (S.running) {
      const left = Math.max(0, ROUND_MS - (now - S.t0)) / 1000;
      g.textAlign = 'right';
      g.fillText(`${left.toFixed(1)}초`, W - 16, 28);
    }
    g.textAlign = 'center';
    if (S.flash && now < S.flash.until) {
      g.fillStyle = S.flash.color;
      g.font = '800 40px system-ui';
      g.fillText(S.flash.text, W / 2, H * 0.22);
    }
    if (!S.running) {
      g.fillStyle = '#e8e8e8';
      g.font = '800 34px system-ui';
      g.fillText(S.over ? `끝! 점수 ${S.score}` : 'FORCE PUSH', W / 2, H / 2 - 10);
      g.font = '16px system-ui';
      g.fillStyle = '#9aa3b2';
      g.fillText(S.over ? `최고 ${S.best} · 손바닥을 밀면 다시 시작` : '손바닥을 화면 쪽으로 밀면 시작 (키보드 ↑ 도 가능)', W / 2, H / 2 + 22);
    }
  }

  function starPath(g, x, y, r, rot) {
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 ? r * 0.45 : r, a = rot + i * Math.PI / 5;
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath();
  }

  let last = 0;
  function frame(now) {
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0);
    last = now;
    if (S.cv.clientWidth !== S.W || S.cv.clientHeight !== S.H) resize();
    update(now, dt);
    draw(now);
    requestAnimationFrame(frame);
  }

  window.ForcePush = { init, start, get state() { return { running: S.running, score: S.score, lives: S.lives, best: S.best }; } };
})();
