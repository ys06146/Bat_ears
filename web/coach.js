/* Motion coach: a person seen from behind, sitting at the laptop, showing the gesture to make.
 * Seen from behind, the figure's left/right is the user's left/right (no mirror confusion).
 *
 * window.BatCoach
 *   create(container) -> coach    adds an SVG to the container
 *   coach.ready(kind)              start pose + dashed path ("3" and "1" of the countdown)
 *   coach.preview(kind, ms)        slow ghost run of the motion ("2")
 *   coach.go(kind)                 the real stroke at real speed, then a slow return (on "GO")
 *   coach.idle()                   hand resting
 *   coach.loop(kinds)              demo loop (left/right test view); stops on any other call
 *   kind: 'push' | 'pull' | 'wave' | 'left' | 'right'
 * Distances: the laptop is ~31 cm wide in the picture, so a swipe spans ~1.6x the laptop (~50 cm).
 */
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const SHOULDER = [226, 188];
  const REST = [236, 132];
  // [start, end] of each stroke in picture coordinates (laptop deck spans x 84..276)
  const PATHS = {
    left: [[322, 112], [38, 112]],
    right: [[38, 112], [322, 112]],
    push: [[216, 142], [200, 98]],
    pull: [[200, 98], [216, 142]],
    wave: [[214, 140], [202, 100]],
  };
  const LABEL = {
    left: '◀ 약 50cm를 0.4초에 한 번 · 돌아올 땐 천천히',
    right: '약 50cm를 0.4초에 한 번 ▶ · 돌아올 땐 천천히',
    push: '화면 쪽으로 15cm 빠르게 ⟶ · 돌아올 땐 천천히',
    pull: '⟵ 내 쪽으로 15cm 빠르게 · 돌아올 땐 천천히',
    wave: '화면 쪽으로 앞뒤 빠르게 3번 〰',
  };
  const COLOR = { push: '#4fc3f7', pull: '#ffb74d', wave: '#b388ff', left: '#80deea', right: '#80deea' };
  const STROKE_MS = { left: 400, right: 400, push: 320, pull: 320, wave: 1100 };

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const clamp01 = (t) => Math.max(0, Math.min(1, t));
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // two-segment arm: the elbow sits where both segments meet, bent down/outward; far reaches straighten it
  function elbowOf(S, H) {
    const dx = H[0] - S[0], dy = H[1] - S[1], d = Math.max(1, Math.hypot(dx, dy));
    const a = Math.max(72, d / 2 + 1);
    const h = Math.sqrt(Math.max(0, a * a - (d / 2) * (d / 2)));
    let px = -dy / d, py = dx / d;
    if (px + py < 0) { px = -px; py = -py; }
    return [S[0] + dx / 2 + px * h, S[1] + dy / 2 + py * h];
  }

  function handShape(parent, opacity) {
    const g = el('g', { opacity }, parent);
    el('ellipse', { cx: 0, cy: 0, rx: 12, ry: 15, fill: '#f1c27d', stroke: '#c79a5b', 'stroke-width': 1.5 }, g);
    for (let i = 0; i < 4; i++) el('rect', { x: -11 + i * 6, y: -27, width: 5, height: 14, rx: 2.5, fill: '#f1c27d', stroke: '#c79a5b', 'stroke-width': 1 }, g);
    el('ellipse', { cx: 13, cy: 2, rx: 4, ry: 8, fill: '#f1c27d', stroke: '#c79a5b', 'stroke-width': 1, transform: 'rotate(-30 13 2)' }, g);
    return g;
  }

  function create(container) {
    const svg = el('svg', { viewBox: '0 0 360 226', class: 'coach', role: 'img', 'aria-label': '동작 안내' });
    container.appendChild(svg);
    // laptop: screen, deck, the two speakers (left/right swipes use one tone per speaker)
    el('rect', { x: 110, y: 6, width: 140, height: 82, rx: 6, fill: '#1b2330', stroke: '#3a4558', 'stroke-width': 2 }, svg);
    el('rect', { x: 118, y: 13, width: 124, height: 66, rx: 3, fill: '#22324a' }, svg);
    el('polygon', { points: '98,88 262,88 278,110 82,110', fill: '#2a3342', stroke: '#3a4558', 'stroke-width': 2 }, svg);
    const spk = el('g', { opacity: 0 }, svg);
    el('circle', { cx: 96, cy: 101, r: 4, fill: '#80deea' }, spk);
    el('circle', { cx: 264, cy: 101, r: 4, fill: '#80deea' }, spk);
    // guide path + arrowhead, trail, ghost, person
    const guide = el('path', { d: '', fill: 'none', stroke: '#9aa3b2', 'stroke-width': 2.5, 'stroke-dasharray': '7 6', opacity: 0 }, svg);
    const head = el('polygon', { points: '', fill: '#9aa3b2', opacity: 0 }, svg);
    const trail = [0, 1, 2, 3, 4].map(() => el('circle', { r: 9, fill: '#80deea', opacity: 0 }, svg));
    const ghost = handShape(svg, 0);
    // the person, seen from behind: shirt, neck, head (hair) with ears
    const body = el('path', { d: '', fill: '#5a74a8', stroke: '#7d94c4', 'stroke-width': 1.5 }, svg);
    const neck = el('rect', { x: 171, y: 160, width: 18, height: 20, rx: 6, fill: '#d9a86c' }, svg);
    const earL = el('ellipse', { cx: 159, cy: 150, rx: 4, ry: 7, fill: '#d9a86c' }, svg);
    const earR = el('ellipse', { cx: 201, cy: 150, rx: 4, ry: 7, fill: '#d9a86c' }, svg);
    const headG = el('circle', { cx: 180, cy: 148, r: 21, fill: '#2a2420', stroke: '#7a6656', 'stroke-width': 2 }, svg);
    const upper = el('path', { d: '', fill: 'none', stroke: '#5a74a8', 'stroke-width': 16, 'stroke-linecap': 'round' }, svg);
    const fore = el('path', { d: '', fill: 'none', stroke: '#e0b07a', 'stroke-width': 11, 'stroke-linecap': 'round' }, svg);
    const hand = handShape(svg, 1);
    el('rect', { x: 20, y: 207, width: 320, height: 18, rx: 9, fill: '#0b0f16', opacity: 0.75 }, svg);
    const label = el('text', { x: 180, y: 220, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: '#e6e9ef' }, svg);

    const st = { anim: null, raf: 0, loopTimer: 0, pos: REST.slice() };

    function place(g, p) {
      const s = 0.82 + 0.36 * clamp01((p[1] - 96) / 46); // nearer the screen = a bit smaller
      g.setAttribute('transform', `translate(${p[0].toFixed(1)} ${p[1].toFixed(1)}) scale(${s.toFixed(3)})`);
    }
    function setHand(p) {
      st.pos = p;
      place(hand, p);
      // the body leans a little toward a far reach
      const lean = 0.12 * (p[0] - REST[0]);
      const S = [SHOULDER[0] + lean, SHOULDER[1]], cx = 180 + lean * 0.6;
      body.setAttribute('d', `M${cx - 92},226 Q${cx - 82},180 ${cx - 34},174 L${cx + 34},174 Q${cx + 82},180 ${cx + 92},226 Z`);
      neck.setAttribute('x', (cx - 9).toFixed(1));
      earL.setAttribute('cx', (cx - 21).toFixed(1)); earR.setAttribute('cx', (cx + 21).toFixed(1));
      headG.setAttribute('cx', cx.toFixed(1));
      const W = [p[0], p[1] + 12]; // wrist, just below the palm
      const E = elbowOf(S, W);
      upper.setAttribute('d', `M${S[0].toFixed(1)},${S[1]} L${E[0].toFixed(1)},${E[1].toFixed(1)}`);
      fore.setAttribute('d', `M${E[0].toFixed(1)},${E[1].toFixed(1)} L${W[0].toFixed(1)},${W[1].toFixed(1)}`);
    }
    function setGuide(kind) {
      if (!kind) { guide.setAttribute('opacity', 0); head.setAttribute('opacity', 0); spk.setAttribute('opacity', 0); label.textContent = ''; return; }
      const [a, b] = PATHS[kind];
      guide.setAttribute('d', `M${a[0]},${a[1]} L${b[0]},${b[1]}`);
      guide.setAttribute('stroke', COLOR[kind]);
      guide.setAttribute('opacity', 0.8);
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), L = 13;
      const pts = [b, [b[0] - L * Math.cos(ang - 0.5), b[1] - L * Math.sin(ang - 0.5)], [b[0] - L * Math.cos(ang + 0.5), b[1] - L * Math.sin(ang + 0.5)]];
      head.setAttribute('points', pts.map((q) => q.map((v) => v.toFixed(1)).join(',')).join(' '));
      head.setAttribute('fill', COLOR[kind]);
      head.setAttribute('opacity', 0.9);
      spk.setAttribute('opacity', kind === 'left' || kind === 'right' ? 0.9 : 0);
      label.textContent = LABEL[kind];
    }
    function clearTrail() { trail.forEach((c) => c.setAttribute('opacity', 0)); }

    function run(anim) {
      st.anim = { ...anim, t0: performance.now() };
      if (!st.raf) st.raf = requestAnimationFrame(tick);
    }
    function tick(now) {
      st.raf = 0;
      const a = st.anim;
      if (!a) return;
      const t = now - a.t0;
      const done = a.step(t);
      if (!done) st.raf = requestAnimationFrame(tick);
      else st.anim = null;
    }
    function stopLoop() { clearTimeout(st.loopTimer); st.loopTimer = 0; }

    const coach = {
      el: svg,
      idle() {
        stopLoop(); st.anim = null; setGuide(null); clearTrail(); ghost.setAttribute('opacity', 0); setHand(REST);
      },
      ready(kind, keepLoop) {
        if (!keepLoop) stopLoop();
        st.anim = null; clearTrail(); ghost.setAttribute('opacity', 0);
        setGuide(kind);
        const from = st.pos, to = PATHS[kind][0];
        run({ step: (t) => { const u = clamp01(t / 350); setHand(lerp(from, to, ease(u))); return u >= 1; } });
      },
      preview(kind, ms = 500) {
        stopLoop(); setGuide(kind); clearTrail();
        const [a, b] = PATHS[kind];
        setHand(a);
        ghost.setAttribute('opacity', 0.4);
        run({
          step: (t) => {
            const u = clamp01(t / ms);
            const p = kind === 'wave' ? lerp(a, b, (1 - Math.cos(u * 6 * Math.PI)) / 2) : lerp(a, b, ease(u));
            place(ghost, p);
            if (u >= 1) ghost.setAttribute('opacity', 0);
            return u >= 1;
          },
        });
      },
      go(kind, keepLoop) {
        if (!keepLoop) stopLoop();
        setGuide(kind); ghost.setAttribute('opacity', 0);
        const [a, b] = PATHS[kind], strokeMs = STROKE_MS[kind], holdMs = 250, backMs = 900;
        const hist = [];
        setHand(a);
        run({
          step: (t) => {
            let p;
            if (t < strokeMs) {
              const u = t / strokeMs;
              p = kind === 'wave' ? lerp(a, b, (1 - Math.cos(u * 6 * Math.PI)) / 2) : lerp(a, b, ease(u));
              hist.push(p);
            } else if (t < strokeMs + holdMs) {
              p = kind === 'wave' ? a : b;
            } else {
              const u = clamp01((t - strokeMs - holdMs) / backMs), from = kind === 'wave' ? a : b;
              p = lerp(from, REST, ease(u));
              p = [p[0], p[1] + 14 * Math.sin(Math.PI * u)]; // the slow way back dips lower
            }
            setHand(p);
            // fading trail behind the fast stroke shows its speed
            trail.forEach((c, i) => {
              const q = hist[hist.length - 1 - i * 3];
              const fade = t < strokeMs + holdMs ? 1 : Math.max(0, 1 - (t - strokeMs - holdMs) / 300);
              if (q) { c.setAttribute('cx', q[0].toFixed(1)); c.setAttribute('cy', q[1].toFixed(1)); c.setAttribute('fill', COLOR[kind]); c.setAttribute('opacity', ((0.45 - i * 0.08) * fade).toFixed(2)); }
            });
            return t >= strokeMs + holdMs + backMs;
          },
        });
      },
      // demo loop for the left/right test view: ready -> go -> pause, alternating kinds
      loop(kinds = ['right', 'left']) {
        stopLoop();
        let i = 0;
        const next = () => {
          const kind = kinds[i++ % kinds.length];
          coach.ready(kind, true);
          st.loopTimer = setTimeout(() => {
            coach.go(kind, true);
            st.loopTimer = setTimeout(next, 2200);
          }, 900);
        };
        next();
      },
      stop() { stopLoop(); st.anim = null; },
    };
    coach.idle();
    return coach;
  }

  window.BatCoach = { create };
})();
