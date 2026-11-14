/* Doppler Speed Gun: a 3-round mini-game that shows off what Bat Ears measures.
 *
 * Round 1  Max speed      push as fast as you can                   score = speed (capped)
 * Round 2  Precision      pull at a target speed                    score = closeness to the target
 * Round 3  In the dark    the screen goes black, push at a target   a camera would see nothing; the echo still works
 *
 * Every result shows the physics: the echo of the f0 tone comes back shifted by df = 2·v·f0/c.
 * Top 10 with names are kept in localStorage ('batears.speed').
 * Without a mic: ArrowUp / ArrowDown fire the engine's simulated gestures (0.8 m/s);
 * S fires a simulated gesture of the expected kind at a random speed.
 *
 * window.SpeedGun: init(root), setActive(bool)
 */
(function () {
  'use strict';
  const C = 343;
  const KEY = 'batears.speed';
  const VMAX = 2;               // gauge range, m/s
  const WAIT_MS = 9000;         // time to make the gesture
  const ROUNDS = [
    { id: 'max', name: '최고 속도', kind: 'push', icon: '⚡', text: '최대한 빠르게 손바닥을 화면 쪽으로 미세요!' },
    { id: 'aim', name: '정밀 도전', kind: 'pull', icon: '🎯', text: '목표 속도에 맞춰 손을 당기세요' },
    { id: 'dark', name: '어둠 속에서', kind: 'push', icon: '🌑', text: '불이 꺼져요. 카메라라면 아무것도 못 봐요. 목표 속도로 미세요' },
  ];

  const S = {
    root: null, el: {}, active: false,
    phase: 'ready',             // ready | intro | wait | result | final
    round: 0, target: 0, results: [], until: 0, needle: 0, peak: 0, liveV: 0, lastSaved: -1,
  };

  // ---------------------------------------------------------------- scoreboard
  function loadTop() { try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
  function saveTop(entry) {
    const list = loadTop().concat(entry).sort((a, b) => b.score - a.score || a.t - b.t).slice(0, 10);
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (_) { /* private mode */ }
    return list.indexOf(entry);
  }

  // ---------------------------------------------------------------- sounds (under 2 kHz)
  let actx = null;
  function tone(f, dur, vol, delay) {
    try {
      actx = actx || new AudioContext();
      if (actx.state === 'suspended') actx.resume();
      const t = actx.currentTime + (delay || 0), o = actx.createOscillator(), g = actx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.05);
    } catch (_) { /* no audio */ }
  }
  const sfx = {
    go() { tone(660, 0.12, 0.25); tone(990, 0.2, 0.25, 0.12); },
    hit(score) { const n = score >= 90 ? 4 : score >= 60 ? 3 : 2; for (let i = 0; i < n; i++) tone(523 * Math.pow(1.26, i), 0.15, 0.25, i * 0.08); },
    miss() { tone(220, 0.3, 0.3); },
    end() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, 0.25, i * 0.14)); },
  };

  // ---------------------------------------------------------------- game flow
  const f0 = () => (window.BatEars && BatEars.freq) || 20000;
  const shift = (v) => 2 * v * f0() / C;
  const kmh = (v) => v * 3.6;

  function startGame() {
    S.results = [];
    S.round = 0;
    S.lastSaved = -1;
    startRound();
  }

  function startRound() {
    const r = ROUNDS[S.round];
    S.target = r.id === 'max' ? 0 : +(0.35 + Math.random() * 0.5).toFixed(2);
    S.phase = 'intro';
    S.until = performance.now() + 1600;
    S.peak = 0;
    S.root.classList.toggle('dark', r.id === 'dark');
    render();
  }

  function onGesture(e) {
    if (!S.active) return;
    if (S.phase === 'ready' || S.phase === 'final') {
      if (e.kind === 'push' && (S.phase === 'ready' || S.lastSaved >= 0)) startGame();
      return;
    }
    if (S.phase !== 'wait') return;
    const r = ROUNDS[S.round];
    if (e.kind !== r.kind) { flash(`${e.kind === 'push' ? '밀기' : e.kind === 'pull' ? '당기기' : '다른 동작'}가 감지됐어요. 이번엔 ${r.kind === 'push' ? '밀기' : '당기기'}예요!`); return; }
    finishRound(Math.max(0, e.speed || 0), !!e.simulated);
  }

  function finishRound(v, simulated) {
    const r = ROUNDS[S.round];
    let score;
    if (r.id === 'max') score = Math.min(100, Math.round(v / 1.5 * 100));
    else score = Math.max(0, Math.round(100 - Math.abs(v - S.target) * 250));
    S.results.push({ round: r.id, v, target: S.target, score, simulated });
    S.peak = v;
    S.phase = 'result';
    S.until = performance.now() + 2600;
    S.root.classList.remove('dark');
    if (v > 0) sfx.hit(score); else sfx.miss();
    render();
  }

  function next() {
    S.round++;
    if (S.round < ROUNDS.length) { startRound(); return; }
    S.phase = 'final';
    sfx.end();
    render();
    setTimeout(() => { if (S.phase === 'final' && S.lastSaved < 0) S.el.name.focus(); }, 50);
  }

  function total() { return S.results.reduce((s, r) => s + r.score, 0); }

  let flashTimer = 0;
  function flash(msg) {
    S.el.flash.textContent = msg;
    S.el.flash.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { S.el.flash.hidden = true; }, 1500);
  }

  // ---------------------------------------------------------------- loop
  function tick(now) {
    requestAnimationFrame(tick);
    if (!S.active) return;
    if (S.phase === 'intro' && now >= S.until) { S.phase = 'wait'; S.until = now + WAIT_MS; sfx.go(); render(); }
    else if (S.phase === 'wait' && now >= S.until) finishRound(0, false);
    else if (S.phase === 'result' && now >= S.until) next();
    if (S.phase === 'wait') S.el.timer.style.width = (100 * Math.max(0, S.until - now) / WAIT_MS).toFixed(1) + '%';

    // needle: live hand speed while waiting, the measured speed after a result
    const want = S.phase === 'result' ? S.peak : S.phase === 'wait' ? S.liveV : 0;
    S.needle += (want - S.needle) * 0.18;
    drawGauge();
    S.liveV *= 0.9;
  }

  function onFrame(f) {
    if (!S.active || !f.tone || f.calibrating || !Number.isFinite(f.v)) return;
    if (Math.max(f.dUp, f.dDown) > (f.thUp || 6) * 0.5) S.liveV = Math.max(S.liveV, Math.abs(f.v));
  }

  // ---------------------------------------------------------------- drawing
  function drawGauge() {
    const cv = S.el.gauge, dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h - 12, R = Math.min(w / 2 - 16, h - 28);
    const ang = (v) => Math.PI + Math.min(1, v / VMAX) * Math.PI;
    // track
    g.lineCap = 'round';
    g.lineWidth = 14; g.strokeStyle = '#27272a';
    g.beginPath(); g.arc(cx, cy, R, Math.PI, 2 * Math.PI); g.stroke();
    // target band
    const r = ROUNDS[S.round];
    if (S.target && S.phase !== 'ready' && S.phase !== 'final' && r && r.id !== 'max') {
      g.strokeStyle = '#4ade80'; g.lineWidth = 14;
      g.beginPath(); g.arc(cx, cy, R, ang(S.target - 0.06), ang(S.target + 0.06)); g.stroke();
    }
    // value arc
    g.strokeStyle = '#c5050c'; g.lineWidth = 14;
    g.beginPath(); g.arc(cx, cy, R, Math.PI, ang(S.needle)); g.stroke();
    // ticks
    g.fillStyle = '#71717a'; g.font = '11px Inter, system-ui'; g.textAlign = 'center';
    for (let v = 0; v <= VMAX; v += 0.5) {
      const a = ang(v);
      g.fillText(v.toFixed(1), cx + Math.cos(a) * (R - 26), cy + Math.sin(a) * (R - 26) + 4);
    }
    // needle
    const a = ang(S.needle);
    g.strokeStyle = '#fafafa'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * (R - 8), cy + Math.sin(a) * (R - 8)); g.stroke();
    g.fillStyle = '#fafafa'; g.beginPath(); g.arc(cx, cy, 6, 0, Math.PI * 2); g.fill();
  }

  function physics(v, kind) {
    const d = shift(v), sign = kind === 'pull' ? -1 : 1, base = f0();
    const echo = Math.round(base + sign * d);
    return `반사음 ${base.toLocaleString()} → ${echo.toLocaleString()} Hz (${sign > 0 ? '+' : '−'}${d.toFixed(0)} Hz) ⇒ v = Δf·c / 2f₀ = ${v.toFixed(2)} m/s`;
  }

  function render() {
    const e = S.el, r = ROUNDS[S.round];
    e.dots.innerHTML = ROUNDS.map((x, i) => {
      const res = S.results[i];
      const cls = res ? 'done' : i === S.round && S.phase !== 'ready' && S.phase !== 'final' ? 'now' : '';
      return `<span class="${cls}">${x.icon} ${x.name}${res ? ` · ${res.score}점` : ''}</span>`;
    }).join('');
    e.timerWrap.hidden = S.phase !== 'wait';
    e.final.hidden = S.phase !== 'final';
    e.main.hidden = S.phase === 'final';

    if (S.phase === 'ready') {
      e.title.textContent = '🎯 도플러 스피드건';
      e.sub.textContent = '카메라 없이 소리의 메아리만으로 손 속도를 재요. 손바닥을 밀면 시작!';
      e.big.textContent = '–';
      e.unit.textContent = 'm/s';
      e.phys.textContent = `노트북이 ${f0().toLocaleString()} Hz 소리를 내고, 움직이는 손의 메아리가 몇 Hz 바뀌는지로 속도를 계산해요.`;
      e.target.textContent = '';
    } else if (S.phase === 'intro' || S.phase === 'wait') {
      e.title.textContent = `${r.icon} ${S.round + 1}/3 · ${r.name}`;
      e.sub.textContent = S.phase === 'intro' ? '준비…' : r.text;
      e.big.textContent = S.phase === 'intro' ? (r.kind === 'push' ? '밀기!' : '당기기!') : '…';
      e.unit.textContent = S.phase === 'intro' ? '' : 'm/s';
      e.target.textContent = S.target ? `목표 ${S.target.toFixed(2)} m/s (±0.06 안이면 만점 근처)` : '';
      e.phys.textContent = S.phase === 'wait' ? `${r.kind === 'push' ? '밀면 메아리가 높아지고' : '당기면 메아리가 낮아지고'}, 빠를수록 더 많이 바뀌어요.` : '';
    } else if (S.phase === 'result') {
      const res = S.results[S.results.length - 1];
      e.title.textContent = `${r.icon} ${r.name} · ${res.score}점`;
      e.big.textContent = res.v ? res.v.toFixed(2) : '놓침';
      e.unit.textContent = res.v ? `m/s · ${kmh(res.v).toFixed(1)} km/h` : '';
      e.target.textContent = res.target ? `목표 ${res.target.toFixed(2)} m/s · 차이 ${Math.abs(res.v - res.target).toFixed(2)} m/s` : '';
      e.sub.textContent = r.id === 'dark' && res.v
        ? '📷 카메라: 깜깜해서 아무것도 못 봤어요 · 🦇 Bat Ears: 소리로 정확히 잡았어요'
        : res.v ? (res.score >= 90 ? '완벽해요! 🔥' : res.score >= 60 ? '좋아요!' : '조금 더!') : '시간 안에 동작이 없었어요';
      e.phys.textContent = res.v ? physics(res.v, r.kind) + (res.simulated ? ' (키보드 시뮬레이션)' : '') : '';
    } else if (S.phase === 'final') {
      const sum = total();
      e.finalScore.textContent = `${sum}점`;
      e.finalLines.innerHTML = S.results.map((x, i) => `<li>${ROUNDS[i].icon} ${ROUNDS[i].name}: <b>${x.v ? x.v.toFixed(2) + ' m/s' : '놓침'}</b>${x.target ? ` (목표 ${x.target.toFixed(2)})` : ''} · ${x.score}점</li>`).join('');
      e.saveRow.hidden = S.lastSaved >= 0;
      renderTop();
    }
  }

  function renderTop() {
    const list = loadTop();
    S.el.top.innerHTML = list.length
      ? list.map((x, i) => `<li class="${i === S.lastSaved ? 'new' : ''}"><span>${i + 1}. ${escapeHtml(x.name)}</span><b>${x.score}점</b><span class="hint">최고 ${x.vmax.toFixed(2)} m/s</span></li>`).join('')
      : '<li class="hint">아직 기록이 없어요. 첫 번째가 되어 보세요!</li>';
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function save() {
    const name = (S.el.name.value || '').trim().slice(0, 12) || '익명';
    const vmax = Math.max(0, ...S.results.map((x) => x.v));
    S.lastSaved = saveTop({ name, score: total(), vmax, t: Date.now() });
    render();
    S.el.again.focus();
  }

  // ---------------------------------------------------------------- setup
  function init(root) {
    S.root = root;
    root.innerHTML = `
      <div class="sg-dots" data-k="dots"></div>
      <div class="sg-main" data-k="main">
        <div class="sg-title" data-k="title"></div>
        <div class="sg-sub" data-k="sub"></div>
        <canvas class="sg-gauge" data-k="gauge"></canvas>
        <div class="sg-read"><span class="sg-big" data-k="big">–</span><span class="sg-unit" data-k="unit"></span></div>
        <div class="sg-target" data-k="target"></div>
        <div class="progress sg-timer" data-k="timerWrap" hidden><div data-k="timer"></div></div>
        <div class="sg-phys" data-k="phys"></div>
        <div class="sg-flash" data-k="flash" hidden></div>
      </div>
      <div class="sg-final" data-k="final" hidden>
        <div class="sg-title">🏁 총점</div>
        <div class="sg-big" data-k="finalScore"></div>
        <ul class="sg-lines" data-k="finalLines"></ul>
        <div class="row center" data-k="saveRow">
          <input data-k="name" maxlength="12" placeholder="이름 (12자까지)">
          <button data-k="saveBtn">순위표에 올리기</button>
        </div>
        <div class="sg-top-title">🏆 상위 10</div>
        <ol class="sg-top" data-k="top"></ol>
        <div class="row center"><button class="secondary" data-k="again">↻ 다시 하기 (밀기)</button></div>
      </div>`;
    root.querySelectorAll('[data-k]').forEach((n) => { S.el[n.dataset.k] = n; });
    S.el.saveBtn.onclick = save;
    S.el.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); e.stopPropagation(); });
    S.el.again.onclick = () => { S.phase = 'ready'; render(); S.el.again.blur(); };
    BatEars.on('gesture', onGesture);
    BatEars.on('frame', onFrame);
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (!S.active || e.repeat || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 's' || e.key === 'S') {
        const kind = S.phase === 'wait' ? ROUNDS[S.round].kind : 'push';
        const v = S.target && S.phase === 'wait' ? S.target + (Math.random() - 0.5) * 0.2 : 0.4 + Math.random() * 1.1;
        if (S.phase === 'final') { S.phase = 'ready'; render(); }
        onGesture({ kind, speed: +v.toFixed(2), simulated: true });
      }
    });
    render();
    requestAnimationFrame(tick);
  }

  function setActive(on) {
    S.active = !!on;
    if (!on) { S.phase = 'ready'; S.root.classList.remove('dark'); }
    render();
  }

  window.SpeedGun = { init, setActive, get state() { return { phase: S.phase, round: S.round, results: S.results.slice(), total: total() }; } };
})();
