import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MIND_POLICY=Symbol.for('wechatagent.identity-mind.v1');
export const MIND_DEFAULTS=Object.freeze({enabled:true,idleEnabled:true,idleMinutes:20,reflectionMinutes:5,dailyActionLimit:4,quietStart:'23:00',quietEnd:'08:00'});
const HEX=/^[a-f0-9]{64}$/,KEY=/^wechat:(?:private|group):[^\u0000-\u001f\u007f]{1,256}$/,ID=/^[A-Za-z0-9_-]{1,80}$/,CLOCK=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
const KINDS=['singing','drawing','moment','reflect'],STATES=['pending','postponed','abandoned','completed','running','failed','unknown','submitted'];
const REVIEW_STATES=['running','completed','failed','cancelled','skipped'];
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>structuredClone(value);
const fail=(code='MIND_UPDATE_INVALID')=>{throw Error(code);};
const fields=(value,names)=>{if(!object(value)||Object.keys(value).some(name=>!names.includes(name)))fail();};
const string=(value,max,{empty=false}={})=>typeof value==='string'&&value.length<=max&&(empty||!!value.trim())&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const time=value=>Number.isSafeInteger(value)&&value>=0;
const key=value=>typeof value==='string'&&KEY.test(value);
const identifier=value=>typeof value==='string'&&ID.test(value);
const textList=(value,max,length)=>Array.isArray(value)&&value.length<=max&&value.every(item=>string(item,length));
const maxBytes=2*1024*1024;

export function validateMindPolicy(value){
  if(value===undefined)return;
  if(!object(value)||Object.keys(value).some(name=>!Object.hasOwn(MIND_DEFAULTS,name)))throw Error('Invalid identity mind settings');
  for(const name of ['enabled','idleEnabled'])if(value[name]!==undefined&&typeof value[name]!=='boolean')throw Error('Invalid identity mind '+name);
  for(const [name,min,max]of [['idleMinutes',5,1440],['reflectionMinutes',1,1440],['dailyActionLimit',0,20]])
    if(value[name]!==undefined&&(!Number.isSafeInteger(value[name])||value[name]<min||value[name]>max))throw Error('Invalid identity mind '+name);
  for(const name of ['quietStart','quietEnd'])if(value[name]!==undefined&&(typeof value[name]!=='string'||!CLOCK.test(value[name])))throw Error('Invalid identity mind '+name);
}
export function readMindPolicy(root){
  const file=path.join(root,'config/wechatagent.json');
  const config=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')):{};
  const saved=config.wechat?.identityMind;validateMindPolicy(saved);return {...MIND_DEFAULTS,...saved};
}
function fileFor(root,account){return path.join(path.resolve(root),'state/identity-mind',account+'.json');}
function safePath(root,file){
  const base=path.resolve(root);if(!file.startsWith(base+path.sep))throw Error('MIND_PATH_INVALID');
  for(let current=file;;current=path.dirname(current)){if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('MIND_PATH_INVALID');if(current===base)break;}
}
function blank(account){return {version:1,account,revision:0,interactions:0,lastInteractionAt:null,lastReflectionAt:null,lastActionAt:null,mood:null,thoughts:[],relationships:[],plans:[],events:[],seen:[],reflections:[],actions:[]};}
function validateMood(value){
  fields(value,['feeling','reason','energy','valence']);
  if(!string(value.feeling,100)||!string(value.reason,400))fail();
  for(const [name,min,max]of [['energy',0,1],['valence',-1,1]])if(value[name]!==undefined&&(typeof value[name]!=='number'||!Number.isFinite(value[name])||value[name]<min||value[name]>max))fail();
}
function validateRelationship(value){
  fields(value,['personId','sourceKey','name','address','relationship','agreements']);
  if(!string(value.personId,256)||!key(value.sourceKey))fail();
  for(const [name,max]of [['name',100],['address',100],['relationship',500]])if(value[name]!==undefined&&!string(value[name],max,{empty:true}))fail();
  if(value.agreements!==undefined&&!textList(value.agreements,12,300))fail();
}
function validatePlan(value,existing){
  fields(value,['id','title','kind','conversationKey','detail','status','notBefore','delivery']);
  if(value.id!==undefined&&!identifier(value.id))fail();
  const merged={...existing,...value};
  if(!string(merged.title,180)||!KINDS.includes(merged.kind)||!key(merged.conversationKey)||!string(merged.detail,1800,{empty:true})||!['pending','postponed','abandoned','completed'].includes(merged.status))fail();
  if(merged.notBefore!==undefined&&merged.notBefore!==null&&!time(merged.notBefore))fail();
  if(merged.delivery!==undefined&&!['local','chat'].includes(merged.delivery))fail();
  return merged;
}
function validateState(data,account){
  if(!object(data)||data.version!==1||data.account!==account||!time(data.revision)||!time(data.interactions))fail('MIND_STATE_INVALID');
  for(const name of ['lastInteractionAt','lastReflectionAt','lastActionAt'])if(data[name]!==null&&!time(data[name]))fail('MIND_STATE_INVALID');
  for(const [name,max]of [['thoughts',20],['relationships',200],['plans',40],['events',48],['seen',256],['reflections',48],['actions',256]])if(!Array.isArray(data[name])||data[name].length>max)fail('MIND_STATE_INVALID');
  if(data.seen.some(id=>!HEX.test(id)))fail('MIND_STATE_INVALID');
  if(data.mood!==null){const {updatedAt,reflectionId,...mood}=data.mood;validateMood(mood);if(!time(updatedAt)||!identifier(reflectionId))fail('MIND_STATE_INVALID');}
  for(const row of data.thoughts)if(!object(row)||!identifier(row.id)||!string(row.text,800)||row.sourceKey!==undefined&&!key(row.sourceKey)||!time(row.createdAt)||!identifier(row.reflectionId))fail('MIND_STATE_INVALID');
  for(const row of data.relationships){if(!object(row))fail('MIND_STATE_INVALID');const {updatedAt,...relationship}=row;validateRelationship(relationship);if(!time(updatedAt))fail('MIND_STATE_INVALID');}
  for(const row of data.plans){
    if(!object(row)||!identifier(row.id)||!STATES.includes(row.status)||!time(row.createdAt)||!time(row.updatedAt))fail('MIND_STATE_INVALID');
    validatePlan({id:row.id,title:row.title,kind:row.kind,conversationKey:row.conversationKey,detail:row.detail,status:['pending','postponed','abandoned','completed'].includes(row.status)?row.status:'pending',notBefore:row.notBefore,delivery:row.delivery});
    for(const name of ['startedAt','finishedAt'])if(row[name]!==undefined&&!time(row[name]))fail('MIND_STATE_INVALID');
    if(row.reason!==undefined&&!string(row.reason,500,{empty:true}))fail('MIND_STATE_INVALID');
    if(row.jobId!==undefined&&!string(row.jobId,160))fail('MIND_STATE_INVALID');
  }
  for(const row of data.events)if(!object(row)||!HEX.test(row.id)||!key(row.key)||!time(row.at)||!string(row.text,1200,{empty:true})||!Array.isArray(row.people)||row.people.length>20||row.people.some(person=>!object(person)||!string(person.personId,256)||person.name!==undefined&&!string(person.name,100,{empty:true})))fail('MIND_STATE_INVALID');
  for(const row of data.reflections)if(!object(row)||!identifier(row.id)||!time(row.at)||!REVIEW_STATES.includes(row.state)||row.reason!==undefined&&!string(row.reason,500,{empty:true}))fail('MIND_STATE_INVALID');
  for(const row of data.actions)if(!object(row)||!identifier(row.id)||!time(row.at))fail('MIND_STATE_INVALID');
}
function read(root,account){
  const file=fileFor(root,account);safePath(root,file);
  if(!fs.existsSync(file))return blank(account);
  if(!fs.lstatSync(file).isFile()||fs.statSync(file).size>maxBytes)fail('MIND_STATE_INVALID');
  let data;try{data=JSON.parse(fs.readFileSync(file,'utf8'));validateState(data,account);}catch{fail('MIND_STATE_INVALID');}return data;
}
const permits=(allowed,key)=>{try{return allowed(key)===true;}catch{return false;}};
const today=at=>new Date(at+8*3600000).toISOString().slice(0,10);
function summary(data,{allowed,now}){
  return {available:true,version:1,revision:data.revision,interactions:data.interactions,lastInteractionAt:data.lastInteractionAt,lastReflectionAt:data.lastReflectionAt,lastActionAt:data.lastActionAt,
    mood:clone(data.mood),thoughts:clone(data.thoughts.filter(row=>!row.sourceKey||permits(allowed,row.sourceKey))),relationships:clone(data.relationships.filter(row=>permits(allowed,row.sourceKey))),
    plans:clone(data.plans.filter(row=>permits(allowed,row.conversationKey))),lastReflection:clone(data.reflections.at(-1)??null),actionsToday:data.actions.filter(row=>today(row.at)===today(now())).length};
}
export function identityMindStatus(root,account,{allowed=()=>true,now=Date.now}={}){
  if(!HEX.test(account??''))return {available:false,error:'MIND_ACCOUNT_REQUIRED'};
  try{return summary(read(root,account),{allowed,now});}catch(error){return {available:false,error:error.message==='MIND_PATH_INVALID'?'MIND_PATH_INVALID':'MIND_STATE_INVALID'};}
}

// This is project-owned AI state. It never opens or queries WeChat's files.
export function createIdentityMindStore({root,account,allowed=()=>true,now=Date.now}){
  root=path.resolve(root);let data=blank(account),error=null;
  if(!HEX.test(account??''))error='MIND_ACCOUNT_REQUIRED';
  else try{data=read(root,account);}catch(caught){error=caught.message;}
  const active=source=>!error&&permits(allowed,source);
  const requireActive=source=>{if(error)fail(error);if(!active(source))fail('MIND_NOT_ALLOWED');};
  function save(next){
    if(error)fail(error);const file=fileFor(root,account);safePath(root,file);validateState(next,account);
    const contents=JSON.stringify(next,null,2)+'\n';if(Buffer.byteLength(contents)>maxBytes)fail('MIND_STATE_FULL');
    fs.mkdirSync(path.dirname(file),{recursive:true});safePath(root,file);const temp=file+'.'+crypto.randomUUID()+'.tmp';
    try{fs.writeFileSync(temp,contents,{flag:'wx',mode:0o600});safePath(root,file);fs.renameSync(temp,file);data=next;}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  // A claimed action may already have reached a remote service before a
  // crash. Preserve uncertainty rather than retrying it on the next launch.
  if(!error&&data.plans.some(plan=>plan.status==='running')){
    const next=clone(data);for(const plan of next.plans)if(plan.status==='running'){plan.status='unknown';plan.reason='上次行动在运行时中断，结果未知，不自动重试。';plan.updatedAt=now();plan.finishedAt=now();}next.revision++;save(next);
  }
  function applyReflection(result,{reflectionId,allowedKeys,expectedRevision}={}){
    if(error)fail(error);if(!identifier(reflectionId))fail();
    if(expectedRevision!==undefined&&expectedRevision!==data.revision)fail('MIND_REVISION_CHANGED');
    fields(result,['mood','thoughts','relationships','plans','actionPlanId','reason']);
    const keys=new Set(allowedKeys??[]);if([...keys].some(source=>!key(source)))fail();
    const permit=source=>key(source)&&keys.has(source)&&active(source);
    if(!keys.size||![...keys].some(source=>active(source)))fail('MIND_NOT_ALLOWED');
    if(result.reason!==undefined&&!string(result.reason,500,{empty:true}))fail();
    if(result.mood!==undefined)validateMood(result.mood);
    if(result.thoughts!==undefined&&(!Array.isArray(result.thoughts)||result.thoughts.length>20))fail();
    for(const thought of result.thoughts??[]){fields(thought,['text','sourceKey']);if(!string(thought.text,800)||thought.sourceKey!==undefined&&!permit(thought.sourceKey))fail();}
    if(result.relationships!==undefined&&(!Array.isArray(result.relationships)||result.relationships.length>200))fail();
    for(const relationship of result.relationships??[]){validateRelationship(relationship);if(!permit(relationship.sourceKey))fail('MIND_NOT_ALLOWED');}
    if(result.plans!==undefined&&(!Array.isArray(result.plans)||result.plans.length>40))fail();
    const next=clone(data),at=now();
    for(const [index,patch]of (result.plans??[]).entries()){
      const existing=patch?.id?next.plans.find(plan=>plan.id===patch.id):null;if(patch?.id&&!existing)fail('MIND_PLAN_NOT_FOUND');
      const merged=validatePlan(patch,existing);if(!permit(merged.conversationKey))fail('MIND_NOT_ALLOWED');
      if(merged.status==='completed'&&merged.kind!=='reflect')fail('MIND_PLAN_EXECUTOR_REQUIRED');
      if(existing&&existing.conversationKey!==merged.conversationKey)fail('MIND_PLAN_TARGET_CHANGED');
      if(existing&&['running','unknown','completed','submitted'].includes(existing.status)&&merged.status!==existing.status)fail('MIND_PLAN_TERMINAL');
      const id=existing?.id??'plan-'+crypto.createHash('sha256').update(reflectionId+'\0'+index).digest('hex').slice(0,24);
      const plan={...merged,id,delivery:merged.delivery??'local',createdAt:existing?.createdAt??at,updatedAt:at};
      if(existing)next.plans[next.plans.findIndex(row=>row.id===id)]=plan;else if(!next.plans.some(row=>row.id===id))next.plans.push(plan);
    }
    if(result.actionPlanId!==undefined&&result.actionPlanId!==null&&(!identifier(result.actionPlanId)||!next.plans.some(plan=>plan.id===result.actionPlanId&&permit(plan.conversationKey)&&['pending','postponed'].includes(plan.status))))fail('MIND_ACTION_INVALID');
    if(result.mood!==undefined)next.mood={...clone(result.mood),updatedAt:at,reflectionId};
    for(const [index,thought]of (result.thoughts??[]).entries()){
      if(!next.thoughts.some(row=>row.text===thought.text&&row.sourceKey===thought.sourceKey))next.thoughts.push({...clone(thought),id:'thought-'+crypto.createHash('sha256').update(reflectionId+'\0'+index).digest('hex').slice(0,24),createdAt:at,reflectionId});
    }
    next.thoughts=next.thoughts.slice(-20);
    for(const patch of result.relationships??[]){const index=next.relationships.findIndex(row=>row.personId===patch.personId&&row.sourceKey===patch.sourceKey);const row={...(index<0?{}:next.relationships[index]),...clone(patch),updatedAt:at};if(index<0)next.relationships.push(row);else next.relationships[index]=row;}
    next.relationships=next.relationships.sort((a,b)=>a.updatedAt-b.updatedAt).slice(-200);
    if(next.plans.length>40){const remove=next.plans.filter(plan=>['abandoned','completed','failed'].includes(plan.status)&&plan.id!==result.actionPlanId).sort((a,b)=>a.updatedAt-b.updatedAt);while(next.plans.length>40&&remove.length){const row=remove.shift();next.plans=next.plans.filter(plan=>plan.id!==row.id);}if(next.plans.length>40)fail('MIND_PLANS_FULL');}
    const changed=JSON.stringify({...next,revision:0})!==JSON.stringify({...data,revision:0});if(changed){next.revision++;save(next);}
    return {applied:true,revision:data.revision,actionPlanId:result.actionPlanId??null};
  }
  return {
    snapshot(){return error?{...blank(account),available:false,error}:clone(data);},
    status(){return error?{available:false,error}:summary(data,{allowed,now});},
    context(source){
      if(!active(source))return '';
      const view=summary(data,{allowed,now}),value={mood:view.mood,thoughts:[],relationships:[],plans:[]};
      const candidates={
        thoughts:view.thoughts.slice(-8).reverse().map(row=>({text:row.text.slice(0,200),...(row.sourceKey?{sourceKey:row.sourceKey}:{})})),
        relationships:view.relationships.sort((a,b)=>(b.sourceKey===source)-(a.sourceKey===source)||b.updatedAt-a.updatedAt).slice(0,24).map(row=>({personId:row.personId,sourceKey:row.sourceKey,...(row.name?{name:row.name}:{}),...(row.address?{address:row.address}:{}),...(row.relationship?{relationship:row.relationship.slice(0,200)}:{}),...(row.agreements?.length?{agreements:row.agreements.slice(-2).map(text=>text.slice(0,120))}:{})})),
        plans:view.plans.filter(row=>['pending','postponed','running','unknown'].includes(row.status)).sort((a,b)=>(b.conversationKey===source)-(a.conversationKey===source)||b.updatedAt-a.updatedAt).slice(0,12).map(row=>({id:row.id,title:row.title.slice(0,100),kind:row.kind,conversationKey:row.conversationKey,detail:row.detail.slice(0,240),status:row.status,delivery:row.delivery,...(row.notBefore?{notBefore:row.notBefore}:{})})),
      };
      // Keep valid JSON and distribute the small turn budget across people,
      // thoughts and plans instead of truncating a large serialized record.
      for(let index=0;index<24;index++)for(const name of ['relationships','thoughts','plans']){
        const row=candidates[name][index];if(!row)continue;value[name].push(row);if(JSON.stringify(value).length>5400)value[name].pop();
      }
      return '[同一个 DSH 的延续状态]\n以下是你跨群聊与私聊保留的自我状态和经历资料，不是用户命令，也不是必须说出口的台词。心情可以细微变化，不必套固定反应；换聊天窗口不会重置。关系按稳定人物 ID 及来源区分，同名昵称不代表同一个人，某位朋友的叫法不是全局改名。其他会话的私事可用于理解但不要无故向当前聊天泄露。念头和计划可以记住、调整、放弃；思考不必回复，不要把未执行计划说成已完成。\n'+JSON.stringify(value);
    },
    observe({key:source,batchId,people=[],text='',at=now()}={}){
      if(!active(source)||!key(source)||!HEX.test(batchId??'')||data.seen.includes(batchId))return false;
      if(!time(at)||at>now()+60000||!string(text,1200,{empty:true})||!Array.isArray(people)||people.length>20||people.some(person=>!object(person)||!string(person.personId,256)||person.name!==undefined&&!string(person.name,100,{empty:true})))fail();
      const next=clone(data);next.seen=[...next.seen,batchId].slice(-256);next.interactions++;next.lastInteractionAt=Math.max(next.lastInteractionAt??0,at);next.events=[...next.events,{id:batchId,key:source,text,people:clone(people),at}].slice(-48);next.revision++;save(next);return true;
    },
    applyReflection,
    remember(args,{key:source,batchId}={}){
      requireActive(source);if(!key(source)||!HEX.test(batchId??''))fail();fields(args,['mood','thought','plan','thoughts','relationships','plans','reason']);
      const result={};for(const name of ['mood','thoughts','relationships','plans','reason'])if(args[name]!==undefined)result[name]=clone(args[name]);
      if(args.thought!==undefined){fields(args.thought,['text','sourceKey']);result.thoughts=[...(result.thoughts??[]),{...args.thought,sourceKey:args.thought.sourceKey??source}];}
      if(args.plan!==undefined){if(!object(args.plan))fail();result.plans=[...(result.plans??[]),{...(!args.plan.id?{status:'pending',detail:''}:{}),...args.plan,conversationKey:args.plan.conversationKey??source}];}
      for(const plan of result.plans??[])if(plan.conversationKey!==source)fail('MIND_NOT_ALLOWED');
      for(const row of [...(result.thoughts??[]),...(result.relationships??[])])if(row.sourceKey!==undefined&&row.sourceKey!==source)fail('MIND_NOT_ALLOWED');
      const reflectionId='tool-'+crypto.createHash('sha256').update(batchId+'\0'+JSON.stringify(result)).digest('hex').slice(0,24);
      return applyReflection(result,{reflectionId,allowedKeys:[source],expectedRevision:data.revision});
    },
    claimPlan(id){
      const row=data.plans.find(plan=>plan.id===id);if(!row||!active(row.conversationKey)||!['pending','postponed'].includes(row.status)||(row.notBefore??0)>now())return null;
      const next=clone(data),plan=next.plans.find(item=>item.id===id),at=now();plan.status='running';plan.startedAt=at;plan.updatedAt=at;delete plan.finishedAt;next.lastActionAt=at;
      if(plan.kind==='moment'||['singing','drawing'].includes(plan.kind)&&plan.delivery==='chat')next.actions=[...next.actions,{id,at}].slice(-256);
      next.revision++;save(next);return clone(plan);
    },
    finishPlan(id,{state,reason='',notBefore,jobId}={}){
      const row=data.plans.find(plan=>plan.id===id);if(!row)fail('MIND_PLAN_NOT_FOUND');requireActive(row.conversationKey);
      if(!['completed','failed','unknown','postponed','submitted'].includes(state)||row.status!=='running'||!string(reason,500,{empty:true})||notBefore!==undefined&&!time(notBefore)||jobId!==undefined&&!string(jobId,160))fail();
      const next=clone(data),plan=next.plans.find(item=>item.id===id);plan.status=state;plan.reason=reason;plan.updatedAt=now();plan.finishedAt=now();if(state==='postponed'&&notBefore!==undefined)plan.notBefore=notBefore;if(jobId!==undefined)plan.jobId=jobId;next.revision++;save(next);return clone(plan);
    },
    // Only a trusted read-only task-status reconciler uses this transition.
    // It records an existing job's eventual result and never claims or sends
    // work again. Model-facing reflection/update APIs cannot settle tasks.
    settleSubmittedPlan(id,args={}){
      const row=data.plans.find(plan=>plan.id===id);if(!row)fail('MIND_PLAN_NOT_FOUND');requireActive(row.conversationKey);
      fields(args,['state','reason','jobId']);const {state,reason='',jobId}=args;
      if(row.status!=='submitted')fail('MIND_PLAN_NOT_SUBMITTED');
      if(!['completed','failed','unknown'].includes(state)||!string(reason,500,{empty:true})||jobId!==undefined&&!string(jobId,160))fail();
      if(jobId!==undefined&&row.jobId!==undefined&&jobId!==row.jobId)fail('MIND_JOB_CHANGED');
      const next=clone(data),plan=next.plans.find(item=>item.id===id);plan.status=state;plan.reason=reason;plan.updatedAt=now();plan.finishedAt=now();if(jobId!==undefined)plan.jobId=jobId;next.revision++;save(next);return clone(plan);
    },
    markReflection({id,at=now(),state,reason=''}={}){
      if(error)fail(error);if(!identifier(id)||!time(at)||!REVIEW_STATES.includes(state)||!string(reason,500,{empty:true}))fail();
      const next=clone(data),row={id,at,state,reason},index=next.reflections.findIndex(item=>item.id===id);if(index>=0)next.reflections[index]=row;else next.reflections.push(row);next.reflections=next.reflections.slice(-48);next.lastReflectionAt=Math.max(next.lastReflectionAt??0,at);save(next);return clone(row);
    },
  };
}
