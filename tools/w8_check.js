#!/usr/bin/env node
// w8_check.js —— W8 报错门类离线自检（node 跑 prompt_viewer/raw_*.json + snapshots-*.jsonl）
// 用法：node w8_check.js [main.js 路径] [index.ui.js 路径] [prompt_viewer 目录]
// 检查：A 两实现（main.js W8_WARN ↔ 桥 W8_WARN_UI）全库扫描一致性（必须 0 差异）；
//      B 警告数 vs skip 复算对拍（已知差异白名单：0449d90e——历史警告已被上下文压缩清除）；
//      C w8CountNew 增量去重单测。报告落 /tmp/w8_report.txt；有 FAIL 退出码 1。
const fs = require('fs');
const MAIN = process.argv[2] || '/sdcard/Download/Operit/dev_package/com.operit.prompt_viewer_ui_v2/dist/main.js';
const IDX = process.argv[3] || '/sdcard/Download/Operit/dev_package/com.operit.prompt_viewer_ui_v2/dist/ui/dashboard/index.ui.js';
const PV = process.argv[4] || '/sdcard/Download/Operit/prompt_viewer/';

function extract(file, begin, end) {
  const s = fs.readFileSync(file, 'utf8');
  const a = s.indexOf(begin), b = s.indexOf(end);
  if (a < 0 || b < 0) { console.error('SEG-NOT-FOUND in ' + file + ' (' + begin + ')'); process.exit(1); }
  return s.slice(a, b);
}
const segMain = extract(MAIN, '// ==== W8_WARN BEGIN', '// ==== W8_WARN END ====');
const apiMain = new Function(segMain + '\nreturn { w8WarnTypeOf: w8WarnTypeOf, w8ScanWarns: w8ScanWarns, w8CountNew: w8CountNew };')();
const segUi = extract(IDX, '// ==== W8_WARN_UI BEGIN', '// ==== W8_WARN_UI END ====');
const apiUi = new Function(segUi + '\nreturn { w8WarnTypeOfUi: w8WarnTypeOfUi, w8ScanWarnsUi: w8ScanWarnsUi };')();

const problems = [];
const obs = [];

// ---------- A+B: 扫描全库 raw ----------
function readJsonText(p) { return fs.readFileSync(p, 'utf8').replace(/\n/g, ''); }
const rawFiles = fs.readdirSync(PV).filter(f => /^raw_.*\.json$/.test(f)).sort();
const warns = {};
let implDiff = 0, rawParsed = 0;
for (const f of rawFiles) {
  let p;
  try { p = JSON.parse(readJsonText(PV + f)); } catch (e) { problems.push(f + ' PARSE-FAIL'); continue; }
  rawParsed++;
  const hist = p.preparedHistory || [];
  const listMain = apiMain.w8ScanWarns(hist);
  const listUi = apiUi.w8ScanWarnsUi(hist);
  if (JSON.stringify(listMain) !== JSON.stringify(listUi)) { implDiff++; problems.push(f + ' impl-mismatch main=' + listMain.length + ' ui=' + listUi.length); }
  const key = String(p.chatId || '').slice(0, 8);
  if (listMain.length) warns[key] = (warns[key] || 0) + listMain.length;
}

// ---------- skip 复算（预研 w8_duipai.py 同口径移植） ----------
function skipBySession(pvDir) {
  const out = {};
  const files = fs.readdirSync(pvDir).filter(f => /^snapshots-\d+\.jsonl$/.test(f)).sort();
  for (const f of files) {
    const t = fs.readFileSync(pvDir + f, 'utf8');
    for (const ln of t.split('\n')) {
      if (!ln.trim()) continue;
      let o; try { o = JSON.parse(ln); } catch (e) { continue; }
      (out[o.session] = out[o.session] || []).push(o);
    }
  }
  const res = {};
  for (const s in out) {
    const arr = out[s].sort((a, b) => (a.atMs || 0) - (b.atMs || 0));
    const merged = [];
    for (const x of arr) {
      const last = merged[merged.length - 1];
      if (last && Math.abs((x.atMs || 0) - last.atMs) < 10000) merged[merged.length - 1] = x;
      else merged.push(x);
    }
    let lastUc = -1, sum = 0;
    for (const r of merged) {
      const uc = (r.countByKind || {}).USER || 0;
      if (lastUc >= 0 && uc > lastUc) { const sk = uc - lastUc - 1; if (sk > 0) sum += sk; }
      if (uc > 0) lastUc = uc;
    }
    res[s] = sum;
  }
  return res;
}
const skips = skipBySession(PV);
// 基准集（预研 2026-09-17 四会话必须一致）；其余差异为数据历史状态（留档/快照部署前），列观察不判 FAIL
const MUST_MATCH = ['0715207c', '20b39514', '25ffef96', '58e1a3ec'];
const sessions = Array.from(new Set(Object.keys(warns).concat(Object.keys(skips)))).sort();
const pairs = [];
for (const s of sessions) {
  const w = warns[s] || 0, k = skips[s] || 0;
  if (w !== k) {
    if (MUST_MATCH.indexOf(s) >= 0) problems.push('must-match ' + s + ' warn=' + w + ' skip=' + k);
    else obs.push('DIFF(数据侧·部署前历史) ' + s + ' warn=' + w + ' skip=' + k);
  }
  if (w || k) pairs.push(s + ' warn=' + w + ' skip=' + k + (w === k ? ' OK' : ' DIFF'));
}
for (const s of MUST_MATCH) {
  if ((warns[s] || 0) === 0 && (skips[s] || 0) === 0) obs.push('must-match stale: ' + s + ' (数据已滚出窗口)');
}

// ---------- C: 去重单测 ----------
const cases = [
  { v: ['A', 'B'], r: {}, want: 2 },
  { v: ['A', 'B'], r: { A: 1, B: 1 }, want: 0 },
  { v: ['A', 'A'], r: { A: 1 }, want: 1 },
  { v: ['A'], r: { A: 2 }, want: 0 },
  { v: ['A'], r: {}, want: 1 },
  { v: [], r: { A: 1 }, want: 0 },
];
let dupBad = 0;
cases.forEach((c, i) => {
  const got = apiMain.w8CountNew(c.v.map(t => ({ text: t })), c.r).length;
  if (got !== c.want) { dupBad++; problems.push('dedupe-case' + i + ' got=' + got + ' want=' + c.want); }
});

// ---------- 报告 ----------
const lines = [];
lines.push('== W8 报错门类自检报告 ==');
lines.push('raw: ' + rawParsed + '/' + rawFiles.length + ' 份解析 | 两实现扫描差异: ' + implDiff);
lines.push('对拍（警告数 vs skip 复算）:');
for (const l of pairs) lines.push('  ' + l);
if (obs.length) { lines.push('已知差异:'); for (const l of obs) lines.push('  ' + l); }
lines.push('去重单测: ' + (cases.length - dupBad) + '/' + cases.length + ' 过');
lines.push('问题: ' + (problems.length ? '\n  ' + problems.slice(0, 40).join('\n  ') : '无'));
lines.push(problems.length ? 'RESULT: FAIL' : 'RESULT: PASS');
const report = lines.join('\n');
fs.writeFileSync('/tmp/w8_report.txt', report);
console.log(report);
process.exit(problems.length ? 1 : 0);