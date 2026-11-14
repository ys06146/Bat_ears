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
    g.textContent = e.kind === 'push' ? '밀기 ⟶' : e.kind === 'pull' ? '⟵ 당기기' : '〰 흔들기';
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
    const ok = await BatEars.start({ freq: Number($('freq').value), raw: $('raw').checked });
    if (ok) showSettings(BatEars.info);
    else showIntro(null);
    return ok;
  }
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

  // ---- game, scoreboard
  ForcePush.init($('game'));
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
      li.innerHTML = `<b>${e.score}점</b><span>콤보 ${e.combo || 0} · ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}</span>`;
      ol.appendChild(li);
    });
  }
  ForcePush.onEnd((r) => { newScoreAt = r.t; renderScores(); });
  renderScores();
  const renderMute = () => { $('mute').textContent = ForcePush.muted ? '🔇 효과음' : '🔊 효과음'; };
  $('mute').onclick = () => { ForcePush.setMuted(!ForcePush.muted); renderMute(); $('mute').blur(); };
  window.addEventListener('keydown', (e) => { if (e.key === 'm' || e.key === 'M') setTimeout(renderMute, 0); });
  $('resetScores').onclick = () => { try { localStorage.removeItem('batears.scores'); } catch (_) { /* ignore */ } renderScores(); };

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
      const ok = await startEngine();
      if (ok && params.get('rec') === '1') BatRecorder.start();
      await sleep(Number(params.get('secs') || 8) * 1000);
      const summary = ok ? await BatEars.stop() : null;
      console.log('BATEARS ' + JSON.stringify({ type: 'auto-app', ok, summary, game: ForcePush.state, recorderRows: BatRecorder.count, csvHead: BatRecorder.toCsv().split('\n').slice(0, 2) }));
      document.title = 'DONE';
    })();
  }
})();
