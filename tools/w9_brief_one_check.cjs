#!/usr/bin/env node
/**
 * W9① 步 brief 单步化对拍：旧全量（w7BriefOf） vs 新单步（w7BriefOne）。
 * 从旧桥（改造前版本，archive）提取 w7BriefOf 作参考；从新桥提取 w7BriefOne；
 * 对全库 raw_*.json 每步逐字节对比（JSON.stringify），并验证越界返回 null。
 * 用法：node tools/w9_brief_one_check.cjs [new_bridge] [old_bridge] [prompt_viewer_dir]
 * PASS=退出码 0。
 */
const fs = require('fs'), path = require('path');
const NEW = process.argv[2] || '/tmp/operit-repo-sync/toolpkg/dist/ui/dashboard/index.ui.js';
const OLD = process.argv[3] || '/sdcard/Download/Operit/projects/dsh-context-port/archive/w9_brief_ondemand_20260917/repo/toolpkg/dist/ui/dashboard/index.ui.js';
const DIR = process.argv[4] || '/sdcard/Download/Operit/prompt_viewer';

function grabFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('missing function ' + name);
  let j = src.indexOf('{', i), depth = 0, k = j;
  for (; k < src.length; k++) { const ch = src[k]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) break; } }
  return src.slice(i, k + 1);
}
function seg(src, aStr, bStr) {
  const a = src.indexOf(aStr), b = src.indexOf(bStr);
  if (a < 0 || b < 0) throw new Error('missing segment ' + aStr);
  return src.slice(a, b);
}
const newSrc = fs.readFileSync(NEW, 'utf8');
const oldSrc = fs.readFileSync(OLD, 'utf8');
const newApi = new Function([
  grabFn(newSrc, 'fa2Unesc'), grabFn(newSrc, 'fa2ToolTail'),
  seg(newSrc, '// ==== W7_BRIEF BEGIN', '// ==== W7_BRIEF END ===='),
  ';return { w7BriefOne: w7BriefOne, w7PointIdxs: w7PointIdxs };'
].join('\n'))();
const oldApi = new Function([
  grabFn(oldSrc, 'fa2Unesc'), grabFn(oldSrc, 'fa2ToolTail'),
  seg(oldSrc, '// ==== W7_BRIEF BEGIN', '// ==== W7_BRIEF END ===='),
  ';return { w7BriefOf: w7BriefOf, w7PointIdxs: w7PointIdxs };'
].join('\n'))();

const files = fs.readdirSync(DIR).filter(f => /^raw_.*\.json$/.test(f));
let filesN = 0, steps = 0, diffs = 0;
const samples = [];
for (const f of files) {
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\n/g, '')); }
  catch (e) { continue; }
  filesN++;
  const hist = Array.isArray(d.preparedHistory) ? d.preparedHistory : [];
  const pIdxOld = oldApi.w7PointIdxs(hist);
  const pIdxNew = newApi.w7PointIdxs(hist);
  if (JSON.stringify(pIdxOld) !== JSON.stringify(pIdxNew)) { diffs++; samples.push(f + ': pIdxs mismatch'); continue; }
  const ref = oldApi.w7BriefOf(hist, pIdxOld);
  for (let s = 0; s < pIdxNew.length; s++) {
    steps++;
    const one = newApi.w7BriefOne(hist, pIdxNew, s);
    if (JSON.stringify(one) !== JSON.stringify(ref[s])) {
      diffs++;
      if (samples.length < 10) samples.push(f + ' step#' + s + ' @' + pIdxNew[s] + '\n    one=' + JSON.stringify(one).slice(0, 200) + '\n    ref=' + JSON.stringify(ref[s]).slice(0, 200));
    }
  }
  if (newApi.w7BriefOne(hist, pIdxNew, -1) !== null) { diffs++; samples.push(f + ': s=-1 not null'); }
  if (newApi.w7BriefOne(hist, pIdxNew, pIdxNew.length) !== null) { diffs++; samples.push(f + ': s=len not null'); }
}
console.log(JSON.stringify({ files: filesN, steps, diffs }));
samples.forEach(s => console.log('  -', s));
console.log(diffs === 0 ? 'RESULT: PASS' : 'RESULT: FAIL (' + diffs + ')');
process.exit(diffs === 0 ? 0 : 1);
