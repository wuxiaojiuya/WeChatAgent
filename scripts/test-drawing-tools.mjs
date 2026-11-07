import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {bindDrawingTools,DRAWING_POLICY,drawingReplyOutcome} from '../packages/dsh-social-bridge-plugin/drawing-tools.mjs';
import {apply as restrictTools} from '../packages/dsh-social-bridge-plugin/social-tool-restrict.mjs';

const key='wechat:private:123',id='11111111-1111-4111-8111-111111111111';
function fixture(t,{fetchImpl,...options}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'drawing-tools-')),tools=new Map(),registrations=new Map(),calls=[];
  fs.mkdirSync(path.join(root,'config'));fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify({wechat:{whitelist:{private:['123'],groups:[]}}}));
  let turn={controller:new AbortController()},capability={enabled:true,chats:[key],apiKeyConfigured:true},job={id,state:'running',stage:'正在生成图片',conversationKey:key},allowed=true;
  const ctx={tools:{register(tool,options={}){tools.set(tool.name,tool);registrations.set(tool.name,options);return()=>{tools.delete(tool.name);registrations.delete(tool.name);};}}};
  const binding=bindDrawingTools(ctx,root,key,()=>turn,{...options,isAllowed:()=>allowed,fetchImpl:async(url,request)=>{
    calls.push({url,request});
    if(fetchImpl)return fetchImpl(url,request,{root,capability,job});
    return Response.json(url.endsWith('/api/info')?{project:'WeChatAgent Console',root,token:'fixture-token'}:url.endsWith('/api/drawing-capability')?{settings:capability,conversations:[{key,title:'测试会话'}]}:{job});
  }});
  t.after(()=>{binding.dispose();fs.rmSync(root,{recursive:true,force:true});});
  return {root,ctx,tools,registrations,binding,calls,setTurn:value=>turn={controller:new AbortController(),...value},setCapability:value=>capability=value,setJob:value=>job=value,setAllowed:value=>allowed=value,turn:()=>turn};
}
const result=async(tool,args={})=>JSON.parse((await tool.execute(args)).content);

test('native tool resolution awaits drawing eligibility before the first schema snapshot and shares one lookup per turn',async t=>{
  const f=fixture(t),policy=f.ctx[DRAWING_POLICY];
  const resolve=async()=>{
    const definitions=[];
    for(const [name,tool]of f.tools){
      const registration=f.registrations.get(name);
      if(registration.when===undefined||await registration.when({agent:{ctx:f.ctx},signal:f.turn().controller.signal}))definitions.push(tool);
    }
    return definitions.filter(tool=>policy.names().has(tool.name)).map(tool=>tool.name);
  };
  assert.equal(policy.names().size,0);
  assert.deepEqual(await resolve(),['wechat_draw_image','wechat_drawing_status']);
  await resolve();await f.binding.refresh();
  assert.equal(f.calls.filter(row=>row.url.endsWith('/api/drawing-capability')).length,1);
  f.setTurn();assert.deepEqual(await resolve(),['wechat_draw_image','wechat_drawing_status']);
  assert.equal(f.calls.filter(row=>row.url.endsWith('/api/drawing-capability')).length,2);
  for(const capability of [{enabled:false,chats:[key],apiKeyConfigured:true},{enabled:true,chats:[],apiKeyConfigured:true},{enabled:true,chats:[key],apiKeyConfigured:false}]){
    f.setTurn();f.setCapability(capability);assert.deepEqual(await resolve(),[]);
  }
  f.setTurn();f.setAllowed(false);const before=f.calls.length;assert.deepEqual(await resolve(),[]);assert.equal(f.calls.length,before);
  f.setAllowed(true);f.turn().controller.abort();assert.deepEqual(await resolve(),[]);assert.equal(f.calls.length,before);
});

test('drawing tools and instructions require fresh enabled capability, configured key and live conversation authorization',async t=>{
  const f=fixture(t),policy=f.ctx[DRAWING_POLICY];assert.equal(policy.names().size,0);assert.equal(f.binding.instructions(),'');
  assert.equal(await f.binding.refresh(),true);assert.deepEqual([...policy.names()],['wechat_draw_image','wechat_drawing_status']);
  assert.match(f.binding.instructions(),/只看图.*不能擅自画图/);assert.match(f.binding.instructions(),/模糊先问清/);
  const before=f.calls.length;await f.binding.refresh();assert.equal(f.calls.length,before,'one capability lookup per model turn');
  for(const capability of [{enabled:false,chats:[key],apiKeyConfigured:true},{enabled:true,chats:[],apiKeyConfigured:true},{enabled:true,chats:[key],apiKeyConfigured:false}]){
    f.setTurn();f.setCapability(capability);assert.equal(await f.binding.refresh(),false);assert.equal(policy.names().size,0);
  }
  f.setCapability({enabled:true,chats:[key],apiKeyConfigured:true});f.setTurn();await f.binding.refresh();f.setAllowed(false);assert.equal(policy.names().size,0);
  f.setAllowed(true);fs.writeFileSync(path.join(f.root,'config/wechatagent.json'),JSON.stringify({wechat:{whitelist:{private:[],groups:[]}}}));assert.equal(policy.names().size,0);
});

test('drawing generation submits the bound conversation and internal request id exactly once per turn',async t=>{
  const f=fixture(t),tool=f.tools.get('wechat_draw_image');await f.binding.refresh();
  const first=await result(tool,{prompt:'请画一只趴在窗边看雨的橘猫，水彩风格。'});assert.equal(first.job.state,'running');assert.equal(first.job.sent,false);
  await result(tool,{prompt:'请画一只趴在窗边看雨的橘猫，水彩风格。'});
  const generate=f.calls.filter(row=>row.url.endsWith('/generate'));assert.equal(generate.length,1);
  const body=JSON.parse(generate[0].request.body);assert.deepEqual(Object.keys(body).sort(),['conversationKey','previewOnly','prompt','requestId']);assert.equal(body.conversationKey,key);assert.equal(body.previewOnly,false);assert.match(body.requestId,/^[a-f0-9-]{36}$/);
  const previous=f.turn().drawingOutcome;const conflict=await result(tool,{prompt:'换一张，画山水。'});assert.match(conflict.message,/不会生成第二张/);assert.deepEqual(f.turn().drawingOutcome,previous);assert.equal(f.calls.filter(row=>row.url.endsWith('/generate')).length,1);
  f.setTurn();await result(tool,{prompt:'画一条红色小鱼。'});assert.equal(f.calls.filter(row=>row.url.endsWith('/generate')).length,2);
});

test('persona photo requests are presented as virtual image generation without claiming real photography',async t=>{
  const f=fixture(t);await f.binding.refresh();
  const tool=f.tools.get('wechat_draw_image'),instructions=f.binding.instructions();
  for(const text of ['发张你的照片','自拍','看看你的样子','当前人格','虚拟角色','实际调用工具']){
    assert(tool.description.includes(text),text);assert(instructions.includes(text),text);
  }
  assert.match(instructions,/不冒称真实拍照/);assert.match(instructions,/只看图.*不能擅自画图/);
  const prompt='根据本会话人格生成一张角色自拍：黑色长发、温暖日常穿搭、自然窗边光，虚拟角色形象照。';
  await result(tool,{prompt});
  const requests=f.calls.filter(row=>row.url.endsWith('/generate'));assert.equal(requests.length,1);
  assert.equal(JSON.parse(requests[0].request.body).prompt,prompt);
});

test('model arguments cannot redirect drawings or supply credentials, paths or API controls',async t=>{
  const f=fixture(t),tool=f.tools.get('wechat_draw_image');await f.binding.refresh();
  assert.deepEqual(Object.keys(tool.parameters.properties),['prompt']);assert.equal(tool.parameters.additionalProperties,false);
  for(const args of [{prompt:'cat',conversationKey:'wechat:private:456'},{prompt:'cat',path:'C:/secret.png'},{prompt:'cat',apiKey:'secret'},{prompt:'cat',url:'https://foreign.invalid'},{prompt:'cat',requestId:'chosen'}, {prompt:''},{prompt:'a'.repeat(4001)}])await assert.rejects(tool.execute(args));
  assert.equal(f.calls.filter(row=>row.url.endsWith('/generate')).length,0);
});

test('a lost generation response stays unconfirmed and a repeat never resubmits the image',async t=>{
  const f=fixture(t,{fetchImpl:async(url,request,{root,capability})=>{
    if(url.endsWith('/api/info'))return Response.json({project:'WeChatAgent Console',root,token:'fixture-token'});
    if(url.endsWith('/api/drawing-capability'))return Response.json({settings:capability});throw Error('socket disconnected with private details');
  }}),tool=f.tools.get('wechat_draw_image');
  const first=await result(tool,{prompt:'画一只猫。'}),second=await result(tool,{prompt:'画一只猫。'});
  assert.equal(first.job.state,'unconfirmed');assert.equal(second.job.state,'unconfirmed');assert.equal(f.calls.filter(row=>row.url.endsWith('/generate')).length,1);assert(!JSON.stringify(first).includes('private details'));
  assert.match(drawingReplyOutcome('RESPOND: 图片已经发给你了。',f.turn()),/结果还没确认/);
});

test('status discovers the latest chat task after rebinding and uses only the scoped query to fetch a receipt',async t=>{
  const f=fixture(t),status=f.tools.get('wechat_drawing_status');
  const first=await result(status);assert.equal(first.job.id,id);assert(f.calls.at(-1).url.endsWith('/latest?conversationKey=wechat%3Aprivate%3A123'));
  f.setTurn();f.setJob({id,state:'success',stage:'图片已生成',conversationKey:key,delivery:{state:'unconfirmed'},previewUrl:'http://127.0.0.1/private.png',file:'C:/private.png',apiKey:'secret'});
  const generated=await result(status);assert.equal(generated.job.sent,false);assert(!JSON.stringify(generated).includes('private.png'));assert(!JSON.stringify(generated).includes('secret'));assert(f.calls.at(-1).url.includes('/jobs/'+id+'?conversationKey='));
  assert.match(drawingReplyOutcome('RESPOND: 发给你啦。',f.turn()),/发送结果还没确认/);
  f.setTurn();f.setJob({id,state:'success',conversationKey:key,delivery:{state:'confirmed'}});assert.equal((await result(status,{jobId:id})).job.sent,true);assert.equal(drawingReplyOutcome('RESPOND: 画好了，发你啦。',f.turn()),'RESPOND: 画好了，发你啦。');
  f.setTurn();f.setJob(null);assert.equal((await result(status)).job.state,'none');assert.match(drawingReplyOutcome('RESPOND: 还在画。',f.turn()),/没有已启动/);
});

test('drawing status accepts a complete API success receipt without replacing truthful sent wording',async t=>{
  const f=fixture(t),delivery={state:'api-acknowledged',sent:true,confirmed:false,apiAcknowledged:true,receipt:'supplier-api',delivered:'api-acknowledged'};
  f.setJob({id,state:'success',conversationKey:key,delivery});
  const response=await result(f.tools.get('wechat_drawing_status'));
  assert.equal(response.job.sent,true);assert.equal(response.job.delivery.sent,true);assert.equal(response.job.delivery.confirmed,false);
  assert.equal(response.job.delivery.apiAcknowledged,true);assert.equal(response.job.delivery.receipt,'supplier-api');assert.equal(response.job.delivery.delivered,'api-acknowledged');
  assert.equal(Object.hasOwn(response.job.delivery,'serverId'),false);
  assert.equal(drawingReplyOutcome('RESPOND: 画好了，图片发你啦。',f.turn()),'RESPOND: 画好了，图片发你啦。');
  assert.equal(f.calls.filter(row=>row.url.endsWith('/generate')).length,0);
});

test('drawing status never treats an incomplete or contradictory API acknowledgement as a successful send',async t=>{
  const ack={state:'api-acknowledged',sent:true,confirmed:false,apiAcknowledged:true,receipt:'supplier-api',delivered:'api-acknowledged'};
  for(const mutate of [r=>delete r.sent,r=>r.sent=false,r=>delete r.confirmed,r=>r.confirmed=true,r=>delete r.apiAcknowledged,
    r=>r.apiAcknowledged=false,r=>delete r.receipt,r=>r.receipt='wechat-image-server-id',r=>delete r.delivered,r=>r.delivered='server-confirmed']){
    const f=fixture(t),delivery={...ack};mutate(delivery);f.setJob({id,state:'success',conversationKey:key,delivery,sent:true});
    const response=await result(f.tools.get('wechat_drawing_status'));assert.equal(response.job.sent,false);assert.equal(response.job.delivery.sent,false);
    assert.match(drawingReplyOutcome('RESPOND: 图片发你啦。',f.turn()),/发送结果还没确认/);assert.equal(f.calls.filter(row=>row.url.endsWith('/generate')).length,0);
  }
});

test('revocation, network opt-out, mismatched jobs and foreign consoles cannot start or confirm a drawing',async t=>{
  const f=fixture(t),tool=f.tools.get('wechat_draw_image');await f.binding.refresh();f.setCapability({enabled:false,chats:[key],apiKeyConfigured:true});await assert.rejects(tool.execute({prompt:'画一只猫。'}),/未开启/);assert.equal(f.calls.filter(row=>row.url.endsWith('/generate')).length,0);
  f.setCapability({enabled:true,chats:[key],apiKeyConfigured:true});f.setTurn({networkOptOut:true});assert.equal((await result(tool,{prompt:'画一只猫。'})).job.state,'failed');assert.equal(f.calls.filter(row=>row.url.endsWith('/generate')).length,0);
  f.setTurn();f.setJob({id,state:'success',conversationKey:'wechat:private:456',delivery:{state:'confirmed'}});assert.equal((await result(f.tools.get('wechat_drawing_status'))).job.state,'unconfirmed');
  const foreign=fixture(t,{fetchImpl:async()=>Response.json({project:'WeChatAgent Console',root:'Z:/other',token:'private-token'})});assert.equal(await foreign.binding.refresh(),false);assert.equal(foreign.calls.length,1);assert.equal(foreign.ctx[DRAWING_POLICY].names().size,0);
});

test('drawing outcome guard keeps truthful persona wording while refusing invented completion and delivery',()=>{
  assert.equal(drawingReplyOutcome('RESPOND: 普通聊天。',{}),'RESPOND: 普通聊天。');
  for(const state of ['failed','unconfirmed','running'])for(const text of ['RESPOND: 图片已经发送成功了。','RESPOND: 已经画好了，你看这张。','RESPOND: 图片发你了，看看。','RESPOND: 照片发你了。','RESPOND: 自拍发给你了。','RESPOND: 形象照画好了。'])assert.notEqual(drawingReplyOutcome(text,{drawingOutcome:{state,sent:false}}),text);
  const failed={drawingOutcome:{state:'failed',sent:false}},natural='RESPOND: 哎，这张没画成，服务这会儿出了问题。';assert.equal(drawingReplyOutcome(natural,failed),natural);
  const pending='RESPOND: 结果还没确认，我先不重复生成。';assert.equal(drawingReplyOutcome(pending,{drawingOutcome:{state:'unconfirmed',sent:false}}),pending);
  const generated='RESPOND: 图片已经生成，不过微信发送还没确认。';assert.equal(drawingReplyOutcome(generated,{drawingOutcome:{state:'success',sent:false,delivery:{state:'unconfirmed'}}}),generated);
  const unsent='RESPOND: 画好了，可微信没发出去。';assert.equal(drawingReplyOutcome(unsent,{drawingOutcome:{state:'success',sent:false}}),unsent);
});

test('reading an older drawing status never replaces normal acknowledgement or unrelated conversation',()=>{
  const replies=['RESPOND: 哈哈，笑这么开心。','RESPOND: 那就好，你喜欢就行。','RESPOND: 好呀，知道你收到了。','RESPOND: 今天吃什么？','SILENT'];
  for(const state of ['success','failed','interrupted','cancelled','unconfirmed','none','queued','running']){
    for(const delivery of ['unconfirmed','failed'])for(const reply of replies){
      assert.equal(drawingReplyOutcome(reply,{drawingOutcome:{state,sent:false,delivery:{state:delivery}}}),reply,state+' must not force an old task notice into ordinary chat');
    }
  }
  const generated='RESPOND: 画好了，这个配色你喜欢吗？';
  assert.equal(drawingReplyOutcome(generated,{drawingOutcome:{state:'success',sent:false,delivery:{state:'unconfirmed'}}}),generated,'generation success is true even without a send receipt');
  for(const state of ['none','failed','unconfirmed'])assert.notEqual(drawingReplyOutcome('RESPOND: 正在画，等一下。',{drawingOutcome:{state,sent:false}}),'RESPOND: 正在画，等一下。');
});

test('social tool presentation and execution include only the live drawing policy',async t=>{
  const f=fixture(t),guards=[],handlers=[];f.ctx.tools.guard=guard=>guards.push(guard);f.ctx.on=(name,handler)=>handlers.push({name,handler});restrictTools(f.ctx);
  const guard=guards[0],agent={ctx:f.ctx};assert.equal(typeof guard({agent,name:'wechat_draw_image'}),'string');await f.binding.refresh();assert.equal(guard({agent,name:'wechat_draw_image'}),undefined);
  const assembly={sections:[],tools:[{name:'pwsh'},{name:'wechat_draw_image'},{name:'wechat_drawing_status'}]};
  const shown=await handlers[0].handler(null,{scope:agent},async()=>assembly);assert.deepEqual(shown.tools.map(tool=>tool.name),['wechat_draw_image','wechat_drawing_status']);f.setAllowed(false);assert.equal(typeof guard({agent,name:'wechat_draw_image'}),'string');
});

test('local practice submits preview-only generation with the current revision and no chat target',async t=>{
  const revision='a'.repeat(64);let f;
  f=fixture(t,{fetchImpl:async(url,request,{root,capability})=>{
    if(url.endsWith('/api/info'))return Response.json({project:'WeChatAgent Console',root,token:'fixture-token'});
    if(url.endsWith('/api/drawing-capability'))return Response.json({settings:capability,revision});
    return Response.json({job:{id,state:'queued',previewOnly:true}});
  }});
  const turn=f.setTurn({previewOnly:true}),draw=f.tools.get('wechat_draw_image');
  const first=await result(draw,{prompt:'自己练习画一幅安静的雨夜。'});await result(draw,{prompt:'自己练习画一幅安静的雨夜。'});
  const submissions=f.calls.filter(row=>row.url.endsWith('/generate'));assert.equal(submissions.length,1);
  const body=JSON.parse(submissions[0].request.body);assert.deepEqual(Object.keys(body).sort(),['previewOnly','prompt','requestId','revision']);assert.equal(body.previewOnly,true);assert.equal(body.revision,revision);assert.equal(Object.hasOwn(body,'conversationKey'),false);assert.equal(first.job.state,'queued');assert.equal(first.job.sent,false);assert.equal(turn.drawingLatest,id);
  const checked=await result(f.tools.get('wechat_drawing_status'));assert.equal(checked.job.id,id);assert(f.calls.at(-1).url.endsWith('/jobs/'+id));assert.equal(f.calls.at(-1).url.includes('conversationKey'),false);
});

test('local drawing status does not discover chat jobs and rejects a foreign or non-preview result',async t=>{
  const f=fixture(t);f.setTurn({previewOnly:true});const status=f.tools.get('wechat_drawing_status');
  const empty=await result(status);assert.equal(empty.job.state,'none');assert.equal(f.calls.some(row=>/\/(?:jobs|latest)(?:[/?]|$)/.test(row.url)),false);
  for(const job of [{id,state:'success',conversationKey:'wechat:private:456',previewOnly:true},{id,state:'success',conversationKey:key,previewOnly:false},{id,state:'success',conversationKey:key}]){
    f.setTurn({previewOnly:true});f.setJob(job);const response=await status.execute({jobId:id}),value=JSON.parse(response.content);assert.equal(response.isError,true);assert.equal(value.job.state,'unconfirmed');assert.equal(value.job.sent,false);assert(!response.content.includes('wechat:private:456'));
  }
});

test('local drawing practice cannot replace the normal chat latest job',async t=>{
  const localId='22222222-2222-4222-8222-222222222222';let f;
  f=fixture(t,{fetchImpl:async(url,request,{root,capability})=>{
    if(url.endsWith('/api/info'))return Response.json({project:'WeChatAgent Console',root,token:'fixture-token'});
    if(url.endsWith('/api/drawing-capability'))return Response.json({settings:capability,revision:'b'.repeat(64)});
    if(url.endsWith('/generate')){const local=JSON.parse(request.body).previewOnly;return Response.json({job:{id:local?localId:id,state:'queued',...(local?{previewOnly:true}:{conversationKey:key})}});}
    return Response.json({job:{id,state:'running',conversationKey:key}});
  }});
  const draw=f.tools.get('wechat_draw_image'),status=f.tools.get('wechat_drawing_status');await result(draw,{prompt:'画给朋友的猫'});
  f.setTurn({previewOnly:true});await result(draw,{prompt:'自己练习的雨夜'});
  f.setTurn();const normal=await result(status);assert.equal(normal.job.id,id);assert(f.calls.at(-1).url.includes('/jobs/'+id+'?conversationKey='));assert(!f.calls.at(-1).url.includes(localId));
});
