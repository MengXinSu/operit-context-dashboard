#!/usr/bin/env node
// holiday_check.cjs —— 法定节假日计价单元自检（从 App.tsx 抽取纯函数直测）
// 用法：TZ=Asia/Shanghai node holiday_check.cjs [App.tsx 路径]
// 覆盖：节假日全天谷时（中秋/国庆/春节/劳动/元旦）、边界（左闭右开）、
//       节后恢复峰时、周末与调休、表外年份退化保底；退出码非 0 = FAIL。
const fs = require('fs');

const SRC = process.argv[2] || '/tmp/dsh-ui-lab/exp1/src/App.tsx';
const src = fs.readFileSync(SRC, 'utf8');

const start = src.indexOf('function inSpan');
const endMarker = 'return !cfg.peaks.some((sp) => inSpan(d, sp))';
const end = src.indexOf(endMarker, start);
if (start < 0 || end < 0) { console.error('EXTRACT FAILED：未找到 inSpan/isOffpeakAt 代码块'); process.exit(1); }
const endLine = src.indexOf('\n}', end) + 2;
let code = src.slice(start, endLine);
code = code.replace(/([a-zA-Z)]): (PriceSpan|Date|PriceConfig|ReadonlySet<string>|boolean|string)/g, '$1');

const prelude = `
const cfg = { peaks: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }], weekdaysOnly: true, models: {} };
`;
const epilogue = `return { isOffpeakAt: (d) => isOffpeakAt(cfg, d), HOLIDAYS };`;

const { isOffpeakAt, HOLIDAYS } = new Function(prelude + code + epilogue)();

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log('PASS: ' + name + (extra ? ' | ' + extra : '')); }
  else { fail++; console.log('FAIL: ' + name + (extra ? ' | ' + extra : '')); }
}

check('HOLIDAYS 表 33 天（2026 国务院安排）', HOLIDAYS.size === 33, 'size=' + HOLIDAYS.size);

const CASES = [
  ['国庆周一 11:00 → 谷（修复核心）', '2026-10-05T11:00:00+08:00', true],
  ['国庆周一 09:30 → 谷', '2026-10-05T09:30:00+08:00', true],
  ['国庆周一 15:00 → 谷', '2026-10-05T15:00:00+08:00', true],
  ['国庆周二 10:00 → 谷', '2026-10-06T10:00:00+08:00', true],
  ['国庆周三 14:30 → 谷', '2026-10-07T14:30:00+08:00', true],
  ['节后周四 10:00 → 峰（恢复）', '2026-10-08T10:00:00+08:00', false],
  ['节后周四 15:00 → 峰', '2026-10-08T15:00:00+08:00', false],
  ['节后周四 13:00 → 谷（午休）', '2026-10-08T13:00:00+08:00', true],
  ['节后周四 08:59 → 谷', '2026-10-08T08:59:00+08:00', true],
  ['节后周四 12:00 → 谷（右开）', '2026-10-08T12:00:00+08:00', true],
  ['节后周四 14:00 → 峰（左闭）', '2026-10-08T14:00:00+08:00', false],
  ['节后周四 18:00 → 谷（右开）', '2026-10-08T18:00:00+08:00', true],
  ['中秋周五 15:00 → 谷', '2026-09-25T15:00:00+08:00', true],
  ['中秋前周四 15:00 → 峰', '2026-09-24T15:00:00+08:00', false],
  ['中秋后周一 10:00 → 峰', '2026-09-28T10:00:00+08:00', false],
  ['国庆首日 09:00 → 谷', '2026-10-01T09:00:00+08:00', true],
  ['国庆前一日 10:00 → 峰', '2026-09-30T10:00:00+08:00', false],
  ['劳动节 10:00 → 谷', '2026-05-01T10:00:00+08:00', true],
  ['劳动节后 10:00 → 峰', '2026-05-06T10:00:00+08:00', false],
  ['春节内工作日 10:00 → 谷', '2026-02-18T10:00:00+08:00', true],
  ['普通周日 10:00 → 谷（周末）', '2026-10-11T10:00:00+08:00', true],
  ['调休上班周六 10:00 → 谷（周末规则）', '2026-10-10T10:00:00+08:00', true],
  ['普通周一 10:00 → 峰（对照）', '2026-10-12T10:00:00+08:00', false],
  ['元旦 10:00 → 谷', '2026-01-01T10:00:00+08:00', true],
  ['元旦假内 1-3 10:00 → 谷', '2026-01-03T10:00:00+08:00', true],
  ['表外年份（2027-01-04 周一）10:00 → 峰（退化保底）', '2027-01-04T10:00:00+08:00', false],
];

for (const [label, iso, expectOff] of CASES) {
  const got = isOffpeakAt(new Date(iso));
  check(label, got === expectOff, `expect=${expectOff ? '谷' : '峰'} got=${got ? '谷' : '峰'}`);
}

console.log(`\n==== holiday_check: PASS=${pass} FAIL=${fail} ====`);
process.exit(fail ? 1 : 0);