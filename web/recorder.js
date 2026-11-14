/* Bat Ears recorder: logs per-frame features plus a live label to CSV (training data and accuracy tables).
 *
 * window.BatRecorder
 *   start(), stop(), toggle(), setLabel(name), download(), clear()
 *   onChange(fn)       called when the label, the row count or the recording state changes
 *   labels, label, recording, count
 *
 * Hotkeys: 1 idle, 2 push, 3 pull, 4 wave, 5 other (typing, walking by, ...)
 * Columns: session, t_ms, label, gesture, dUp_db, dDown_db, up_db, down_db, v_mps, snr_db,
 *          carrier_db, noise_db, u1..u6, d1..d6 (sub-band echo energy above / below the carrier, dB)
 */
(function () {
  'use strict';

  const LABELS = ['idle', 'push', 'pull', 'wave', 'other'];
  const rows = [];
  const watchers = [];
  let recording = false, label = 'idle', pendingGesture = '', session = '';

  const num = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '');
  const stamp = () => {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };
  function notify() { watchers.forEach((fn) => { try { fn(api); } catch (e) { console.error(e); } }); }

  BatEars.on('frame', (f) => {
    if (!recording || !f.tone || f.calibrating) return;
    rows.push([
      session, num(f.t, 1), label, pendingGesture,
      num(f.dUp, 2), num(f.dDown, 2), num(f.up, 2), num(f.down, 2), num(f.v, 3),
      num(f.snr, 1), num(f.carrier, 1), num(f.noise, 1),
      ...f.bandsUp.map((x) => num(x, 2)), ...f.bandsDown.map((x) => num(x, 2)),
    ]);
    pendingGesture = '';
    if (rows.length % 30 === 0) notify();
  });

  BatEars.on('gesture', (g) => {
    if (recording) pendingGesture = g.kind + (g.simulated ? '_sim' : '');
  });

  function toCsv() {
    const head = ['session', 't_ms', 'label', 'gesture', 'dUp_db', 'dDown_db', 'up_db', 'down_db', 'v_mps', 'snr_db', 'carrier_db', 'noise_db',
      'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6'];
    return [head.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }

  const api = {
    labels: LABELS,
    get label() { return label; },
    get recording() { return recording; },
    get count() { return rows.length; },
    start() { if (!recording) { recording = true; session = stamp(); notify(); } },
    stop() { if (recording) { recording = false; notify(); } },
    toggle() { if (recording) api.stop(); else api.start(); },
    setLabel(name) { if (LABELS.includes(name)) { label = name; notify(); } },
    clear() { rows.length = 0; notify(); },
    onChange(fn) { watchers.push(fn); },
    download() {
      const blob = new Blob([toCsv()], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `batears_${stamp()}.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    },
    toCsv,
  };

  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const i = '12345'.indexOf(e.key);
    if (i >= 0) api.setLabel(LABELS[i]);
  });

  window.BatRecorder = api;
})();
