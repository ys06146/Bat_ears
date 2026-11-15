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
    chip.textContent = !s.running ? 'Stopped' : s.busy ? 'Checking bands' : s.calibrating ? 'Measuring baseline · keep your hand away' : 'Listening';
    $('start').disabled = s.running;
    $('stop').disabled = !s.running;
    $('check').disabled = !s.running || s.busy;
  }

  function showSettings(info) {
    if (!info) return;
    const mark = (v) => (v === false ? 'off ✅' : v === true ? 'on ⚠️' : '?');
    $('settings').textContent = `Mic ${info.micRate || '?'}Hz · processing ${info.ctxRate}Hz · echo cancellation ${mark(info.ec)} · noise suppression ${mark(info.ns)} · auto gain ${mark(info.agc)}`;
    if (info.autoTune) {
      $('settings').textContent += ` · tone in use ${info.f0}Hz`;
      if (info.autoTune.occupied) $('settings').textContent += ' · no substitute band found';
    }
    if (info.micRate && info.micRate < 40000) warn(`The mic runs at ${info.micRate}Hz, so it can’t hear above ${info.micRate / 2}Hz. Pick another mic, or set the mic format to 48000 Hz in Sound settings.`);
  }

  // ---- engine events
  BatEars.on('state', setStatus);
  BatEars.on('error', (e) => warn(`Can’t open the microphone (${e.name}). Click the icon left of the address bar → allow the microphone → reload.`));
  // the left/right model learned by an earlier "↔ Left/right only" check on this laptop (used only with the same tone pair)
  // left/right model from this sitting's 🧭 check (sessionStorage: gone with the tab); models from older sittings
  // (localStorage, before v3) are dropped because they don't carry over
  try { localStorage.removeItem('batears-lr-model'); } catch (_) { /* none */ }
  try { const m = JSON.parse(sessionStorage.getItem('batears-lr-model')); if (m && m.model && m.pair) BatEars.config.lrModel = m; } catch (_) { /* none */ }
  // another laptop running Bat Ears (or any ultrasonic beacon) nearby spoils both devices' detection
  const FOREIGN = '⚠️ Foreign ultrasound';
  BatEars.on('foreign', (e) => {
    if (e.tones.length) warn(`${FOREIGN} heard (${e.tones.map((k) => k.toFixed(1)).join(', ')} kHz). If Bat Ears is running on another laptop, please turn it off. Running both spoils detection on each.`);
    else if ($('warn').textContent.startsWith(FOREIGN)) warn('');
  });
  BatEars.on('gesture', (e) => {
    const c = BatEars.counts;
    $('nPush').textContent = c.push || 0;
    $('nPull').textContent = c.pull || 0;
    const g = $('gesture');
    const names = { push: 'Push ⟶', pull: '⟵ Pull', wave: '〰 Wave', left: '◀ Left', right: 'Right ▶' };
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
      warn('The reflected signal is weak (SNR below 15 dB). Turn the volume up, unplug headphones, or try a lower frequency.', true);
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
    if (sweep) $('settings').textContent += ' · band check: ' + sweep.map((s) => `${(s.f / 1000).toFixed(1)}k ${s.snr.toFixed(0)}dB`).join(', ');
  };
  $('freq').oninput = () => {
    const f = Number($('freq').value);
    $('freqLabel').textContent = (f / 1000).toFixed(1) + ' kHz';
    BatEars.setFreq(f);
  };
  $('vol').oninput = () => BatEars.setVolume($('vol').value);
  $('th').onchange = () => { BatEars.config.threshold = Number($('th').value) || 6; };
  $('raw').onchange = () => { if (BatEars.running) warn('Calibration settings apply after you stop and start again.'); };

  // ---- recorder UI
  const labelNames = { idle: '1 Still', push: '2 Push', pull: '3 Pull', wave: '4 Wave', other: '5 Other' };
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
    $('rec').textContent = BatRecorder.recording ? '■ Stop recording' : '● Start recording';
    $('recCount').textContent = `${BatRecorder.count} rows`;
    if (!BatRecorder.canPickFolder) {
      $('pickDir').disabled = true;
      $('saveStatus').textContent = 'This browser doesn’t support auto-save. Use the Save CSV button.';
    } else if (BatRecorder.lastError) {
      $('saveStatus').textContent = `⚠️ Auto-save failed: ${BatRecorder.lastError}`;
    } else if (BatRecorder.folderName) {
      $('saveStatus').textContent = `✅ Auto-save: ${BatRecorder.folderName}` + (BatRecorder.lastSaved ? ` · last ${BatRecorder.lastSaved}` : '');
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

  // ---- guided data collection (settings remembered on this laptop)
  const SETTINGS = ['who', 'dist', 'noise', 'perGesture', 'incWave', 'incSwipe', 'incTyping'];
  try {
    const saved = JSON.parse(localStorage.getItem('batears-settings') || '{}');
    SETTINGS.forEach((id) => {
      if (saved[id] === undefined) return;
      if ($(id).type === 'checkbox') $(id).checked = !!saved[id]; else $(id).value = saved[id];
    });
  } catch (_) { /* first visit or storage blocked */ }
  function saveSettings() {
    try {
      const o = {};
      SETTINGS.forEach((id) => { o[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value; });
      localStorage.setItem('batears-settings', JSON.stringify(o));
    } catch (_) { /* ignore */ }
  }
  SETTINGS.forEach((id) => { $(id).onchange = saveSettings; });
  // lrOnly: the "↔ Left/right only" button = a short left/right-only stereo session (no push/pull, no typing block)
  async function startCollect(lrOnly = false) {
    if (BatCollect.active) return;
    const circleOnly = lrOnly === 'circle'; // the 🌀 circle session (2D spike)
    lrOnly = lrOnly === true;
    // name is optional: letters/numbers only (it ends up in public file names); empty = 'anon'
    const who = $('who').value.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || 'anon';
    saveSettings();
    // the folder is remembered: reuse it without a picker; only the very first time asks to pick
    if (BatRecorder.canPickFolder && !BatRecorder.folderName) {
      const name = await BatRecorder.restoreFolder();
      if (!name) {
        try { await BatRecorder.pickFolder(); } catch (_) { /* cancelled: files are downloaded at the end instead */ }
      }
    }
    const res = await BatCollect.start({
      who, dist: $('dist').value, noise: $('noise').value, perGesture: circleOnly ? 10 : lrOnly ? 6 : Number($('perGesture').value),
      wave: $('incWave').checked, swipe: $('incSwipe').checked, typing: lrOnly || circleOnly ? false : $('incTyping').checked, freq: Number($('freq').value),
      swipeOnly: lrOnly, circleOnly,
    });
    if (res && BatEars.info) showSettings(BatEars.info);
    $('stereo').checked = BatEars.stereo;
    try { if (res && BatCollect.lastMeta) ExpLog.addFromMeta(BatCollect.lastMeta); } catch (e) { console.error('[explog]', e); }
  }
  try { ExpLog.init($('explog')); } catch (e) { console.error('[explog]', e); } // a broken log card must not stop the app
  window.startCollect = startCollect; // the left/right test view has a shortcut button too
  $('collect').onclick = () => startCollect(false);
  $('collectLR').onclick = () => startCollect(true);
  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if ((e.key === 's' || e.key === 'S') && !document.body.classList.contains('page-game') && !BatCollect.active && !document.body.classList.contains('speed-on') && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
      e.preventDefault();
      startCollect();
    }
  });

  // ---- game / sonar view, scoreboard
  ForcePush.init($('game'));
  SonarView.init($('sonar'), $('cam'));
  SpeedGun.init($('speed'));
  LRTest.init($('lr'));
  function setView(view) {
    const sonar = view === 'sonar', speed = view === 'speed', lr = view === 'lr';
    $('game').hidden = view !== 'game';
    $('sonar').hidden = !sonar;
    $('speed').hidden = !speed;
    $('lr').hidden = !lr;
    $('camBtn').hidden = !sonar;
    $('tabGame').classList.toggle('sel', view === 'game');
    $('tabSonar').classList.toggle('sel', sonar);
    $('tabSpeed').classList.toggle('sel', speed);
    $('tabLR').classList.toggle('sel', lr);
    document.body.classList.toggle('sonar-on', sonar);
    document.body.classList.toggle('speed-on', speed);
    document.body.classList.toggle('lr-on', lr);
    $('intro').hidden = view !== 'game' || $('intro').hidden;
    SonarView.setActive(sonar);
    SpeedGun.setActive(speed);
    LRTest.setActive(lr);
    if (!sonar) { SonarView.stopCamera(); $('camBox').hidden = true; $('camBtn').classList.remove('sel'); }
  }
  $('tabGame').onclick = () => setView('game');
  $('tabSonar').onclick = () => setView('sonar');
  $('tabSpeed').onclick = () => { setView('speed'); $('tabSpeed').blur(); };
  $('tabLR').onclick = () => { setView('lr'); $('tabLR').blur(); };
  $('camBtn').onclick = async () => {
    const on = await SonarView.toggleCamera();
    $('camBox').hidden = !on;
    $('camBtn').classList.toggle('sel', on);
  };
  if (['sonar', 'speed', 'lr'].includes(params.get('view'))) setView(params.get('view'));
  setStatus({ running: false });
  showIntro(params.get('auto') === '1' ? null : 'steps');
  $('introStart').onclick = () => { showIntro('cal'); startEngine(); };
  $('introKeys').onclick = () => { showIntro(null); document.activeElement.blur(); };

  function renderScores() {
    const list = ForcePush.scores();
    const ol = $('scores');
    ol.innerHTML = '';
    if (!list.length) { ol.innerHTML = '<li>No records yet</li>'; return; }
    list.forEach((e) => {
      const li = document.createElement('li');
      if (e.t === newScoreAt) li.className = 'new';
      const d = new Date(e.t);
      li.innerHTML = `<b></b><span>Combo ${e.combo || 0} · ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}</span>`;
      li.querySelector('b').textContent = `${e.name || 'Anonymous'} · ${e.score} pts`;
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
    $('nameTitle').textContent = r.record ? `🏆 New record! ${r.score} pts · please leave your name` : `🏆 ${r.rank + 1}! ${r.score} pts · please leave your name`;
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
    $('presentBtn').textContent = on ? '✕ Exit presentation mode' : '⛶ Presentation mode';
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
  const renderMute = () => { $('mute').textContent = ForcePush.muted ? '🔇 Sound effects' : '🔊 Sound effects'; };
  $('mute').onclick = () => { ForcePush.setMuted(!ForcePush.muted); renderMute(); $('mute').blur(); };
  window.addEventListener('keydown', (e) => { if (e.key === 'm' || e.key === 'M') setTimeout(renderMute, 0); });
  $('resetScores').onclick = () => {
    const b = $('resetScores');
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Really clear it?'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Clear'; }, 3000); return; }
    try { localStorage.removeItem('batears.scores'); } catch (_) { /* ignore */ }
    b.dataset.armed = ''; b.textContent = 'Clear';
    renderScores();
  };

  // ---- unattended self-test: index.html?auto=1&secs=8 (headless Chrome + fake mic)
  // ---- self-test of the guided collection: index.html?collect=1&fast=0.15[&undo=1]
  if (params.get('collect') === '1') {
    (async () => {
      if (params.get('undo') === '1') setTimeout(() => BatCollect.undo(), 6000); // exercise undo mid-session
      const res = await BatCollect.start({
        speed: Number(params.get('fast') || 0.15), who: 'selftest', dist: 20, noise: params.get('noise') || 'auto',
        perGesture: Number(params.get('n') || 3), wave: false, swipe: params.get('swipe') === '1', typing: params.get('lr') !== '1', noDownload: true,
        swipeOnly: params.get('lr') === '1', // &lr=1: the "↔ Left/right only" session
        circleOnly: params.get('circle') === '1', // &circle=1: the 🌀 circle session
      });
      const session = res && res.session;
      const lines = session ? BatRecorder.toCsv(session).split('\n') : [];
      const head = lines[0] ? lines[0].split(',') : [];
      const li = head.indexOf('label'), ci = head.indexOf('cue'), byLabel = {}, cues = {};
      lines.slice(1).forEach((l) => {
        const c = l.split(',');
        byLabel[c[li]] = (byLabel[c[li]] || 0) + 1;
        if (c[ci]) cues[c[ci]] = (cues[c[ci]] || 0) + 1;
      });
      const vli = head.indexOf('vL');
      const stereoRows = lines.slice(1).filter((l) => l.split(',')[vli] !== '').length;
      const m = BatCollect.lastMeta || {};
      const meta = {
        noise: m.noise, noiseSource: m.noiseSource, room: m.room, sessionIndex: m.sessionIndex, fpsKeys: Object.keys(m.client || {}), burst: !!m.burst,
        stereoPair: m.stereoPair, lrCheck: m.lrCheck, swipeFeats: (m.trials || []).filter((t) => t.swipe).length, foreignTones: m.foreignTones,
        wav: m.wav, tStart0: m.trials && m.trials[0] && m.trials[0].tStart, csvT0: lines[1] ? Number(lines[1].split(',')[1]) : null,
      };
      // the raw WAV holds the real mic signal: tone power (Goertzel) at the stereo tones vs. off-tone, channel 0, 1 s
      if (BatCollect.lastWav) {
        try {
          const dv = new DataView(await BatCollect.lastWav.arrayBuffer());
          const C = dv.getUint16(22, true), rate = dv.getUint32(24, true), n = Math.min(rate, (dv.byteLength - 44) / 2 / C - rate);
          const pow = (f) => {
            const w = 2 * Math.cos(2 * Math.PI * f / rate);
            let s1 = 0, s2 = 0;
            for (let i = 0; i < n; i++) { const s0 = dv.getInt16(44 + ((rate + i) * C) * 2, true) / 32768 + w * s1 - s2; s2 = s1; s1 = s0; }
            return +(10 * Math.log10((s1 * s1 + s2 * s2 - w * s1 * s2) / n / n + 1e-20)).toFixed(1);
          };
          meta.wavCheck = { C, rate, bytes: dv.byteLength, db18k: pow(18000), db19k5: pow(19500), db17k: pow(17000) };
        } catch (e) { meta.wavCheck = { error: String(e) }; }
      }
      console.log('BATEARS ' + JSON.stringify({ type: 'collect-test', res, byLabel, cues, stereoRows, stereo: BatEars.stereo, meta, gameRunning: ForcePush.state.running }));
      document.title = 'DONE';
    })();
  }

  if (params.get('auto') === '1') {
    (async () => {
      if (params.get('stereo') === '1') $('stereo').checked = true;
      if (params.get('seq') === '1') BatEars.config.sequence = true; // &seq=1: gesture-password sequence mode
      const t0 = performance.now(), events = [], bursts = [];
      BatEars.on('gesture', (e) => events.push(`${e.kind}@${((e.t - t0) / 1000).toFixed(2)}`));
      window.__autoEvents = events;
      // stereo: &lrmodel=<{pair, model} JSON> injects a left/right model (otherwise none, ignoring a saved one);
      // every burst's swipe.js features are logged so a model can be learned offline from a known schedule
      try { BatEars.config.lrModel = params.get('lrmodel') ? JSON.parse(params.get('lrmodel')) : null; } catch (_) { BatEars.config.lrModel = null; }
      BatEars.on('burst', (e) => { if (e.feat) bursts.push({ at: +((e.start - t0) / 1000).toFixed(2), ...Object.fromEntries(Object.entries(e.feat).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(4) : v])) }); });
      window.__autoBursts = bursts;
      const ok = await startEngine();
      if (ok && params.get('rec') === '1') BatRecorder.start();
      await sleep(Number(params.get('secs') || 8) * 1000);
      const summary = ok ? await BatEars.stop() : null;
      if (BatEars.stereo || params.get('stereo') === '1') console.log('BATEARS ' + JSON.stringify({ type: 'auto-bursts', bursts: window.__autoBursts, pair: BatEars.info && BatEars.info.stereoFreqs }));
      console.log('BATEARS ' + JSON.stringify({ type: 'auto-app', ok, events: window.__autoEvents, summary, foreign: BatEars.foreign, game: ForcePush.state, recorderRows: BatRecorder.count, csvHead: BatRecorder.toCsv().split('\n').slice(0, 2) }));
      document.title = 'DONE';
    })();
  }
})();
