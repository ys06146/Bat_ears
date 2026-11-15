// Drive vision_full.html in a headless Chrome (its own instance: another script on the same tab would navigate it away)
// and dump every frame's landmarks. usage: node vf_run.mjs <cdp port> <page url> <webm url, relative to the page> <out.json>
import { writeFileSync } from 'node:fs';
const [, , port, pageUrl, webm, outFile] = process.argv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
const call = (method, params = {}) => new Promise((r) => { const k = ++id; pending.set(k, r); ws.send(JSON.stringify({ id: k, method, params })); });
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result ? r.result.value : r; };
await call('Page.navigate', { url: `${pageUrl}?delegate=CPU&webm=${encodeURIComponent(webm)}` });
const t0 = Date.now(); let last = 0;
while (true) {
  await sleep(3000);
  const s = await ev(`JSON.stringify({ state: VF.state, done: VF.done, total: VF.total, err: VF.err, info: VF.info })`);
  const o = JSON.parse(s || '{}');
  if (Date.now() - last > 30000) { last = Date.now(); console.log(new Date().toTimeString().slice(0, 8), o.state, `${o.done}/${o.total}`, o.err || ''); }
  if (o.state === 'done' || o.state === 'error') { console.log('final', s); if (o.state === 'error') process.exit(1); break; }
  if (Date.now() - t0 > 30 * 60000) { console.log('timeout'); process.exit(1); }
}
const n = await ev('VF.rows.length'); const rows = [];
for (let a = 0; a < n; a += 400) rows.push(...JSON.parse(await ev(`JSON.stringify(VF.rows.slice(${a}, ${a + 400}))`)));
const info = JSON.parse(await ev('JSON.stringify(VF.info)'));
writeFileSync(outFile, JSON.stringify({ info, rows }));
console.log('wrote', outFile, rows.length, 'rows');
process.exit(0);
