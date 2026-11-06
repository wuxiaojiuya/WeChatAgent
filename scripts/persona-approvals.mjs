import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {activeReaderAccount} from './reader-account-state.mjs';
import {administratorFriend,privateChatId} from './chat-administrators.mjs';
import {allowedConversation,conversationWorkMode} from '../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
import {assistantSenderAllowed,verifiedAssistantSender} from '../packages/dsh-social-bridge-plugin/assistant-policy.mjs';
import {personaError} from '../public/console/persona-files.mjs';
import {selectRoleText} from '../components/qq-bridge/src/role-card.js';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
export const parsePersonaDecision=text=>typeof text==='string'?/^(同意|拒绝)人格\s+([a-f0-9]{12})$/i.exec(text.trim()):null;
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);};

// All mutations run synchronously in the console process, alongside config saves.
export function createPersonaApprovals({root,configFor,saveConfig,now=Date.now,accountFor=()=>activeReaderAccount(root).id}) {
  const directory=path.join(root,'state/persona-approvals');
  const fileFor=id=>{if(!/^[a-f0-9]{12}$/.test(id))fail('人格审批编号无效。',400);return path.join(directory,id+'.json');};
  const load=id=>{const file=fileFor(id);if(!fs.existsSync(file))fail('没有找到这条人格提案。',404);return read(file);};
  const save=p=>write(fileFor(p.id),p);
  const all=()=>fs.existsSync(directory)?fs.readdirSync(directory).filter(n=>/^[a-f0-9]{12}\.json$/.test(n)).map(n=>read(path.join(directory,n))):[];
  const admins=config=>{
    const io=path.join(root,'state/wechat-io-config.json'),self=fs.existsSync(io)?read(io).self_wxid:'';
    return (config.wechat.assistant?.administrators??[]).filter(wxid=>wxid!==self&&administratorFriend(wxid)&&assistantSenderAllowed(config.wechat,'wechat:private:'+privateChatId(wxid),wxid));
  };
  function base(config,key) {
    const name=config.persona.chats?.[key]??config.persona.default;
    if(personaError(name,'校验'))fail('当前人格名称无效。');
    const raw=fs.readFileSync(path.join(root,'roles',name+'.md'),'utf8');
    return {name,revision:hash(raw),binding:config.persona.chats?.[key]??null,workMode:conversationWorkMode(config.wechat,key)};
  }
  function current(p,config) {
    if(p.account!==accountFor()||!accountFor()||!allowedConversation(config.wechat,p.key))return false;
    try{return JSON.stringify(p.base)===JSON.stringify(base(config,p.key));}catch{return false;}
  }
  function refresh(p,config) {
    if(p.state==='applying'&&p.account===accountFor()){
      const file=path.join(root,'roles',p.target+'.md');
      p.state=config.persona.chats?.[p.key]===p.target&&fs.existsSync(file)&&hash(fs.readFileSync(file,'utf8'))===hash(p.content)?'approved':'failed';save(p);
    }
    if(p.state==='pending'&&(p.expiresAt<=now()||!current(p,config)||!p.recipients.some(wxid=>admins(config).includes(wxid)))) {
      p.state=p.expiresAt<=now()?'expired':'conflict';save(p);
    }
    return p;
  }
  function reviewContext({conversationKey:key,accountScope}) {
    const config=configFor(),account=accountFor();
    if(!account||accountScope!==account||!allowedConversation(config.wechat,key))fail('当前账号或聊天未就绪。',403);
    if(!admins(config).length)fail('请先添加一位好友为管理员，并保存到聊天范围。',400);
    const currentBase=base(config,key);
    const pending=all().filter(p=>p.account===account&&p.key===key).map(p=>refresh(p,config)).find(p=>p.state==='pending');
    const content=fs.readFileSync(path.join(root,'roles',currentBase.name+'.md'),'utf8');
    return {base:currentBase,content,effectiveContent:selectRoleText(content,'v2'),pending:pending?publicProposal(pending):null};
  }
  function propose({conversationKey:key,content,reason,accountScope,expectedBase}) {
    const config=configFor(),recipients=admins(config),account=accountFor();
    if(!account||accountScope!==account||!allowedConversation(config.wechat,key))fail('当前账号或聊天未就绪。',403);
    if(!recipients.length)fail('请先添加一位好友为管理员，并保存到聊天范围。',400);
    if(expectedBase!==undefined&&JSON.stringify(expectedBase)!==JSON.stringify(base(config,key)))fail('回顾期间人格设置已改变，请重新回顾。');
    const error=personaError('AI人格',content);
    if(error||typeof reason!=='string'||!reason.trim()||reason.length>200||content.length>6000||!selectRoleText(content,'v2').trim())fail(error||'人格草案最多 6,000 字，修改理由为 1–200 字。',400);
    for(const p of all().filter(p=>p.account===account&&p.key===key)) {
      refresh(p,config);
      if(p.state==='pending') {
        if(p.content===content&&p.reason===reason)return publicProposal(p);
        fail('此会话已有待审批人格，请等待管理员处理。');
      }
    }
    const p={id:crypto.randomBytes(6).toString('hex'),account,key,content,reason,base:base(config,key),recipients,state:'pending',createdAt:now(),expiresAt:now()+86400000,acknowledged:{}};
    save(p);return publicProposal(p);
  }
  const publicProposal=p=>({id:p.id,conversationKey:p.key,state:p.state,reason:p.reason,content:p.content,createdAt:p.createdAt,expiresAt:p.expiresAt,personaName:p.target??null});
  function list(){const config=configFor();return all().filter(p=>p.account===accountFor()).map(p=>publicProposal(refresh(p,config))).sort((a,b)=>b.createdAt-a.createdAt);}
  function notifications() {
    const config=configFor(),result=[];
    for(const p of all().filter(p=>p.account===accountFor())) {
      if(refresh(p,config).state!=='pending')continue;
      const body=`【AI 人格修改申请 ${p.id}】\n会话：${p.key}\n原人格：${p.base.name}\n理由（AI 提议）：${p.reason}\n\n以下是待审批的人格全文，仅为草案：\n${p.content}`;
      const chunks=Array.from(body).reduce((a,c)=>{if(a.at(-1).length>=1100)a.push('');a[a.length-1]+=c;return a;},['']);
      for(const wxid of p.recipients.filter(wxid=>admins(config).includes(wxid))) {
        const count=chunks.length+1;
        const texts=[...chunks,`【人格审批 ${p.id}】草案已展示完毕。仅影响申请会话，不改变其他聊天或工具权限。24 小时内回复以下完整指令：\n同意人格 ${p.id}\n或：拒绝人格 ${p.id}`];
        texts.forEach((text,index)=>{const id=hash(`persona-${p.account}-${p.id}-${wxid}-${index}`);if(!p.acknowledged[id])result.push({id,proposalId:p.id,wxid,target:privateChatId(wxid),index,count,text:`[${index+1}/${count}] ${text}`});});
      }
    }
    return result;
  }
  function acknowledge(id) {
    const notice=notifications().find(n=>n.id===id);if(!notice)return {ok:true};
    const p=load(notice.proposalId);p.acknowledged[id]=now();save(p);return {ok:true};
  }
  function decide(message,accountScope) {
    const command=parsePersonaDecision(message?.text);
    if(!command||message.kind!=='private'||message.message_type!=='text'||message.voice||message.quote||message.reply||message.quoteReply||message.forwardedRecord||message.segments?.some(s=>s.type!=='text'))fail('请在私聊中单独发送完整人格审批指令。',400);
    if(!accountScope||accountScope!==accountFor())fail('微信账号已切换，请在当前账号重新申请。',403);
    const config=configFor(),sender=verifiedAssistantSender(message),key='wechat:private:'+String(message.conversation_id);
    if(!administratorFriend(sender)||!assistantSenderAllowed(config.wechat,key,sender))fail('只有已指定的管理员可以审批人格。',403);
    const p=load(command[2].toLowerCase());
    if(p.account!==accountFor()||!p.recipients.includes(sender))fail('这条提案不属于当前账号或管理员。',403);
    if(p.state==='applying'&&config.persona.chats?.[p.key]===p.target&&fs.existsSync(path.join(root,'roles',p.target+'.md'))&&hash(fs.readFileSync(path.join(root,'roles',p.target+'.md'),'utf8'))===hash(p.content)){p.state='approved';save(p);}
    refresh(p,config);
    if(p.state!=='pending')return {...publicProposal(p),message:p.state==='approved'?'此人格已经批准生效。':`此提案已结束（${p.state}），未再次修改人格。`};
    // Do not approve a draft that has not been completely delivered to this admin.
    if(notifications().some(n=>n.proposalId===p.id&&n.wxid===sender))fail('人格草案尚未完整送达，请等完整通知后再审批。');
    p.decidedBy=sender;p.decidedAt=now();
    if(command[1]==='拒绝'){p.state='rejected';save(p);return {...publicProposal(p),message:'已拒绝，原人格保持不变。'};}
    p.target='AI人格-'+p.id;p.state='applying';save(p);
    const targetFile=path.join(root,'roles',p.target+'.md');
    if(fs.existsSync(targetFile)&&fs.readFileSync(targetFile,'utf8')!==p.content)fail('生成人格文件发生冲突，请重新提案。');
    try{
      write(targetFile,p.content);
      const next=structuredClone(config);next.persona.chats??={};next.persona.chats[p.key]=p.target;
      const mode=next.wechat.modeSettings?.[p.key]?.[p.base.workMode];if(mode?.settings)mode.settings.persona=p.target;
      saveConfig(next);p.state='approved';save(p);
    }catch(error){
      // Config is the commit point. A lost journal write must not apply twice.
      if(configFor().persona.chats?.[p.key]===p.target){p.state='approved';save(p);}
      else{p.state='failed';save(p);throw error;}
    }
    return {...publicProposal(p),message:'已同意，新人格从该会话的下一轮对话开始生效，其他会话不受影响。'};
  }
  return {propose,list,notifications,acknowledge,decide,reviewContext};
}
