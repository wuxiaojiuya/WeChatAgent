import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {AssistantTasks,parseAssistantCommand,formatAssistantTask} from '../packages/dsh-social-bridge-plugin/assistant-tasks.mjs';
import {createAssistantControl} from '../packages/dsh-social-bridge-plugin/assistant-control.mjs';
import {bindDshAccess,DSH_ACCESS_POLICY} from '../packages/dsh-social-bridge-plugin/dsh-access.mjs';
import {validateConversationSettings} from '../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
import {chatSettingsSnapshot,applyChatSettings} from '../public/console/conversation-settings.mjs';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {DshPluginClient} from '../components/qq-bridge/src/dsh/plugin-client.js';
import {AssistantNotifications,isSilentAssistantNotification} from '../packages/dsh-social-bridge-plugin/assistant-notifications.mjs';
const key='wechat:group:123',sender='wxid_admin',member='wxid_member',taskId='T0123456789abcdef';
const wait=async fn=>{for(let i=0;i<400;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,3));}assert.fail('condition timed out');};
const temp=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-controller-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const request=(batch='a',extra={})=>({conversationKey:key,assistantSender:sender,senderWxid:sender,batchId:batch.repeat(64),message:'执行隔离测试任务',...extra});
const config=()=>({persona:{default:'fixture'},wechat:{whitelist:{groups:['123','456'],private:[]},workModes:{[key]:'assistant','wechat:group:456':'assistant'},assistant:{administrators:[sender],adminOnlyGroups:{[key]:false}},dshAccess:{chats:{[key]:{skills:[],tools:[]}}}}});
function store(t,execute=async()=>({text:'RESPOND: 完成'}),allowed=()=>true){const root=temp(t),tasks=new AssistantTasks({file:path.join(root,'tasks.json'),execute,allowed});t.after(()=>tasks.close());return {root,tasks};}

test('a durable batch starts once, returns the same ID and preserves the exact completed result after restart',async t=>{
 let calls=0;const {tasks}=store(t,async()=>{calls++;return {text:'RESPOND: 原始结果'};});const first=tasks.submit(request());assert.equal(tasks.submit(request()).id,first.id);await wait(()=>tasks.get(first.id).state==='completed');assert.equal(calls,1);
 const restored=new AssistantTasks({file:tasks.file,execute:async()=>{calls++;},allowed:()=>true});t.after(()=>restored.close());assert.equal(restored.submit(request()).id,first.id);assert.equal(restored.view(restored.get(first.id),{result:true}).output.text,'RESPOND: 原始结果');assert.equal(calls,1);
});
test('per-chat execution is serialized; another chat proceeds independently and cancellation frees the queue',async t=>{
 const releases=[];const {tasks}=store(t,(_body,signal)=>new Promise((resolve,reject)=>{releases.push(resolve);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));
 const a=tasks.submit(request('a')),b=tasks.submit(request('b')),c=tasks.submit(request('c',{conversationKey:'wechat:group:456'}));await wait(()=>releases.length===2);assert.equal(tasks.get(b.id).state,'queued');tasks.cancel(a.id);await wait(()=>tasks.get(b.id).state==='running');assert.equal(tasks.get(a.id).state,'cancelled');releases[1]({text:'RESPOND: other'});await wait(()=>tasks.get(c.id).state==='completed');releases[2]({text:'RESPOND: next'});await wait(()=>tasks.get(b.id).state==='completed');
});
test('restarted running and queued tasks require an explicit fresh continuation',async t=>{
 const {tasks}=store(t,()=>new Promise(()=>{}));const a=tasks.submit(request('a')),b=tasks.submit(request('b'));await wait(()=>tasks.get(a.id).state==='running');let calls=0;
 const restored=new AssistantTasks({file:tasks.file,execute:async()=>{calls++;return {text:'RESPOND: 未执行过的排队任务'};},allowed:()=>true});t.after(()=>restored.close());assert.equal(restored.get(a.id).state,'interrupted');assert.equal(restored.get(b.id).state,'interrupted');restored.pump();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls,0);assert.equal(restored.get(a.id).output,undefined);
});
test('queue revocation cancels only that sender and a fresh continuation needs its own batch',async t=>{
 let allowed=true,calls=0;const {tasks}=store(t,async()=>{calls++;return {text:'RESPOND: 结果'};},()=>allowed);const a=tasks.submit(request());await wait(()=>tasks.get(a.id).state==='completed');assert.throws(()=>tasks.submit(request('b',{assistantParentId:taskId})),/PARENT/);const b=tasks.submit(request('b',{assistantParentId:a.id}));await wait(()=>tasks.get(b.id).state==='completed');assert.equal(tasks.get(b.id).parentId,a.id);allowed=false;assert.throws(()=>tasks.submit(request('c')),/SENDER_DENIED/);assert.equal(calls,2);
});
test('exact commands accept task IDs and approval tokens without treating quoted or ordinary chat as controls',()=>{
 assert.deepEqual(parseAssistantCommand('助手，任务列表',['助手']),{action:'list'});assert.deepEqual(parseAssistantCommand('取消任务 '+taskId),{action:'cancel',taskId});assert.equal(parseAssistantCommand('请解释“取消任务”是什么意思'),null);assert.equal(parseAssistantCommand('批准 A0123456789abcdef').action,'approve');assert.equal(parseAssistantCommand('继续任务 '+taskId+' 只整理结果').text,'只整理结果');assert.equal(parseAssistantCommand('新任务 整理项目').action,'new');assert(!formatAssistantTask({id:taskId,state:'running',stage:'执行中'}).includes('RESPOND'));
});
test('native capability inheritance is opt-in, follows live tools, and cannot elevate a social agent',async t=>{
 const root=temp(t),c=config();fs.mkdirSync(path.join(root,'config'));const save=()=>fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(c));save();let definitions=[{name:'pwsh'},{name:'read'},{name:'third_party_task'}];const ctx={get:()=>({schemas:()=>definitions})},agentCtx={tools:{register:()=>()=>{}}},agent={ctx:agentCtx,session:{header:{cwd:root}}},turn={controller:new AbortController(),skillCalls:0,toolCalls:0};
 const binding=bindDshAccess(agentCtx,ctx,agent,root,key,()=>turn);t.after(()=>binding.dispose());assert.equal(agentCtx[DSH_ACCESS_POLICY].names().size,0);c.wechat.dshAccess.chats[key].mode='native';save();assert(agentCtx[DSH_ACCESS_POLICY].check('pwsh'));definitions.push({name:'newly_installed_tool'});assert(agentCtx[DSH_ACCESS_POLICY].names().has('newly_installed_tool'));assert(!agentCtx[DSH_ACCESS_POLICY].names().has('wechat_file_send'));c.wechat.workModes[key]='social';save();assert.equal(agentCtx[DSH_ACCESS_POLICY].names().size,0);
});
test('capability settings round-trip without losing custom grants, dirty-state drift or assistant mode history',()=>{
 const c=config(),original=chatSettingsSnapshot(c,key),s=structuredClone(original);s.access={skills:['document'],tools:['read'],mode:'native',remoteApproval:true,timeoutMinutes:60,toolLimit:500};applyChatSettings(c,key,s.settings,s.access);validateConversationSettings(c.wechat);assert.deepEqual(chatSettingsSnapshot(c,key),s);const social=chatSettingsSnapshot(c,key,'social');applyChatSettings(c,key,social.settings,social.access);assert.deepEqual(chatSettingsSnapshot(c,key,'assistant'),s);assert.throws(()=>validateConversationSettings({...c.wechat,dshAccess:{chats:{[key]:{skills:[],tools:[],mode:'admin',toolLimit:10000}}}}));
});
function controlFixture(t){
 const f=store(t,()=>new Promise(()=>{})),c=config(),file=path.join(f.root,'config/wechatagent.json');fs.mkdirSync(path.dirname(file));const save=()=>fs.writeFileSync(file,JSON.stringify(c));save();let approvalHandler;
 let questionHandler;const pending=new Map(),mappings={[key]:'session-1'},profiles={[key]:{workspaceId:'group-a'}},ctx={on(name,fn){if(name==='approval/request')approvalHandler=fn;if(name==='user-questions/request')questionHandler=fn;return ()=>{};},agents:{get:()=>undefined},get:()=>undefined};
 const groups={snapshot:()=>({available:true,groups:[{id:'group-a',title:'当前'},{id:'group-b',title:'工作'}]}),run:async(_action,body)=>({ok:true,sessionId:'session-2',groupId:body.groupId})};
 const control=createAssistantControl({ctx,root:f.root,tasks:f.tasks,accountReady:()=>true,sessionGroups:groups,mappings,profiles,pending});t.after(()=>control.dispose());return {...f,c,save,control,pending,mappings,profiles,ask:(...args)=>approvalHandler(...args),question:(...args)=>questionHandler(...args),body:extra=>({conversationKey:key,senderWxid:sender,...extra})};
}

test('native question answers are bound to the live task owner and never replace approval intents',async t=>{
 const f=controlFixture(t),job=f.tasks.submit(request());await wait(()=>f.tasks.get(job.id).state==='running');f.pending.set('session-1',{taskId:job.id});const controller=new AbortController(),req={agent:{session:{id:'session-1'}},questions:[{id:'one',question:'选择目录',options:[{label:'甲'},{label:'乙'}]}],signal:controller.signal};
 const outcome=f.question(req,async()=>assert.fail('must relay'));await wait(()=>f.tasks.get(job.id).state==='waiting_input');const token=f.tasks.get(job.id).question.id;await assert.rejects(f.control('answer',f.body({senderWxid:member,token,text:'甲'})),/ADMIN_REQUIRED/);await f.control('answer',f.body({token,text:'甲'}));assert.deepEqual(await outcome,{answers:[{id:'one',selected:['甲']}]});
 assert.equal(await f.question({...req,questions:[{...req.questions[0],intent:{kind:'approval'}}]},async()=> 'local-confirmation'),'local-confirmation');
});
test('successful background commands are silent while failures remain durable and permission checked',t=>{
 const root=temp(t),file=path.join(root,'notifications.json');let allowed=true;const queue=new AssistantNotifications(file,()=>allowed),session={id:'s'},job={id:taskId,sender};
 queue.observe(session,{type:'job/registered',data:{jobId:'pwsh-success'}},key,job);
 queue.observe(session,{type:'job/settled',data:{jobId:'pwsh-success',status:'completed',cause:'producer'}},key);
 queue.observe(session,{type:'job/settled',data:{jobId:'pwsh-success',status:'completed',cause:'producer'}},key);assert.equal(queue.list().length,0);
 queue.observe(session,{type:'job/registered',data:{jobId:'pwsh-failed'}},key,job);
 queue.observe(session,{type:'job/settled',data:{jobId:'pwsh-failed',status:'failed',cause:'producer'}},key);
 queue.observe(session,{type:'job/settled',data:{jobId:'pwsh-failed',status:'failed',cause:'producer'}},key);assert.equal(queue.list().length,1);assert(queue.list()[0].text.includes('failed'));
 const restored=new AssistantNotifications(file,()=>allowed);assert.equal(restored.list()[0].id,queue.list()[0].id);restored.ack(restored.list()[0].id);assert.equal(restored.list().length,0);
 restored.queue({id:'other',key,sender,text:'任务失败'});allowed=false;assert.equal(restored.list().length,0);
});
test('old queued success notices are retired without losing scheduled results or failure notices',t=>{
 const file=path.join(temp(t),'notifications.json'),queue=new AssistantNotifications(file,()=>true),text='后台任务 pwsh-4461d4759e744393 已结束，状态：completed。需要详细结果可让助手检查该任务。';
 const legacy=queue.queue({id:'legacy',key,sender,text}),result=queue.queue({id:'scheduled-result',key,sender,kind:'result',text}),failed=queue.queue({id:'failed',key,sender,text:text.replace('completed','failed')});
 assert.equal(isSilentAssistantNotification({kind:'status',text}),true);assert.equal(isSilentAssistantNotification({kind:'result',text}),false);assert.equal(isSilentAssistantNotification({kind:'status',text:'引用：'+text}),false);assert.equal(isSilentAssistantNotification({kind:'status',text:text+'\n其他内容'}),false);
 const restored=new AssistantNotifications(file,()=>true);assert.deepEqual(restored.list().map(item=>item.id),[result,failed]);const persisted=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(persisted.messages[legacy].state,'cancelled');assert.equal(persisted.messages[result].text,text);assert.equal(new AssistantNotifications(file,()=>true).list().length,2);
});
test('scheduled continuations use recorded native schedule IDs and cannot guess the owner from unrelated messages',t=>{
 const queue=new AssistantNotifications(path.join(temp(t),'notifications.json'),()=>true),job={id:taskId,sender},session={id:'s',snapshotEvents:()=>[{type:'tool/call',data:{callId:'call',name:'schedule_create'}}]};queue.observe(session,{type:'tool/result',data:{message:{toolCallId:'call',content:[{type:'text',text:'{"id":"schedule-exact-1"}'}]}}},key,job);
 assert.equal(queue.scheduleOwner('s',[{source:{kind:'schedule'},content:[{type:'text',text:'schedule_id_json: \"schedule-exact-1\"'}]}]).sender,sender);assert.equal(queue.scheduleOwner('s',[{source:{kind:'user'},content:[{type:'text',text:'schedule-exact-1'}]}]),null);assert.equal(queue.scheduleOwner('s',[{source:{kind:'schedule'},content:[{type:'text',text:'unrelated'}]}]),null);
});
test('durable task lookups and cancellation never expose another sender or chat',async t=>{
 const f=controlFixture(t),job=f.tasks.submit(request());await wait(()=>f.tasks.get(job.id).state==='running');await assert.rejects(f.control('result',f.body({senderWxid:member,taskId:job.id})),/ADMIN_REQUIRED/);await assert.rejects(f.control('list',f.body({senderWxid:member})),/ADMIN_REQUIRED/);await assert.rejects(f.control('result',f.body({conversationKey:'wechat:group:456',taskId:job.id})),/NOT_FOUND/);assert((await f.control('status',f.body({taskId:job.id}))).running);
});
test('workspace switches require a bound second confirmation and never run while a task is active',async t=>{
 const f=controlFixture(t);await assert.rejects(f.control('workspace-select',f.body({senderWxid:member,groupId:'group-b'})),/ADMIN/);const request=await f.control('workspace-select',f.body({groupId:'group-b'})),token=/W[a-f0-9]{16}/.exec(request.text)[0];await assert.rejects(f.control('workspace-confirm',f.body({token:'W0000000000000000'})),/EXPIRED/);assert((await f.control('workspace-confirm',f.body({token}))).ok);await assert.rejects(f.control('workspace-confirm',f.body({token})),/EXPIRED/);
});
test('native approval relay requires local opt-in, exact logged action and a currently authorized administrator',async t=>{
 const f=controlFixture(t),job=f.tasks.submit(request());await wait(()=>f.tasks.get(job.id).state==='running');f.pending.set('session-1',{taskId:job.id});const controller=new AbortController(),req={agent:{session:{id:'session-1',snapshotEvents:()=>[{type:'tool/call',data:{callId:'call-1',name:'pwsh',arguments:'{"command":"Get-Date"}'}}]}},toolName:'pwsh',callId:'call-1',reason:'Run the requested command',signal:controller.signal};let local=0;
 assert.equal(await f.ask(req,async()=>{local++;return 'rejected';}),'rejected');assert.equal(local,1);f.c.wechat.dshAccess.chats[key].remoteApproval=true;f.save();const outcome=f.ask(req,async()=>{local++;return 'unavailable';});await wait(()=>f.tasks.get(job.id).state==='waiting_approval');const token=f.tasks.get(job.id).approval.id;assert(f.tasks.get(job.id).approval.action.includes('Get-Date'));await assert.rejects(f.control('approve',f.body({token,senderWxid:member})),/ADMIN/);assert.equal(f.tasks.get(job.id).state,'waiting_approval');await f.control('approve',f.body({token}));assert.equal(await outcome,'allowed-once');await assert.rejects(f.control('approve',f.body({token})),/EXPIRED/);assert.equal(local,1);
});
test('approval revocation, cancellation and unavailable full arguments cannot grant an action',async t=>{
 const f=controlFixture(t),job=f.tasks.submit(request());await wait(()=>f.tasks.get(job.id).state==='running');f.pending.set('session-1',{taskId:job.id});f.c.wechat.dshAccess.chats[key].remoteApproval=true;f.save();const controller=new AbortController(),req={agent:{session:{id:'session-1',snapshotEvents:()=>[{type:'tool/call',data:{callId:'one',arguments:'{"command":"Get-Date"}'}}]}},toolName:'pwsh',callId:'one',signal:controller.signal};const outcome=f.ask(req,async()=> 'unavailable');await wait(()=>f.tasks.get(job.id).approval);const token=f.tasks.get(job.id).approval.id;f.c.wechat.dshAccess.chats[key].remoteApproval=false;f.save();await assert.rejects(f.control('approve',f.body({token})),/REVOKED/);controller.abort();assert.equal(await outcome,'cancelled');assert.equal(await f.ask({...req,signal:undefined,callId:'missing'},async()=> 'rejected'),'rejected');
});
test('text and a file arriving together become one assistant task; status is never queued behind execution',async t=>{
 const root=temp(t),buffer=new MessageBuffer(path.join(root,'buffer.json')),calls=[],sent=[];let release;
 const engine=new SocialEngine({buffer,assistantBatchMs:60,batchMs:1,workModeFor:()=> 'assistant',assistantAccess:()=>true,privateMinIntervalMs:0,minIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:100,stickerPolicyFor:()=>({enabled:false}),decide:async(_key,prompt,metadata)=>{calls.push({prompt,metadata});await new Promise(resolve=>{release=resolve;});return 'RESPOND: 已接收文件并完成';},assistantControl:async()=>({text:'任务执行中'}),send:async(_message,text)=>{sent.push(text);return {confirmed:true};}});t.after(()=>engine.stop());
 const message=(id,text,extra={})=>({platform:'wechat',kind:'private',conversation_id:'123',sender_id:'123',sender_wxid:sender,message_id:id,text,timestamp:Date.now()/1000,...extra});engine.receive(message('text','请分析我发的文件'));await new Promise(resolve=>setTimeout(resolve,10));engine.receive(message('file','[文件] report.pdf',{files:[{id:'f'.repeat(64),name:'report.pdf',size:100}]}));await wait(()=>calls.length===1);assert.equal(calls[0].metadata.files.length,1);assert(calls[0].prompt.includes('report.pdf'));engine.receive(message('status','任务状态'));await wait(()=>sent.length===1);assert.equal(buffer.unread('wechat:private:123').length,2);release();await wait(()=>sent.length===2);assert.equal(calls.length,1);assert.equal(buffer.unread('wechat:private:123').length,0);
});
test('short RPC polling returns the original result on replay and only submits the native operation once',async t=>{
 const f=store(t,async()=>({text:'RESPOND: 实际完成'})),server=http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/health')return res.end(JSON.stringify({ok:true,assistantController:'durable-wechat-tasks-v1'}));let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);if(req.url.endsWith('/submit'))return res.end(JSON.stringify({task:f.tasks.submit(body)}));if(req.url.endsWith('/result'))return res.end(JSON.stringify({task:f.tasks.view(f.tasks.get(body.taskId),{result:true})}));res.writeHead(404);res.end('{}');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const client=new DshPluginClient({url:'http://127.0.0.1:'+server.address().port,token:'fixture'});client.taskPollMs=1;const meta={workMode:'assistant',assistantSender:sender,batchId:'a'.repeat(64)};assert.equal(await client.followup(key,'执行测试任务',meta),'RESPOND: 实际完成');assert.equal(await client.followup(key,'执行测试任务',meta),'RESPOND: 实际完成');assert.equal(f.tasks.jobs.size,1);
});
