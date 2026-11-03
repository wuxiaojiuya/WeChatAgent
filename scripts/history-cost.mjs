import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {HistoryStore} from '../packages/dsh-social-bridge-plugin/history-store.mjs';
import {activeReaderAccount} from './reader-account-state.mjs';

export function usageReport(rows,{invoice=null}={}){
  const total={calls:rows.length,U:0,R:0,W:0,O:0,missingUsage:0},purposes={};
  for(const row of rows){const group=purposes[row.purpose]??={calls:0,U:0,R:0,W:0,O:0,missingUsage:0};group.calls++;
    if(['u','r','w','o'].some(k=>row[k]===null||row[k]===undefined)){total.missingUsage++;group.missingUsage++;continue;}
    for(const [name,key]of [['U','u'],['R','r'],['W','w'],['O','o']]){if(!Number.isSafeInteger(row[key])||row[key]<0)throw Error('COST_USAGE_INVALID');total[name]+=row[key];group[name]+=row[key];}
  }
  total.P=total.U+total.R+total.W;total.cacheReadRate=total.P?total.R/total.P:0;
  const money={verified:false,reason:'尚未导入可逐笔关联的真实账单；Token 用量不是金额。'};
  if(invoice){
    if(invoice.version!==1||typeof invoice.source!=='string'||!invoice.source.trim()||!['CNY','USD'].includes(invoice.currency)||!Array.isArray(invoice.rows))throw Error('COST_INVOICE_INVALID');
    const entries=new Map();for(const row of invoice.rows){if(typeof row.usageId!=='string'||entries.has(row.usageId)||!Number.isFinite(row.cost)||row.cost<0)throw Error('COST_INVOICE_INVALID');entries.set(row.usageId,row.cost);}
    const matched=rows.filter(r=>entries.has(r.id));Object.assign(money,{matched:matched.length,unmatched:rows.length-matched.length,currency:invoice.currency,source:invoice.source,matchedCost:matched.reduce((n,r)=>n+entries.get(r.id),0)});
    money.verified=rows.length>0&&matched.length===rows.length;money.reason=money.verified?'所有用量记录均已逐笔关联到账单；金额来自导入账单。':'账单匹配不完整，不能验证总费用。';
  }
  return {version:1,generatedAt:new Date().toISOString(),total,purposes,money,records:rows,notice:'U=未缓存输入，R=缓存读取，W=缓存写入，P=U+R+W；O 已包含供应商计入的推理输出。摘要、工具续跑和失败重试也必须计费。不同工作量或缓存冷热的时间段不能直接归因于此优化。'};
}
export function compareReports(before,after){
  const difference={calls:after.total.calls-before.total.calls,P:after.total.P-before.total.P,U:after.total.U-before.total.U,R:after.total.R-before.total.R,W:after.total.W-before.total.W,O:after.total.O-before.total.O};
  if(before.money.verified&&after.money.verified&&before.money.currency===after.money.currency)difference.money={currency:before.money.currency,before:before.money.matchedCost,after:after.money.matchedCost,saved:before.money.matchedCost-after.money.matchedCost};
  return {difference,attribution:'只有工作量、模型、单价及缓存条件可比时，差额才支持成本收益判断；这里不自动声称因果。'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,arg,index,all)=>arg.startsWith('--')?[...pairs,[arg.slice(2),all[index+1]]]:pairs,[]));
  if(!args.chat)throw Error('Usage: node scripts/history-cost.mjs --chat wechat:private:ID [--since ISO] [--until ISO] [--invoice invoice.json] [--compare baseline.json] [--out report.json]');
  const root=path.resolve(args.root??path.join(import.meta.dirname,'..')),account=activeReaderAccount(root),store=new HistoryStore(root,account.id||account.legacyId);
  try{
    const since=args.since?Date.parse(args.since):0,until=args.until?Date.parse(args.until):Date.now();if(!Number.isFinite(since)||!Number.isFinite(until)||since>until)throw Error('COST_WINDOW_INVALID');
    const report=usageReport(store.usageRows(args.chat).filter(row=>row.at>=since&&row.at<=until),{invoice:args.invoice?JSON.parse(fs.readFileSync(args.invoice,'utf8')):null});
    report.window={chat:args.chat,since,until};if(args.invoice)report.invoiceSha256=crypto.createHash('sha256').update(fs.readFileSync(args.invoice)).digest('hex');
    if(args.compare)report.comparison=compareReports(JSON.parse(fs.readFileSync(args.compare,'utf8')),report);
    const text=JSON.stringify(report,null,2)+'\n';if(args.out)fs.writeFileSync(path.resolve(args.out),text,{mode:0o600});else console.log(text);
  }finally{store.close();}
}
