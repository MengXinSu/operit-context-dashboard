// holiday_verify.cjs —— 法定节假日计价验证：峰谷徽章 + 金额 + 今日花费（Playwright + mock 桥 + 固定时钟）
// 跑法：TZ=Asia/Shanghai NODE_PATH=/usr/lib/node_modules/@playwright/mcp/node_modules node holiday_verify.cjs [new_page] [old_page]
// 覆盖：① 假日时刻（10-05 11:00）徽章=谷（旧版=峰）② 节后工作日徽章=峰
//       ③ 会话金额：假日消息走谷价 + 工作日消息走峰价，新=¥18.00 / 旧=¥24.00（全额峰价）
//       ④ 今日花费=¥6.00（假日会话）⑤ 无页面错误；旧页面不存在时自动跳过对照。
const { chromium } = require('playwright');
const fs = require('fs');

const NEW_PAGE = process.argv[2] || process.env.NEW_PAGE || 'file:///tmp/dsh-ui-lab/exp1/dist/index.single.html';
const OLD_PAGE = process.argv[3] || process.env.OLD_PAGE || 'file:///sdcard/Download/Operit/projects/dsh-context-port/archive/holiday_20261005/index.single.old.html';

const T_HOL = Date.parse('2026-10-05T11:00:00+08:00');  // 国庆假日
const T_WORK = Date.parse('2026-10-08T11:00:00+08:00'); // 节后工作日
const CLOCK_HOL = '2026-10-05T11:00:00+08:00';
const CLOCK_WORK = '2026-10-08T11:00:00+08:00';

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log('PASS: ' + name + (extra ? ' | ' + extra : '')); }
  else { fail++; console.log('FAIL: ' + name + (extra ? ' | ' + extra : '')); }
}

function mockScript() {
  return (a) => {
    window.CtxProbe = {
      api: function (payload) {
        const req = JSON.parse(payload);
        const m = req.m;
        if (m === 'summary') return JSON.stringify({
          ok: true, session: 'HOL-TEST',
          current: { system: 100, tools: 50, user: 10, inject: 5, skill: 2, assistant: 20, tool: 3, total: 190 },
          counts: { TOOL_CALL: 5 },
          worldbook: { blocks: 0, chars: 0, entries: 0, names: [] },
          historyCount: 12,
        });
        if (m === 'timeline') return JSON.stringify({ ok: true, items: [] });
        if (m === 'steps') return JSON.stringify({ ok: true, items: [] });
        if (m === 'messages') return JSON.stringify({
          ok: true,
          items: [
            { t: a.tHol, sentAt: a.tHol, input: 2000000, output: 1000000, cached: 0, waitMs: 0, outMs: 0, roleName: 'AI', model: 'deepseek-flash' },
            { t: a.tWork, sentAt: a.tWork, input: 4000000, output: 2000000, cached: 0, waitMs: 0, outMs: 0, roleName: 'AI', model: 'deepseek-flash' },
          ],
        });
        if (m === 'todayMessages') return JSON.stringify({ ok: true, groups: [
          { session: { key: 'HOL-TEST', name: '假日会话' }, base: { input: 0, output: 0, cached: 0 }, items: [
            { t: a.tHol, sentAt: a.tHol, input: 2000000, output: 1000000, cached: 0, model: 'deepseek-flash' },
          ] },
        ] });
        if (m === 'events' || m === 'toolUsage') return JSON.stringify({ ok: true, items: [] });
        if (m === 'fileActivity') return JSON.stringify({ ok: true, entries: [], totals: { read: { files: 0, ops: 0 }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 }, added: 0, removed: 0 }, userIdx: [] });
        if (m === 'sessionUsage') return JSON.stringify({ ok: true, session: 'HOL-TEST', rows: 0, input: 0, output: 0, cached: 0, first: 0, last: 0 });
        if (m === 'rawSection') return JSON.stringify({ ok: true, kind: 'list', total: 0, offset: 0, items: [] });
        return JSON.stringify({ ok: true, items: [] });
      },
    };
  };
}

async function readCard(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[title*="本会话按模型价格表估算"]');
    if (!el) return null;
    const spans = Array.from(el.querySelectorAll('span')).map((s) => s.textContent);
    return { badge: spans[0] || '', cost: spans[1] || '' };
  });
}

async function open(browser, url, clockIso) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.clock.setFixedTime(new Date(clockIso));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.addInitScript(mockScript(), { tHol: T_HOL, tWork: T_WORK });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const el = document.querySelector('[title*="本会话按模型价格表估算"]');
    return el && Array.from(el.querySelectorAll('span')).some((s) => s.textContent.includes('¥'));
  }, null, { timeout: 20000 });
  return { ctx, page, errs };
}

(async () => {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1237/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });

  // ── ① 新版 @ 假日时刻：徽章=谷、会话金额=¥18.00、今日花费=¥6.00 ──
  {
    const { ctx, page, errs } = await open(browser, NEW_PAGE, CLOCK_HOL);
    const r = await readCard(page);
    console.log('[新版@假日] 读取:', JSON.stringify(r));
    check('新版徽章=谷（假日时刻）', r && r.badge === '谷', 'got=' + (r && r.badge));
    check('新版会话金额=¥18.00（假日谷价 6 + 工作日峰价 12）', r && r.cost === '¥18.00', 'got=' + (r && r.cost));
    // 展开价格面板 → 今日花费
    await page.click('[title*="本会话按模型价格表估算"]');
    await page.waitForTimeout(500);
    const todayTxt = await page.evaluate(() => {
      const el = [...document.querySelectorAll('span')].find((s) => s.textContent === '今日花费');
      return el ? el.parentElement.textContent : null;
    });
    console.log('[新版@假日] 今日花费文本:', JSON.stringify(todayTxt));
    check('新版今日花费=¥6.00（假日会话谷价）', !!todayTxt && todayTxt.includes('¥6.00'), todayTxt || 'null');
    check('新版@假日无页面错误', errs.length === 0, errs.slice(0, 2).join('; '));
    await ctx.close();
  }

  // ── ② 新版 @ 节后工作日：徽章=峰 ──
  {
    const { ctx, page, errs } = await open(browser, NEW_PAGE, CLOCK_WORK);
    const r = await readCard(page);
    console.log('[新版@工作日] 读取:', JSON.stringify(r));
    check('新版徽章=峰（节后工作日）', r && r.badge === '峰', 'got=' + (r && r.badge));
    check('新版@工作日无页面错误', errs.length === 0, errs.slice(0, 2).join('; '));
    await ctx.close();
  }

  // ── ③ 旧版对照 @ 假日时刻：徽章=峰、金额=¥24.00（展示修复必要性） ──
  const oldPathOnDisk = OLD_PAGE.replace('file://', '');
  if (!fs.existsSync(oldPathOnDisk)) {
    console.log('SKIP: 旧版对照页不存在，跳过（' + oldPathOnDisk + '）');
  } else {
    const { ctx, page } = await open(browser, OLD_PAGE, CLOCK_HOL);
    const r = await readCard(page);
    console.log('[旧版@假日] 读取:', JSON.stringify(r));
    check('旧版金额=¥24.00（对照：全额峰价）', r && r.cost === '¥24.00', 'got=' + (r && r.cost));
    await ctx.close();
  }

  await browser.close();
  console.log(`\n==== holiday_verify: PASS=${pass} FAIL=${fail} ====`);
  process.exit(fail ? 1 : 0);
})();