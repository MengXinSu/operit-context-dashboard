#!/usr/bin/env node
// focus_check.js —— W3 定位联动离线自检（node 跑 prompt_viewer/raw_*.json 对照）
// 用法：node focus_check.js [index.ui.js 路径] [prompt_viewer 目录]
// 验证：① op 的 resultIdx / callIdx 是真实 hist 下标且 kind 对（resultIdx↔TOOL_RESULT、callIdx↔TOOL_CALL）
//      ② fa2FocusPage 对每个锚点都能给出含锚点的页（且 pos 落在页内）
//      ③ 不存在的锚点 → miss（不抛错）；④ 未传 focus → null（普通分页不受影响）
// 有 problem 时退出码 1。
const fs = require('fs');
const IDX = process.argv[2] || '/sdcard/Download/Operit/dev_package/com.operit.prompt_viewer_ui_v2/dist/ui/dashboard/index.ui.js';
const PV = process.argv[3] || '/sdcard/Download/Operit/prompt_viewer/';
const BEGIN = '// ==== FILE_ACTIVITY_V2 BEGIN';
const END = '// ==== FILE_ACTIVITY_V2 END ====';
const src = fs.readFileSync(IDX, 'utf8');
const a = src.indexOf(BEGIN), b = src.indexOf(END);
if (a < 0 || b < 0) { console.error('SEG-NOT-FOUND in ' + IDX); process.exit(1); }
const seg = src.slice(a, b);
const api = new Function(seg + '\nreturn { fa2Compute: fa2Compute, fa2FocusPage: fa2FocusPage };')();
const LIM = 30;

const files = fs.readdirSync(PV).filter(f => /^raw_.*\.json$/.test(f)).sort();
const sum = { files: 0, ops: 0, anchors: 0, pages: 0, miss: 0, nullOk: 0 };
const problems = [];
for (const f of files) {
  let p;
  try { p = JSON.parse(fs.readFileSync(PV + f, 'utf8').replace(/\n/g, '')); } catch (e) { problems.push(f + ' PARSE-FAIL'); continue; }
  const hist = p.preparedHistory || [];
  const act = api.fa2Compute(hist);
  // 复刻 apiRawSection 的 tool 分类拾取（TOOL_CALL / TOOL_RESULT，idx = hist 下标）
  const toolItems = [];
  for (let m = 0; m < hist.length; m++) {
    const k = String((hist[m] || {}).kind || '').toUpperCase();
    if (k === 'TOOL_CALL' || k === 'TOOL_RESULT') toolItems.push({ idx: m, kind: k });
  }
  const rev = toolItems.slice().reverse();
  const revIdxs = rev.map(x => x.idx);
  for (const en of act.entries) {
    for (const op of en.ops) {
      sum.ops++;
      const pairs = [['resultIdx', op.resultIdx, 'TOOL_RESULT'], ['callIdx', op.callIdx, 'TOOL_CALL']];
      for (const [name, anchor, wantKind] of pairs) {
        sum.anchors++;
        if (typeof anchor !== 'number' || anchor < 0 || anchor >= hist.length) {
          problems.push(f + ' anchor-range ' + name + '=' + anchor);
          continue;
        }
        const k = String((hist[anchor] || {}).kind || '').toUpperCase();
        if (k !== wantKind) problems.push(f + ' anchor-kind ' + name + '=' + anchor + ' got ' + k);
        const fr = api.fa2FocusPage(revIdxs, anchor, LIM);
        if (!fr || fr.miss) { problems.push(f + ' focus-miss anchor=' + anchor); continue; }
        const page = rev.slice(fr.offset, fr.offset + LIM);
        if (!page.some(x => x.idx === anchor)) problems.push(f + ' page-miss anchor=' + anchor);
        if (fr.pos < fr.offset || fr.pos >= fr.offset + LIM) problems.push(f + ' pos-out-of-page anchor=' + anchor);
        sum.pages++;
      }
    }
  }
  // ③ 不存在的锚点 → miss 而非异常
  sum.miss++;
  const frM = api.fa2FocusPage(revIdxs, hist.length + 999, LIM);
  if (!frM || !frM.miss) problems.push(f + ' expected-miss-failed');
  // ④ 未传 focus → null
  sum.nullOk++;
  const frN = api.fa2FocusPage(revIdxs, undefined, LIM);
  if (frN !== null) problems.push(f + ' no-focus-should-null');
  sum.files++;
}
const lines = [];
lines.push('== W3 定位联动自检报告 ==');
lines.push('文件: ' + sum.files + ' 份 raw | op ' + sum.ops + ' 条');
lines.push('锚点: ' + sum.anchors + ' 个（resultIdx+callIdx）| 命中页 ' + sum.pages + ' | 反例 miss ' + sum.miss + ' | 无 focus ' + sum.nullOk);
lines.push('问题: ' + (problems.length ? problems.slice(0, 40).join('\n  ') : '无'));
lines.push(problems.length ? 'RESULT: FAIL' : 'RESULT: PASS');
const report = lines.join('\n');
fs.writeFileSync('/tmp/focus_report.txt', report);
console.log(report);
process.exit(problems.length ? 1 : 0);