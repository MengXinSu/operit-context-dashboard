// w4_verify.cjs —— W4 设置卡本地交互验证（Playwright + mock 桥）
// 跑法：NODE_PATH=/usr/lib/node_modules/@playwright/mcp/node_modules node w4_verify.cjs
// 场景：0 存在/默认收起 1 展开+默认高亮 2 fileSort→文件卡联动 3 gran→趋势卡联动 4 刷新持久化 5 toolSort 落盘
const { chromium } = require('playwright');
const fs = require('fs');

const PAGE = process.env.W4_PAGE || 'file:///tmp/dsh-ui-lab/exp1/dist/index.single.html';
const SHOT_DIR = '/sdcard/Download/Operit/_w4_shots';
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

  await page.addInitScript(() => {
    window.CtxProbe = {
      api: function (payload) {
        const req = JSON.parse(payload);
        const m = req.m;
        if (m === 'fileActivity') return JSON.stringify({
          ok: true,
          entries: [
            { path: '/sdcard/test/a.md', form: 'text', reads: 1, writes: 0, searches: 0, added: 0, removed: 0, errs: 0, ops: [{ seq: 178, kind: 'read', tool: 'read_file', path: '/sdcard/test/a.md', added: 0, removed: 0, err: false, callIdx: 177, resultIdx: 178 }] },
            { path: '/sdcard/test/b.md', form: 'text', reads: 1, writes: 0, searches: 0, added: 0, removed: 0, errs: 0, ops: [{ seq: 119, kind: 'read', tool: 'read_file', path: '/sdcard/test/b.md', added: 0, removed: 0, err: false, callIdx: 118, resultIdx: 119 }] },
            { path: '/sdcard/test/c.md', form: 'text', reads: 1, writes: 0, searches: 0, added: 0, removed: 0, errs: 0, ops: [{ seq: 999999, kind: 'read', tool: 'read_file', path: '/sdcard/test/c.md', added: 0, removed: 0, err: false, callIdx: 999998, resultIdx: 999999 }] },
          ],
          totals: { read: { files: 3, ops: 3 }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 }, added: 0, removed: 0 },
        });
        if (m === 'summary') return JSON.stringify({ ok: true, session: 'W4-TEST', current: { system: 100, tools: 50, user: 10, inject: 5, skill: 2, assistant: 20, tool: 3, total: 190 }, counts: { TOOL_CALL: 3 }, worldbook: { blocks: 0, chars: 0, entries: 0, names: [] }, historyCount: 5 });
        if (m === 'rawSection') return JSON.stringify({ ok: true, kind: 'text', total: 0, chars: 0, content: '' });
        if (m === 'todayMessages') return JSON.stringify({ ok: true, groups: [] });
        return JSON.stringify({ ok: true, items: [] });
      },
    };
  });

  await page.goto(PAGE);
  await page.waitForFunction(() => document.body.innerText.includes('/sdcard/test/a.md'), null, { timeout: 20000 });
  console.log('页面加载 + 文件卡数据 OK');

  // ── 场景0：设置卡存在、默认收起、标题/描述 ──
  const s0 = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => c.querySelector('.lc-settings-head'));
    if (!card) return { found: false };
    return {
      found: true,
      open: !!card.querySelector('.lc-settings-body'),
      name: card.querySelector('.lc-settings-name').textContent,
      desc: card.querySelector('.lc-settings-desc').textContent,
    };
  });
  check('0a 设置卡存在', s0.found === true);
  check('0b 默认收起', s0.open === false);
  check('0c 标题/描述渲染', s0.name === '设置' && /默认偏好/.test(s0.desc || ''), JSON.stringify(s0));

  // ── 场景1：展开 → 四行 + 默认高亮 ──
  await page.evaluate(() => { document.querySelector('.lc-settings-head').click(); });
  await page.waitForFunction(() => !!document.querySelector('.lc-settings-body'));
  const rows = await page.evaluate(() => [...document.querySelectorAll('.lc-settings-row')].map((r) => ({
    label: r.querySelector('.lc-settings-label').textContent,
    on: [...r.querySelectorAll('.lc-gran-btn')].filter((b) => b.className.includes('lc-gran-on')).map((b) => b.textContent),
  })));
  check('1a 四行偏好齐全', rows.length === 4, rows.map((r) => r.label).join(' / '));
  check('1b 默认高亮 轮次/全量/按次数/按次数',
    !!(rows[0] && rows[0].on[0] === '轮次' && rows[1].on[0] === '全量' && rows[2].on[0] === '按次数' && rows[3].on[0] === '按次数'),
    JSON.stringify(rows.map((r) => r.on)));
  await page.screenshot({ path: SHOT_DIR + '/w4_1_settings_open.png' });

  // ── 场景2：fileSort → 按路径（localStorage + 设置卡 + 文件卡联动）──
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.lc-settings-row')].find((r) => r.innerText.includes('文件活动'));
    [...row.querySelectorAll('.lc-gran-btn')].find((b) => b.textContent === '按路径').click();
  });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('dsh-prefs-v1') || '{}').fileSort === 'path', null, { timeout: 5000 });
  check('2a localStorage fileSort=path', true);
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => c.querySelector('.lc-fa-sort'));
    const on = card && [...card.querySelectorAll('.lc-fa-sort .lc-gran-btn')].find((b) => b.className.includes('lc-gran-on'));
    return on && on.textContent === '按路径';
  }, null, { timeout: 5000 });
  const fa2 = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => c.querySelector('.lc-fa-sort'));
    const firstRow = card.querySelector('.lc-fa-row');
    return { first: firstRow ? firstRow.innerText.replace(/\n/g, ' ') : '' };
  });
  check('2b 文件卡排序高亮=按路径（联动）', true);
  check('2c 文件卡首行=a.md（路径序）', fa2.first.includes('a.md'), fa2.first);

  // ── 场景3：gran → 步骤（localStorage + 趋势卡按钮联动）──
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.lc-settings-row')].find((r) => r.innerText.includes('粒度'));
    [...row.querySelectorAll('.lc-gran-btn')].find((b) => b.textContent === '步骤').click();
  });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('dsh-prefs-v1') || '{}').granularity === 'step', null, { timeout: 5000 });
  check('3a localStorage granularity=step', true);
  const trBtns = await page.evaluate(() => [...document.querySelectorAll('.lc-gran-btn')]
    .filter((b) => !b.closest('.lc-settings-body') && (b.textContent === '步骤' || b.textContent === '轮次'))
    .map((b) => b.textContent));
  check('3b 趋势卡按钮显示=步骤', trBtns.includes('步骤'), JSON.stringify(trBtns));

  // ── 场景4：刷新持久化（fileSort=path / gran=step 默认值生效）──
  await page.reload();
  await page.waitForFunction(() => document.body.innerText.includes('/sdcard/test/a.md'), null, { timeout: 20000 });
  const s4 = await page.evaluate(() => {
    const first = document.querySelector('.lc-fa-row') ? document.querySelector('.lc-fa-row').innerText : '';
    const tr = [...document.querySelectorAll('.lc-gran-btn')]
      .filter((b) => !b.closest('.lc-settings-body') && (b.textContent === '步骤' || b.textContent === '轮次'))
      .map((b) => b.textContent);
    return { first, tr, openBody: !!document.querySelector('.lc-settings-body') };
  });
  check('4a 重载后文件卡默认排序=按路径（a.md 首行）', s4.first.includes('a.md'), s4.first);
  check('4b 重载后趋势卡按钮=步骤', s4.tr.includes('步骤'), JSON.stringify(s4.tr));
  check('4c 重载后设置卡回到收起', s4.openBody === false);

  // ── 场景5：toolSort → 按大小落盘（消费点 W5）──
  await page.evaluate(() => { document.querySelector('.lc-settings-head').click(); });
  await page.waitForFunction(() => !!document.querySelector('.lc-settings-body'));
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.lc-settings-row')].find((r) => r.innerText.includes('工具定义'));
    [...row.querySelectorAll('.lc-gran-btn')].find((b) => b.textContent === '按大小').click();
  });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('dsh-prefs-v1') || '{}').toolSort === 'size', null, { timeout: 5000 });
  check('5a localStorage toolSort=size（W5 消费）', true);
  await page.screenshot({ path: SHOT_DIR + '/w4_2_after.png' });

  console.log('==== W4 verify: PASS=' + pass + ' FAIL=' + fail + ' ====');
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(2); });
