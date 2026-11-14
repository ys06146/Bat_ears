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
  const NAMES = { push: '밀기', pull: '당기기', wave: '흔들기', left: '왼쪽', right: '오른쪽' };
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
    return `<td class="${cls(p)}" title="맞힘 ${g.hit} · 틀림 ${g.wrong} · 놓침 ${g.miss}">${g.hit}/${g.n}</td>`;
  }

  function render() {
    const rows = S.rows.slice().reverse();
    const e = S.el;
    e.count.textContent = `${S.rows.length}회`;
    if (!rows.length) {
      e.table.innerHTML = '<tr><td class="dim">아직 기록이 없어요. 위에서 🎯 시작으로 실험하면 끝날 때 자동으로 한 줄 추가돼요.</td></tr>';
      e.summary.innerHTML = '';
      return;
    }
    e.table.innerHTML = `
      <tr><th>시각</th><th>사람</th><th>거리</th><th>소음</th><th>민감도</th><th>정확도</th><th>밀기</th><th>당기기</th><th>흔들기</th><th>틀림</th><th>놓침</th><th>타자 오작동</th><th>평균 속도</th><th>메모</th><th></th></tr>` +
      rows.map((r) => {
        const p = pct(r.hits, r.trials);
        const conf = Object.entries(r.confusions || {}).map(([k, v]) => `${k} ${v}`).join(', ');
        return `<tr data-id="${esc(r.id)}">
          <td>${new Date(r.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${r.aborted ? ' <span class="dim">(중단)</span>' : ''}</td>
          <td>${esc(r.who)}</td><td>${esc(r.dist)}cm</td><td>${esc(r.noise)}</td><td>${esc(r.threshold)}dB</td>
          <td class="${cls(p)}"><b>${p}%</b> <span class="dim">${r.hits}/${r.trials}</span></td>
          ${gestureCell(r, 'push')}${gestureCell(r, 'pull')}${gestureCell(r, 'wave')}
          <td title="${esc(conf)}">${r.wrong}${conf ? ' <span class="dim">ⓘ</span>' : ''}</td><td>${r.miss}</td>
          <td>${r.typingFalse == null ? '–' : r.typingFalse}</td>
          <td>${r.avgSpeed == null ? '–' : r.avgSpeed + ' m/s'}</td>
          <td><input class="xl-note" value="${esc(r.note)}" placeholder="메모"></td>
          <td><button class="secondary small xl-del" title="이 줄 지우기">✕</button></td>
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
      return `<span class="xl-chip ${cls(p)}">${esc(d)}cm · <b>${p}%</b> (${g.hits}/${g.trials}, ${g.runs}회) · 틀림 ${g.wrong}${g.typingRuns ? ` · 타자 오작동 평균 ${(g.typing / g.typingRuns).toFixed(1)}` : ''}</span>`;
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
    const head = ['시각', '사람', '거리', '소음', '민감도', '정확도', '밀기', '당기기', '흔들기', '틀림', '놓침', '타자 오작동', '메모'];
    const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`].concat(S.rows.map((r) => {
      const g = (k) => (r.by && r.by[k] && r.by[k].n ? `${r.by[k].hit}/${r.by[k].n}` : '–');
      return `| ${new Date(r.t).toLocaleString()} | ${r.who} | ${r.dist}cm | ${r.noise} | ${r.threshold}dB | ${pct(r.hits, r.trials)}% (${r.hits}/${r.trials}) | ${g('push')} | ${g('pull')} | ${g('wave')} | ${r.wrong} | ${r.miss} | ${r.typingFalse == null ? '–' : r.typingFalse} | ${(r.note || '').replace(/\|/g, '/')} |`;
    }));
    const text = lines.join('\n');
    try { await navigator.clipboard.writeText(text); flash('📋 마크다운 표를 복사했어요 (experiments/results.md에 붙여 넣기)'); } catch (_) { flash('복사가 막혔어요. CSV로 내보내 주세요'); }
  }
  let flashT = 0;
  function flash(msg) { S.el.msg.textContent = msg; clearTimeout(flashT); flashT = setTimeout(() => { S.el.msg.textContent = ''; }, 4000); }

  // ---------------------------------------------------------------- setup
  function init(root) {
    S.root = root;
    S.rows = load();
    root.innerHTML = `
      <div class="row between"><b>📒 실험 기록장</b><span class="hint" data-k="count"></span></div>
      <label class="wide">이번 조건 메모 <input data-k="note" class="grow" maxlength="80" placeholder="예: 천천히 밀기, 비스듬히, 볼륨 70%"></label>
      <p class="hint">🎯 시작으로 한 번 실험이 끝날 때마다 결과가 아래 표에 자동으로 쌓여요. 위 메모도 같이 저장돼요. 표의 메모는 나중에 고칠 수 있어요.</p>
      <div class="xl-summary" data-k="summary"></div>
      <div class="xl-wrap"><table class="xl-table" data-k="table"></table></div>
      <div class="row">
        <button class="secondary small" data-k="csv">CSV 내보내기</button>
        <button class="secondary small" data-k="md">표 복사 (마크다운)</button>
        <button class="secondary small" data-k="clear">전체 지우기</button>
        <span class="hint" data-k="msg"></span>
      </div>`;
    root.querySelectorAll('[data-k]').forEach((n) => { S.el[n.dataset.k] = n; });
    try { S.el.note.value = localStorage.getItem(KEY + '.note') || ''; } catch (_) { /* ignore */ }
    S.el.note.addEventListener('input', () => { try { localStorage.setItem(KEY + '.note', S.el.note.value); } catch (_) { /* ignore */ } });
    S.el.csv.onclick = exportCsv;
    S.el.md.onclick = copyMarkdown;
    S.el.clear.onclick = () => {
      const b = S.el.clear;
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = '정말 다 지울까요?'; setTimeout(() => { b.dataset.armed = ''; b.textContent = '전체 지우기'; }, 3000); return; }
      S.rows = []; save(); render(); b.dataset.armed = ''; b.textContent = '전체 지우기';
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
