/* Guided trials: "3, 2, 1, 밀기!" with a beep. Every trial is labelled, scored live and saved automatically.
 *
 * window.BatCollect
 *   start(settings)  { who, dist, noise, perGesture, wave, swipe, typing, freq, speed, noDownload }
 *                    swipe: add left/right trials (switches the engine to stereo mode)
 *                    swipeOnly: left/right trials only (a short stereo session; files get an _lr tag)
 *                    who: short code (letters/numbers, e.g. seojin or p1); dist: 10/20/30 cm; noise: quiet/noisy;
 *                    perGesture: trials per gesture; wave: add wave trials; typing: 15 s typing block (false triggers)
 *                    speed < 1 shortens everything (self-tests)
 *   stop()           end early (what was recorded is still saved)
 *   undo()           drop the last trial (its rows become label 'skip') and do it again later
 *   active
 *
 * Files: batears_<time>_<who>_d<dist>_<noise>_<device>.csv + .json (settings and live scores), so four laptops
 * never overwrite each other. Shortcuts while running: U = undo, Esc = stop.
 */
(function () {
  'use strict';

  const NAMES = { push: '밀기', pull: '당기기', wave: '흔들기', left: '왼쪽', right: '오른쪽' };
  const HOW = {
    push: '손바닥을 화면 쪽으로 빠르게 ⟶ (돌아올 땐 천천히)',
    pull: '손을 내 쪽으로 빠르게 ⟵ (돌아올 땐 천천히)',
    wave: '손바닥을 앞뒤로 빠르게 〰',
    left: '키보드 위 10~15cm에서 손을 왼쪽 끝까지 빠르게 쓸기 ◀ (돌아올 땐 천천히)',
    right: '키보드 위 10~15cm에서 손을 오른쪽 끝까지 빠르게 쓸기 ▶ (돌아올 땐 천천히)',
  };
  const WINDOW_MS = 1800;   // after "GO", the first detected gesture counts
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let S = null, ui = null, beepCtx = null, lastMeta = null, lastWav = null;

  function deviceId() {
    try {
      let id = localStorage.getItem('batears-dev');
      if (!id) { id = Math.random().toString(36).slice(2, 6); localStorage.setItem('batears-dev', id); }
      return id;
    } catch (_) {
      return Math.random().toString(36).slice(2, 6);
    }
  }

  // Short audible beeps (well below the 20 kHz tone, quiet, before the motion) for the countdown.
  function beep(freq, ms, vol = 0.1) {
    try {
      beepCtx = beepCtx || new AudioContext();
      const t = beepCtx.currentTime, o = beepCtx.createOscillator(), g = beepCtx.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.01);
      g.gain.linearRampToValueAtTime(0, t + ms / 1000);
      o.connect(g).connect(beepCtx.destination);
      o.start(t);
      o.stop(t + ms / 1000 + 0.02);
    } catch (_) { /* no sound is fine */ }
  }

  function buildUi() {
    const el = document.createElement('div');
    el.className = 'collect';
    el.innerHTML = `
      <div class="c-head"></div>
      <div class="c-count"></div>
      <div class="c-big"></div>
      <div class="c-coach"></div>
      <div class="c-how"></div>
      <div class="c-feedback"></div>
      <div class="c-progress"></div>
      <div class="c-bar"><div></div></div>
      <div class="row c-buttons">
        <button class="secondary c-undo">↩ 방금 거 취소 (U)</button>
        <button class="secondary c-stop">■ 그만 (Esc)</button>
      </div>`;
    document.querySelector('.stage').appendChild(el);
    el.querySelector('.c-undo').onclick = () => undo();
    el.querySelector('.c-stop').onclick = () => stop();
    const q = (c) => el.querySelector(c);
    // a person seen from behind demonstrates each gesture in time with 3-2-1 (web/coach.js)
    const coach = window.BatCoach ? window.BatCoach.create(q('.c-coach')) : null;
    return { el, head: q('.c-head'), count: q('.c-count'), big: q('.c-big'), how: q('.c-how'), feedback: q('.c-feedback'), progress: q('.c-progress'), bar: q('.c-bar > div'), coach };
  }

  function show(on) {
    if (!ui) ui = buildUi();
    ui.el.style.display = on ? 'flex' : 'none';
    document.body.classList.toggle('collecting', on);
  }

  function say(big, how = '', count = '') {
    ui.big.textContent = big;
    ui.how.textContent = how;
    ui.count.textContent = count;
  }

  function feedback(text, cls) {
    ui.feedback.textContent = text;
    ui.feedback.className = 'c-feedback ' + (cls || '');
  }

  function renderProgress() {
    const parts = Object.keys(S.target).map((k) => {
      const done = S.trials.filter((t) => t.kind === k);
      const hit = done.filter((t) => t.result === 'hit').length;
      return `${NAMES[k]} ${done.length}/${S.target[k]} (맞힘 ${hit})`;
    });
    const all = S.trials.length, hits = S.trials.filter((t) => t.result === 'hit').length;
    ui.progress.textContent = parts.join(' · ') + (all ? ` · 실시간 정확도 ${Math.round((hits / all) * 100)}%` : '');
    const total = Object.values(S.target).reduce((a, b) => a + b, 0);
    ui.bar.style.width = `${Math.round((all / total) * 100)}%`;
  }

  // Resolves once the engine has finished calibrating (or after timeoutMs).
  function waitReady(timeoutMs) {
    return new Promise((resolve) => {
      let off = null;
      const timer = setTimeout(() => { if (off) off(); resolve(false); }, timeoutMs);
      off = BatEars.on('frame', (f) => {
        if (f.tone && !f.calibrating) { clearTimeout(timer); off(); resolve(true); }
      });
    });
  }

  const med = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
  };

  // ~2 s of the room before recording: loudness (speech/music band), far-band noise, SNR and frame rate.
  function measureRoom(ms) {
    return new Promise((resolve) => {
      const amb = [], noise = [], snr = [], ts = [];
      const off = BatEars.on('frame', (f) => { amb.push(f.ambient); noise.push(f.noise); snr.push(f.snr); ts.push(f.t); });
      setTimeout(() => {
        off();
        const gaps = ts.slice(1).map((t, i) => t - ts[i]);
        const g = med(gaps);
        resolve({ ambientDb: med(amb), noiseDb: med(noise), snrDb: med(snr), fps: g ? Math.round(1000 / g) : null });
      }, ms);
    });
  }

  // Auto noise class: compared with the quietest room this laptop has measured (+8 dB = noisy).
  function classifyNoise(room) {
    const quietest = store.get('batears-quietest-ambient', null);
    if (room.ambientDb == null) return 'quiet';
    if (quietest == null || room.ambientDb < quietest) store.set('batears-quietest-ambient', room.ambientDb);
    return quietest != null && room.ambientDb > quietest + 8 ? 'noisy' : 'quiet';
  }

  // left/right check session: n swipes each way + 3 push + 3 pull (are pushes/pulls misread as swipes?)
  const LR_PP = 3;
  function planLr(n) {
    const list = [];
    for (let i = 0; i < n; i++) list.push('left', 'right');
    for (let i = 0; i < LR_PP; i++) list.push('push', 'pull');
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    return list;
  }

  function plan(perGesture, wave, swipe, pushPull = true) {
    const list = [];
    if (pushPull) for (let i = 0; i < perGesture; i++) list.push('push', 'pull');
    if (wave) for (let i = 0; i < Math.ceil(perGesture / 2); i++) list.push('wave');
    if (swipe) for (let i = 0; i < perGesture; i++) list.push('left', 'right');
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    return list;
  }

  // the first gesture inside the current trial window decides the result
  function onGesture(e) {
    if (!S) return;
    if (S.win && e.t >= S.win.t0 && e.t <= S.win.t0 + WINDOW_MS && !S.win.got) S.win.got = { kind: e.kind, speed: e.speed || 0 };
    if (S.typingFrom && e.t >= S.typingFrom && !e.simulated) S.typingFalse++;
  }

  async function start(opt = {}) {
    if (S) return null;
    // swipeOnly: a short left/right-only session (stereo) for tuning swipes; it implies swipe
    opt = { ...opt, swipe: !!(opt.swipe || opt.swipeOnly), swipeOnly: !!opt.swipeOnly };
    if (opt.swipeOnly) opt.wave = false;
    const speed = opt.speed || 1;
    const who = String(opt.who || 'anon').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || 'anon';
    const dist = Math.max(1, Math.min(150, Math.round(Number(opt.dist)))) || 20; // typed in cm
    let noise = opt.noise === 'noisy' ? 'noisy' : opt.noise === 'quiet' ? 'quiet' : 'auto';
    const perGesture = Math.max(1, Number(opt.perGesture) || 10);
    const queue = opt.swipeOnly ? planLr(perGesture) : plan(perGesture, !!opt.wave, opt.swipe, true);
    const target = opt.swipeOnly ? { push: LR_PP, pull: LR_PP } : { push: perGesture, pull: perGesture };
    if (opt.wave) target.wave = Math.ceil(perGesture / 2);
    if (opt.swipe) { target.left = perGesture; target.right = perGesture; }
    S = {
      opt, speed, who, dist, noise, queue, target, trials: [], win: null, aborted: false,
      typingFrom: 0, typingFalse: 0, startedAt: new Date().toISOString(), device: deviceId(),
      foreign: new Set(BatEars.foreign || []), // other ultrasonic tones heard during the session (kHz)
    };
    show(true);
    feedback('');
    const headText = () => `${who} · ${dist}cm · ${{ noisy: '시끄러움', quiet: '조용함', auto: '소음 재는 중' }[noise]}${opt.swipe ? ' · 스테레오' : ''} · 기기 ${S.device}`;
    ui.head.textContent = headText();
    renderProgress();
    let result = null;
    const offG = BatEars.on('gesture', onGesture);
    const offF = BatEars.on('foreign', (e) => { if (S) e.tones.forEach((k) => S.foreign.add(k)); });
    // stereo: keep each trial's longest motion burst (swipe.js features) for the left/right check; a swipe can
    // end a little after its window closes, so the trial that just closed still takes it
    const offB = BatEars.on('burst', (e) => {
      if (!S || !e.feat) return;
      const span = WINDOW_MS * S.speed;
      const keep = (w) => e.t >= w.t0 && e.start <= w.t0 + span && (!w.feat || e.feat.n > w.feat.n);
      if (S.win) { if (keep(S.win)) S.win.feat = e.feat; }
      else if (S.lastWin && keep(S.lastWin)) { S.lastWin.feat = e.feat; S.lastWin.trial.swipe = e.feat; }
    });
    const off = () => { offG(); offF(); offB(); };
    try {
      say('준비', '마이크를 켜는 중이에요. 손을 치워 주세요');
      if (BatEars.running && BatEars.stereo !== !!opt.swipe) await BatEars.stop(); // switch mono <-> stereo
      if (!BatEars.running) {
        const ok = await BatEars.start({ freq: opt.freq, raw: true, stereo: !!opt.swipe });
        if (!ok) { say('마이크를 열 수 없어요', '주소창 왼쪽에서 마이크를 허용하고 다시 눌러 주세요'); await sleep(3000); return null; }
      }
      say('준비', '기준값을 잡는 중이에요. 손을 치우고 가만히');
      await waitReady(5000);
      say('준비', '주변 소리를 재는 중이에요 (2초)');
      S.room = await measureRoom(2000 * speed);
      S.noiseSource = noise === 'auto' ? 'auto' : 'manual';
      if (noise === 'auto') noise = classifyNoise(S.room);
      S.noise = noise;
      ui.head.textContent = headText();
      S.sessionIndex = store.get('batears-session-n', 0) + 1;
      store.set('batears-session-n', S.sessionIndex);
      BatRecorder.setTag(`${who}_d${dist}_${noise}${opt.swipeOnly ? '_lr' : ''}_${S.device}`);
      BatRecorder.setLabel('idle');
      BatRecorder.start();
      S.session = BatRecorder.session;
      // stereo sessions also keep the raw mic signal (WAV next to the CSV) so left/right ideas can be tested offline
      if (opt.swipe && opt.capture !== false && (await BatEars.captureStart())) ui.head.textContent = headText() + ' · 🎙️ 원음 저장 중';
      if (opt.swipeOnly) {
        say('손을 키보드 위 10~15cm에 두세요', BatEars.hasLrModel ? '좌우 끝까지 넓게, 빠르게 쓸기 (약 50cm)'
          : '좌우 끝까지 넓게, 빠르게 쓸기 (약 50cm). 처음엔 기록만 하고, 끝나면 이 노트북에서 좌우가 되는지 알려 드려요');
        await sleep(2500 * speed);
      } else {
        say('손을 화면 앞 15cm쯤에 두세요', '팁: 빠르게 치고, 천천히 원위치');
        await sleep(1500 * speed);
      }

      S.phase = 'trials';
      while (S.queue.length && !S.aborted) {
        const kind = S.queue.shift();
        const tStart = performance.now();
        for (const n of ['3', '2', '1']) {
          if (S.aborted) break;
          say(n, `다음: ${NAMES[kind]}`, `${S.trials.length + 1}번째`);
          // 3: start pose and path, 2: slow ghost run, 1: ready again
          if (ui.coach) { if (n === '2') ui.coach.preview(kind, 500 * speed); else ui.coach.ready(kind); }
          beep(660, 90);
          await sleep(550 * speed);
        }
        if (S.aborted) break;
        beep(990, 140, 0.12);
        BatRecorder.setLabel(kind);
        BatRecorder.markCue(kind);
        S.win = { t0: performance.now(), got: null, feat: null };
        say(`${NAMES[kind]}!`, HOW[kind]);
        if (ui.coach) ui.coach.go(kind); // the real stroke at real speed, then a slow way back
        ui.big.className = 'c-big go ' + kind;
        await sleep(WINDOW_MS * speed);
        BatRecorder.setLabel('idle');
        ui.big.className = 'c-big';
        if (ui.coach) ui.coach.idle();
        const got = S.win.got;
        const res = !got ? 'miss' : got.kind === kind ? 'hit' : 'wrong';
        const trial = { kind, result: res, got: got && got.kind, speed: got ? +got.speed.toFixed(2) : null, tStart, tEnd: performance.now() + 600 * speed };
        if (S.win.feat) trial.swipe = S.win.feat;
        S.trials.push(trial);
        S.lastWin = { t0: S.win.t0, feat: S.win.feat, trial };
        S.win = null;
        const learning = (kind === 'left' || kind === 'right') && !BatEars.hasLrModel;
        if (learning) feedback(`📝 ${NAMES[kind]} 기록했어요 (좌우 점검 중이라 판정은 끝나고 알려 드려요)`, 'ok');
        else if (res === 'hit') feedback(`✅ ${NAMES[kind]} 인식! ${got.speed ? got.speed.toFixed(1) + ' m/s' : ''}`, 'ok');
        else if (res === 'wrong') feedback(`❌ ${NAMES[got.kind] || got.kind}(으)로 잡혔어요 · 빠르게 치고 천천히 돌아오기`, 'bad');
        else feedback('⚪ 못 잡았어요 · 조금 더 빠르고 크게', 'miss');
        renderProgress();
        say('', '쉬는 중…');
        await sleep(900 * speed);
      }

      S.phase = 'after';
      if (opt.swipe && window.BatSwipe && !S.aborted) {
        await sleep(400 * speed); // let the last swipe's burst end
        S.lrCheck = runLrCheck();
      }
      if (opt.typing && !S.aborted) {
        say('⌨️ 평소처럼 타자 치기', '손짓은 하지 말고 15초 동안 아무 글이나 쳐 주세요 (오작동 측정)');
        feedback('');
        BatRecorder.setLabel('other');
        S.typingFrom = performance.now();
        for (let i = 15; i > 0 && !S.aborted; i--) { ui.count.textContent = `${i}초`; await sleep(1000 * speed); }
        S.typingTo = performance.now();
        S.typingFrom = 0;
        BatRecorder.setLabel('idle');
      }
      say('끝! 손을 치우고 가만히', '', '');
      await sleep(1500 * speed);
    } finally {
      off();
      if (BatRecorder.recording) BatRecorder.stop();
      BatRecorder.setLabel('idle');
      if (BatEars.capturing) { try { S.wav = await BatEars.captureStop(); } catch (e) { console.error('[collect] capture', e); } }
      result = finish();
      if (opt.speed && opt.speed < 1) await sleep(300);
      else await waitClose(120000); // keep the summary up until closed (button, Esc or Enter)
      show(false);
      S = null;
    }
    return result;
  }

  function waitClose(timeoutMs) {
    S.closing = true;
    ui.el.querySelector('.c-undo').style.display = 'none';
    const btn = ui.el.querySelector('.c-stop');
    btn.textContent = '✓ 닫기 (Enter)';
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        window.removeEventListener('keydown', onKey);
        btn.onclick = () => stop();
        btn.textContent = '■ 그만 (Esc)';
        ui.el.querySelector('.c-undo').style.display = '';
        resolve();
      };
      const onKey = (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); done(); } };
      const timer = setTimeout(done, timeoutMs);
      btn.onclick = done;
      window.addEventListener('keydown', onKey);
    });
  }

  // The cued swipes decide whether this laptop can do left/right at all (bravo's swipe.js LRCheck: leave-one-out
  // accuracy >= 0.8 and d' >= 1.5). A pass stores the model for this tone pair; it is used from the next swipe on.
  const LR_REASON = {
    no: '좌우 신호가 없어요 (스피커 간격·소리 효과 탓일 수 있어요)',
    pp: '밀기·당기기가 좌우로 잘못 읽혀요: 키보드 위 10~15cm에서 더 넓게 쓸어 보세요',
    rev: '좌우가 자주 반대로 나와요: 키보드 위 10~15cm에서 더 넓게 쓸어 보세요',
    weak: '신호가 약해요: 키보드 위 10~15cm에서 더 넓게 쓸어 보세요',
    not: '쓸기가 너무 적게 잡혔어요',
  };
  function runLrCheck() {
    const chk = new BatSwipe.LRCheck({ need: 4 });
    S.trials.forEach((t) => { if (t.swipe) chk.add(t.kind, t.swipe); }); // left/right + push/pull (false-swipe rate)
    const r = chk.result(), pair = BatEars.stereoPair;
    const why = r.ok ? '' : /^no /.test(r.reason) ? LR_REASON.no : /^push\/pull/.test(r.reason) ? LR_REASON.pp
      : /reversed/.test(r.reason) ? LR_REASON.rev : /^weak/.test(r.reason) ? LR_REASON.weak : LR_REASON.not;
    const out = {
      ok: r.ok, looAcc: r.looAcc, looWrong: r.looWrong, looUndecided: r.looUndecided, fpRate: r.fpRate, dComb: r.dComb,
      dprime: r.dprime || null, reason: r.reason, why, nL: chk.L.length, nR: chk.R.length, nPushPull: chk.N.length,
      hadModel: BatEars.hasLrModel, pair, version: BatSwipe.VERSION,
    };
    if (r.ok && pair) {
      BatEars.config.lrModel = { pair: pair.slice(), model: r.model, looAcc: r.looAcc, at: new Date().toISOString() };
      store.set('batears-lr-model', BatEars.config.lrModel);
    }
    return out;
  }

  function finish() {
    if (!S || !S.session) return null;
    const by = {};
    for (const k of Object.keys(S.target)) {
      const ts = S.trials.filter((t) => t.kind === k);
      by[k] = { n: ts.length, hit: ts.filter((t) => t.result === 'hit').length, wrong: ts.filter((t) => t.result === 'wrong').length, miss: ts.filter((t) => t.result === 'miss').length };
    }
    const n = S.trials.length, hits = S.trials.filter((t) => t.result === 'hit').length;
    const meta = {
      session: S.session, who: S.who, dist: S.dist, noise: S.noise, noiseSource: S.noiseSource, device: S.device,
      sessionIndex: S.sessionIndex, room: S.room,
      perGesture: S.opt.perGesture, wave: !!S.opt.wave, swipe: !!S.opt.swipe, swipeOnly: !!S.opt.swipeOnly, typing: !!S.opt.typing,
      startedAt: S.startedAt, finishedAt: new Date().toISOString(), aborted: S.aborted,
      live: { trials: n, hits, accuracy: n ? +(hits / n).toFixed(3) : null, byGesture: by, typingFalseTriggers: S.opt.typing ? S.typingFalse : null },
      engine: BatEars.info, detector: BatEars.config.detector, burst: BatEars.config.burst, volume: BatEars.config.volume,
      freq: BatEars.freq, stereo: BatEars.stereo,
      ...(BatEars.stereo ? { stereoDetector: BatEars.config.stereoDetector, stereoPair: BatEars.stereoPair, lrCheck: S.lrCheck || null, lrModel: BatEars.config.lrModel } : {}),
      foreignTones: [...S.foreign].sort((a, b) => a - b),
      // raw mic WAV of this session (stereo sessions): t0 = performance.now() ms of its first sample (same clock as
      // the CSV t_ms column and the trials' tStart/tEnd)
      wav: S.wav ? { file: `batears_${S.session}.wav`, rate: S.wav.rate, channels: S.wav.channels, seconds: S.wav.seconds, t0: S.wav.t0, capped: S.wav.capped, bytes: S.wav.blob.size, via: S.wav.via } : null,
      client: {
        ua: navigator.userAgent, platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform,
        lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        screen: `${screen.width}x${screen.height}@${window.devicePixelRatio || 1}`,
      },
      trials: S.trials,
    };
    lastMeta = meta;
    lastWav = S.wav ? S.wav.blob : null;
    const rows = BatRecorder.toCsv(S.session).split('\n').length - 1;
    if (!S.opt.noDownload || BatRecorder.folderName) {
      if (!BatRecorder.folderName) BatRecorder.download(S.session);
      BatRecorder.saveJson(`batears_${S.session}.json`, meta);
      if (S.wav) BatRecorder.saveFile(meta.wav.file, S.wav.blob);
    }
    say(S.aborted ? '중단됨' : '완료 🎉', BatRecorder.folderName ? `"${BatRecorder.folderName}" 폴더에 자동 저장됐어요` : 'CSV·JSON을 내려받았어요. 드라이브 nhng/ml/data에 넣어 주세요', `${rows}줄`);
    const lr = S.lrCheck;
    const pc = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
    const lrText = !lr ? '' : lr.ok
      ? `↔ 좌우 쓸 수 있어요! (점검: 맞음 ${pc(lr.looAcc)} · 반대 ${pc(lr.looWrong)} · 밀기·당기기 오인 ${pc(lr.fpRate)}) 이제부터 좌우가 잡혀요`
      : `↔ 이 노트북은 좌우 구분이 어려워요: ${lr.why} (맞음 ${pc(lr.looAcc)} · 반대 ${pc(lr.looWrong)} · 밀기·당기기 오인 ${pc(lr.fpRate)})`;
    if (S.opt.swipeOnly && lr && !lr.hadModel) feedback(lrText, lr.ok ? 'ok' : 'bad'); // a learning run: no live verdicts to show
    else feedback((n ? `실시간 정확도 ${Math.round((hits / n) * 100)}% (${hits}/${n})` : '') + (S.opt.typing ? ` · 타자 중 오작동 ${S.typingFalse}번` : '') + (lrText ? ` · ${lrText}` : ''), 'ok');
    return { session: S.session, rows, ...meta.live };
  }

  function undo() {
    if (!S || !S.trials.length || S.phase !== 'trials') return; // only while trials are still running
    const last = S.trials.pop();
    BatRecorder.relabel(last.tStart, last.tEnd, 'skip');
    S.queue.push(last.kind);
    feedback(`↩ 방금 ${NAMES[last.kind]} 취소. 나중에 다시 할게요`, 'miss');
    renderProgress();
  }

  function stop() { if (S) S.aborted = true; }

  window.addEventListener('keydown', (e) => {
    if (!S || S.closing) return;
    if (e.key === 'Escape') { e.preventDefault(); stop(); }
    else if (e.key === 'u' || e.key === 'U') { e.preventDefault(); undo(); }
  });

  window.BatCollect = { start, stop, undo, get active() { return !!S; }, get lastMeta() { return lastMeta; }, get lastWav() { return lastWav; } };
})();
