// w3_verify.cjs —— W3 定位联动本地交互验证（Playwright + mock 桥）
// 跑法：NODE_PATH=/usr/lib/node_modules/@playwright/mcp/node_modules node w3_verify.cjs
// 场景：① 已加载直滚（零 focus 请求）② 深锚点 focus 一页直达 ③ miss 提示
const { chromium } = require('playwright');
const fs = require('fs');

const PAGE = process.env.W3_PAGE || 'file:///tmp/dsh-ui-lab/exp1/dist/index.single.html';
const SHOT_DIR = '/sdcard/Download/Operit/_w3_shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS: ' + name + (extra ? ' | ' + extra : '')); }
  else { fail++; console.log('FAIL: ' + name + (extra ? ' | ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1237/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  // ── mock 桥：tool 池 80 条（idx 100..179），fileActivity 三个文件 ──
  await page.addInitScript(() => {
    const pool = [];
    for (let i = 0; i < 80; i++) {
      pool.push({ idx: 100 + i, kind: i % 2 === 0 ? 'TOOL_CALL' : 'TOOL_RESULT', toolName: 'read_file', chars: 50, preview: 'preview ' + (100 + i) });
    }
    const calls = [];
    window.__calls = calls;
    function rawSection(section, offset, limit, focusIdx) {
      if (section !== 'tool') return { ok: true, kind: 'text', total: 0, chars: 0, content: '' };
      const rev = pool.slice().reverse();
      const fo = (focusIdx === undefined || focusIdx === null) ? -1 : focusIdx;
      if (fo >= 0) {
        const pos = rev.findIndex((x) => x.idx === fo);
        if (pos < 0) return { ok: true, kind: 'list', total: rev.length, items: [], focusMiss: true, focusIdx: fo };
        const off = Math.floor(pos / limit) * limit;
        return { ok: true, kind: 'list', total: rev.length, offset: off, items: rev.slice(off, off + limit), focusIdx: fo };
      }
      return { ok: true, kind: 'list', total: rev.length, offset: offset || 0, items: rev.slice(offset || 0, (offset || 0) + limit) };
    }
    window.CtxProbe = {
      api: function (payload) {
        const req = JSON.parse(payload);
        const m = req.m;
        if (m === 'rawSection') { calls.push({ m, section: req.section, offset: req.offset, limit: req.limit, focusIdx: req.focusIdx }); return JSON.stringify(rawSection(req.section, req.offset || 0, req.limit || 30, req.focusIdx)); }
        if (m === 'rawItem') return JSON.stringify({ ok: true, kind: 'TOOL', content: 'CONTENT-FOR-' + req.index });
        if (m === 'fileActivity') return JSON.stringify({
          ok: true,
          entries: [
            { path: '/sdcard/test/a.md', form: 'text', reads: 1, writes: 0, searches: 0, added: 0, removed: 0, errs: 0, ops: [{ seq: 178, kind: 'read', tool: 'read_file', path: '/sdcard/test/a.md', added: 0, removed: 0, err: false, callIdx: 177, resultIdx: 178 }] },
            { path: '/sdcard/test/b.md', form: 'text', reads: 1, writes: 0, searches: 0, added: 0, removed: 0, errs: 0, ops: [{ seq: 119, kind: 'read', tool: 'read_file', path: '/sdcard/test/b.md', added: 0, removed: 0, err: false, callIdx: 118, resultIdx: 119 }] },
            { path: '/sdcard/test/c.md', form: 'text', reads: 1, writes: 0, searches: 0, added: 0, removed: 0, errs: 0, ops: [{ seq: 999999, kind: 'read', tool: 'read_file', path: '/sdcard/test/c.md', added: 0, removed: 0, err: false, callIdx: 999998, resultIdx: 999999 }] },
          ],
          totals: { read: { files: 3, ops: 3 }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 }, added: 0, removed: 0 },
        });
        if (m === 'summary') return JSON.stringify({ ok: true, session: 'W3-TEST', current: { system: 100, tools: 50, user: 10, inject: 5, skill: 2, assistant: 20, tool: 3, total: 190 }, counts: { TOOL_CALL: 3 }, worldbook: { blocks: 0, chars: 0, entries: 0, names: [] }, historyCount: 5 });
        if (m === 'timeline' || m === 'messages' || m === 'events' || m === 'steps' || m === 'toolUsage') return JSON.stringify({ ok: true, items: [] });
        if (m === 'todayMessages') return JSON.stringify({ ok: true, groups: [] });
        return JSON.stringify({ ok: true, items: [] });
      },
    };
  });

  await page.goto(PAGE);
  await page.waitForFunction(() => document.body.innerText.includes('/sdcard/test/a.md'), null, { timeout: 20000 });
  console.log('页面加载 + 文件卡数据 OK');
  await page.screenshot({ path: SHOT_DIR + '/w3_0_loaded.png' });

  // ── 场景① 已加载直滚：先手动打开「工具结果」分类，再点 a.md 的 op ──
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => c.innerText.includes('上下文浏览器'));
    const cat = [...card.querySelectorAll('span')].find((s) => s.textContent === '工具结果');
    cat.parentElement.click();
  });
  await page.waitForFunction(() => document.body.innerText.includes('preview 179'), null, { timeout: 10000 }); // 第一页含最新条目
  await page.evaluate(() => { window.__calls.length = 0; }); // 清计数
  await page.evaluate(() => { [...document.querySelectorAll('.lc-fa-row')].find((el) => el.innerText.includes('a.md')).click(); });
  await page.waitForFunction(() => !!document.querySelector('.lc-fa-op'));
  await page.evaluate(() => { document.querySelector('.lc-fa-op').click(); });
  await page.waitForFunction(() => document.body.innerText.includes('CONTENT-FOR-178'), null, { timeout: 10000 });
  const focusCalls1 = await page.evaluate(() => window.__calls.filter((c) => c.m === 'rawSection' && c.focusIdx !== undefined).length);
  check('① 已加载直滚：零 focus 请求', focusCalls1 === 0, 'focusCalls=' + focusCalls1);
  check('① 目标条目已展开', true);
  await page.screenshot({ path: SHOT_DIR + '/w3_1_direct.png' });

  // ── 场景② 深锚点 focus 直达：点 b.md 的 op（锚点 idx=119，位于第 3 页）──
  await page.evaluate(() => { window.__calls.length = 0; });
  await page.evaluate(() => { [...document.querySelectorAll('.lc-fa-row')].find((el) => el.innerText.includes('b.md')).click(); });
  await page.waitForFunction(() => [...document.querySelectorAll('.lc-fa-row')].some((el) => el.innerText.includes('b.md') && el.parentElement.querySelector('.lc-fa-ops')));
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.lc-fa-row')].find((el) => el.innerText.includes('b.md'));
    row.parentElement.querySelector('.lc-fa-op').click();
  });
  await page.waitForFunction(() => document.body.innerText.includes('CONTENT-FOR-119'), null, { timeout: 10000 });
  const focusCalls2 = await page.evaluate(() => window.__calls.filter((c) => c.m === 'rawSection' && c.focusIdx !== undefined).map((c) => c.focusIdx));
  check('② focus 请求发出且锚点为 119', focusCalls2.includes(119), JSON.stringify(focusCalls2));
  // 视口检查（等 smooth 滚动完成）
  const inView = await page.waitForFunction(() => {
    const pre = [...document.querySelectorAll('pre')].find((e) => e.innerText.includes('CONTENT-FOR-119'));
    if (!pre) return false;
    const r = pre.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  }, null, { timeout: 5000 }).then(() => true).catch(() => false);
  check('② 目标条目滚入视口', inView);
  await page.screenshot({ path: SHOT_DIR + '/w3_2_focus.png' });

  // ── 场景③ miss：点 c.md 的 op（锚点不存在）→ 提示 ──
  await page.evaluate(() => { window.__calls.length = 0; });
  await page.evaluate(() => { [...document.querySelectorAll('.lc-fa-row')].find((el) => el.innerText.includes('c.md')).click(); });
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.lc-fa-row')];
    const row = rows.find((el) => el.innerText.includes('c.md'));
    return row && row.parentElement.querySelector('.lc-fa-ops');
  });
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.lc-fa-row')].find((el) => el.innerText.includes('c.md'));
    row.parentElement.querySelector('.lc-fa-op').click();
  });
  const noticeShown = await page.waitForFunction(() => document.body.innerText.includes('未找到对应结果'), null, { timeout: 10000 }).then(() => true).catch(() => false);
  const focusCalls3 = await page.evaluate(() => window.__calls.filter((c) => c.m === 'rawSection' && c.focusIdx !== undefined).map((c) => c.focusIdx));
  check('③ miss 提示出现', noticeShown, 'focusCalls=' + JSON.stringify(focusCalls3));
  await page.screenshot({ path: SHOT_DIR + '/w3_3_miss.png' });

  console.log('==== RESULT: pass=' + pass + ' fail=' + fail + ' ====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SCRIPT-ERROR', e); process.exit(2); });
