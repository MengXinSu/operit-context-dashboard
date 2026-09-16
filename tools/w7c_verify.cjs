// w7c_verify.cjs —— W7② 计费 Token 卡本地交互验证（Playwright + mock 桥）
// 跑法：NODE_PATH=/usr/lib/node_modules/@playwright/mcp/node_modules node w7c_verify.cjs
// 场景：① 卡渲染（标题/副标/中心值）② 图例（≈/输出真值/含思考）③ 分摊断言 ④ 空态 ⑤ 无页面错误
const { chromium } = require('playwright');
const fs = require('fs');
const PAGE = process.env.W7C_PAGE || 'file:///tmp/dsh-ui-lab/exp1/dist/index.single.html';
const SHOT_DIR = '/sdcard/Download/Operit/_w7_shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS: ' + name + (extra ? ' | ' + extra : '')); }
  else { fail++; console.log('FAIL: ' + name + (extra ? ' | ' + extra : '')); }
}
function mockScript() {
  return () => {
    window.CtxProbe = {
      api: function (payload) {
        const req = JSON.parse(payload);
        const m = req.m;
        if (m === 'summary') return JSON.stringify({ ok: true, session: 'W7C-TEST', current: { system: 100, tools: 50, user: 10, inject: 5, skill: 2, assistant: 20, tool: 3, total: 190 }, counts: { TOOL_CALL: 5 }, worldbook: { blocks: 0, chars: 0, entries: 0, names: [] }, historyCount: 12 });
        if (m === 'timeline') return JSON.stringify({ ok: true, items: [] });
        if (m === 'steps') return JSON.stringify({ ok: true, items: [] });
        if (m === 'messages' || m === 'events' || m === 'toolUsage') return JSON.stringify({ ok: true, items: [] });
        if (m === 'todayMessages') return JSON.stringify({ ok: true, groups: [] });
        if (m === 'fileActivity') return JSON.stringify({ ok: true, entries: [], totals: { read: { files: 0, ops: 0 }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 }, added: 0, removed: 0 }, userIdx: [] });
        if (m === 'sessionUsage') return JSON.stringify(window.__W7C_USAGE);
        if (m === 'rawSection') return JSON.stringify({ ok: true, kind: 'list', total: 0, offset: 0, items: [] });
        return JSON.stringify({ ok: true, items: [] });
      },
    };
  };
}
(async () => {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1237/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  // ── 场景 A：有数据 ──
  const ctx1 = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx1.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('[pageerror]', e.message); });
  await page.addInitScript(() => { window.__W7C_USAGE = { ok: true, session: 'W7C-TEST', rows: 6, input: 28555341, output: 223984, cached: 27749376, first: 1, last: 2 }; });
  await page.addInitScript(mockScript());
  await page.goto(PAGE);
  await page.waitForFunction(() => document.body.innerText.includes('28.8M'), null, { timeout: 20000 });
  const s1 = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => {
      const t = c.querySelector('.lc-card-title-text');
      return t && (t.textContent === 'Token 统计' || t.textContent === 'Token统计');
    });
    if (!card) return null;
    const title = card.querySelector('.lc-card-title-text').textContent;
    const sub = card.querySelector('.lc-card-title span:last-child').textContent;
    return { title, sub, text: card.innerText.replace(/\s+/g, ' ') };
  });
  check('1a 卡渲染（标题）', !!s1 && (s1.title === 'Token 统计' || s1.title === 'Token统计'), JSON.stringify(s1 && s1.title));
  check('1b 副标「6 条完成消息 · 计费口径」', !!s1 && s1.sub.includes('6') && s1.sub.includes('计费口径'), JSON.stringify(s1 && s1.sub));
  check('1c 中心值 28.8M', !!s1 && s1.text.includes('28.8M'), '');
  check('2a 输出行真值 224.0k + 含思考标签', !!s1 && /输出[^\n]{0,24}含思考[^\n]{0,24}224\.0k/.test(s1.text), JSON.stringify(s1 && s1.text.slice(0, 500)));
  check('2b system 分段 ≈15.0M', !!s1 && s1.text.includes('15.0M'), '');
  check('2c 输出行不带 ≈', !!s1 && !/≈224\.0k/.test(s1.text), '');
  await page.screenshot({ path: SHOT_DIR + '/w7c_billing.png' });
  check('5a 无页面错误', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
  // ── 场景 B：空态 ──
  const ctx2 = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2 });
  const page2 = await ctx2.newPage();
  const errs2 = [];
  page2.on('pageerror', (e) => errs2.push(e.message));
  await page2.addInitScript(() => { window.__W7C_USAGE = { ok: true, session: 'W7C-TEST', rows: 0, input: 0, output: 0, cached: 0, first: 0, last: 0 }; });
  await page2.addInitScript(mockScript());
  await page2.goto(PAGE);
  await page2.waitForFunction(() => document.body.innerText.includes('会话暂无计费数据'), null, { timeout: 15000 });
  check('3a 空态文案', true, '');
  check('5b 无页面错误（空态页）', errs2.length === 0, JSON.stringify(errs2.slice(0, 3)));
  await page2.screenshot({ path: SHOT_DIR + '/w7c_empty.png' });
  console.log('==== W7C verify: PASS=' + pass + ' FAIL=' + fail + ' ====');
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})();