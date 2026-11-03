import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {AssistantTasks,assistantProgressText} from '../packages/dsh-social-bridge-plugin/assistant-tasks.mjs';
import {AssistantFeedback,feedbackDefaults,feedbackSnapshot,saveFeedback} from '../packages/dsh-social-bridge-plugin/assistant-feedback.mjs';
import {ASSISTANT_FEEDBACK_INSTRUCTIONS,assistantFeedbackInstructions} from '../packages/dsh-social-bridge-plugin/work-modes.mjs';
import {stableChatInstructions} from '../packages/dsh-social-bridge-plugin/prompt-context.mjs';
import {DshPluginClient} from '../components/qq-bridge/src/dsh/plugin-client.js';
const key='wechat:private:123',id='T0123456789abcdef';
const message=text=>({content:[{type:'reasoning',text:'DO_NOT_FORWARD_PRIVATE_REASONING'},{type:'text',text:'WECHAT_PROGRESS: '+text},{type:'tool-call',name:'read',arguments:{}}]});
const job=(extra={})=>({id,conversationKey:key,owner:'wxid_fixture',state:'running',stage:'正在执行工具',tool:'read',...extra});
const notice=(text,id=1)=>({id,text,at:100000});
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-feedback-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let now=100000;const feedback=new AssistantFeedback({root,now:()=>now}),sent=[];return {root,feedback,sent,send:async(task,text)=>{sent.push({task,text});return {confirmed:true};},advance:ms=>now+=ms,save(change){const snap=feedbackSnapshot(root),settings=structuredClone(snap.settings);change(settings);return saveFeedback(root,{revision:snap.revision,settings});}};}

test('only explicitly labelled public tool-call text is eligible; reasoning and ordinary messages never are',()=>{
 assert.equal(assistantProgressText(message('这份论文有点厚，鱼先潜进去翻翻。')),'这份论文有点厚，鱼先潜进去翻翻。');
 assert.equal(assistantProgressText({toolCalls:[{name:'read'}],content:[{type:'text',text:'WECHAT_PROGRESS: 先看看原文再开麦。'}]}),'先看看原文再开麦。');
 for(const invalid of [{content:[{type:'text',text:'WECHAT_PROGRESS: 普通最终文本'}]},{content:[{type:'reasoning',text:'WECHAT_PROGRESS: 私有推理'},{type:'tool-call',name:'read'}]},{content:[{type:'text',text:'普通中间说明'},{type:'tool-call',name:'read'}]},message('第一行\n第二行'),message('a'.repeat(81)),message('RESPOND: 不应发出'),message('排队中'),message('任务 '+id),message('<think>不能转发</think>')])assert.equal(assistantProgressText(invalid),'');
});

test('default AI mode is silent while queued, absent progress, completed or merely given final output',async t=>{
 const f=fixture(t);assert.equal(feedbackDefaults().mode,'playful');assert.equal(await f.feedback.notify(job({state:'queued'}),f.send),false);await f.feedback.notify(job(),f.send);await f.feedback.notify(job({state:'completed',output:{text:'RESPOND: 直接结果'}}),f.send);assert.equal(f.sent.length,0);
});

test('AI messages vary with the task, are rate-limited and capped, and never fall back to the quote pool',async t=>{
 const f=fixture(t);f.save(s=>{s.maxUpdates=2;s.phrases.accepted=['MUST_NOT_USE_LOCAL_QUOTE'];});
 await f.feedback.notify(job({feedback:notice('鱼先把论文里的重点捞出来。')}),f.send);await f.feedback.notify(job({feedback:notice('工具箱有点挤，先整理这份表格。',2)}),f.send);assert.equal(f.sent.length,1);f.advance(15000);await f.feedback.notify(job({feedback:notice('工具箱有点挤，先整理这份表格。',2)}),f.send);f.advance(15000);await f.feedback.notify(job({feedback:notice('再检查一次来源。',3)}),f.send);assert.equal(f.sent.length,2);assert.equal(f.sent[0].text,'🐟 鱼先把论文里的重点捞出来。');assert.equal(f.sent[1].text,'🐟 工具箱有点挤，先整理这份表格。');assert(!JSON.stringify(f.sent).includes('MUST_NOT_USE_LOCAL_QUOTE'));assert(!JSON.stringify(f.sent).includes('排队中'));
});

test('unconfirmed AI delivery keeps exact text and ID after newer output and restart, then acknowledges each notice once',async t=>{
 const f=fixture(t),attempts=[],send=async(task,text)=>{attempts.push({task,text});return {confirmed:attempts.length>1};};
 await f.feedback.notify(job({feedback:notice('鱼先读原文，免得一本正经地瞎说。')}),send);f.advance(5000);
 const restarted=new AssistantFeedback({root:f.root,now:()=>105000});await restarted.notify(job({feedback:notice('新阶段不能替换正在核对的投递。',2)}),send);assert.equal(attempts.length,2);assert.equal(attempts[0].text,attempts[1].text);assert.equal(attempts[0].task.feedbackKey,attempts[1].task.feedbackKey);
 const after=new AssistantFeedback({root:f.root,now:()=>120000});await after.notify(job({feedback:notice('鱼先读原文，免得一本正经地瞎说。')}),send);assert.equal(attempts.length,2);await after.notify(job({feedback:notice('证据捞到了，再核对一下关键数字。',2)}),send);assert.equal(attempts.length,3);assert.notEqual(attempts[1].task.feedbackKey,attempts[2].task.feedbackKey);
});

test('AI progress skips recent duplicate phrases, but approvals and questions always retain their exact details',async t=>{
 const f=fixture(t);await f.feedback.notify(job({feedback:notice('鱼去核对一下可靠来源。')}),f.send);f.advance(15000);await f.feedback.notify(job({feedback:notice('鱼去核对一下可靠来源。',2)}),f.send);await f.feedback.notify(job({id:'T1123456789abcdef',feedback:notice('鱼去核对一下可靠来源。')}),f.send);assert.equal(f.sent.length,1);
 await f.feedback.notify(job({state:'waiting_approval',approval:{id:'A0123456789abcdef',action:'执行已确认的文件操作'}}),f.send);assert(f.sent[1].text.includes('批准 A0123456789abcdef'));await f.feedback.notify(job({state:'waiting_input',question:{id:'Q0123456789abcdef',text:'保存到哪个目录？'}}),f.send);assert(f.sent[2].text.includes('保存到哪个目录？'));assert(!f.sent[1].text.includes('鱼去核对'));
});

test('model notices are attached only to live tasks; persisted progress survives restart without resuming work',async t=>{
 const f=fixture(t);let complete;const tasks=new AssistantTasks({file:path.join(f.root,'tasks.json'),allowed:()=>true,execute:()=>new Promise(resolve=>complete=resolve)});t.after(()=>tasks.close());
 const task=tasks.submit({conversationKey:key,assistantSender:'wxid_fixture',batchId:'a'.repeat(64),message:'读取文件'});assert.equal(tasks.progressMessage(task.id,message('尚未开始时不播报。')),false);await new Promise(resolve=>setImmediate(resolve));assert(tasks.progressMessage(task.id,message('先拆开文件看看有没有真材实料。')));assert.equal(tasks.progressMessage(task.id,message('先拆开文件看看有没有真材实料。')),false);assert.equal(tasks.view(tasks.get(task.id)).feedback.text,'先拆开文件看看有没有真材实料。');tasks.persist();
 const restored=new AssistantTasks({file:tasks.file,allowed:()=>true,execute:async()=>assert.fail('must not resume')});t.after(()=>restored.close());assert.equal(restored.get(task.id).state,'interrupted');assert.equal(restored.view(restored.get(task.id)).feedback.id,1);assert.equal(restored.progressMessage(task.id,message('过期通知')),false);complete({text:'RESPOND: 完成'});
});

test('AI instructions are stable and owner-controlled, absent from social or member-chat prompts and custom quote mode',t=>{
 const f=fixture(t);assert.equal(assistantFeedbackInstructions(f.root),ASSISTANT_FEEDBACK_INSTRUCTIONS);fs.mkdirSync(path.join(f.root,'config'),{recursive:true});fs.writeFileSync(path.join(f.root,'config/wechatagent.json'),JSON.stringify({wechat:{whitelist:{private:['123'],groups:[]},workModes:{[key]:'assistant'}}}));assert(stableChatInstructions(f.root,key).includes(ASSISTANT_FEEDBACK_INSTRUCTIONS));assert(!stableChatInstructions(f.root,'wechat:private:456').includes('WECHAT_PROGRESS:'));
 for(const mode of ['quotes','off','basic']){f.save(s=>{s.mode=mode;s.phrases.accepted=['USER_TEXT_MUST_NOT_BECOME_INSTRUCTIONS'];});assert.equal(assistantFeedbackInstructions(f.root),'');assert(!stableChatInstructions(f.root,key).includes('WECHAT_PROGRESS:'));assert(!stableChatInstructions(f.root,key).includes('USER_TEXT_MUST_NOT_BECOME_INSTRUCTIONS'));}
});

test('existing task polling delivers public AI progress and final result without a separate model request',async t=>{
 const f=fixture(t),requests=[];let polls=0;const server=http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/health')return res.end(JSON.stringify({ok:true,assistantController:'durable-wechat-tasks-v1'}));let raw='';for await(const chunk of req)raw+=chunk;requests.push({url:req.url,body:JSON.parse(raw)});const task=req.url.endsWith('/submit')?job({state:'queued'}):++polls===1?job({feedback:notice('鱼先去资料堆里捞个靠谱答案。')}):job({state:'completed',output:{text:'RESPOND: 最终结果'}});res.end(JSON.stringify({task}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const client=new DshPluginClient({url:'http://127.0.0.1:'+server.address().port,token:'fixture',feedback:f.feedback});client.taskPollMs=1;const result=await client.followup(key,'原始任务',{workMode:'assistant',assistantSender:'wxid_fixture',batchId:'a'.repeat(64),onTaskUpdate:f.send});assert.equal(result,'RESPOND: 最终结果');assert.equal(f.sent.length,1);assert.equal(f.sent[0].text,'🐟 鱼先去资料堆里捞个靠谱答案。');assert(requests.every(request=>/^\/assistant-task\/(submit|result)$/.test(request.url)));assert(!JSON.stringify(requests).includes('鱼先去资料堆'));
});
