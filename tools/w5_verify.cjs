// w5_verify.cjs —— W5 复核修补本地交互验证（Playwright + mock 桥）
// 跑法：NODE_PATH=/usr/lib/node_modules/@playwright/mcp/node_modules node w5_verify.cjs
// 场景：1 事件卡 chips/筛选/新在前/空态 2 缓存命中 2 位小数 3 工具定义排序+×N 4 点柱详情压缩标记 5 读取失败提示
const { chromium } = require('playwright');
const fs = require('fs');
const PAGE = process.env.W5_PAGE || 'file:///tmp/dsh-ui-lab/exp1/dist/index.single.html';
const SHOT_DIR = '/sdcard/Download/Operit/_w5_shots';
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
    const now = Date.now();
    window.CtxProbe = {
      api: function (payload) {
        const req = JSON.parse(payload);
        const m = req.m;
        if (m === 'summary') return JSON.stringify({ ok: true, session: 'W5-TEST', current: { system: 100, tools: 50, user: 10, inject: 5, skill: 2, assistant: 20, tool: 3, total: 190 }, counts: { TOOL_CALL: 5 }, worldbook: { blocks: 0, chars: 0, entries: 0, names: [] }, historyCount: 12 });
        if (m === 'timeline') {
          const items = [];
          for (let i = 1; i <= 8; i++) {
            items.push({ seq: i, turn: i <= 4 ? 1 : 2, step: ((i - 1) % 4) + 1, t: now - (9 - i) * 60000, stage: 'send', system: 100, tools: 50, user: 10, inject: 5, skill: 2, assistant: 20, tool: 3, total: 190 + i * 10, historyCount: i <= 4 ? 100 : 30, historyChars: 5000, skip: 0 });
          }
          return JSON.stringify({ ok: true, items });
        }
        if (m === 'steps') return JSON.stringify({ ok: true, items: [] });
        if (m === 'messages') return JSON.stringify({ ok: true, items: [{ t: now - 120000, sentAt: now - 180000, input: 10000, output: 500, cached: 9568, waitMs: 1000, outMs: 2500, roleName: 'AI', model: 'deepseek-flash' }] });
        if (m === 'events') return JSON.stringify({ ok: true, items: [
          { kind: 'compaction', at: '2026-09-16T10:00:00', atMs: now - 300000, count: 5, from: 100, to: 30, savedChars: 5000 },
          { kind: 'model', at: '2026-09-16T10:30:00', atMs: now - 180000, from: 'a', to: 'b' },
          { kind: 'compaction', at: '2026-09-16T11:00:00', atMs: now - 60000, count: 12, from: 200, to: 20, savedChars: 9000 },
        ] });
        if (m === 'fileActivity') return JSON.stringify({ ok: true, entries: [], totals: { read: { files: 0, ops: 0 }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 }, added: 0, removed: 0 } });
        if (m === 'toolUsage') return JSON.stringify({ ok: true, items: [{ name: 'read_file', count: 9 }, { name: 'edit_file', count: 3 }, { name: 'list_files', count: 6 }] });
        if (m === 'todayMessages') return JSON.stringify({ ok: true, groups: [] });
        if (m === 'rawSection') {
          if (req.section === 'tools') return JSON.stringify({ ok: true, kind: 'list', total: 3, offset: 0, items: [
            { idx: 'tool:0', name: 'read_file', preview: '读取文件内容……', chars: 500 },
            { idx: 'tool:1', name: 'edit_file', preview: '编辑文件……', chars: 900 },
            { idx: 'tool:2', name: 'list_files', preview: '列出目录……', chars: 300 },
          ] });
          if (req.section === 'user') return JSON.stringify({ ok: true, kind: 'list', total: 1, offset: 0, items: [{ idx: 7, kind: 'USER', chars: 12, preview: '你好（mock）' }] });
          if (req.section === 'tool') return JSON.stringify({ ok: true, kind: 'list', total: 1, offset: 0, items: [{ idx: 100, kind: 'TOOL_RESULT', toolName: 'read_file', chars: 5000, preview: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXX' }] });
          return JSON.stringify({ ok: true, kind: 'list', total: 0, items: [] });
        }
        if (m === 'rawItem') {
          if (req.index === 7) return JSON.stringify({ ok: false, error: 'mock failure' });
          return JSON.stringify({ ok: true, kind: 'TOOL_RESULT', toolName: 'read_file', content: 'X'.repeat(5000) });
        }
        return JSON.stringify({ ok: true, items: [] });
      },
    };
  });
  await page.goto(PAGE);
  await page.waitForFunction(() => document.body.innerText.includes('上下文事件'), null, { timeout: 20000 });
  console.log('页面加载 OK');

  // ── 场景1：事件卡 chips / 计数 / 行内 kind chip / 筛选 / 空态 ──
  const s1 = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => {
      const t = c.querySelector('.lc-card-title-text');
      return t && t.textContent === '上下文事件';
    });
    const chips = [...card.querySelectorAll('.lc-kinds .lc-gran-btn')];
    return {
      n: chips.length,
      texts: chips.map((c) => c.innerText.replace(/\s+/g, '')),
      counts: chips.map((c) => { const k = c.querySelector('.lc-kind-n'); return k ? k.textContent : null; }),
      rows: [...card.querySelectorAll('.lc-kind')].map((k) => k.textContent),
    };
  });
  check('1a 事件chips=2（压缩/切换）', s1.n === 2 && s1.texts[0] === '压缩2' && s1.texts[1] === '切换1', JSON.stringify(s1.texts));
  check('1b 行内kind chip 新在前', JSON.stringify(s1.rows) === JSON.stringify(['压缩', '切换', '压缩']), JSON.stringify(s1.rows));
  await page.screenshot({ path: SHOT_DIR + '/w5_1_events.png' });
  await page.evaluate(() => { [...document.querySelectorAll('.lc-kinds .lc-gran-btn')].find((b) => b.innerText.includes('切换')).click(); });
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => {
      const t = c.querySelector('.lc-card-title-text');
      return t && t.textContent === '上下文事件';
    });
    return card.querySelectorAll('.lc-kind-compaction').length === 2 && card.querySelectorAll('.lc-kind-model').length === 0;
  }, null, { timeout: 5000 });
  check('1c 取消「切换」筛选→仅压缩2行', true);
  await page.evaluate(() => { [...document.querySelectorAll('.lc-kinds .lc-gran-btn')].find((b) => b.innerText.includes('压缩')).click(); });
  await page.waitForFunction(() => document.body.innerText.includes('暂无上下文事件'), null, { timeout: 5000 });
  check('1d 全取消→空态', true);
  await page.evaluate(() => { [...document.querySelectorAll('.lc-kinds .lc-gran-btn')].forEach((b) => b.click()); });
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => {
      const t = c.querySelector('.lc-card-title-text');
      return t && t.textContent === '上下文事件';
    });
    return card.querySelectorAll('.lc-kind-compaction').length === 2;
  }, null, { timeout: 5000 });
  check('1e 恢复全选', true);

  // ── 场景2：缓存命中 2 位小数 ──
  const s2 = await page.evaluate(() => {
    const label = [...document.querySelectorAll('.lc-card div')].find((d) => d.children.length === 0 && d.textContent === '缓存命中');
    const cell = label ? label.parentElement : null;
    return { val: cell ? cell.firstChild.textContent : null, statsHit: window.__hitProbe || null };
  });
  check('2a 缓存命中=95.68%（2位小数）', s2.val === '95.68%', String(s2.val));

  // ── 场景3：工具定义排序 + ×N ──
  await page.evaluate(() => { [...document.querySelectorAll('span')].filter((s) => s.textContent === '工具定义' && s.parentElement.tagName === 'DIV')[0].parentElement.click(); });
  await page.waitForFunction(() => [...document.querySelectorAll('.lc-gran-btn')].some((b) => b.textContent === '按大小'), null, { timeout: 8000 });
  const s3a = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => {
      const t = c.querySelector('.lc-card-title-text');
      return t && t.textContent === '上下文浏览器';
    });
    const names = [...card.querySelectorAll('b')].map((b) => b.textContent).filter((x) => x);
    const btns = [...card.querySelectorAll('.lc-gran-btn')].map((b) => ({ t: b.textContent, on: b.className.includes('lc-gran-on') }));
    const firstB = [...card.querySelectorAll('b')][0];
    const firstRowText = firstB ? firstB.parentElement.parentElement.textContent : null;
    return { names, btns: btns.map((x) => x.t + (x.on ? '*' : '')), firstRowText };
  });
  check('3a 工具条三按钮（默认按次数高亮）', JSON.stringify(s3a.btns) === JSON.stringify(['按大小', '按次数*', '按名称']), JSON.stringify(s3a.btns));
  check('3b count 序：read_file/9 > list_files/6 > edit_file/3', JSON.stringify(s3a.names) === JSON.stringify(['read_file', 'list_files', 'edit_file']), JSON.stringify(s3a.names));
  check('3c 行尾 ×N 显示', /×9/.test(s3a.firstRowText || ''), String(s3a.firstRowText));
  await page.screenshot({ path: SHOT_DIR + '/w5_2_tools.png' });
  await page.evaluate(() => { [...document.querySelectorAll('.lc-gran-btn')].find((b) => b.textContent === '按大小' && !b.closest('.lc-settings-body')).click(); });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('dsh-prefs-v1') || '{}').toolSort === 'size', null, { timeout: 5000 });
  check('3d 点「按大小」→localStorage toolSort=size', true);
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => {
      const t = c.querySelector('.lc-card-title-text');
      return t && t.textContent === '上下文浏览器';
    });
    const names = [...card.querySelectorAll('b')].map((b) => b.textContent).filter((x) => x);
    return names[0] === 'edit_file';
  }, null, { timeout: 5000 });
  const s3b = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.lc-card')].find((c) => {
      const t = c.querySelector('.lc-card-title-text');
      return t && t.textContent === '上下文浏览器';
    });
    return [...card.querySelectorAll('b')].map((b) => b.textContent).filter((x) => x);
  });
  check('3e size 序：edit_file/900 首行', JSON.stringify(s3b) === JSON.stringify(['edit_file', 'read_file', 'list_files']), JSON.stringify(s3b));

  // ── 场景4：点柱详情压缩标记 ──
  console.log('bars count:', await page.evaluate(() => document.querySelectorAll('.lc-bar').length));
  await page.evaluate(() => { const bars = document.querySelectorAll('.lc-bar'); if (bars.length > 1) bars[1].click(); });
  await page.waitForFunction(() => document.body.innerText.includes('✂压缩'), null, { timeout: 5000 });
  const s4 = await page.evaluate(() => { const m = document.body.innerText.match(/✂压缩 −\d+条/); return m ? m[0] : null; });
  check('4a 点第2柱→详情含「✂压缩 −70条」', s4 === '✂压缩 −70条', String(s4));
  await page.screenshot({ path: SHOT_DIR + '/w5_3_detail.png' });

  // ── 场景5：浏览器条目读取失败提示 ──
  await page.evaluate(() => { [...document.querySelectorAll('span')].filter((s) => s.textContent === '用户消息' && s.parentElement.tagName === 'DIV')[0].parentElement.click(); });
  await page.waitForFunction(() => document.body.innerText.includes('你好（mock）'), null, { timeout: 5000 });
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((d) => d.children.length === 0 && d.textContent === '你好（mock）');
    el.parentElement.click();
  });
  await page.waitForFunction(() => document.body.innerText.includes('读取失败 · 点击重试'), null, { timeout: 8000 });
  check('5a 读取失败提示（点击重试）', true);
  await page.screenshot({ path: SHOT_DIR + '/w5_4_fail.png' });

  // ── 场景6：长内容渐进展开（1200 预览 +「展开全部」）──
  await page.evaluate(() => { [...document.querySelectorAll('span')].filter((s) => s.textContent === '工具结果' && s.parentElement.tagName === 'DIV')[0].parentElement.click(); });
  await page.waitForFunction(() => /X{20}/.test(document.body.innerText), null, { timeout: 5000 });
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((d) => d.children.length === 0 && /X{20}/.test(d.textContent) && d.textContent.length < 200);
    el.parentElement.click();
  });
  await page.waitForFunction(() => { const t = document.body.innerText; return t.includes('展开全部') && t.includes('5000'); }, null, { timeout: 8000 });
  check('6a 长内容展开→1200预览+「展开全部」按钮', true);
  const s6 = await page.evaluate(() => {
    const pre = [...document.querySelectorAll('pre')].find((p) => /X{100}/.test(p.textContent));
    return pre ? { len: pre.textContent.length, tail: pre.textContent.slice(-40) } : null;
  });
  check('6b 预览长度≈1200+提示尾巴', !!s6 && s6.len <= 1400 && /数据未丢失/.test(s6.tail || ''), JSON.stringify(s6));
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.includes('展开全部')).click(); });
  await page.waitForFunction(() => document.body.innerText.includes('收起'), null, { timeout: 5000 });
  const s6c = await page.evaluate(() => {
    const pre = [...document.querySelectorAll('pre')].find((p) => /X{100}/.test(p.textContent));
    return pre ? pre.textContent.length : 0;
  });
  check('6c 展开全部→全文（≥4900）', s6c >= 4900, String(s6c));
  await page.screenshot({ path: SHOT_DIR + '/w5_5_expand.png' });

  console.log('==== W5 verify: PASS=' + pass + ' FAIL=' + fail + ' ====');
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(2); });