#!/usr/bin/env node
// fa_check.js —— 文件活动 v2 离线自检（W1 交付物；node 跑 prompt_viewer/raw_*.json 对照）
// 用法：node fa_check.js [index.ui.js 路径] [prompt_viewer 目录]
// 逻辑：从宿主桥 index.ui.js 提取 FILE_ACTIVITY_V2 纯函数段 → 对全库 raw 跑 fa2Compute
//      → 守恒断言 + 覆盖率报告 + 与纯 FIFO 配对的差异对比；有 problem 时退出码 1。
const fs = require('fs');
const IDX = process.argv[2] || '/sdcard/Download/Operit/dev_package/com.operit.prompt_viewer_ui_v2/dist/ui/dashboard/index.ui.js';
const PV = process.argv[3] || '/sdcard/Download/Operit/prompt_viewer/';
const BEGIN = '// ==== FILE_ACTIVITY_V2 BEGIN';
const END = '// ==== FILE_ACTIVITY_V2 END ====';
const src = fs.readFileSync(IDX, 'utf8');
const a = src.indexOf(BEGIN), b = src.indexOf(END);
if (a < 0 || b < 0) { console.error('SEG-NOT-FOUND in ' + IDX); process.exit(1); }
const seg = src.slice(a, b);
const api = new Function(seg + '\nreturn { fa2Compute: fa2Compute, fa2ParseCall: fa2ParseCall, fa2ParseResult: fa2ParseResult, fa2Pair: fa2Pair };')();

// 纯 FIFO 配对（对照组）：同名工具按出现顺序先到先配
function fifoMap(calls, results) {
  const byTool = {};
  for (const c of calls) (byTool[c.tool] || (byTool[c.tool] = [])).push(c);
  const map = {}, used = {};
  for (const r of results) {
    const cands = byTool[r.tool] || [];
    const pick = cands.find(c => !used[c.idx]);
    if (pick) { used[pick.idx] = 1; map[pick.idx] = r.idx; }
  }
  return map;
}

const files = fs.readdirSync(PV).filter(f => /^raw_.*\.json$/.test(f)).sort();
const sum = { files: 0, calls: 0, results: 0, paired: 0, hint: 0, win: 0, fifo: 0, unpairedC: 0, unpairedR: 0, ops: 0, entries: 0, readWin: 0, delta: 0, hits: 0, fifoDiff: 0 };
const problems = [];
for (const f of files) {
  let p;
  try { p = JSON.parse(fs.readFileSync(PV + f, 'utf8').replace(/\n/g, '')); } catch (e) { problems.push(f + ' PARSE-FAIL'); continue; }
  const hist = p.preparedHistory || [];
  const act = api.fa2Compute(hist);
  const s = act.stats;
  // 断言 1：配对守恒
  if (s.paired + s.unpairedResults !== s.results) problems.push(f + ' pair-mismatch ' + (s.paired + s.unpairedResults) + '!=' + s.results);
  // 断言 2：op 字段合格
  for (const en of act.entries) {
    if (!en.path) problems.push(f + ' empty-path');
    if (['image', 'dir', 'text'].indexOf(en.form) < 0) problems.push(f + ' bad-form:' + en.form);
    for (const op of en.ops) {
      if (['read', 'write', 'search'].indexOf(op.kind) < 0) problems.push(f + ' bad-kind:' + op.kind);
      if (typeof op.seq !== 'number' || typeof op.callIdx !== 'number' || typeof op.resultIdx !== 'number') problems.push(f + ' bad-anchor');
      if (op.read) sum.readWin++;
      if (op.added || op.removed) sum.delta++;
      if (op.hits) sum.hits++;
      sum.ops++;
    }
  }
  // 对照 2：与纯 FIFO 的配对差异
  const calls = [], results = [];
  for (let i = 0; i < hist.length; i++) {
    const k = String((hist[i] || {}).kind || '').toUpperCase();
    const c = String((hist[i] || {}).content || '');
    if (k === 'TOOL_CALL') { const pc = api.fa2ParseCall(c, i); if (pc) calls.push(pc); }
    else if (k === 'TOOL_RESULT') { const pr = api.fa2ParseResult(c, i); if (pr) results.push(pr); }
  }
  const m1 = {}, m2 = fifoMap(calls, results);
  const calls2 = [];
  for (let i = 0; i < hist.length; i++) {
    const k = String((hist[i] || {}).kind || '').toUpperCase();
    const c = String((hist[i] || {}).content || '');
    if (k === 'TOOL_CALL') { const pc = api.fa2ParseCall(c, i); if (pc) calls2.push(pc); }
  }
  const results2 = [];
  for (let i = 0; i < hist.length; i++) {
    const k = String((hist[i] || {}).kind || '').toUpperCase();
    const c = String((hist[i] || {}).content || '');
    if (k === 'TOOL_RESULT') { const pr = api.fa2ParseResult(c, i); if (pr) results2.push(pr); }
  }
  api.fa2Pair(calls2, results2);
  for (const c of calls2) if (c.result) m1[c.idx] = c.result.idx;
  for (const k in m1) if (m2[k] !== undefined && m2[k] !== m1[k]) sum.fifoDiff++;
  sum.files++; sum.calls += s.calls; sum.results += s.results; sum.paired += s.paired; sum.hint += s.hintMatched; sum.win += s.winMatched; sum.fifo += s.fifo; sum.unpairedC += s.unpairedCalls; sum.unpairedR += s.unpairedResults; sum.entries += act.entries.length;
}
const lines = [];
lines.push('== 文件活动 v2 自检报告 ==');
lines.push('文件: ' + sum.files + ' 份 raw | call ' + sum.calls + ' / result ' + sum.results);
lines.push('配对: ' + sum.paired + ' (hint ' + sum.hint + ' / win ' + sum.win + ' / fifo ' + sum.fifo + ') | 未配 result ' + sum.unpairedR + ' | 未 settle call ' + sum.unpairedC);
lines.push('产物: op ' + sum.ops + ' 条 / 文件条目 ' + sum.entries + ' | 窗口 ' + sum.readWin + ' · delta ' + sum.delta + ' · hits ' + sum.hits);
lines.push('对照: 与纯 FIFO 配对差异 ' + sum.fifoDiff + ' 条（内容线索纠正数）');
lines.push('问题: ' + (problems.length ? problems.slice(0, 40).join('\n  ') : '无'));
lines.push(problems.length ? 'RESULT: FAIL' : 'RESULT: PASS');
const report = lines.join('\n');
fs.writeFileSync('/tmp/fa_report.txt', report);
console.log(report);
process.exit(problems.length ? 1 : 0);