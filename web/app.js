/* UI glue: connects the page controls to BatEars (dsp.js), BatRecorder (recorder.js) and ForcePush (game.js). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let clearAt = 0;

  function warn(msg, auto) { const w = $('warn'); w.textContent = msg; w.dataset.auto = auto ? '1' : ''; }

  // ---- start screen: covered webcam + calibration guide
  let calStart = 0, newScoreAt = 0;
  function showIntro(which) { // 'steps' | 'cal' | null
    $('intro').hidden = !which;
    $('introSteps').hidden = which !== 'steps';
    $('introCal').hidden = which !== 'cal';
  }

  function setStatus(s) {
    if (s.running && s.calibrating) {
      if (!calStart) calStart = performance.now();
      showIntro('cal');
    } else {
      calStart = 0;
      if (s.running) showIntro(null);
    }
    ForcePush.setReady(!(s.running && (s.calibrating || s.busy)));
    const chip = $('status');
    chip.className = 'chip' + (s.running ? (s.calibrating ? ' cal' : ' on') : '');
    chip.textContent = !s.running ? '정지' : s.busy ? '대역 점검 중' : s.calibrating ? '기준값 잡는 중 · 손 치우기' : '듣는 중';
    $('start').disabled = s.running;
    $('stop').disabled = !s.running;
    $('check').disabled = !s.running || s.busy;
  }

  function showSettings(info) {
    if (!info) return;
    const mark = (v) => (v === false ? '꺼짐 ✅' : v === true ? '켜짐 ⚠️' : '?');
    $('settings').textContent = `마이크 ${info.micRate || '?'}Hz · 처리 ${info.ctxRate}Hz · 에코 제거 ${mark(info.ec)} · 잡음 억제 ${mark(info.ns)} · 자동 음량 ${mark(info.agc)}`;
    if (info.micRate && info.micRate < 40000) warn(`마이크가 ${info.micRate}Hz라서 ${info.micRate / 2}Hz 위는 못 받아요. 다른 마이크를 고르거나 소리 설정에서 마이크 형식을 48000Hz로 바꿔 주세요.`);
  }

  // ---- engine events
  BatEars.on('state', setStatus);
  BatEars.on('error', (e) => warn(`마이크를 열 수 없어요 (${e.name}). 주소창 왼쪽 아이콘 → 마이크 허용 → 새로고침.`));
  BatEars.on('gesture', (e) => {
    const c = BatEars.counts;
    $('nPush').textContent = c.push || 0;
    $('nPull').textContent = c.pull || 0;
    const g = $('gesture');
    const names = { push: '밀기 ⟶', pull: '⟵ 당기기', wave: '〰 흔들기', left: '◀ 왼쪽', right: '오른쪽 ▶' };
    g.textContent = names[e.kind] || e.kind;
    g.className = e.kind;
    clearAt = performance.now() + 600;
  });
  BatEars.on('frame', (f) => {
    $('snr').textContent = Number.isFinite(f.snr) ? f.snr.toFixed(0) + 'dB' : '–';
    $('vel').textContent = (f.dUp > 3 || f.dDown > 3) ? (f.v >= 0 ? '+' : '') + f.v.toFixed(2) : '–';
    const pct = (d) => Math.max(0, Math.min(100, d * 5)) + '%';
    $('barUp').style.width = pct(f.dUp);
    $('barDown').style.width = pct(f.dDown);
    $('vUp').textContent = f.calibrating ? '…' : f.dUp.toFixed(1);
    $('vDown').textContent = f.calibrating ? '…' : f.dDown.toFixed(1);
    if (f.tone && !f.calibrating && !(f.snr >= BatEars.config.minSnr)) {
      warn('반사 신호가 약해요 (SNR 15dB 미만). 음량을 올리거나, 헤드폰을 빼거나, 주파수를 낮춰 보세요.', true);
    } else if ($('warn').dataset.auto === '1') warn('');
    if (calStart) {
      const total = (BatEars.config.settleMs || 0) + (BatEars.config.calibMs || 1500);
      $('calBar').style.width = Math.min(98, (performance.now() - calStart) / total * 100) + '%';
    }
    if (clearAt && performance.now() > clearAt) { $('gesture').textContent = '–'; $('gesture').className = ''; clearAt = 0; }
    BatEars.drawZoom($('zoom'));
    BatEars.drawWide($('wide'));
  });

  // ---- controls
  async function startEngine() {
    warn('');
    const ok = await BatEars.start({ freq: Number($('freq').value), raw: $('raw').checked, stereo: $('stereo').checked });
    if (ok) showSettings(BatEars.info);
    else showIntro(null);
    return ok;
  }
  $('stereo').onchange = async () => {
    if (!BatEars.running) return;
    await BatEars.stop();
    await startEngine();
  };
  $('start').onclick = startEngine;
  $('stop').onclick = () => BatEars.stop();
  $('check').onclick = async () => {
    const sweep = await BatEars.bandCheck();
    if (sweep) $('settings').textContent += ' · 대역 점검: ' + sweep.map((s) => `${(s.f / 1000).toFixed(1)}k ${s.snr.toFixed(0)}dB`).join(', ');
  };
  $('freq').oninput = () => {
    const f = Number($('freq').value);
    $('freqLabel').textContent = (f / 1000).toFixed(1) + ' kHz';
    BatEars.setFreq(f);
  };
  $('vol').oninput = () => BatEars.setVolume($('vol').value);
  $('th').onchange = () => { BatEars.config.threshold = Number($('th').value) || 6; };
  $('raw').onchange = () => { if (BatEars.running) warn('보정 설정은 정지 후 다시 시작해야 적용돼요.'); };

  // ---- recorder UI
  const labelNames = { idle: '1 가만히', push: '2 밀기', pull: '3 당기기', wave: '4 흔들기', other: '5 기타' };
  BatRecorder.labels.forEach((name) => {
    const b = document.createElement('button');
    b.className = 'secondary';
    b.textContent = labelNames[name] || name;
    b.dataset.label = name;
    b.onclick = () => BatRecorder.setLabel(name);
    $('labels').appendChild(b);
  });
  function renderRecorder() {
    document.querySelectorAll('#labels button').forEach((b) => b.classList.toggle('sel', b.dataset.label === BatRecorder.label));
    $('rec').textContent = BatRecorder.recording ? '■ 기록 정지' : '● 기록 시작';
    $('recCount').textContent = `${BatRecorder.count}줄`;
    if (!BatRecorder.canPickFolder) {
      $('pickDir').disabled = true;
      $('saveStatus').textContent = '이 브라우저는 자동 저장을 지원하지 않아요. CSV 저장 버튼을 쓰세요.';
    } else if (BatRecorder.lastError) {
      $('saveStatus').textContent = `⚠️ 자동 저장 실패: ${BatRecorder.lastError}`;
    } else if (BatRecorder.folderName) {
      $('saveStatus').textContent = `✅ 자동 저장: ${BatRecorder.folderName}` + (BatRecorder.lastSaved ? ` · 마지막 ${BatRecorder.lastSaved}` : '');
    }
  }
  BatRecorder.onChange(renderRecorder);
  renderRecorder();
  $('pickDir').onclick = async () => {
    try { await BatRecorder.pickFolder(); } catch (e) { if (e.name !== 'AbortError') $('saveStatus').textContent = '⚠️ ' + e.message; }
  };
  $('rec').onclick = () => BatRecorder.toggle();
  $('save').onclick = () => BatRecorder.download();
  $('clear').onclick = () => BatRecorder.clear();

  // ---- guided data collection
  $('collect').onclick = async () => {
    if (BatCollect.active) return;
    if (BatRecorder.canPickFolder && !BatRecorder.folderName) {
      try { await BatRecorder.pickFolder(); } catch (_) { /* cancelled: the CSV is downloaded at the end instead */ }
    }
    const ok = await BatCollect.start({ dist: $('dist').value, who: $('who').value, freq: Number($('freq').value) });
    if (ok && BatEars.info) showSettings(BatEars.info);
  };

  // ---- game / sonar view, scoreboard
  ForcePush.init($('game'));
  SonarView.init($('sonar'), $('cam'));
  SpeedGun.init($('speed'));
  function setView(view) {
    const sonar = view === 'sonar', speed = view === 'speed';
    $('game').hidden = view !== 'game';
    $('sonar').hidden = !sonar;
    $('speed').hidden = !speed;
    $('camBtn').hidden = !sonar;
    $('tabGame').classList.toggle('sel', view === 'game');
    $('tabSonar').classList.toggle('sel', sonar);
    $('tabSpeed').classList.toggle('sel', speed);
    document.body.classList.toggle('sonar-on', sonar);
    document.body.classList.toggle('speed-on', speed);
    $('intro').hidden = view !== 'game' || $('intro').hidden;
    SonarView.setActive(sonar);
    SpeedGun.setActive(speed);
    if (!sonar) { SonarView.stopCamera(); $('camBox').hidden = true; $('camBtn').classList.remove('sel'); }
  }
  $('tabGame').onclick = () => setView('game');
  $('tabSonar').onclick = () => setView('sonar');
  $('tabSpeed').onclick = () => { setView('speed'); $('tabSpeed').blur(); };
  $('camBtn').onclick = async () => {
    const on = await SonarView.toggleCamera();
    $('camBox').hidden = !on;
    $('camBtn').classList.toggle('sel', on);
  };
  if (params.get('view') === 'sonar' || params.get('view') === 'speed') setView(params.get('view'));
  setStatus({ running: false });
  showIntro(params.get('auto') === '1' ? null : 'steps');
  $('introStart').onclick = () => { showIntro('cal'); startEngine(); };
  $('introKeys').onclick = () => { showIntro(null); document.activeElement.blur(); };

  function renderScores() {
    const list = ForcePush.scores();
    const ol = $('scores');
    ol.innerHTML = '';
    if (!list.length) { ol.innerHTML = '<li>아직 기록이 없어요</li>'; return; }
    list.forEach((e) => {
      const li = document.createElement('li');
      if (e.t === newScoreAt) li.className = 'new';
      const d = new Date(e.t);
      li.innerHTML = `<b></b><span>콤보 ${e.combo || 0} · ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}</span>`;
      li.querySelector('b').textContent = `${e.name || '익명'} · ${e.score}점`;
      ol.appendChild(li);
    });
  }
  // name entry after a game that made the top 10
  let nameFor = 0;
  ForcePush.onEnd((r) => {
    newScoreAt = r.t;
    renderScores();
    if (r.rank < 0) return;
    nameFor = r.t;
    $('nameTitle').textContent = r.record ? `🏆 신기록! ${r.score}점 · 이름을 남겨 주세요` : `🏆 ${r.rank + 1}등! ${r.score}점 · 이름을 남겨 주세요`;
    $('nameInput').value = '';
    $('nameBox').hidden = false;
    setTimeout(() => $('nameInput').focus(), 50);
  });
  function closeName(save) {
    if (save && nameFor) ForcePush.setName(nameFor, $('nameInput').value);
    nameFor = 0;
    $('nameBox').hidden = true;
    $('nameInput').blur();
    renderScores();
  }
  $('nameBox').onsubmit = (e) => { e.preventDefault(); closeName(true); };
  $('nameSkip').onclick = () => closeName(false);
  BatEars.on('gesture', () => { if (!$('nameBox').hidden && ForcePush.state.running) closeName(false); });

  // presentation mode: fullscreen, no side panel, bigger text
  function setPresent(on) {
    document.body.classList.toggle('present', on);
    $('presentBtn').textContent = on ? '✕ 발표 모드 끄기' : '⛶ 발표 모드';
    $('presentBtn').blur();
  }
  $('presentBtn').onclick = async () => {
    const on = !document.body.classList.contains('present');
    try {
      if (on && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      if (!on && document.fullscreenElement) await document.exitFullscreen();
    } catch (_) { /* fullscreen not allowed: still switch the layout */ }
    setPresent(on);
  };
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) setPresent(false); });
  if (params.get('present') === '1') setPresent(true);
  renderScores();
  const renderMute = () => { $('mute').textContent = ForcePush.muted ? '🔇 효과음' : '🔊 효과음'; };
  $('mute').onclick = () => { ForcePush.setMuted(!ForcePush.muted); renderMute(); $('mute').blur(); };
  window.addEventListener('keydown', (e) => { if (e.key === 'm' || e.key === 'M') setTimeout(renderMute, 0); });
  $('resetScores').onclick = () => {
    const b = $('resetScores');
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = '정말 지울까요?'; setTimeout(() => { b.dataset.armed = ''; b.textContent = '지우기'; }, 3000); return; }
    try { localStorage.removeItem('batears.scores'); } catch (_) { /* ignore */ }
    b.dataset.armed = ''; b.textContent = '지우기';
    renderScores();
  };

  // ---- unattended self-test: index.html?auto=1&secs=8 (headless Chrome + fake mic)
  // ---- self-test of the guided collection: index.html?collect=1&fast=0.15
  if (params.get('collect') === '1') {
    (async () => {
      const res = await BatCollect.start({ speed: Number(params.get('fast') || 0.15), dist: '20', who: 'p0', noDownload: true });
      const lines = res ? BatRecorder.toCsv(res.session).split('\n') : [];
      const head = lines[0] ? lines[0].split(',') : [];
      const li = head.indexOf('label'), ci = head.indexOf('cue'), byLabel = {}, cues = {};
      lines.slice(1).forEach((l) => {
        const c = l.split(',');
        byLabel[c[li]] = (byLabel[c[li]] || 0) + 1;
        if (c[ci]) cues[c[ci]] = (cues[c[ci]] || 0) + 1;
      });
      console.log('BATEARS ' + JSON.stringify({ type: 'collect-test', res, byLabel, cues, gameRunning: ForcePush.state.running }));
      document.title = 'DONE';
    })();
  }

  if (params.get('auto') === '1') {
    (async () => {
      if (params.get('stereo') === '1') $('stereo').checked = true;
      const t0 = performance.now(), events = [];
      BatEars.on('gesture', (e) => events.push(`${e.kind}@${((e.t - t0) / 1000).toFixed(2)}`));
      window.__autoEvents = events;
      const ok = await startEngine();
      if (ok && params.get('rec') === '1') BatRecorder.start();
      await sleep(Number(params.get('secs') || 8) * 1000);
      const summary = ok ? await BatEars.stop() : null;
      console.log('BATEARS ' + JSON.stringify({ type: 'auto-app', ok, events: window.__autoEvents, summary, game: ForcePush.state, recorderRows: BatRecorder.count, csvHead: BatRecorder.toCsv().split('\n').slice(0, 2) }));
      document.title = 'DONE';
    })();
  }
})();
