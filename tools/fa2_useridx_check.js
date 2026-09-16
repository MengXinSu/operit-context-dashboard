// w6_useridx_check.js —— 验证 fa2Compute 新增 userIdx 与 hist 中 USER 下标一致
const fs = require('fs');
const IDX = process.argv[2] || '/sdcard/Download/Operit/dev_package/com.operit.prompt_viewer_ui_v2/dist/ui/dashboard/index.ui.js';
const PV = process.argv[3] || '/sdcard/Download/Operit/prompt_viewer/';
const src = fs.readFileSync(IDX, 'utf8');
const a = src.indexOf('// ==== FILE_ACTIVITY_V2 BEGIN'), b = src.indexOf('// ==== FILE_ACTIVITY_V2 END ====');
if (a < 0 || b < 0) { console.error('SEG-NOT-FOUND'); process.exit(1); }
const seg = src.slice(a, b);
const api = new Function(seg + '\nreturn { fa2Compute: fa2Compute };')();
let fails = 0, files = 0, totalUsers = 0;
for (const f of fs.readdirSync(PV).filter(x => /^raw_.*\.json$/.test(x)).sort()) {
  let p; try { p = JSON.parse(fs.readFileSync(PV + f, 'utf8').replace(/\n/g, '')); } catch (e) { continue; }
  files++;
  const hist = p.preparedHistory || [];
  const act = api.fa2Compute(hist);
  const want = [];
  for (let i = 0; i < hist.length; i++) {
    if (String((hist[i] || {}).kind || '').toUpperCase() === 'USER') want.push(i);
  }
  const got = act.userIdx || [];
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    fails++;
    console.log('MISMATCH', f, 'want=' + want.length, 'got=' + got.length, JSON.stringify(want.slice(0, 6)), JSON.stringify(got.slice(0, 6)));
  } else {
    totalUsers += got.length;
  }
}
console.log('files=' + files + ' totalUserAnchors=' + totalUsers + ' fails=' + fails);
process.exit(fails ? 1 : 0);
