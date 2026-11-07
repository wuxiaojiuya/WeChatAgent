import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {activeConnection} from './hook-connection-state.mjs';
import {allowedConversation,conversationWorkMode} from '../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
import {personaError} from '../public/console/persona-files.mjs';
import {selectRoleText} from '../components/qq-bridge/src/role-card.js';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
export const parsePersonaDecision=text=>typeof text==='string'?/^(同意|拒绝)人格\s+([a-f0-9]{12})$/i.exec(text.trim()):null;
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);};

// All mutations run synchronously in the console process, alongside config saves.
export function createPersonaApprovals({root,configFor,saveConfig,now=Date.now,accountFor=()=>activeConnection(root).id}) {
  const directory=path.join(root,'state/persona-approvals');
  const fileFor=id=>{if(!/^[a-f0-9]{12}$/.test(id))fail('人格审批编号无效。',400);return path.join(directory,id+'.json');};
  const save=p=>write(fileFor(p.id),p);
  const all=()=>fs.existsSync(directory)?fs.readdirSync(directory).filter(n=>/^[a-f0-9]{12}\.json$/.test(n)).map(n=>read(path.join(directory,n))):[];
  function base(config,key) {
    const name=config.persona.chats?.[key]??config.persona.default;
    if(personaError(name,'校验'))fail('当前人格名称无效。');
    const raw=fs.readFileSync(path.join(root,'roles',name+'.md'),'utf8');
    return {name,revision:hash(raw),binding:config.persona.chats?.[key]??null,workMode:conversationWorkMode(config.wechat,key)};
  }
  function refresh(p,config) {
    if(p.state==='applying'&&p.account===accountFor()){
      const file=path.join(root,'roles',p.target+'.md');
      p.state=config.persona.chats?.[p.key]===p.target&&fs.existsSync(file)&&hash(fs.readFileSync(file,'utf8'))===hash(p.content)?(p.autonomous?'applied':'approved'):'failed';save(p);
    }
    if(p.state==='pending'){p.state='superseded';save(p);}
    return p;
  }
  function reviewContext({conversationKey:key,accountScope}) {
    const config=configFor(),account=accountFor();
    if(!account||accountScope!==account||!allowedConversation(config.wechat,key))fail('当前账号或聊天未就绪。',403);
    const currentBase=base(config,key);
    const content=fs.readFileSync(path.join(root,'roles',currentBase.name+'.md'),'utf8');
    return {base:currentBase,content,effectiveContent:selectRoleText(content,'v2'),pending:null,mode:'autonomous'};
  }
  function propose(body) {
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['conversationKey','content','reason','accountScope','expectedBase'].includes(key)))fail('人格更新参数无效。',400);
    const {conversationKey:key,content,reason,accountScope,expectedBase}=body;
    const config=configFor(),account=accountFor();
    if(!account||accountScope!==account||!allowedConversation(config.wechat,key))fail('当前账号或聊天未就绪。',403);
    const currentBase=base(config,key);
    if(!expectedBase||JSON.stringify(expectedBase)!==JSON.stringify(currentBase))fail('回顾期间人格设置已改变，请重新读取当前人格。');
    validateCard(content,reason);
    const id=crypto.randomBytes(6).toString('hex'),target='AI人格-'+id;
    const p={id,account,key,content,reason,base:currentBase,recipients:[],state:'applying',createdAt:now(),target,acknowledged:{},autonomous:true};
    const original=fs.readFileSync(path.join(root,'roles',currentBase.name+'.md'),'utf8');
    write(path.join(root,'state/persona-backups',account,id+'.md'),original);save(p);
    const targetFile=path.join(root,'roles',target+'.md');
    if(fs.existsSync(targetFile))fail('人格文件发生冲突，请重新生成。');
    try{
      write(targetFile,content);
      const next=structuredClone(config);next.persona.chats??={};next.persona.chats[key]=target;
      const mode=next.wechat.modeSettings?.[key]?.[currentBase.workMode];if(mode?.settings)mode.settings.persona=target;
      saveConfig(next);p.state='applied';p.appliedAt=now();save(p);
      // Historical approval requests are retained for audit, but must not
      // notify administrators after autonomous updates are enabled.
      for(const old of all().filter(row=>row.account===account&&row.key===key&&row.state==='pending')){old.state='superseded';save(old);}
    }catch(error){
      if(configFor().persona.chats?.[key]===target){p.state='applied';save(p);}
      else{p.state='failed';save(p);throw error;}
    }
    return {...publicProposal(p),message:'人格已自主更新，下一轮对话生效。原卡与备份保留，其他会话及工具权限不变。',notification:'可按自己的意愿在当前对话简短说明改动；无需申请同意，也未自动发送管理员私聊。'};
  }
  function validateCard(content,reason){
    const error=personaError('AI人格',content);
    if(error||typeof reason!=='string'||!reason.trim()||reason.length>200||content.length>6000||!selectRoleText(content,'v2').trim())fail(error||'人格卡最多 6,000 字，修改理由为 1–200 字。',400);
  }
  function applyDefault(body){
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['content','reason','accountScope','expectedBase'].includes(key)))fail('默认人格更新参数无效。',400);
    const {content,reason,accountScope,expectedBase}=body;
    const config=configFor(),account=accountFor();
    if(!account||accountScope!==account)fail('当前账号未就绪。',403);
    const name=config.persona.default;if(personaError(name,'校验'))fail('当前默认人格名称无效。');
    const file=path.join(root,'roles',name+'.md'),original=fs.readFileSync(file,'utf8');
    if(!expectedBase||expectedBase.name!==name||expectedBase.revision!==hash(original))fail('默认人格已经改变，未覆盖手动修改。');
    validateCard(content,reason);
    const id=crypto.randomBytes(6).toString('hex');
    write(path.join(root,'state/persona-backups',account,id+'.md'),original);
    write(file,content);
    const p={id,account,key:null,content,reason,base:expectedBase,recipients:[],state:'applied',createdAt:now(),target:name,appliedAt:now(),acknowledged:{},autonomous:true};save(p);
    return {...publicProposal(p),message:'默认人格已由 AI 重新生成，原卡已备份。'};
  }
  const publicProposal=p=>({id:p.id,conversationKey:p.key,state:p.state,reason:p.reason,content:p.content,createdAt:p.createdAt,expiresAt:p.expiresAt,personaName:p.target??null,autonomous:p.autonomous===true});
  function list(){const config=configFor();return all().filter(p=>p.account===accountFor()).map(p=>publicProposal(refresh(p,config))).sort((a,b)=>b.createdAt-a.createdAt);}
  function notifications(){list();return [];}
  function acknowledge(){return {ok:true};}
  function decide(message,accountScope){
    if(!parsePersonaDecision(message?.text))fail('人格指令无效。',400);
    if(!accountScope||accountScope!==accountFor())fail('微信账号已切换。',403);
    return {state:'superseded',message:'人格已改为 AI 自主更新，不再需要审批。可在人格页面查看成长记录或手工编辑。'};
  }
  return {propose,list,notifications,acknowledge,decide,reviewContext,applyDefault};
}
