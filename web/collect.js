/* Guided data collection: one click, about 2 minutes. The page says what to do and labels everything.
 *
 * window.BatCollect
 *   start({ dist, who, freq, speed, noDownload })   speed < 1 shortens every step (self-tests)
 *   stop()
 *   active
 *
 * In "cue" steps a prompt ("밀어!") flashes every 2 s and the recorder logs it in the `cue` column,
 * so experiments can score each detection against the moment the gesture was asked for.
 * The game ignores gestures while this runs.
 */
(function () {
  'use strict';

  const STEPS = [
    { label: 'idle', secs: 12, text: '손을 치우고 가만히 있어 주세요' },
    { label: 'push', secs: 20, text: '"밀어!"가 뜰 때마다 손바닥을 화면 쪽으로 밀기', cue: 'push', cueText: '밀어!', every: 2 },
    { label: 'idle', secs: 5, text: '잠깐 쉬어요. 손을 내려 주세요' },
    { label: 'pull', secs: 20, text: '"당겨!"가 뜰 때마다 손을 화면에서 멀리 당기기', cue: 'pull', cueText: '당겨!', every: 2 },
    { label: 'idle', secs: 5, text: '잠깐 쉬어요. 손을 내려 주세요' },
    { label: 'wave', secs: 15, text: '손바닥을 앞뒤로 빠르게 흔들기' },
    { label: 'other', secs: 20, text: '평소처럼 타자 치기·몸 움직이기 (손짓은 하지 않기)' },
    { label: 'idle', secs: 10, text: '손을 치우고 가만히. 거의 끝났어요!' },
  ];
  const LABEL_KO = { idle: '가만히', push: '밀기', pull: '당기기', wave: '흔들기', other: '기타' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let active = false, abort = false, ui = null, cueUntil = 0;

  function buildUi() {
    const el = document.createElement('div');
    el.className = 'collect';
    el.innerHTML = '<div class="c-step"></div><div class="c-text"></div><div class="c-cue"></div>' +
      '<div class="c-count"></div><div class="c-bar"><div></div></div><button class="secondary c-stop">그만하기</button>';
    document.querySelector('.stage').appendChild(el);
    el.querySelector('.c-stop').onclick = () => { abort = true; };
    return {
      el, step: el.querySelector('.c-step'), text: el.querySelector('.c-text'), cue: el.querySelector('.c-cue'),
      count: el.querySelector('.c-count'), bar: el.querySelector('.c-bar > div'),
    };
  }

  function show(on) {
    if (!ui) ui = buildUi();
    ui.el.style.display = on ? 'flex' : 'none';
    document.body.classList.toggle('collecting', on);
  }

  function say(step, text) {
    ui.step.textContent = step;
    ui.text.textContent = text;
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

  async function start(opt = {}) {
    if (active) return null;
    active = true;
    abort = false;
    const speed = opt.speed || 1;
    show(true);
    ui.cue.textContent = '';
    ui.count.textContent = '';
    ui.bar.style.width = '0%';
    let result = null;
    try {
      say('준비', '마이크를 켜는 중이에요. 손을 치워 주세요');
      if (!BatEars.running) {
        const ok = await BatEars.start({ freq: opt.freq, raw: true });
        if (!ok) {
          say('준비', '마이크를 열 수 없어요. 주소창 왼쪽에서 마이크를 허용하고 다시 눌러 주세요.');
          await sleep(3000);
          return null;
        }
      }
      say('준비', '기준값을 잡는 중이에요. 손을 치우고 가만히');
      await waitReady(5000);
      BatRecorder.setTag(`d${opt.dist || 'x'}_${opt.who || 'p0'}`);
      BatRecorder.start();
      const totalMs = STEPS.reduce((s, x) => s + x.secs, 0) * speed * 1000;
      let doneMs = 0;
      for (let i = 0; i < STEPS.length && !abort; i++) {
        const s = STEPS[i], dur = s.secs * speed * 1000;
        BatRecorder.setLabel(s.label);
        say(`${i + 1} / ${STEPS.length} · ${LABEL_KO[s.label]}`, s.text);
        const t0 = performance.now();
        let nextCue = s.cue ? t0 + 1000 * speed : Infinity;
        for (;;) {
          const now = performance.now(), el = now - t0;
          if (abort || el >= dur) break;
          if (now >= nextCue) {
            BatRecorder.markCue(s.cue);
            ui.cue.textContent = s.cueText;
            cueUntil = now + 600 * Math.min(1, speed * 2);
            nextCue += s.every * 1000 * speed;
          }
          if (cueUntil && now > cueUntil) { ui.cue.textContent = ''; cueUntil = 0; }
          ui.count.textContent = `${Math.ceil((dur - el) / 1000)}초`;
          ui.bar.style.width = `${(((doneMs + el) / totalMs) * 100).toFixed(1)}%`;
          await sleep(40);
        }
        doneMs += dur;
      }
      ui.cue.textContent = '';
      const session = BatRecorder.session;
      BatRecorder.stop();
      BatRecorder.setLabel('idle');
      if (!BatRecorder.folderName && !opt.noDownload) BatRecorder.download(session);
      result = { session, aborted: abort, rows: BatRecorder.toCsv(session).split('\n').length - 1 };
      say(abort ? '중단됨' : '완료 🎉', BatRecorder.folderName
        ? `드라이브 폴더 "${BatRecorder.folderName}"에 자동 저장됐어요. 고마워요!`
        : 'CSV를 내려받았어요. 내 드라이브 > nhng > ml > data에 넣어 주세요.');
      ui.count.textContent = `${result.rows}줄 기록`;
      await sleep(opt.speed && opt.speed < 1 ? 300 : 3500);
      return result;
    } finally {
      if (BatRecorder.recording) BatRecorder.stop();
      active = false;
      show(false);
    }
  }

  window.BatCollect = {
    start,
    stop() { abort = true; },
    get active() { return active; },
    steps: STEPS,
  };
})();
