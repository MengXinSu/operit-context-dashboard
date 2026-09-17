// w9_verify.cjs —— W9① 步 brief 按需化（单步拉取+缓存+失败降级）本地交互验证（Playwright + mock 桥）
// 跑法：NODE_PATH=/usr/lib/node_modules/@playwright/mcp/node_modules node w9_verify.cjs
// 场景：① 三行渲染（按需拉取）② chip 点击直达（user/tool/assistant/tool + 快路径）③ 会话内缓存（切走再切回零新请求）
//       ④ 轮模式输入行「（无新增）」⑤ 失败降级（step not found → 无三行不崩）⑥ 无页面错误
const { chromium } = require('playwright');
const fs = require('fs');
const PAGE = process.env.W9_PAGE || 'file:///tmp/dsh-ui-lab/exp1/dist/index.single.html';
const SHOT_DIR = '/sdcard/Download/Operit/_w9_shots';
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
    try { localStorage.setItem('dsh-prefs-v1', JSON.stringify({ granularity: 'step' })); } catch (e) {}
    const now = Date.now();
    window.__calls = [];
    window.__briefCalls = [];
    const pools = {
      user: [{ idx: 1, kind: 'USER', toolName: '', chars: 20, preview: '来帮我读文件' }],
      assistant: [{ idx: 6, kind: 'ASSISTANT', toolName: '', chars: 30, preview: '找到问题了' }],
      tool: [
        { idx: 4, kind: 'TOOL_RESULT', toolName: 'read_file', chars: 40, preview: '文件内容头 READ-OK' },
        { idx: 5, kind: 'TOOL_RESULT', toolName: 'grep_code', chars: 40, preview: '命中数3 GREP-OK' },
        { idx: 7, kind: 'TOOL_CALL', toolName: 'edit_file', chars: 40, preview: '改了2行 EDIT-OK' },
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
    // W9：steps 不携带全量 brief，只带 pIdx 锚点；brief 由 stepBrief 单步现取。
    const briefMap = {
      3: { pIdx: 3, openerIdx: 1, op: [1, '来帮我读文件'], ins: [], res: [[2, '思考', '先看看在哪儿', 'A']] },
      6: { pIdx: 6, openerIdx: 1, op: [1, '来帮我读文件'], ins: [[4, 'read_file', '文件内容头 READ-OK', 0], [5, 'grep_code', '命中数3 GREP-OK', 0]], res: [[6, '思考', '找到问题了', 'A'], [7, 'edit_file', '改了2行 EDIT-OK', 'T']] },
    };
    const stepsItems = [
      { seq: 1, turn: 1, step: 1, t: now - 300000, stage: 'send', system: 10, tools: 5, user: 5, inject: 2, skill: 1, assistant: 3, tool: 2, total: 28, historyCount: 5, historyChars: 100, skip: 0, pIdx: 3 },
      { seq: 2, turn: 1, step: 2, t: now - 200000, stage: 'send', system: 10, tools: 5, user: 5, inject: 2, skill: 1, assistant: 6, tool: 4, total: 40, historyCount: 8, historyChars: 180, skip: 0, pIdx: 6 },
      { seq: 3, turn: 2, step: 1, t: now - 100000, stage: 'send', system: 10, tools: 5, user: 5, inject: 2, skill: 1, assistant: 3, tool: 2, total: 30, historyCount: 6, historyChars: 120, skip: 0, pIdx: 98 },
    ];
    const tl = [];
    for (let i = 1; i <= 4; i++) {
      tl.push({ seq: i, turn: i, step: 1, t: now - (5 - i) * 60000, stage: 'send', system: 10, tools: 5, user: 5, inject: 2, skill: 1, assistant: 3, tool: 2, total: 28 + i, historyCount: 5 + i, historyChars: 100 + i * 10, skip: 0, pIdx: 200 + i });
    }
    window.CtxProbe = {
      api: function (payload) {
        const req = JSON.parse(payload);
        const m = req.m;
        if (m === 'summary') return JSON.stringify({ ok: true, session: 'W9-TEST', current: { system: 100, tools: 50, user: 10, inject: 5, skill: 2, assistant: 20, tool: 3, total: 190 }, counts: { TOOL_CALL: 5 }, worldbook: { blocks: 0, chars: 0, entries: 0, names: [] }, historyCount: 12 });
        if (m === 'timeline') return JSON.stringify({ ok: true, items: tl });
        if (m === 'steps') return JSON.stringify({ ok: true, items: stepsItems });
        if (m === 'stepBrief') {
          window.__briefCalls.push({ pIdx: req.pIdx });
          const b = briefMap[req.pIdx];
          return JSON.stringify(b ? { ok: true, brief: b } : { ok: false, error: 'step not found' });
        }
        if (m === 'messages' || m === 'events' || m === 'toolUsage') return JSON.stringify({ ok: true, items: [] });
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
  await page.waitForFunction(() => document.querySelectorAll('.lc-bar').length >= 3, null, { timeout: 20000 });
  console.log('页面加载 OK（步骤模式）');
  // ── 场景①：点第 2 柱 → 按需拉取 → 详情卡三行 ──
  await page.evaluate(() => { document.querySelectorAll('.lc-bar')[1].click(); });
  await page.waitForFunction(() => document.querySelectorAll('.lc-brief-chip').length >= 4, null, { timeout: 5000 });
  const s1 = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.lc-brief-chip')].map((c) => c.textContent);
    const tags = [...document.querySelectorAll('.lc-brief-tag')].map((c) => c.textContent);
    return { chips, tags };
  });
  check('1a 三行标签（本轮/输入/回复）', s1.tags.join(',') === '本轮,输入,回复', JSON.stringify(s1.tags));
  check('1b chip 数=5（本轮1+输入2+回复2）', s1.chips.length === 5, JSON.stringify(s1.chips));
  check('1c 输入 chip 文案（read_file/grep_code）', s1.chips.some((c) => c.includes('read_file')) && s1.chips.some((c) => c.includes('grep_code')), JSON.stringify(s1.chips));
  check('1d 回复 chip 文案（思考/edit_file）', s1.chips.some((c) => c.includes('思考')) && s1.chips.some((c) => c.includes('edit_file')), JSON.stringify(s1.chips));
  const bc1 = await page.evaluate(() => window.__briefCalls.map((x) => x.pIdx));
  check('1e 选中即按需拉取（仅 pIdx=6 一次）', bc1.length === 1 && bc1[0] === 6, JSON.stringify(bc1));
  await page.screenshot({ path: SHOT_DIR + '/w9_1_three_rows.png' });
  // ── 场景②：chip 点击直达 ──
  async function clickChip(match, section, fIdx, waitText, label) {
    const ok = await page.evaluate((txt) => {
      const c = [...document.querySelectorAll('.lc-brief-chip')].find((x) => x.textContent.includes(txt));
      if (!c) return false;
      c.click();
      return true;
    }, match);
    check('2 ' + label + '：chip 可点击', ok);
    await page.waitForFunction((t) => document.body.innerText.includes(t), waitText, { timeout: 8000 });
    const calls = await page.evaluate(() => window.__calls);
    const last = calls[calls.length - 1];
    check('2 ' + label + '：直达 ' + section + '#' + fIdx, !!last && last.section === section && String(last.focusIdx) === String(fIdx), JSON.stringify(last));
  }
  await clickChip('来帮我读文件', 'user', 1, '全文MOCK-1', '本轮→用户');
  await clickChip('read_file', 'tool', 4, '全文MOCK-4', '输入→工具');
  await clickChip('思考', 'assistant', 6, '全文MOCK-6', '回复→助手');
  await clickChip('edit_file', 'tool', 7, '全文MOCK-7', '回复→工具调用');
  await page.screenshot({ path: SHOT_DIR + '/w9_2_locate.png' });
  // ── 场景②b：快路径（已打开 tool 分类 + 目标在同页 → 零新增 focus 请求）──
  const before = await page.evaluate(() => window.__calls.length);
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('.lc-brief-chip')].find((x) => x.textContent.includes('read_file'));
    if (c) c.click();
  });
  await page.waitForFunction(() => document.body.innerText.includes('全文MOCK-4'), null, { timeout: 8000 });
  const after = await page.evaluate(() => window.__calls.length);
  check('2e 快路径：已打开分类零新增 focus 请求', after === before, before + ' -> ' + after);
  // ── 场景③：会话内缓存（点柱1→新拉取；切回柱2→零新请求）──
  await page.evaluate(() => { document.querySelectorAll('.lc-bar')[0].click(); });
  await page.waitForFunction(() => document.body.innerText.includes('先看看在哪儿'), null, { timeout: 5000 });
  const bc2 = await page.evaluate(() => window.__briefCalls.map((x) => x.pIdx));
  check('3c 新步拉取（pIdx=3 追加）', bc2.length === 2 && bc2[1] === 3, JSON.stringify(bc2));
  await page.evaluate(() => { document.querySelectorAll('.lc-bar')[1].click(); });
  await page.waitForFunction(() => document.body.innerText.includes('找到问题了'), null, { timeout: 5000 });
  const bc3 = await page.evaluate(() => window.__briefCalls.map((x) => x.pIdx));
  check('3d 切回缓存命中（零新增请求）', bc3.length === 2, JSON.stringify(bc3));
  // ── 场景⑤：失败降级（pIdx=98 → step not found → 无三行不崩）──
  await page.evaluate(() => { document.querySelectorAll('.lc-bar')[2].click(); });
  await page.waitForTimeout(700);
  const s5 = await page.evaluate(() => ({
    chips: document.querySelectorAll('.lc-brief-chip').length,
    detailOpen: !!document.querySelector('.lc-card'),
  }));
  check('5a 失败降级：无三行且详情卡仍在', s5.chips === 0 && s5.detailOpen === true, JSON.stringify(s5));
  // ── 场景④：轮模式（输入行「（无新增）」；轮1最后一步 pIdx=6 已在缓存）──
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => c.querySelector('.lc-bar'));
    const btn = [...card.querySelectorAll('.lc-gran-btn')].find((b) => b.textContent === '步骤');
    if (btn) btn.click();
  });
  await page.waitForFunction(() => document.querySelectorAll('.lc-bar').length >= 4, null, { timeout: 5000 });
  await page.evaluate(() => { document.querySelectorAll('.lc-bar')[0].click(); });
  await page.waitForFunction(() => document.body.innerText.includes('（无新增）'), null, { timeout: 5000 });
  const s4 = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.lc-brief-chip')].map((c) => c.textContent);
    return { chips, hasNoInputs: document.body.innerText.includes('（无新增）') };
  });
  check('4a 轮模式：输入行「（无新增）」', s4.hasNoInputs === true, JSON.stringify(s4.hasNoInputs));
  check('4b 轮模式：回复 chip 仍在（找到问题了）', s4.chips.some((c) => c.includes('找到问题了')), JSON.stringify(s4.chips));
  await page.screenshot({ path: SHOT_DIR + '/w9_3_turn.png' });
  // ── 场景⑥：无页面错误 ──
  check('6a 无页面错误', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
  console.log('==== W9 verify: PASS=' + pass + ' FAIL=' + fail + ' ====');
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})();