#!/usr/bin/env node
/**
 * W7① 步 brief 自检：从桥提取 W7_BRIEF 段 + fa2Unesc/fa2ToolTail（共用实现），
 * 对全库 raw_*.json 复算，验证：
 *   1) 每步 op/ins/res 下标均为合法 hist 下标；
 *   2) ins 条目 kind 全为 TOOL_RESULT；res 条目 kind ∈ {ASSISTANT, TOOL_CALL}；op 为 USER；
 *   3) 下标顺序严格递增；
 *   4) 输出统计（steps/opener 缺失/预览空率）。
 * 用法：node tools/w7_brief_check.cjs [index.ui.js] [prompt_viewer_dir]
 * PASS=退出码 0。
 */
const fs=require('fs'),path=require('path');
const BRIDGE=process.argv[2]||'/sdcard/Download/Operit/dev_package/com.operit.prompt_viewer_ui_v2/dist/ui/dashboard/index.ui.js';
const DIR=process.argv[3]||'/sdcard/Download/Operit/prompt_viewer';

const src=fs.readFileSync(BRIDGE,'utf8');
const a=src.indexOf('// ==== W7_BRIEF BEGIN');
const b=src.indexOf('// ==== W7_BRIEF END ====');
if(a<0||b<0){console.log('FAIL: W7_BRIEF 段未找到');process.exit(1);}
function grab(name){
  const i=src.indexOf('function '+name+'(');
  if(i<0) throw new Error('missing function '+name);
  let j=src.indexOf('{',i),depth=0,k=j;
  for(;k<src.length;k++){const ch=src[k];if(ch==='{')depth++;else if(ch==='}'){depth--;if(depth===0)break;}}
  return src.slice(i,k+1);
}
const code=[grab('fa2Unesc'),grab('fa2ToolTail'),src.slice(a,b)].join('\n');
const api=new Function(code+';return {w7BriefOf:w7BriefOf,w7PointIdxs:w7PointIdxs};')();

const files=fs.readdirSync(DIR).filter(f=>/^raw_.*\.json$/.test(f));
let fails=0,totalSteps=0,noOpener=0,insTotal=0,resTotal=0,emptyPreview=0,emptyTag=0;
const samples=[];
function bad(f,msg){fails++;if(samples.length<12)samples.push(f+': '+msg);}
function kindOf(h,i){return String((h[i]&&(h[i].kind||h[i].role))||'').toUpperCase();}

for(const f of files){
  let d;
  try{ d=JSON.parse(fs.readFileSync(path.join(DIR,f),'utf8').replace(/\n/g,'')); }
  catch(e){ bad(f,'PARSE '+e.message); continue; }
  const hist=Array.isArray(d.preparedHistory)?d.preparedHistory:[];
  const pIdxs=api.w7PointIdxs(hist);
  const briefs=api.w7BriefOf(hist,pIdxs);
  if(briefs.length!==pIdxs.length) bad(f,'len mismatch '+briefs.length+'/'+pIdxs.length);
  for(const br of briefs){
    totalSteps++;
    if(br.op){
      if(br.op[0]<0||br.op[0]>=hist.length) bad(f,'op idx oob '+br.op[0]);
      else if(kindOf(hist,br.op[0])!=='USER') bad(f,'op kind='+kindOf(hist,br.op[0])+' @'+br.op[0]);
      if(!br.op[1]) emptyPreview++;
    } else noOpener++;
    let last=-1;
    for(const e of br.ins){
      if(e[0]<0||e[0]>=hist.length) bad(f,'ins idx oob '+e[0]);
      else if(kindOf(hist,e[0])!=='TOOL_RESULT') bad(f,'ins kind='+kindOf(hist,e[0])+' @'+e[0]);
      if(e[0]<=last) bad(f,'ins order @'+e[0]);
      last=e[0];
      if(!e[2]) emptyPreview++;
    }
    last=-1;
    for(const e of br.res){
      const k=kindOf(hist,e[0]);
      if(k!=='ASSISTANT'&&k!=='TOOL_CALL') bad(f,'res kind='+k+' @'+e[0]);
      if(e[0]<=last) bad(f,'res order @'+e[0]);
      last=e[0];
      if(!e[2]) emptyPreview++;
      if(!e[1]) emptyTag++;
    }
    insTotal+=br.ins.length; resTotal+=br.res.length;
  }
}
// DEMO：挑一个含 ins+res 的步展示
let demo=null;
for(const f of files){
  try{
    const d=JSON.parse(fs.readFileSync(path.join(DIR,f),'utf8').replace(/\n/g,''));
    const h=d.preparedHistory||[];
    const bs=api.w7BriefOf(h,api.w7PointIdxs(h));
    const hit=bs.find(x=>x.ins.length&&x.res.length);
    if(hit){demo={f,br:hit};break;}
  }catch(e){}
}
console.log(JSON.stringify({files:files.length,steps:totalSteps,noOpener,insTotal,resTotal,emptyPreview,emptyTag,fails}));
if(demo) console.log('DEMO',demo.f,JSON.stringify(demo.br));
samples.forEach(s=>console.log('  -',s));
console.log(fails===0?'RESULT: PASS':'RESULT: FAIL ('+fails+')');
process.exit(fails===0?0:1);
