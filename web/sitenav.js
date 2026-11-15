/* Site menu shared by the main pages: HOLOGRAM (the main demo) · GAME · COLLECT DATA · AIR PASSWORD.
 * Include it right after <body>: <script src="sitenav.js"></script>. It inserts the bar first in <body>, marks the
 * current page, and sets --nav-h on <html> so a page can make room for it.
 * Experimental controls marked class="lab-only" stay hidden unless the address has ?lab=1 (teammates' tools, kept off the demo).
 * data-overlay on the script tag (hologram.html): the bar floats over a full-screen page instead of taking a row. */
(function () {
  'use strict';
  const me = document.currentScript;
  const overlay = !!(me && me.hasAttribute('data-overlay'));
  const LINKS = [
    ['hologram.html', 'Hologram', '🦇'],
    ['index.html', 'Game', '🎮'],
    ['collect.html', 'Collect data', '🎯'],
    ['key.html', 'Air password', '🔐'],
  ];
  const H = 44;
  const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const css = `
.site-nav{${overlay ? 'position:fixed;top:0;left:0;right:0;' : 'position:relative;'}z-index:60;height:${H}px;display:flex;align-items:center;gap:4px;
  padding:0 max(14px, env(safe-area-inset-right, 0px)) 0 max(14px, env(safe-area-inset-left, 0px));background:rgba(7,10,16,.88);
  border-bottom:1px solid #1d2533;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  font:600 12px/1 Inter,system-ui,-apple-system,"Segoe UI","Apple SD Gothic Neo",sans-serif;letter-spacing:.08em;overflow-x:auto;scrollbar-width:none}
.site-nav::-webkit-scrollbar{display:none}
.site-nav .brand{color:#e9eef7;font-weight:800;letter-spacing:0;font-size:14px;margin-right:12px;white-space:nowrap;text-decoration:none}
.site-nav a.item{color:#8d9bb0;text-decoration:none;text-transform:uppercase;padding:8px 11px;border-radius:8px;white-space:nowrap}
.site-nav a.item:hover{color:#e9eef7;background:#141c28}
.site-nav a.item.sel{color:#e9eef7;background:#1a2433;box-shadow:inset 0 -2px 0 #72daca}
.site-nav a:focus-visible{outline:2px solid #72daca;outline-offset:2px}
body.present .site-nav,body.film .site-nav{display:none}
body:not(.lab-mode) .lab-only{display:none!important}`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const nav = document.createElement('nav');
  nav.className = 'site-nav';
  nav.setAttribute('aria-label', 'Bat Ears pages');
  const brand = document.createElement('a');
  brand.className = 'brand'; brand.href = 'hologram.html'; brand.textContent = '🦇 Bat Ears';
  nav.appendChild(brand);
  for (const [href, label, icon] of LINKS) {
    const a = document.createElement('a');
    a.className = 'item' + (href === here ? ' sel' : '');
    a.href = href;
    a.textContent = `${icon} ${label}`;
    if (href === here) a.setAttribute('aria-current', 'page');
    nav.appendChild(a);
  }
  const put = () => {
    document.body.insertBefore(nav, document.body.firstChild);
    document.body.classList.add('has-nav');
    if (/[?&]lab=1\b/.test(location.search)) document.body.classList.add('lab-mode');
  };
  if (document.body) put(); else document.addEventListener('DOMContentLoaded', put);
  document.documentElement.style.setProperty('--nav-h', H + 'px');
})();
