/* Bat Ears recorder: logs per-frame features plus a live label to CSV (training data and accuracy tables).
 *
 * window.BatRecorder
 *   start(), stop(), toggle(), setLabel(name), download(), clear()
 *   pickFolder()       choose a folder once (e.g. Google Drive > nhng > ml > data). After that, each
 *                      recording is saved there automatically (every 15 s while recording, and on stop).
 *   onChange(fn)       called when the label, rows, recording state or save status changes
 *   labels, label, recording, count, canPickFolder, folderName, lastSaved, lastError
 *
 * Hotkeys: 1 idle, 2 push, 3 pull, 4 wave, 5 other (typing, walking by, ...)
 * Columns: session, t_ms, label, gesture, dUp_db, dDown_db, up_db, down_db, v_mps, snr_db,
 *          carrier_db, noise_db, u1..u6, d1..d6 (sub-band echo energy above / below the carrier, dB),
 *          cue (set on the frame where the guided collection asked for a gesture)
 *   setTag(tag)        appended to the next session id / file name (e.g. d20_p1)
 *   markCue(kind)      mark the next frame with a cue
 */
(function () {
  'use strict';

  const LABELS = ['idle', 'push', 'pull', 'wave', 'other', 'left', 'right'];
  // stereo columns (vL, vR, dUpL, dDownL, dUpR, dDownR) are empty unless stereo mode is on
  const HEAD = ['session', 't_ms', 'label', 'gesture', 'dUp_db', 'dDown_db', 'up_db', 'down_db', 'v_mps', 'snr_db',
    'carrier_db', 'noise_db', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'cue',
    'vL', 'vR', 'dUpL', 'dDownL', 'dUpR', 'dDownR'];
  const CUE = HEAD.indexOf('cue');
  const AUTOSAVE_MS = 15000;
  const rows = [];
  const watchers = [];
  let recording = false, label = 'idle', pendingGesture = '', pendingCue = '', session = '', tag = '';
  let dir = null, timer = 0, saving = false, lastSaved = '', lastError = '';

  const num = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '');
  const stamp = () => {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };
  function notify() { watchers.forEach((fn) => { try { fn(api); } catch (e) { console.error(e); } }); }

  BatEars.on('frame', (f) => {
    if (!recording || !f.tone || f.calibrating) return;
    const s = f.stereo || {};
    rows.push([
      session, num(f.t, 1), label, pendingGesture,
      num(f.dUp, 2), num(f.dDown, 2), num(f.up, 2), num(f.down, 2), num(f.v, 3),
      num(f.snr, 1), num(f.carrier, 1), num(f.noise, 1),
      ...f.bandsUp.map((x) => num(x, 2)), ...f.bandsDown.map((x) => num(x, 2)),
      pendingCue,
      num(s.vL, 3), num(s.vR, 3), num(s.dUpL, 2), num(s.dDownL, 2), num(s.dUpR, 2), num(s.dDownR, 2),
    ]);
    pendingGesture = '';
    pendingCue = '';
    if (rows.length % 30 === 0) notify();
  });

  BatEars.on('gesture', (g) => {
    if (recording) pendingGesture = g.kind + (g.simulated ? '_sim' : '');
  });

  function toCsv(onlySession) {
    const body = onlySession ? rows.filter((r) => r[0] === onlySession) : rows;
    return [HEAD.join(','), ...body.map((r) => r.join(','))].join('\n');
  }

  // One file per recording (session), overwritten as it grows, so the training script never double-counts.
  async function saveToFolder(sess) {
    if (!dir || !sess || saving) return false;
    saving = true;
    try {
      const name = `batears_${sess}.csv`;
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(toCsv(sess));
      await w.close();
      lastSaved = name;
      lastError = '';
      return true;
    } catch (e) {
      lastError = e.message || String(e);
      console.error('[BatRecorder] autosave failed', e);
      return false;
    } finally {
      saving = false;
      notify();
    }
  }

  const api = {
    labels: LABELS,
    get label() { return label; },
    get recording() { return recording; },
    get count() { return rows.length; },
    get canPickFolder() { return typeof window.showDirectoryPicker === 'function'; },
    get folderName() { return dir ? dir.name : ''; },
    get lastSaved() { return lastSaved; },
    get lastError() { return lastError; },
    get session() { return session; },
    setTag(t) { tag = String(t || '').replace(/[^A-Za-z0-9_-]/g, ''); },
    markCue(kind) { if (recording) pendingCue = String(kind); },
    start() {
      if (recording) return;
      recording = true;
      session = stamp() + (tag ? `_${tag}` : '');
      if (dir) timer = setInterval(() => saveToFolder(session), AUTOSAVE_MS);
      notify();
    },
    stop() {
      if (!recording) return;
      recording = false;
      clearInterval(timer);
      timer = 0;
      if (dir) saveToFolder(session);
      notify();
    },
    toggle() { if (recording) api.stop(); else api.start(); },
    setLabel(name) { if (LABELS.includes(name) || name === 'skip') { label = name; notify(); } },
    clear() { rows.length = 0; notify(); },
    onChange(fn) { watchers.push(fn); },
    async pickFolder() {
      if (!api.canPickFolder) throw new Error('이 브라우저는 폴더 저장을 지원하지 않아요. 크롬으로 열어 주세요.');
      dir = await window.showDirectoryPicker({ id: 'batears-data', mode: 'readwrite' });
      if (recording && !timer) timer = setInterval(() => saveToFolder(session), AUTOSAVE_MS);
      notify();
      return dir.name;
    },
    download(onlySession) {
      downloadBlob(new Blob([toCsv(onlySession)], { type: 'text/csv' }), `batears_${onlySession || stamp()}.csv`);
    },
    // Rows of the current session between fromT and toT (performance.now() ms) get a new label;
    // 'skip' also clears their cue so the trial is ignored by training and scoring.
    relabel(fromT, toT, newLabel) {
      for (const r of rows) {
        const t = Number(r[1]);
        if (r[0] === session && t >= fromT && t <= toT) {
          r[2] = newLabel;
          if (newLabel === 'skip') r[CUE] = '';
        }
      }
      notify();
    },
    // Session metadata next to the CSV: into the chosen folder, otherwise downloaded.
    async saveJson(name, obj) {
      const text = JSON.stringify(obj, null, 1);
      if (dir) {
        try {
          const fh = await dir.getFileHandle(name, { create: true });
          const w = await fh.createWritable();
          await w.write(text);
          await w.close();
          return true;
        } catch (e) { lastError = e.message || String(e); notify(); }
      }
      downloadBlob(new Blob([text], { type: 'application/json' }), name);
      return false;
    },
    toCsv,
  };

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  window.addEventListener('keydown', (e) => {
    if (window.BatCollect && window.BatCollect.active) return; // guided trials set labels themselves
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const i = '12345'.indexOf(e.key);
    if (i >= 0) api.setLabel(LABELS[i]);
  });

  window.BatRecorder = api;
})();
