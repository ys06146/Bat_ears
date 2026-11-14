/* Force Push: a tiny game driven by BatEars gestures.
 *
 * Push  = blast the nearest incoming meteor (a harder push scores more; quick hits build a combo).
 * Pull  = grab the nearest star for bonus points.
 * Wave  = SHOCKWAVE: clears every meteor on screen, once per round (key W without a mic).
 * Push while the game is not running = start a new 30-second round.
 *
 * Sound effects use their own AudioContext with sine/triangle tones under ~2 kHz,
 * soft attacks and a low-pass filter, so they stay far away from the 20 kHz probe band.
 * The top-5 scoreboard is kept in localStorage (key 'batears.scores').
 *
 * window.ForcePush: init(canvas), start(), setReady(bool), setMuted(bool), scores(), onEnd(fn), get state
 */
(function () {
  'use strict';

  const ROUND_MS = 30000;
  const COMBO_MS = 1800;          // a hit within this window of the last hit keeps the combo
  const SCORE_KEY = 'batears.scores';
  const S = {
    cv: null, g: null, W: 0, H: 0,
    running: false, over: false, ready: true, t0: 0, score: 0, lives: 3, best: 0,
    combo: 0, lastHit: 0, maxCombo: 0, hits: 0, misses: 0, waveLeft: 1, ring: null,
    objs: [], parts: [], stars: [], nextSpawn: 0, flash: null, shake: 0,
    rank: -1, endListeners: [], lastTick: 0,
  };

  // ---------------------------------------------------------------- scoreboard
  function loadScores() {
    try { const a = JSON.parse(localStorage.getItem(SCORE_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; }
  }
  function saveScore(entry) {
    const list = loadScores();
    list.push(entry);
    list.sort((a, b) => b.score - a.score || a.t - b.t);
    const top = list.slice(0, 5);
    try { localStorage.setItem(SCORE_KEY, JSON.stringify(top)); } catch (_) { /* private mode */ }
    return top.indexOf(entry);
  }

  // ---------------------------------------------------------------- sound effects
  const sfx = {
    ctx: null, out: null, muted: false,
    ensure() {
      if (this.muted) return null;
      try {
        if (!this.ctx) {
          this.ctx = new AudioContext();
          const lp = this.ctx.createBiquadFilter();
          lp.type = 'lowpass'; lp.frequency.value = 4000;
          const master = this.ctx.createGain();
          master.gain.value = 0.25;
          lp.connect(master).connect(this.ctx.destination);
          this.out = lp;
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (_) { return null; }
      return this.ctx;
    },
    // one enveloped tone, optionally sliding from f1 to f2
    tone(f1, f2, dur, type, vol, delay) {
      const ctx = this.ensure();
      if (!ctx) return;
      const t = ctx.currentTime + (delay || 0);
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f1, t);
      if (f2 && f2 !== f1) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.5, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.out);
      o.start(t); o.stop(t + dur + 0.02);
    },
    push(power) { this.tone(520 + 200 * power, 90, 0.22, 'triangle', 0.6); this.tone(160, 50, 0.25, 'sine', 0.7); },
    whiff() { this.tone(300, 200, 0.08, 'sine', 0.25); },
    grab() { [880, 1175, 1568].forEach((f, i) => this.tone(f, f, 0.12, 'sine', 0.35, i * 0.06)); },
    hurt() { this.tone(220, 70, 0.35, 'triangle', 0.7); },
    wave() { this.tone(90, 900, 0.4, 'triangle', 0.5); this.tone(1200, 120, 0.6, 'sine', 0.35, 0.1); },
    start() { [523, 659, 784].forEach((f, i) => this.tone(f, f, 0.14, 'triangle', 0.4, i * 0.1)); },
    tick() { this.tone(1000, 1000, 0.05, 'sine', 0.2); },
    end(record) {
      const notes = record ? [523, 659, 784, 1047] : [440, 349, 262];
      notes.forEach((f, i) => this.tone(f, f, 0.22, 'triangle', 0.45, i * 0.16));
    },
  };

  // ---------------------------------------------------------------- lifecycle
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
    S.best = loadScores().reduce((m, e) => Math.max(m, e.score), 0);
    BatEars.on('gesture', onGesture);
    // the engine has no wave key, so simulate it here (W) for keyboard-only play
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (e.repeat || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'w' || e.key === 'W') onGesture({ kind: 'wave', simulated: true });
      else if (e.key === 'm' || e.key === 'M') setMuted(!sfx.muted);
    });
    requestAnimationFrame(frame);
  }

  function start() {
    Object.assign(S, {
      running: true, over: false, t0: performance.now(), score: 0, lives: 3, objs: [], parts: [], nextSpawn: 0,
      combo: 0, lastHit: 0, maxCombo: 0, hits: 0, misses: 0, waveLeft: 1, ring: null, rank: -1, lastTick: 0,
    });
    say('START!', '#ff5a60');
    sfx.start();
  }

  function end() {
    S.running = false;
    S.over = true;
    S.objs = [];
    const entry = { score: S.score, combo: S.maxCombo, hits: S.hits, t: Date.now() };
    S.rank = S.score > 0 ? saveScore(entry) : -1;
    const record = S.score > S.best;
    S.best = Math.max(S.best, S.score);
    sfx.end(record);
    S.endListeners.forEach((fn) => { try { fn({ ...entry, rank: S.rank, record }); } catch (e) { console.error(e); } });
  }

  function say(text, color) { S.flash = { text, color, until: performance.now() + 700 }; }

  // ---------------------------------------------------------------- world
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

  function hit(now) {
    S.combo = now - S.lastHit < COMBO_MS ? S.combo + 1 : 1;
    S.lastHit = now;
    S.maxCombo = Math.max(S.maxCombo, S.combo);
    S.hits++;
    return Math.min(4, 1 + Math.floor((S.combo - 1) / 3)); // ×1, ×2 at 4 hits, ×3 at 7, ×4 at 10
  }

  function onGesture(e) {
    if (!S.running) {
      if (e.kind === 'push' && S.ready) start();
      return;
    }
    const now = performance.now();
    const power = Math.min(2, 0.6 + (e.speed || 0.5));
    if (e.kind === 'push') {
      const o = nearest(false);
      if (!o) { say('PUSH', '#4fc3f7'); sfx.whiff(); return; }
      o.dead = true;
      burst(o, '#ff8a50', 40, power);
      const mult = hit(now);
      const pts = (10 + Math.round(15 * power)) * mult;
      S.score += pts;
      say(mult > 1 ? `×${mult} COMBO +${pts}` : `FORCE PUSH +${pts}`, '#4fc3f7');
      sfx.push(power);
    } else if (e.kind === 'pull') {
      const o = nearest(true);
      if (!o) { say('PULL', '#ffb74d'); sfx.whiff(); return; }
      o.dead = true;
      burst(o, '#ffe082', 24, 0.6);
      const mult = hit(now);
      S.score += 25 * mult;
      say(`GRAB ★ +${25 * mult}`, '#ffe082');
      sfx.grab();
    } else if (e.kind === 'wave') {
      if (S.waveLeft <= 0) { say('SHOCKWAVE 다 썼어요', '#9aa3b2'); return; }
      S.waveLeft--;
      let n = 0;
      for (const o of S.objs) if (!o.dead && !o.star) { o.dead = true; burst(o, '#b39ddb', 18, 1.2); n++; }
      S.score += n * 15;
      S.ring = { t0: now };
      S.shake = 0.25;
      say(`SHOCKWAVE +${n * 15}`, '#b39ddb');
      sfx.wave();
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
          if (!o.star) { S.lives--; S.misses++; S.combo = 0; S.shake = 0.35; say('OUCH', '#ff5252'); sfx.hurt(); }
        }
      }
      const left = ROUND_MS - (now - S.t0);
      const sec = Math.ceil(left / 1000);
      if (sec <= 5 && sec > 0 && sec !== S.lastTick) { S.lastTick = sec; sfx.tick(); }
      if (S.combo && now - S.lastHit > COMBO_MS) S.combo = 0;
      if (S.lives <= 0 || left <= 0) end();
    }
    S.objs = S.objs.filter((o) => !o.dead);
    for (const p of S.parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.97; p.vy *= 0.97; p.life -= dt; }
    S.parts = S.parts.filter((p) => p.life > 0);
    S.shake = Math.max(0, S.shake - dt);
    if (S.ring && now - S.ring.t0 > 600) S.ring = null;
  }

  // ---------------------------------------------------------------- drawing
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
    if (S.ring) {
      const k = (now - S.ring.t0) / 600;
      g.globalAlpha = 1 - k;
      g.strokeStyle = '#b39ddb';
      g.lineWidth = 6 * (1 - k) + 1;
      g.beginPath(); g.arc(W / 2, H / 2, k * Math.max(W, H) * 0.7, 0, Math.PI * 2); g.stroke();
    }
    g.globalAlpha = 1;
    g.restore();

    drawHud(now);
    if (!S.running) drawIdle();
  }

  function drawHud(now) {
    const { g, W, H } = S;
    g.fillStyle = '#e8e8e8';
    g.font = '600 18px Inter, system-ui';
    g.textAlign = 'left';
    g.fillText(`점수 ${S.score}`, 16, 28);
    g.fillStyle = '#ff6b6b';
    g.fillText('❤'.repeat(Math.max(0, S.lives)) + '♡'.repeat(Math.max(0, 3 - S.lives)), 16, 52);
    if (S.running) {
      const left = Math.max(0, ROUND_MS - (now - S.t0)) / 1000;
      g.textAlign = 'right';
      g.fillStyle = left <= 5 ? '#fbbf24' : '#e8e8e8';
      g.fillText(`${left.toFixed(1)}초`, W - 16, 28);
      g.font = '13px system-ui';
      g.fillStyle = S.waveLeft ? '#b39ddb' : '#5a6070';
      g.fillText(S.waveLeft ? '흔들기 SHOCKWAVE 1회' : 'SHOCKWAVE 사용함', W - 16, 50);
      // time bar
      g.fillStyle = '#ffffff22';
      g.fillRect(0, H - 4, W, 4);
      g.fillStyle = left <= 5 ? '#fbbf24' : '#c5050c';
      g.fillRect(0, H - 4, W * left / (ROUND_MS / 1000), 4);
      if (S.combo >= 2) {
        g.textAlign = 'left';
        g.font = '700 15px system-ui';
        g.fillStyle = '#ff5a60';
        g.fillText(`${S.combo} 콤보`, 16, 76);
      }
    }
    g.textAlign = 'center';
    if (S.flash && now < S.flash.until) {
      g.fillStyle = S.flash.color;
      g.font = '800 40px Inter, system-ui';
      g.fillText(S.flash.text, W / 2, H * 0.22);
    }
    if (sfx.muted) {
      g.textAlign = 'right'; g.font = '12px system-ui'; g.fillStyle = '#9aa3b2';
      g.fillText('🔇 M', W - 16, H - 12);
    }
  }

  function drawIdle() {
    const { g, W, H } = S;
    g.fillStyle = '#07080daa';
    g.fillRect(0, 0, W, H);
    g.textAlign = 'center';
    g.fillStyle = '#e8e8e8';
    g.font = '800 34px Inter, system-ui';
    const top = S.over ? H / 2 - 110 : H / 2 - 30;
    g.fillText(S.over ? (S.rank === 0 ? `🏆 신기록! ${S.score}점` : `끝! 점수 ${S.score}`) : 'FORCE PUSH', W / 2, top);
    g.font = '16px system-ui';
    g.fillStyle = '#9aa3b2';
    const hint = !S.ready ? '기준값 잡는 중… 손을 화면에서 치워 주세요'
      : S.over ? '손바닥을 밀면 다시 시작'
        : '손바닥을 화면 쪽으로 밀면 시작 (키보드 ↑ 도 가능)';
    g.fillText(hint, W / 2, top + 30);
    if (!S.over) {
      g.font = '14px system-ui';
      g.fillText('밀기 ⟶ 운석 부수기 · 당기기 ⟵ 별 잡기 · 흔들기 〰 SHOCKWAVE(W)', W / 2, top + 56);
      return;
    }
    g.fillStyle = '#c8cdd6';
    g.font = '14px system-ui';
    g.fillText(`맞힌 수 ${S.hits} · 최대 콤보 ${S.maxCombo} · 놓친 운석 ${S.misses}`, W / 2, top + 56);
    // top 5
    const list = loadScores();
    g.font = '700 15px system-ui';
    g.fillStyle = '#e8e8e8';
    g.fillText('순위표', W / 2, top + 92);
    g.font = '15px ui-monospace, Menlo, monospace';
    list.forEach((e, i) => {
      g.fillStyle = i === S.rank ? '#ff5a60' : '#9aa3b2';
      const line = `${i + 1}.  ${String(e.score).padStart(5)}점   콤보 ${String(e.combo || 0).padStart(2)}`;
      g.fillText(line + (i === S.rank ? '  ◀' : '   '), W / 2, top + 116 + i * 22);
    });
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

  function setMuted(m) { sfx.muted = !!m; if (sfx.muted && sfx.ctx) sfx.ctx.suspend(); }

  window.ForcePush = {
    init, start, setMuted,
    setReady(r) { S.ready = !!r; },
    scores: loadScores,
    onEnd(fn) { S.endListeners.push(fn); },
    get muted() { return sfx.muted; },
    get state() { return { running: S.running, score: S.score, lives: S.lives, best: S.best, combo: S.combo, maxCombo: S.maxCombo }; },
  };
})();
