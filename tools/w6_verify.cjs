// w6_verify.cjs —— W6 收尾本地交互验证（Playwright + mock 桥）
// 跑法：NODE_PATH=/usr/lib/node_modules/@playwright/mcp/node_modules node w6_verify.cjs
// 场景：1 基础/副标题默认 2 点柱→scope 过滤+副标题+时间 3 最新柱→全量 4 超窗口柱→out 提示
//       5 ✕→复位 6 文件名打开（openPath）+ 行展开 op 时间 7 回归（chips=5、无 pageerror）
const { chromium } = require('playwright');
const fs = require('fs');
const PAGE = process.env.W6_PAGE || 'file:///tmp/dsh-ui-lab/exp1/dist/index.single.html';
const SHOT_DIR = '/sdcard/Download/Operit/_w6_shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
let pass = 0, fail = 0;
const pageErrors = [];
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
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('[pageerror]', e.message); });
  await page.addInitScript(() => {
    const now = Date.now();
    window.__openCalls = [];
    const faOps = {
      a: [
        { seq: 25, kind: 'write', tool: 'edit_file', path: '/mock/a.txt', added: 10, removed: 2, err: false, callIdx: 24, resultIdx: 25 },
        { seq: 12, kind: 'read', tool: 'read_file', path: '/mock/a.txt', added: 0, removed: 0, err: false, callIdx: 11, resultIdx: 12 },
        { seq: 5, kind: 'read', tool: 'read_file_part', path: '/mock/a.txt', added: 0, removed: 0, err: false, callIdx: 4, resultIdx: 5 },
      ],
      b: [
        { seq: 23, kind: 'read', tool: 'read_file', path: '/mock/b.md', added: 0, removed: 0, err: false, callIdx: 22, resultIdx: 23 },
        { seq: 20, kind: 'search', tool: 'grep_code', path: '/mock/b.md', added: 0, removed: 0, err: false, callIdx: 19, resultIdx: 20 },
      ],
    };
    window.CtxProbe = {
      api: function (payload) {
        const req = JSON.parse(payload);
        const m = req.m;
        if (m === 'summary') return JSON.stringify({ ok: true, session: 'W6-TEST', current: { system: 100, tools: 50, user: 10, inject: 5, skill: 2, assistant: 20, tool: 3, total: 190 }, counts: { TOOL_CALL: 5 }, worldbook: { blocks: 0, chars: 0, entries: 0, names: [] }, historyCount: 12 });
        if (m === 'timeline') {
          const items = [];
          for (let i = 1; i <= 12; i++) {
            items.push({ seq: i, turn: i, step: 1, t: now - (12 - i) * 3600000, stage: 'send', system: 100, tools: 50, user: 10, inject: 5, skill: 2, assistant: 20, tool: 3, total: 190 + i * 10, historyCount: 100 + i, historyChars: 5000 + i * 10, skip: 0 });
          }
          return JSON.stringify({ ok: true, items });
        }
        if (m === 'steps') return JSON.stringify({ ok: true, items: [] });
        if (m === 'messages') return JSON.stringify({ ok: true, items: [] });
        if (m === 'events') return JSON.stringify({ ok: true, items: [] });
        if (m === 'fileActivity') return JSON.stringify({
          ok: true,
          entries: [
            { path: '/mock/a.txt', form: 'text', reads: 2, writes: 1, searches: 0, added: 10, removed: 2, errs: 0, ops: faOps.a },
            { path: '/mock/b.md', form: 'text', reads: 1, writes: 0, searches: 1, added: 0, removed: 0, errs: 0, ops: faOps.b },
          ],
          totals: { read: { files: 2, ops: 3 }, write: { files: 1, ops: 1 }, search: { files: 1, ops: 1 }, image: { files: 0, ops: 0 }, added: 10, removed: 2 },
          userIdx: [2, 4, 6, 8, 10, 12, 14, 16],
        });
        if (m === 'toolUsage') return JSON.stringify({ ok: true, items: [] });
        if (m === 'todayMessages') return JSON.stringify({ ok: true, groups: [] });
        if (m === 'openPath') { window.__openCalls.push(req.path); return JSON.stringify({ ok: true, path: req.path }); }
        if (m === 'rawSection') return JSON.stringify({ ok: true, kind: 'list', total: 0, offset: 0, items: [] });
        if (m === 'rawItem') return JSON.stringify({ ok: false, error: 'mock' });
        return JSON.stringify({ ok: true, items: [] });
      },
    };
  });
  await page.goto(PAGE);
  await page.waitForFunction(() => document.body.innerText.includes('文件活动'), null, { timeout: 20000 });
  console.log('页面加载 OK');

  const getFa = () => {
    return page.evaluate(() => {
      const card = [...document.querySelectorAll('.lc-card')].find((c) => {
        const t = c.querySelector('.lc-card-title-text');
        return t && t.textContent === '文件活动';
      });
      return {
        sub: card.querySelector('.lc-card-sub') ? card.querySelector('.lc-card-sub').textContent : null,
        rows: [...card.querySelectorAll('.lc-fa-item')].map((r) => r.querySelector('.lc-fa-path b') ? r.querySelector('.lc-fa-path b').textContent : ''),
        chips: [...card.querySelectorAll('.lc-fa-ctl .lc-gran-btn')].map((b) => ({ t: b.textContent, n: b.querySelector('.lc-fa-n') ? b.querySelector('.lc-fa-n').textContent : null })),
        times: [...card.querySelectorAll('.lc-fa-time')].map((s) => s.textContent),
        empty: [...card.querySelectorAll('.lc-empty')].map((e) => e.textContent),
      };
    });
  };

  // ── 场景1：基础 + 副标题默认 ──
  const s1 = await getFa();
  check('1a 文件卡渲染：2 个文件行', s1.rows.length === 2 && s1.rows.includes('a.txt') && s1.rows.includes('b.md'), JSON.stringify(s1.rows));
  check('1b 副标题默认「截至最新」', !!s1.sub && s1.sub.includes('截至最新'), String(s1.sub));
  check('1c 回归：chips=5（全部/读取/写入/搜索/图片）', s1.chips.length === 5, JSON.stringify(s1.chips.map((c) => c.t)));
  await page.screenshot({ path: SHOT_DIR + '/w6_1_base.png' });

  // ── 场景2：点第10柱 → scope 过滤 + 副标题 + 时间 ──
  const nBars = await page.evaluate(() => document.querySelectorAll('.lc-bar').length);
  check('2pre 趋势柱=12', nBars === 12, 'bars=' + nBars);
  await page.evaluate(() => { document.querySelectorAll('.lc-bar')[9].click(); });
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => c.querySelector('.lc-card-title-text') && c.querySelector('.lc-card-title-text').textContent === '文件活动');
    const sub = card.querySelector('.lc-card-sub');
    return sub && /第\s*10\s*轮/.test(sub.textContent);
  }, null, { timeout: 5000 });
  const s2 = await getFa();
  check('2a 副标题随选中=「第 10 轮」', /第\s*10\s*轮/.test(s2.sub || ''), String(s2.sub));
  check('2b 过滤：仅 a.txt（b.md 操作全在锚点后）', s2.rows.length === 1 && s2.rows[0] === 'a.txt', JSON.stringify(s2.rows));
  const chipAll = s2.chips.find((c) => c.t.includes('全部'));
  check('2c 「全部」chip ops=2（a 的 write 被滤掉）', !!chipAll && chipAll.n === '2', JSON.stringify(chipAll));
  const chipWrite = s2.chips.find((c) => c.t.includes('写入'));
  check('2d 「写入」chip ops=0', !!chipWrite && chipWrite.n === '0', JSON.stringify(chipWrite));
  check('2e 文件行时间出现（HH:MM:SS）', s2.times.length === 1 && /^\d{2}:\d{2}:\d{2}$/.test(s2.times[0] || ''), JSON.stringify(s2.times));
  await page.screenshot({ path: SHOT_DIR + '/w6_2_scope.png' });

  // ── 场景3：点最新柱（12）→ 全量恢复 ──
  await page.evaluate(() => { document.querySelectorAll('.lc-bar')[11].click(); });
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => c.querySelector('.lc-card-title-text') && c.querySelector('.lc-card-title-text').textContent === '文件活动');
    return card.querySelectorAll('.lc-fa-item').length === 2;
  }, null, { timeout: 5000 });
  const s3 = await getFa();
  check('3a 最新柱→全量（2 文件 + 副标题「第 12 轮」）', s3.rows.length === 2 && /第\s*12\s*轮/.test(s3.sub || ''), JSON.stringify({ rows: s3.rows, sub: s3.sub }));

  // ── 场景4：点第3柱（超窗口：d=9 ≥ 窗口 8 轮）→ out 提示 ──
  await page.evaluate(() => { document.querySelectorAll('.lc-bar')[2].click(); });
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => c.querySelector('.lc-card-title-text') && c.querySelector('.lc-card-title-text').textContent === '文件活动');
    return [...card.querySelectorAll('.lc-empty')].some((e) => e.textContent.includes('当前数据窗口'));
  }, null, { timeout: 5000 });
  const s4 = await getFa();
  check('4a 超窗口轮→「早于当前数据窗口」提示 + 0 文件行', s4.empty.some((x) => x.includes('当前数据窗口')) && s4.rows.length === 0, JSON.stringify(s4.empty));
  await page.screenshot({ path: SHOT_DIR + '/w6_3_out.png' });

  // ── 场景5：✕ → 复位 ──
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === '✕'); if (b) b.click(); });
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => c.querySelector('.lc-card-title-text') && c.querySelector('.lc-card-title-text').textContent === '文件活动');
    const sub = card.querySelector('.lc-card-sub');
    return sub && sub.textContent.includes('截至最新') && card.querySelectorAll('.lc-fa-item').length === 2;
  }, null, { timeout: 5000 });
  check('5a ✕→副标题复位 + 全量 2 文件', true);

  // ── 场景6：文件名打开 + 行展开 op 时间 ──
  await page.evaluate(() => { const f = [...document.querySelectorAll('.lc-fa-file')].find((b) => b.textContent === 'a.txt'); if (f) f.click(); });
  await page.waitForFunction(() => (window.__openCalls || []).length >= 1, null, { timeout: 5000 });
  const openCalls = await page.evaluate(() => window.__openCalls);
  check('6a 点文件名→openPath 调用（/mock/a.txt）', openCalls.length === 1 && openCalls[0] === '/mock/a.txt', JSON.stringify(openCalls));
  const s6a = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.lc-fa-item')].find((r) => r.querySelector('.lc-fa-path b') && r.querySelector('.lc-fa-path b').textContent === 'a.txt');
    return { open: row.className.includes('lc-fa-item-on'), opsShown: !!row.querySelector('.lc-fa-ops') };
  });
  check('6b 点文件名不触发行展开（stopPropagation 生效）', !s6a.open && !s6a.opsShown, JSON.stringify(s6a));
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.lc-fa-item')].find((r) => r.querySelector('.lc-fa-path b') && r.querySelector('.lc-fa-path b').textContent === 'a.txt');
    row.querySelector('.lc-fa-row').click();
  });
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll('.lc-fa-item')].find((r) => r.querySelector('.lc-fa-path b') && r.querySelector('.lc-fa-path b').textContent === 'a.txt');
    return row.querySelectorAll('.lc-fa-op').length === 3;
  }, null, { timeout: 5000 });
  const s6c = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.lc-fa-item')].find((r) => r.querySelector('.lc-fa-path b') && r.querySelector('.lc-fa-path b').textContent === 'a.txt');
    return [...row.querySelectorAll('.lc-fa-op-time')].map((s) => s.textContent);
  });
  check('6c 展开行→3 个 op 行且含时间', s6c.length === 3 && s6c.every((x) => /^\d{2}:\d{2}:\d{2}$/.test(x)), JSON.stringify(s6c));
  await page.screenshot({ path: SHOT_DIR + '/w6_4_open.png' });

  // ── 场景7：回归（无 pageerror）──
  check('7a 无页面错误', pageErrors.length === 0, JSON.stringify(pageErrors));

  console.log('==== W6 verify: PASS=' + pass + ' FAIL=' + fail + ' ====');
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });