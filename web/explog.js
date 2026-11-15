/* Experiment log: one row per guided-collection run (BatCollect), kept on this laptop, so conditions can be
 * compared side by side (distance, person, noise, sensitivity, a free-text note) and exported.
 *
 * window.ExpLog
 *   init(root)          render into a card
 *   addFromMeta(meta)   add a row from BatCollect.lastMeta (called by app.js after each run)
 *   rows                stored rows
 *
 * Stored in localStorage 'batears.explog'. Export: CSV download, or a Markdown table copied to the clipboard
 * (for experiments/results.md).
 */
(function () {
  'use strict';
  const KEY = 'batears.explog';
  const NAMES = { push: 'Push', pull: 'Pull', wave: 'Wave', left: 'Left', right: 'Right' };
  const S = { root: null, el: {}, rows: [] };

  const load = () => { try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S.rows)); } catch (_) { /* private mode */ } };
  const pct = (h, n) => (n ? Math.round((h / n) * 100) : null);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function addFromMeta(meta) {
    if (!meta || !meta.live || !meta.live.trials) return null;
    const trials = meta.trials || [];
    const by = meta.live.byGesture || {};
    const confusions = {};
    trials.filter((t) => t.result === 'wrong').forEach((t) => {
      const k = `${NAMES[t.kind] || t.kind}→${NAMES[t.got] || t.got}`;
      confusions[k] = (confusions[k] || 0) + 1;
    });
    const hitSpeeds = trials.filter((t) => t.result === 'hit' && t.speed).map((t) => t.speed);
    const row = {
      id: meta.session || String(Date.now()),
      t: meta.finishedAt || new Date().toISOString(),
      who: meta.who || 'anon',
      dist: meta.dist,
      noise: meta.noise || '',
      threshold: BatEars.config.threshold,
      volume: meta.volume,
      freq: meta.freq,
      detector: meta.detector || '',
      trials: meta.live.trials,
      hits: meta.live.hits,
      wrong: trials.filter((t) => t.result === 'wrong').length,
      miss: trials.filter((t) => t.result === 'miss').length,
      by: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { n: v.n, hit: v.hit, wrong: v.wrong, miss: v.miss }])),
      confusions,
      avgSpeed: hitSpeeds.length ? +(hitSpeeds.reduce((a, b) => a + b, 0) / hitSpeeds.length).toFixed(2) : null,
      typingFalse: meta.live.typingFalseTriggers,
      aborted: !!meta.aborted,
      note: S.el.note ? S.el.note.value.trim() : '',
    };
    S.rows = S.rows.filter((r) => r.id !== row.id).concat(row);
    save();
    render();
    return row;
  }

  // ---------------------------------------------------------------- rendering
  function cls(p) { return p == null ? '' : p >= 85 ? 'good' : p >= 65 ? 'mid' : 'bad'; }

  function gestureCell(r, k) {
    const g = r.by && r.by[k];
    if (!g || !g.n) return '<td class="dim">–</td>';
    const p = pct(g.hit, g.n);
    return `<td class="${cls(p)}" title="Hit ${g.hit} · wrong ${g.wrong} · missed ${g.miss}">${g.hit}/${g.n}</td>`;
  }

  function render() {
    const rows = S.rows.slice().reverse();
    const e = S.el;
    e.count.textContent = `${S.rows.length} runs`;
    if (!rows.length) {
      e.table.innerHTML = '<tr><td class="dim">No records yet. Run an experiment with 🎯 Start above and a row is added automatically when it ends.</td></tr>';
      e.summary.innerHTML = '';
      return;
    }
    e.table.innerHTML = `
      <tr><th>Time</th><th>Person</th><th>Distance</th><th>Noise</th><th>Sensitivity</th><th>Accuracy</th><th>Push</th><th>Pull</th><th>Wave</th><th>Wrong</th><th>Missed</th><th>Typing false triggers</th><th>Mean speed</th><th>Memo</th><th></th></tr>` +
      rows.map((r) => {
        const p = pct(r.hits, r.trials);
        const conf = Object.entries(r.confusions || {}).map(([k, v]) => `${k} ${v}`).join(', ');
        return `<tr data-id="${esc(r.id)}">
          <td>${new Date(r.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${r.aborted ? ' <span class="dim">(stopped)</span>' : ''}</td>
          <td>${esc(r.who)}</td><td>${esc(r.dist)}cm</td><td>${esc(r.noise)}</td><td>${esc(r.threshold)}dB</td>
          <td class="${cls(p)}"><b>${p}%</b> <span class="dim">${r.hits}/${r.trials}</span></td>
          ${gestureCell(r, 'push')}${gestureCell(r, 'pull')}${gestureCell(r, 'wave')}
          <td title="${esc(conf)}">${r.wrong}${conf ? ' <span class="dim">ⓘ</span>' : ''}</td><td>${r.miss}</td>
          <td>${r.typingFalse == null ? '–' : r.typingFalse}</td>
          <td>${r.avgSpeed == null ? '–' : r.avgSpeed + ' m/s'}</td>
          <td><input class="xl-note" value="${esc(r.note)}" placeholder="Memo"></td>
          <td><button class="secondary small xl-del" title="Delete this row">✕</button></td>
        </tr>`;
      }).join('');
    // summary by distance (all people pooled)
    const groups = {};
    S.rows.filter((r) => !r.aborted).forEach((r) => {
      const g = groups[r.dist] || (groups[r.dist] = { trials: 0, hits: 0, wrong: 0, runs: 0, typing: 0, typingRuns: 0 });
      g.trials += r.trials; g.hits += r.hits; g.wrong += r.wrong; g.runs++;
      if (r.typingFalse != null) { g.typing += r.typingFalse; g.typingRuns++; }
    });
    e.summary.innerHTML = Object.keys(groups).sort((a, b) => a - b).map((d) => {
      const g = groups[d], p = pct(g.hits, g.trials);
      return `<span class="xl-chip ${cls(p)}">${esc(d)}cm · <b>${p}%</b> (${g.hits}/${g.trials}, ${g.runs} runs) · wrong ${g.wrong}${g.typingRuns ? ` · mean typing false triggers ${(g.typing / g.typingRuns).toFixed(1)}` : ''}</span>`;
    }).join('');
  }

  // ---------------------------------------------------------------- export
  const COLS = ['time', 'who', 'dist_cm', 'noise', 'threshold_db', 'volume', 'freq_hz', 'detector', 'trials', 'hits', 'accuracy',
    'push', 'pull', 'wave', 'wrong', 'miss', 'confusions', 'typing_false', 'avg_speed_mps', 'aborted', 'note'];
  function asRow(r) {
    const g = (k) => (r.by && r.by[k] && r.by[k].n ? `${r.by[k].hit}/${r.by[k].n}` : '');
    return [r.t, r.who, r.dist, r.noise, r.threshold, r.volume, r.freq, r.detector, r.trials, r.hits,
      r.trials ? (r.hits / r.trials).toFixed(3) : '', g('push'), g('pull'), g('wave'), r.wrong, r.miss,
      Object.entries(r.confusions || {}).map(([k, v]) => `${k} ${v}`).join('; '),
      r.typingFalse == null ? '' : r.typingFalse, r.avgSpeed == null ? '' : r.avgSpeed, r.aborted ? 1 : 0, r.note];
  }
  function exportCsv() {
    const q = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const text = '﻿' + [COLS.join(',')].concat(S.rows.map((r) => asRow(r).map(q).join(','))).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = `batears_explog_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function copyMarkdown() {
    const head = ['Time', 'Person', 'Distance', 'Noise', 'Sensitivity', 'Accuracy', 'Push', 'Pull', 'Wave', 'Wrong', 'Missed', 'Typing false triggers', 'Memo'];
    const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`].concat(S.rows.map((r) => {
      const g = (k) => (r.by && r.by[k] && r.by[k].n ? `${r.by[k].hit}/${r.by[k].n}` : '–');
      return `| ${new Date(r.t).toLocaleString()} | ${r.who} | ${r.dist}cm | ${r.noise} | ${r.threshold}dB | ${pct(r.hits, r.trials)}% (${r.hits}/${r.trials}) | ${g('push')} | ${g('pull')} | ${g('wave')} | ${r.wrong} | ${r.miss} | ${r.typingFalse == null ? '–' : r.typingFalse} | ${(r.note || '').replace(/\|/g, '/')} |`;
    }));
    const text = lines.join('\n');
    try { await navigator.clipboard.writeText(text); flash('📋 Copied the Markdown table (paste into experiments/results.md)'); } catch (_) { flash('Copy was blocked. Please export as CSV'); }
  }
  let flashT = 0;
  function flash(msg) { S.el.msg.textContent = msg; clearTimeout(flashT); flashT = setTimeout(() => { S.el.msg.textContent = ''; }, 4000); }

  // ---------------------------------------------------------------- setup
  function init(root) {
    S.root = root;
    S.rows = load();
    root.innerHTML = `
      <div class="row between"><b>📒 Experiment log</b><span class="hint" data-k="count"></span></div>
      <label class="wide">Memo for these conditions <input data-k="note" class="grow" maxlength="80" placeholder="e.g. slow push, at an angle, volume 70%"></label>
      <p class="hint">Each time an experiment started with 🎯 Start finishes, its result is added to the table below automatically, along with the memo above. Memos in the table can be edited later.</p>
      <div class="xl-summary" data-k="summary"></div>
      <div class="xl-wrap"><table class="xl-table" data-k="table"></table></div>
      <div class="row">
        <button class="secondary small" data-k="csv">Export CSV</button>
        <button class="secondary small" data-k="md">Copy table (Markdown)</button>
        <button class="secondary small" data-k="clear">Clear all</button>
        <span class="hint" data-k="msg"></span>
      </div>`;
    root.querySelectorAll('[data-k]').forEach((n) => { S.el[n.dataset.k] = n; });
    try { S.el.note.value = localStorage.getItem(KEY + '.note') || ''; } catch (_) { /* ignore */ }
    S.el.note.addEventListener('input', () => { try { localStorage.setItem(KEY + '.note', S.el.note.value); } catch (_) { /* ignore */ } });
    S.el.csv.onclick = exportCsv;
    S.el.md.onclick = copyMarkdown;
    S.el.clear.onclick = () => {
      const b = S.el.clear;
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Really clear everything?'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Clear all'; }, 3000); return; }
      S.rows = []; save(); render(); b.dataset.armed = ''; b.textContent = 'Clear all';
    };
    S.el.table.addEventListener('change', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr || !e.target.classList.contains('xl-note')) return;
      const r = S.rows.find((x) => x.id === tr.dataset.id);
      if (r) { r.note = e.target.value.trim(); save(); }
    });
    S.el.table.addEventListener('click', (e) => {
      if (!e.target.classList.contains('xl-del')) return;
      const tr = e.target.closest('tr[data-id]');
      S.rows = S.rows.filter((x) => x.id !== tr.dataset.id);
      save(); render();
    });
    render();
  }

  window.ExpLog = { init, addFromMeta, get rows() { return S.rows.slice(); } };
})();
