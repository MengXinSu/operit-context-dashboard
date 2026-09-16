// w7d_verify.cjs —— W7④ 图片附件卡本地交互验证（Playwright + mock 桥）
// 跑法：NODE_PATH=/usr/lib/node_modules/@playwright/mcp/node_modules node tools/w7d_verify.cjs
// 场景：① 图片卡渲染（缩略图/文件名/尺寸/大小/≈token）② link 原样显示、前后文本保留
//       ③ 点击 → 灯箱（Esc / 蒙层 / 关闭钮）④ 失败降级（⚠ + 点击重试不弹灯箱）⑤ 无页面错误
const { chromium } = require('playwright');
const fs = require('fs');

const PAGE = process.env.W7D_PAGE || 'file:///tmp/dsh-ui-lab/exp1/dist/index.single.html';
const SHOT_DIR = '/sdcard/Download/Operit/_w7_shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS: ' + name + (extra ? ' | ' + extra : '')); }
  else { fail++; console.log('FAIL: ' + name + (extra ? ' | ' + extra : '')); }
}

const IMG_OK = '/tmp/operit-repo-sync/tools/fixtures/w7d_real.png';
const IMG_BAD = '/tmp/w7d_imgs/nope.png';

function mockScript() {
  return () => {
    const ITEMS = [
      { idx: 0, kind: 'USER', chars: 300, preview: '看图条目预览AAA <attachment id="/tmp/operit-repo-sync/tools/fixtures/w7d_real.png" filename="测试图.png" type="image/jpeg" size="12345">平台提示PLATFORMTIP勿显示</attachment>' },
      { idx: 1, kind: 'USER', chars: 130, preview: '坏图条目预览BBB <attachment id="/tmp/w7d_imgs/nope.png" filename="BADZZ' },
    ];
    const CONTENT_OK = '看这张图\n<link type=image id="test-uuid-1111">图片</link><attachment id="/tmp/operit-repo-sync/tools/fixtures/w7d_real.png" filename="测试图.png" type="image/jpeg" size="12345">平台提示PLATFORMTIP勿显示</attachment>\n后面还有文字hello';
    const CONTENT_BAD = '坏图在这里：<attachment id="/tmp/w7d_imgs/nope.png" filename="坏图.png" type="image/jpeg" size="999">坏图提示BARTIP勿显</attachment>完事';
    window.CtxProbe = {
      api: function (payload) {
        const req = JSON.parse(payload);
        const m = req.m;
        if (m === 'summary') return JSON.stringify({ ok: true, session: 'W7D-TEST', current: { system: 100, tools: 50, user: 10, inject: 0, skill: 0, assistant: 20, tool: 3, total: 183 }, counts: { TOOL_CALL: 2 }, worldbook: { blocks: 0, chars: 0, entries: 0, names: [] }, historyCount: 4 });
        if (m === 'timeline' || m === 'steps' || m === 'messages' || m === 'events' || m === 'toolUsage') return JSON.stringify({ ok: true, items: [] });
        if (m === 'todayMessages') return JSON.stringify({ ok: true, groups: [] });
        if (m === 'fileActivity') return JSON.stringify({ ok: true, entries: [], totals: { read: { files: 0, ops: 0 }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 }, added: 0, removed: 0 }, userIdx: [] });
        if (m === 'sessionUsage') return JSON.stringify({ ok: true, session: 'W7D-TEST', rows: 0, input: 0, output: 0, cached: 0, first: 0, last: 0 });
        if (m === 'rawSection') return JSON.stringify({ ok: true, kind: 'list', total: ITEMS.length, offset: 0, items: ITEMS });
        if (m === 'rawItem') {
          if (req.index === 0) return JSON.stringify({ ok: true, kind: 'USER', toolName: '', content: CONTENT_OK });
          return JSON.stringify({ ok: true, kind: 'USER', toolName: '', content: CONTENT_BAD });
        }
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
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('[pageerror]', e.message); });
  await page.addInitScript(mockScript());
  await page.goto(PAGE);
  await page.waitForSelector('text=上下文浏览器', { timeout: 20000 });

  // 进入「全部历史」分类
  await page.click('text="全部历史"');
  await page.waitForSelector('text=看图条目预览AAA', { timeout: 10000 });
  const pvText = await page.evaluate(() => document.body.innerText);
  check('1j 预览行：attachment 块折叠、内部提示与截断残段不出现', pvText.indexOf('［图片：测试图.png］') >= 0 && pvText.indexOf('［图片］') >= 0 && pvText.indexOf('PLATFORMTIP') < 0 && pvText.indexOf('BADZZ') < 0 && pvText.indexOf('看图条目预览AAA') >= 0, '');

  // 展开条目0（正常图）
  await page.click('text=看图条目预览AAA');
  await page.waitForSelector('.lc-att-item', { timeout: 10000 });
  await page.waitForTimeout(400);
  const s1 = await page.evaluate(() => {
    const card = document.querySelector('.lc-att-item');
    if (!card) return null;
    const img = card.querySelector('.lc-att-thumb img');
    return {
      text: card.innerText.replace(/\s+/g, ' '),
      hasImg: !!img,
      imgSrc: img ? img.getAttribute('src') : '',
      imgComplete: img ? img.complete : false,
      imgW: img ? img.naturalWidth : 0,
      bodyHasTag: document.body.innerText.indexOf('<attachment') >= 0,
    bodyClose: document.body.innerText.indexOf('</attachment>') >= 0,
    bodyTip: document.body.innerText.indexOf('PLATFORMTIP') >= 0,
    bodyHasLink: document.body.innerText.indexOf('<link') >= 0,
    bodyHasUuid: document.body.innerText.indexOf('test-uuid-1111') >= 0,
      bodyText: document.body.innerText.indexOf('后面还有文字hello') >= 0,
      bodyText2: document.body.innerText.indexOf('看这张图') >= 0,
      cards: document.querySelectorAll('.lc-att-item').length,
    };
  });
  check('1a 图片卡渲染（1 张）', !!s1 && s1.cards === 1, JSON.stringify(s1 && s1.cards));
  check('1b 缩略图 img 与 src', !!s1 && s1.hasImg && s1.imgSrc === 'file://' + IMG_OK, JSON.stringify(s1 && s1.imgSrc));
  check('1c 图片加载完成 naturalWidth=2', !!s1 && s1.imgComplete && s1.imgW === 2, JSON.stringify(s1 && s1.imgW));
  check('1d 文件名显示', !!s1 && s1.text.indexOf('测试图.png') >= 0, JSON.stringify(s1 && s1.text.slice(0, 120)));
  check('1e 尺寸 2×2 显示', !!s1 && s1.text.indexOf('2×2') >= 0, '');
  check('1f 大小 12.3 kB 显示', !!s1 && s1.text.indexOf('12.3 kB') >= 0, '');
  check('1g ≈token 行', !!s1 && s1.text.indexOf('≈') >= 0, JSON.stringify(s1 && s1.text));
  check('1h link 原样显示（不吞掉）；附件标签/闭合/内部提示不出现', !!s1 && !s1.bodyHasTag && !s1.bodyClose && !s1.bodyTip && s1.bodyHasLink && s1.bodyHasUuid, '');
  check('1i 前后文本保留', !!s1 && s1.bodyText && s1.bodyText2, '');

  // 灯箱三连：开→Esc；开→蒙层；开→关闭钮
  await page.click('.lc-att-item');
  await page.waitForSelector('.lc-att-lightbox', { timeout: 5000 });
  check('2a 点击开灯箱', true, '');
  await page.screenshot({ path: SHOT_DIR + '/w7d_lightbox.png' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('2b Esc 关闭燈箱', (await page.$('.lc-att-lightbox')) === null, '');
  await page.click('.lc-att-item');
  await page.waitForSelector('.lc-att-lightbox', { timeout: 5000 });
  await page.click('.lc-att-lightbox-mask', { position: { x: 10, y: 10 } });
  await page.waitForTimeout(200);
  check('2c 蒙层点击关闭', (await page.$('.lc-att-lightbox')) === null, '');
  await page.click('.lc-att-item');
  await page.waitForSelector('.lc-att-lightbox', { timeout: 5000 });
  await page.click('.lc-att-lightbox-close');
  await page.waitForTimeout(200);
  check('2d 关闭钮关闭', (await page.$('.lc-att-lightbox')) === null, '');

  // 坏图条目
  await page.click('text=坏图条目预览BBB');
  await page.waitForSelector('.lc-att-err', { timeout: 10000 });
  await page.waitForTimeout(400);
  const s2 = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.lc-att-item')];
    const card = cards[cards.length - 1];
    return { cards: cards.length, text: card ? card.innerText.replace(/\s+/g, ' ') : '', errCount: document.querySelectorAll('.lc-att-err').length, bodyBadTip: document.body.innerText.indexOf('BARTIP') >= 0 };
  });
  check('3a 两张卡共存', s2.cards === 2, JSON.stringify(s2.cards));
  check('3b 坏图 ⚠ 降级 + 文件名保留 + 内部提示吞掉', s2.errCount >= 1 && s2.text.indexOf('坏图.png') >= 0 && !s2.bodyBadTip, JSON.stringify(s2.text));

  await page.locator('.lc-att-item').nth(1).click();
  await page.waitForTimeout(600);
  check('3c 失败卡点击=重试不弹灯箱', (await page.$('.lc-att-lightbox')) === null, '');
  const errAgain = await page.evaluate(() => document.querySelectorAll('.lc-att-err').length >= 1);
  check('3d 重试后仍失败 ⚠ 保持', errAgain === true, '');

  await page.screenshot({ path: SHOT_DIR + '/w7d_final.png' });
  check('4a 无页面错误', pageErrors.length === 0, pageErrors.join('; '));

  await browser.close();
  console.log('RESULT: PASS=' + pass + ' FAIL=' + fail);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
