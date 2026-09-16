// w8_verify.cjs —— W8 报错门类本地交互验证（Playwright + mock 桥）
// 跑法：NODE_PATH=/usr/lib/node_modules/@playwright/mcp/node_modules node w8_verify.cjs
// 场景：① 事件卡「报错」chip + warn 行渲染 ② 点 warn 行→浏览器定位（user#54）③ 趋势详情「跳过明细」（轮模式聚合）
//      ④ 步骤模式明细 ⑤ 无页面错误
const { chromium } = require('playwright');
const fs = require('fs');
const PAGE = process.env.W8_PAGE || 'file:///tmp/dsh-ui-lab/exp1/dist/index.single.html';
const SHOT_DIR = '/sdcard/Download/Operit/_w8_shots';
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
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('[pageerror]', e.message); });
  await page.addInitScript(() => {
    try { localStorage.setItem('dsh-prefs-v1', JSON.stringify({ granularity: 'turn' })); } catch (e) {}
    const now = Date.now();
    window.__calls = [];
    const WARN_TRUNC = '警告：检测到工具调用输出被截断。本轮所有工具调用均已作废且不会执行。请尝试减少单次输出、拆分任务，或更换更合适的模型/供应商后重试。';
    const WARN_EMPTY = '警告：请输出正文内容，禁止仅输出思考内容。';
    const pools = {
      user: [
        { idx: 54, kind: 'USER', toolName: '', chars: 120, preview: WARN_TRUNC },
        { idx: 121, kind: 'USER', toolName: '', chars: 30, preview: WARN_EMPTY },
      ],
    };
    function rawSection(section, offset, limit, focusIdx) {
      const pool = pools[section];
      if (!pool) return { ok: true, kind: 'text', total: 0, chars: 0, content: '' };
      const rev = pool.slice().reverse();
      const fo = (focusIdx === undefined || focusIdx === null || focusIdx === '') ? -1 : focusIdx;
      if (fo >= 0) {
        const pos = rev.findIndex((x) => x.idx === fo);
        if (pos < 0) return { ok: true, kind: 'list', total: rev.length, items: [], focusMiss: true, focusIdx: fo };
        const off = Math.floor(pos / limit) * limit;
        return { ok: true, kind: 'list', total: rev.length, offset: off, items: rev.slice(off, off + limit), focusIdx: fo };
      }
      return { ok: true, kind: 'list', total: rev.length, offset: offset || 0, items: rev.slice(offset || 0, (offset || 0) + limit) };
    }
    const skipWarnsTurn = [{ wtype: 'trunc', text: WARN_TRUNC, at: '2026-09-17 04:20:11', atMs: now - 600000, idx: 54 }];
    const skipWarnsStep = [{ wtype: 'empty', text: WARN_EMPTY, at: '2026-09-17 04:21:30', atMs: now - 500000, idx: 121 }];
    const tl = [
      { seq: 1, turn: 1, step: 1, t: now - 900000, stage: 'send', system: 100, tools: 50, user: 10, inject: 5, skill: 2, summary: 0, assistant: 20, tool: 3, total: 190, historyCount: 12, historyChars: 900, skip: 0 },
      { seq: 2, turn: 1, step: 2, t: now - 880000, stage: 'send', system: 100, tools: 50, user: 20, inject: 5, skill: 2, summary: 0, assistant: 40, tool: 6, total: 223, historyCount: 14, historyChars: 1000, skip: 0 },
      { seq: 3, turn: 2, step: 1, t: now - 600000, stage: 'send', system: 100, tools: 50, user: 30, inject: 5, skill: 2, summary: 0, assistant: 60, tool: 9, total: 256, historyCount: 16, historyChars: 1200, skip: 1, skipWarns: skipWarnsTurn },
    ];
    const stepsItems = [
      { seq: 1, turn: 1, step: 1, t: now - 900000, stage: 'send', system: 100, tools: 50, user: 10, inject: 5, skill: 2, summary: 0, assistant: 20, tool: 3, total: 190, historyCount: 12, historyChars: 900, skip: 0 },
      { seq: 2, turn: 1, step: 2, t: now - 880000, stage: 'send', system: 100, tools: 50, user: 20, inject: 5, skill: 2, summary: 0, assistant: 40, tool: 6, total: 223, historyCount: 14, historyChars: 1000, skip: 1, skipWarns: skipWarnsStep },
    ];
    const evs = [
      { kind: 'compaction', at: '2026-09-17 04:00:00', atMs: now - 1200000, count: 70, from: 120, to: 50, savedChars: 100000 },
      { kind: 'warn', wtype: 'trunc', text: WARN_TRUNC, idx: 54, at: '2026-09-17 04:20:11', atMs: now - 600000 },
      { kind: 'warn', wtype: 'empty', text: WARN_EMPTY, idx: 121, at: '2026-09-17 04:21:30', atMs: now - 500000 },
    ];
    window.CtxProbe = {
      api: function (payload) {
        const req = JSON.parse(payload);
        const m = req.m;
        if (m === 'summary') return JSON.stringify({ ok: true, session: 'W8-TEST', current: { system: 100, tools: 50, user: 10, inject: 5, skill: 2, assistant: 20, tool: 3, total: 190 }, counts: { TOOL_CALL: 5 }, worldbook: { blocks: 0, chars: 0, entries: 0, names: [] }, historyCount: 12 });
        if (m === 'timeline') return JSON.stringify({ ok: true, items: tl });
        if (m === 'steps') return JSON.stringify({ ok: true, items: stepsItems });
        if (m === 'messages') return JSON.stringify({ ok: true, items: [] });
        if (m === 'events') return JSON.stringify({ ok: true, items: evs });
        if (m === 'toolUsage') return JSON.stringify({ ok: true, items: [] });
        if (m === 'todayMessages') return JSON.stringify({ ok: true, groups: [] });
        if (m === 'fileActivity') return JSON.stringify({ ok: true, entries: [], totals: { read: { files: 0, ops: 0 }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 }, added: 0, removed: 0 }, userIdx: [] });
        if (m === 'rawSection') {
          const r = rawSection(req.section, req.offset || 0, req.limit || 30, req.focusIdx);
          if (req.focusIdx !== undefined && req.focusIdx !== null && req.focusIdx !== '') window.__calls.push({ section: req.section, focusIdx: req.focusIdx });
          return JSON.stringify(r);
        }
        if (m === 'rawItem') return JSON.stringify({ ok: true, kind: 'USER', content: '全文MOCK-' + req.index });
        return JSON.stringify({ ok: true, items: [] });
      },
    };
  });
  await page.goto(PAGE);
  await page.waitForFunction(() => document.querySelectorAll('.lc-bar').length >= 2, null, { timeout: 20000 });
  console.log('页面加载 OK（轮次模式）');

  // ── 场景1：事件卡「报错」chip + warn 行 ──
  const s1 = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => {
      const t = c.querySelector('.lc-card-title-text');
      return t && t.textContent === '上下文事件';
    });
    const chips = [...card.querySelectorAll('.lc-kinds .lc-gran-btn')].map((c) => c.innerText.replace(/\s+/g, ''));
    const warns = [...card.querySelectorAll('.lc-kind-warn')];
    const rows = warns.map((w) => w.parentElement.innerText);
    const clickable = warns.length ? (warns[0].parentElement.getAttribute('style') || '').includes('pointer') : false;
    return { chips, warnCount: warns.length, rows, clickable };
  });
  check('1a chips=压缩1/切换/报错2', s1.chips[0] === '压缩1' && s1.chips[1] === '切换' && s1.chips[2] === '报错2', JSON.stringify(s1.chips));
  check('1b warn 行=2（截断/输出异常）', s1.warnCount === 2 && s1.rows.some((r) => r.includes('[截断]')) && s1.rows.some((r) => r.includes('[输出异常]')), JSON.stringify(s1.rows.map((r) => r.slice(0, 50))));
  check('1c warn 行可点击（cursor pointer）', s1.clickable === true);
  await page.screenshot({ path: SHOT_DIR + '/w8_1_events.png' });

  // ── 场景2：点 warn 行（截断那条）→ 浏览器定位 user#54 ──
  await page.evaluate(() => {
    const w = [...document.querySelectorAll('.lc-kind-warn')].find((x) => x.parentElement.innerText.includes('检测到工具调用输出被截断'));
    if (w) w.parentElement.click();
  });
  let locOk = true;
  try { await page.waitForFunction(() => document.body.innerText.includes('全文MOCK-54'), null, { timeout: 8000 }); } catch (e) { locOk = false; }
  const calls = await page.evaluate(() => window.__calls);
  const last = calls[calls.length - 1];
  check('2a 定位请求 user#54', !!last && last.section === 'user' && String(last.focusIdx) === '54', JSON.stringify(last));
  check('2b 浏览器条目展开（rawItem 内容出现）', locOk);
  await page.screenshot({ path: SHOT_DIR + '/w8_2_locate.png' });

  // ── 场景3：趋势详情「跳过明细」（轮模式聚合）──
  await page.evaluate(() => { document.querySelectorAll('.lc-bar')[1].click(); });
  await page.waitForFunction(() => document.body.innerText.includes('跳过明细'), null, { timeout: 8000 });
  const s3 = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('div')].filter((d) => d.innerText && d.innerText.includes('跳过明细') && d.innerText.includes('检测到工具调用输出被截断'));
    const txt = document.body.innerText;
    return { blockOk: blocks.length > 0, hasCount: txt.includes('1条'), hasSkipFlag: txt.includes('!1') };
  });
  check('3a 详情「跳过明细」块含截断原文', s3.blockOk);
  check('3b 计数 1 条', s3.hasCount);
  check('3c header !1 标记', s3.hasSkipFlag);
  await page.screenshot({ path: SHOT_DIR + '/w8_3_detail.png' });

  // ── 场景4：步骤模式（切「步骤」→ 点 step2 柱 → 输出异常明细）──
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => c.querySelector('.lc-bar'));
    const btn = [...card.querySelectorAll('.lc-gran-btn')].find((b) => b.textContent === '轮次');
    if (btn) btn.click();
  });
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => c.querySelector('.lc-bar'));
    return [...card.querySelectorAll('.lc-gran-btn')].some((b) => b.textContent === '步骤');
  }, null, { timeout: 5000 });
  await page.evaluate(() => { document.querySelectorAll('.lc-bar')[1].click(); });
  let stepOk = true;
  try {
    await page.waitForFunction(() => {
      const blocks = [...document.querySelectorAll('div')].filter((d) => d.innerText && d.innerText.includes('跳过明细') && d.innerText.includes('请输出正文内容'));
      return blocks.length > 0;
    }, null, { timeout: 8000 });
  } catch (e) { stepOk = false; }
  check('4a 步骤模式明细（输出异常）', stepOk);
  await page.screenshot({ path: SHOT_DIR + '/w8_4_step.png' });

  // ── 场景5：无页面错误 ──
  check('5a 无页面错误', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
  console.log('==== W8 verify: PASS=' + pass + ' FAIL=' + fail + ' ====');
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})();