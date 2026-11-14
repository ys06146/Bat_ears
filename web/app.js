/* UI glue: connects the page controls to BatEars (dsp.js), BatRecorder (recorder.js) and ForcePush (game.js). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let clearAt = 0;

  function warn(msg, auto) { const w = $('warn'); w.textContent = msg; w.dataset.auto = auto ? '1' : ''; }

  function setStatus(s) {
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
    g.textContent = e.kind === 'push' ? '밀기 ⟶' : '⟵ 당기기';
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
    if (clearAt && performance.now() > clearAt) { $('gesture').textContent = '–'; $('gesture').className = ''; clearAt = 0; }
    BatEars.drawZoom($('zoom'));
    BatEars.drawWide($('wide'));
  });

  // ---- controls
  async function startEngine() {
    warn('');
    const ok = await BatEars.start({ freq: Number($('freq').value), raw: $('raw').checked });
    if (ok) showSettings(BatEars.info);
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
  }
  BatRecorder.onChange(renderRecorder);
  renderRecorder();
  $('rec').onclick = () => BatRecorder.toggle();
  $('save').onclick = () => BatRecorder.download();
  $('clear').onclick = () => BatRecorder.clear();

  // ---- game
  ForcePush.init($('game'));
  setStatus({ running: false });

  // ---- unattended self-test: index.html?auto=1&secs=8 (headless Chrome + fake mic)
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
