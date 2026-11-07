import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createIdentityMindStore,identityMindStatus,readMindPolicy,validateMindPolicy,MIND_DEFAULTS} from '../packages/dsh-social-bridge-plugin/identity-mind-store.mjs';

const account='a'.repeat(64),otherAccount='b'.repeat(64),friend='wechat:private:123',group='wechat:group:456',stranger='wechat:private:789';
const id=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'identity-mind-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let at=1794045600000,allow=new Set([friend,group]);
  const make=()=>createIdentityMindStore({root,account,allowed:key=>allow.has(key),now:()=>at}),store=make();
  return {root,store,make,file:path.join(root,'state/identity-mind',account+'.json'),advance(ms){at+=ms;},set allowed(value){allow=new Set(value);},get at(){return at;},reflect(result,reflectionId='r-1',extra={}){return store.applyReflection(result,{reflectionId,allowedKeys:[friend,group],...extra});}};
}
const plan=(conversationKey=friend,extra={})=>({title:'有空练一首歌',kind:'singing',conversationKey,detail:'先练习，不急着发送。',status:'pending',...extra});

test('settings use professional defaults and reject invalid or unknown values',t=>{
  const f=fixture(t);assert.deepEqual(readMindPolicy(f.root),MIND_DEFAULTS);
  fs.mkdirSync(path.join(f.root,'config'));fs.writeFileSync(path.join(f.root,'config/wechatagent.json'),JSON.stringify({wechat:{identityMind:{idleMinutes:30,dailyActionLimit:0}}}));
  assert.equal(readMindPolicy(f.root).idleMinutes,30);assert.equal(readMindPolicy(f.root).dailyActionLimit,0);
  for(const value of [null,[],{enabled:'yes'},{idleMinutes:4},{reflectionMinutes:0},{dailyActionLimit:21},{quietStart:'24:00'},{allowEveryone:true}])assert.throws(()=>validateMindPolicy(value));
  validateMindPolicy({enabled:false,idleEnabled:false,idleMinutes:1440,reflectionMinutes:1,dailyActionLimit:20,quietStart:'00:00',quietEnd:'00:00'});
});

test('cross-chat mood, thoughts, people and agreements survive restart without merging nicknames',t=>{
  const f=fixture(t);f.store.observe({key:friend,batchId:id(1),text:'叫我小鱼就好',people:[{personId:'wxid_a',name:'小鱼'}]});
  f.store.observe({key:group,batchId:id(2),text:'今晚一起聊音乐',people:[{personId:'wxid_b',name:'小鱼'}]});
  f.reflect({mood:{feeling:'轻松',reason:'刚和朋友聊了喜欢的歌',energy:.6,valence:.4},thoughts:[{text:'有空想练这首歌',sourceKey:friend}],relationships:[{personId:'wxid_a',sourceKey:friend,name:'小鱼',address:'小鱼',relationship:'聊音乐的朋友',agreements:['周末再聊歌曲']},{personId:'wxid_b',sourceKey:group,name:'小鱼',address:'鱼鱼',relationship:'群友'}],plans:[plan()]});
  const next=f.make(),saved=next.snapshot();assert.equal(saved.interactions,2);assert.equal(saved.relationships.length,2);assert.equal(saved.mood.feeling,'轻松');assert.equal(saved.plans.length,1);assert.equal(saved.thoughts.length,1);
  assert(next.context(group).includes('轻松'));assert(next.context(group).includes('wxid_a'));assert(next.context(group).includes('wxid_b'));assert(next.context(group).includes('不要无故向当前聊天泄露'));
  assert.equal(createIdentityMindStore({root:f.root,account:otherAccount}).snapshot().mood,null);
});

test('observations are bounded, deduplicated across restarts and do not disappear after reflection',t=>{
  const f=fixture(t);assert.equal(f.store.observe({key:friend,batchId:id(1),text:'你好'}),true);assert.equal(f.store.observe({key:friend,batchId:id(1),text:'重复'}),false);
  const revision=f.store.snapshot().revision;f.store.markReflection({id:'r-1',state:'running'});assert.equal(f.store.snapshot().revision,revision);
  f.reflect({reason:'安静回顾',actionPlanId:null});assert.equal(f.store.snapshot().events.length,1);assert.equal(f.make().observe({key:friend,batchId:id(1),text:'重启后重复'}),false);
});

test('stale reflection cannot overwrite a new interaction or explicit updated mood',t=>{
  const f=fixture(t);f.store.observe({key:friend,batchId:id(1),text:'你好'});const revision=f.store.snapshot().revision;
  f.store.observe({key:group,batchId:id(2),text:'新的经历'});
  assert.throws(()=>f.reflect({mood:{feeling:'低落',reason:'旧的反思'}},'old',{expectedRevision:revision}),/MIND_REVISION_CHANGED/);
  assert.equal(f.store.snapshot().events.length,2);assert.equal(f.store.snapshot().mood,null);
  f.store.remember({mood:{feeling:'平静',reason:'我想先听一听'},thought:{text:'想安静一会儿'}},{key:group,batchId:id(3)});
  assert.equal(f.store.snapshot().mood.feeling,'平静');assert.equal(f.make().snapshot().thoughts[0].sourceKey,group);
});

test('bad reflection is atomic and cannot invent targets, fields or a completed action',t=>{
  const f=fixture(t);f.reflect({mood:{feeling:'平静',reason:'没有特别变化'}});const before=f.store.snapshot();
  for(const result of [{mood:{feeling:'开心',reason:'聊天',override:true}},{thoughts:[{text:'跨权限',sourceKey:stranger}]},{relationships:[{personId:'wxid_c',sourceKey:stranger,name:'陌生人'}]},{plans:[plan(stranger)]},{plans:[plan(friend,{status:'running'})]},{actionPlanId:'missing'},{plans:[{id:'unknown',status:'abandoned'}]},{shell:'unsafe'}]){
    assert.throws(()=>f.reflect(result,'r-bad'));assert.deepEqual(f.store.snapshot(),before);
  }
  f.reflect({reason:'暂时保持安静',actionPlanId:null});assert.deepEqual(f.store.snapshot(),before);
});

test('plans can be postponed, revised or abandoned, and completed plans are terminal',t=>{
  const f=fixture(t);f.reflect({plans:[plan(friend,{notBefore:f.at+60000})]});const saved=f.store.snapshot().plans[0];
  assert.equal(f.store.claimPlan(saved.id),null);f.reflect({plans:[{id:saved.id,status:'postponed',notBefore:f.at+120000}]},'r-2');f.advance(120001);
  assert.equal(f.store.claimPlan(saved.id).status,'running');assert.equal(f.store.claimPlan(saved.id),null);
  f.store.finishPlan(saved.id,{state:'postponed',notBefore:f.at+5000,reason:'先休息一会'});assert.equal(f.store.claimPlan(saved.id),null);f.advance(5000);f.store.claimPlan(saved.id);
  f.store.finishPlan(saved.id,{state:'completed',reason:'本地练习已完成'});assert.throws(()=>f.reflect({plans:[{id:saved.id,status:'pending'}]},'r-3'),/MIND_PLAN_TERMINAL/);
  f.reflect({plans:[plan(group)]},'r-4');const second=f.store.snapshot().plans.at(-1);f.reflect({plans:[{id:second.id,status:'abandoned'}]},'r-5');assert.equal(f.store.claimPlan(second.id),null);
});

test('reflection and self-state tools cannot invent completed external work',t=>{
  const f=fixture(t);
  for(const kind of ['singing','drawing','moment']){
    assert.throws(()=>f.reflect({plans:[plan(friend,{kind,status:'completed'})]},'false-'+kind),/MIND_PLAN_EXECUTOR_REQUIRED/);
    assert.throws(()=>f.store.remember({plan:plan(friend,{kind,status:'completed'})},{key:friend,batchId:id(kind)}),/MIND_PLAN_EXECUTOR_REQUIRED/);
  }
  f.reflect({plans:[plan()]});const saved=f.store.snapshot().plans[0];assert.throws(()=>f.reflect({plans:[{id:saved.id,status:'completed'}]},'false-update'),/MIND_PLAN_EXECUTOR_REQUIRED/);
  f.store.claimPlan(saved.id);f.store.finishPlan(saved.id,{state:'completed',reason:'执行器确认实际作品完成'});assert.equal(f.make().snapshot().plans[0].status,'completed');
  f.reflect({plans:[plan(group,{kind:'reflect',status:'completed'})]},'quiet-review');assert.equal(f.store.snapshot().plans.at(-1).status,'completed');
});

test('claims persist before execution; crashes become unknown and submitted jobs never replay',t=>{
  const f=fixture(t);f.reflect({plans:[plan(friend,{delivery:'chat'})]});const first=f.store.snapshot().plans[0];f.store.claimPlan(first.id);
  assert.equal(JSON.parse(fs.readFileSync(f.file,'utf8')).plans[0].status,'running');
  assert.equal(identityMindStatus(f.root,account).plans[0].status,'running');assert.equal(JSON.parse(fs.readFileSync(f.file,'utf8')).plans[0].status,'running');
  const next=f.make();assert.equal(next.snapshot().plans[0].status,'unknown');assert.equal(next.claimPlan(first.id),null);assert.equal(next.status().actionsToday,1);
  next.applyReflection({plans:[plan(friend)]},{reflectionId:'next-job',allowedKeys:[friend]});const second=next.snapshot().plans.at(-1);next.claimPlan(second.id);next.finishPlan(second.id,{state:'submitted',reason:'已提交任务，成品见任务记录',jobId:'job_123'});
  const after=f.make();assert.equal(after.snapshot().plans.at(-1).status,'submitted');assert.equal(after.snapshot().plans.at(-1).jobId,'job_123');assert.equal(after.claimPlan(second.id),null);
});

test('read-only task reconciliation settles submitted jobs after restart without new claims or sends',t=>{
  const f=fixture(t);f.reflect({plans:[plan(friend,{delivery:'chat'})]});const saved=f.store.snapshot().plans[0];f.store.claimPlan(saved.id);f.store.finishPlan(saved.id,{state:'submitted',reason:'生成任务已提交',jobId:'job-existing'});
  const next=f.make(),before=next.snapshot();assert.equal(before.plans[0].status,'submitted');assert.equal(next.claimPlan(saved.id),null);f.advance(60000);
  const result=next.settleSubmittedPlan(saved.id,{state:'completed',reason:'只读任务接口确认作品生成完成，发送状态见任务记录',jobId:'job-existing'});
  assert.equal(result.status,'completed');assert.equal(result.finishedAt,f.at);assert.equal(result.jobId,'job-existing');assert.equal(next.snapshot().revision,before.revision+1);assert.deepEqual(next.snapshot().actions,before.actions);assert.equal(next.snapshot().lastActionAt,before.lastActionAt);assert.equal(next.claimPlan(saved.id),null);
  assert.equal(f.make().snapshot().plans[0].status,'completed');assert.throws(()=>next.settleSubmittedPlan(saved.id,{state:'completed',reason:'重复回执'}),/MIND_PLAN_NOT_SUBMITTED/);
});

test('submitted reconciliation records failure or uncertainty but never reopens another state',t=>{
  for(const state of ['failed','unknown']){
    const f=fixture(t);f.reflect({plans:[plan()]});const saved=f.store.snapshot().plans[0];
    assert.throws(()=>f.store.settleSubmittedPlan(saved.id,{state:'completed',reason:'尚未提交'}),/MIND_PLAN_NOT_SUBMITTED/);
    f.store.claimPlan(saved.id);assert.throws(()=>f.store.settleSubmittedPlan(saved.id,{state:'completed',reason:'仍在入场'}),/MIND_PLAN_NOT_SUBMITTED/);
    f.store.finishPlan(saved.id,{state:'submitted',reason:'等待既有任务',jobId:'real-job'});const before=f.store.snapshot();
    for(const args of [{state:'pending'},{state:'postponed'},{state:'running'},{state:'submitted'},{state:'completed',jobId:'foreign-job'},{state:'completed',reason:'bad',retry:true}])assert.throws(()=>f.store.settleSubmittedPlan(saved.id,args));
    assert.deepEqual(f.store.snapshot(),before);assert.equal(f.store.settleSubmittedPlan(saved.id,{state,reason:'既有任务的明确终态'}).status,state);
    assert.equal(f.store.claimPlan(saved.id),null);assert.throws(()=>f.store.settleSubmittedPlan(saved.id,{state:'completed',reason:'不能升级旧终态'}),/MIND_PLAN_NOT_SUBMITTED/);
    if(state==='unknown')assert.throws(()=>f.reflect({plans:[{id:saved.id,status:'pending'}]},'cannot-reopen-'+state),/MIND_PLAN_TERMINAL/);
  }
});

test('submitted reconciliation rechecks live permission and cannot be reached through model memory updates',t=>{
  const f=fixture(t);f.reflect({plans:[plan()]});const saved=f.store.snapshot().plans[0];f.store.claimPlan(saved.id);f.store.finishPlan(saved.id,{state:'submitted',jobId:'existing-job'});const before=f.store.snapshot();
  f.allowed=[group];assert.throws(()=>f.store.settleSubmittedPlan(saved.id,{state:'completed',reason:'撤销的会话'}),/MIND_NOT_ALLOWED/);assert.deepEqual(f.store.snapshot(),before);
  f.allowed=[friend,group];assert.throws(()=>f.store.remember({plan:{id:saved.id,status:'completed'}},{key:friend,batchId:id('fake-settle')}),/MIND_PLAN_EXECUTOR_REQUIRED/);
  assert.throws(()=>f.store.remember({settleSubmittedPlan:{id:saved.id,state:'completed'}},{key:friend,batchId:id('fake-method')}));assert.deepEqual(f.store.snapshot(),before);
  assert.equal(f.store.settleSubmittedPlan(saved.id,{state:'completed',reason:'权限恢复后读取既有任务终态'}).status,'completed');
});

test('only external singing, drawing or Moments claims count towards a Shanghai calendar-day quota',t=>{
  const f=fixture(t);f.reflect({plans:[plan(friend),plan(group,{kind:'drawing',delivery:'chat'}),plan(friend,{kind:'moment'}),plan(group,{kind:'reflect'})]});
  for(const row of f.store.snapshot().plans){f.store.claimPlan(row.id);f.store.finishPlan(row.id,{state:'completed'});}
  assert.equal(f.store.snapshot().actions.length,2);assert.equal(f.store.status().actionsToday,2);f.advance(86400000);assert.equal(f.store.status().actionsToday,0);
});

test('revoked chats are hidden and cannot mutate memory or start or finish an action',t=>{
  const f=fixture(t);f.reflect({thoughts:[{text:'私聊的想法',sourceKey:friend},{text:'群里的想法',sourceKey:group}],relationships:[{personId:'wxid_a',sourceKey:friend,name:'朋友'}],plans:[plan()]});const saved=f.store.snapshot().plans[0];f.store.claimPlan(saved.id);
  f.allowed=[group];assert.equal(f.store.context(friend),'');assert.equal(f.store.observe({key:friend,batchId:id(9),text:'已撤销'}),false);assert.equal(f.store.claimPlan(saved.id),null);
  assert.throws(()=>f.store.finishPlan(saved.id,{state:'completed'}),/MIND_NOT_ALLOWED/);assert.throws(()=>f.store.remember({thought:{text:'不能写'}},{key:friend,batchId:id(10)}),/MIND_NOT_ALLOWED/);
  assert.equal(f.store.status().plans.length,0);assert.equal(f.store.status().relationships.length,0);assert.equal(f.store.status().thoughts.length,1);
  const view=identityMindStatus(f.root,account,{allowed:key=>key===group});assert.equal(view.plans.length,0);assert.equal(view.thoughts.length,1);
});

test('invalid account, malformed persistent data and symlink paths fail closed without replacing data',t=>{
  const f=fixture(t),invalid=createIdentityMindStore({root:f.root,account:'../escape'});assert.equal(invalid.status().available,false);assert.equal(invalid.observe({key:friend,batchId:id(1)}),false);assert(!fs.existsSync(path.join(f.root,'state')));
  fs.mkdirSync(path.dirname(f.file),{recursive:true});fs.writeFileSync(f.file,'{"version":1,"invalid":true}');const bad=f.make();assert.equal(bad.status().error,'MIND_STATE_INVALID');assert.throws(()=>bad.remember({thought:{text:'不能覆盖坏文件'}},{key:friend,batchId:id(2)}),/MIND_STATE_INVALID/);assert.equal(fs.readFileSync(f.file,'utf8'),'{"version":1,"invalid":true}');
  assert.equal(identityMindStatus(f.root,account).available,false);
});

test('junctions or symlinks cannot redirect project mind writes',t=>{
  const f=fixture(t),target=path.join(f.root,'different-state');fs.mkdirSync(target);fs.mkdirSync(path.join(f.root,'state'));
  try{fs.symlinkSync(target,path.join(f.root,'state/identity-mind'),process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','ENOTSUP'].includes(error.code)){t.skip('host does not permit test links');return;}throw error;}
  const store=f.make();assert.equal(store.status().error,'MIND_PATH_INVALID');assert.equal(store.observe({key:friend,batchId:id(1)}),false);assert.equal(fs.readdirSync(target).length,0);
  assert.equal(identityMindStatus(f.root,account).error,'MIND_PATH_INVALID');
});

test('thoughts, observations and review metadata have durable bounds; repeated tool memory is idempotent',t=>{
  const f=fixture(t);for(let i=0;i<300;i++)f.store.observe({key:i%2?friend:group,batchId:id(i),text:'经历'+i});assert.equal(f.store.snapshot().events.length,48);assert.equal(f.store.snapshot().seen.length,256);assert.equal(f.store.snapshot().interactions,300);
  const args={thought:{text:'想画一幅晚霞'},plan:plan(friend,{kind:'drawing'})};f.store.remember(args,{key:friend,batchId:id('tool')});const count=f.store.snapshot().plans.length;f.store.remember(args,{key:friend,batchId:id('tool')});assert.equal(f.store.snapshot().plans.length,count);
  for(let i=0;i<55;i++)f.store.markReflection({id:'review-'+i,state:'completed',at:f.at+i,reason:'安静'});assert.equal(f.store.snapshot().reflections.length,48);assert.equal(f.store.status().lastReflection.id,'review-54');assert.equal(f.store.status().lastReflectionAt,f.at+54);
  assert.equal(f.make().observe({key:friend,batchId:id(299),text:'重复'}),false);
});

test('ordinary turn context stays bounded valid JSON while retaining all three kinds of memory',t=>{
  const f=fixture(t);f.reflect({mood:{feeling:'平静',reason:'聊了许多音乐话题'},thoughts:Array.from({length:20},(_,i)=>({text:'想法'+i+'字'.repeat(700),sourceKey:friend})),relationships:Array.from({length:50},(_,i)=>({personId:'person-'+i,sourceKey:i%2?friend:group,name:'朋友'+i,relationship:'关系'.repeat(200),agreements:['约定'.repeat(120),'约定'.repeat(120)]})),plans:Array.from({length:20},(_,i)=>plan(i%2?friend:group,{title:'计划'+i,detail:'具体准备'.repeat(350)}))});
  const context=f.store.context(friend);assert(context.length<6000);const parsed=JSON.parse(context.split('\n').slice(2).join('\n'));assert.equal(parsed.mood.feeling,'平静');assert(parsed.thoughts.length);assert(parsed.relationships.length);assert(parsed.plans.length);assert.equal(f.store.snapshot().relationships.length,50);assert.equal(f.store.snapshot().thoughts.length,20);
});
