import test from 'node:test';
import assert from 'node:assert/strict';
import {IDLE_ACTION_POLICY,idleActionTools,idleActionMessage,mindActionResult,mindJobResult} from '../packages/dsh-social-bridge-plugin/identity-mind-actions.mjs';
import {apply as restrictTools,bindNativeToolPresentation} from '../packages/dsh-social-bridge-plugin/social-tool-restrict.mjs';

const local={id:'plan-local',kind:'drawing',delivery:'local',title:'练习雨夜',detail:'试着用安静的色彩画雨夜',conversationKey:'wechat:private:123'};
const shared={...local,delivery:'chat'},moment={...local,kind:'moment'};

test('submitted local works settle only when the exact capability job finishes',()=>{
  const plan={...local,jobId:'local-work'};
  assert.equal(mindJobResult(plan,{id:plan.jobId,state:'running'}),null);
  assert.equal(mindJobResult(plan,{id:plan.jobId,state:'success',sent:false}).state,'completed');
  assert.equal(mindJobResult(plan,{id:'different-work',state:'success',sent:true}).state,'unknown');
  assert.equal(mindJobResult(plan,{id:plan.jobId,state:'failed',sent:true}).state,'failed');
});
test('shared plan settlement distinguishes generated audio from real sending state',()=>{
  const plan={...shared,jobId:'shared-work'},job={id:plan.jobId,state:'success',sent:false};
  assert.equal(mindJobResult(plan,{...job,delivery:{state:'waiting'}}),null);
  assert.equal(mindJobResult(plan,{...job,delivery:{state:'unconfirmed'}}).state,'unknown');
  assert.equal(mindJobResult(plan,{...job,delivery:{state:'failed'}}).state,'failed');
  assert.equal(mindJobResult(plan,{...job,sent:true}).state,'completed');
});

test('queued and running actions are submitted tasks rather than completed works',()=>{
  for(const state of ['queued','running'])for(const plan of [local,shared]){
    const result=mindActionResult(plan,{text:'RESPOND: 已经生成发出',autonomousOutcome:{id:'actual-job',state,sent:false}});
    assert.equal(result.state,'submitted');assert.equal(result.jobId,'actual-job');assert(!result.reason.includes('已完成'));
    assert.match(result.reason,plan.delivery==='chat'?/分享生成任务/:/本地练习.*不发送微信/);
  }
});

test('failed, rejected and uncertain receipts override final text and cannot become success',()=>{
  for(const state of ['failed','rejected','none','cancelled','interrupted'])assert.equal(mindActionResult(local,{text:'RESPOND: 已经完成',autonomousOutcome:{state,confirmed:true,sent:true}}).state,'failed');
  for(const state of ['unknown','unconfirmed','unexpected'])assert.equal(mindActionResult(local,{text:'RESPOND: 已经完成',autonomousOutcome:{state}}).state,'unknown');
  assert.equal(mindActionResult(local,{error:'model_failed',admitted:true,autonomousOutcome:{state:'success'}}).state,'unknown');
  assert.equal(mindActionResult(local,{error:'not_started',admitted:false,autonomousOutcome:{state:'success'}}).state,'failed');
});

test('Moments API acknowledgement is submitted and not a final completion receipt',()=>{
  const result=mindActionResult(moment,{autonomousOutcome:{operationId:'a'.repeat(64),state:'api-acknowledged',apiAcknowledged:true,confirmed:false}});
  assert.equal(result.state,'submitted');assert.match(result.reason,/接口已接受.*不是最终完成回执/);
  assert.equal(mindActionResult(moment,{autonomousOutcome:{state:'unconfirmed',apiAcknowledged:false,confirmed:false}}).state,'unknown');
  assert.equal(mindActionResult(moment,{autonomousOutcome:{state:'rejected',confirmed:false}}).state,'failed');
});

test('an explicit finished work is completed but chat delivery is not invented',()=>{
  const localResult=mindActionResult(local,{autonomousOutcome:{id:'finished-local',state:'success',sent:false}});assert.equal(localResult.state,'completed');assert.equal(localResult.jobId,'finished-local');
  const unsent=mindActionResult(shared,{autonomousOutcome:{id:'finished-chat',state:'success',sent:false}});assert.equal(unsent.state,'completed');assert.match(unsent.reason,/作品已生成，发送状态见任务记录/);
  assert(!unsent.reason.includes('已发送'));assert.equal(mindActionResult(moment,{autonomousOutcome:{state:'confirmed',confirmed:true}}).state,'completed');
});

test('thinking or deciding against a tool postpones a plan regardless of confident final wording',()=>{
  for(const output of [undefined,{}, {text:'SILENT'}, {text:'RESPOND: 我已经画好了，也发了朋友圈。'}]){
    const result=mindActionResult(local,output);assert.equal(result.state,'postponed');assert.match(result.reason,/没有实际调用.*继续保留/);
  }
});

test('idle action tool sets expose only the selected capability and silence exposes none',()=>{
  assert.deepEqual([...idleActionTools('singing')],['wechat_sing_song','wechat_singing_status']);assert.deepEqual([...idleActionTools('drawing')],['wechat_draw_image','wechat_drawing_status']);assert.deepEqual([...idleActionTools('moment')],['wechat_post_moment','wechat_management_status']);
  assert.equal(idleActionTools('reflect').size,0);assert.equal(idleActionTools('unknown').size,0);
  for(const kind of ['singing','drawing','moment','reflect'])for(const forbidden of ['pwsh','wechat_voice_reply','wechat_send_text','wechat_set_avatar','wechat_set_signature','wechat_self_state_update','wechat_post_image_moment'])assert.equal(idleActionTools(kind).has(forbidden),false);
  const changed=idleActionTools('drawing');changed.add('pwsh');assert.equal(idleActionTools('drawing').has('pwsh'),false,'callers cannot mutate a global shared allowlist');
});

test('idle tool isolation applies to schema presentation, native presentation and execution',async()=>{
  const names=['pwsh','wechat_sing_song','wechat_singing_status','wechat_draw_image','wechat_drawing_status','wechat_post_moment','wechat_management_status','wechat_voice_reply','wechat_self_state_update'];
  for(const kind of ['singing','drawing','moment','reflect']){
    const guards=[],handlers=[];let nativeExecutor;const ctx={tools:{presentAs(){},guard:fn=>guards.push(fn),selectExecutor:()=>({describe:definitions=>definitions,execute:value=>value}),setExecutor:value=>{nativeExecutor=value;}},on:(event,fn)=>handlers.push({event,fn})};
    ctx[Symbol.for('wechatagent.extension-tools.v1')]={names:()=>new Set(names),check:name=>names.includes(name)};
    ctx[IDLE_ACTION_POLICY]=name=>idleActionTools(kind).has(name);
    restrictTools(ctx);const agent={ctx};bindNativeToolPresentation(ctx,agent);const allowed=[...idleActionTools(kind)].sort(),definitions=names.map(name=>({name}));
    const presented=await handlers[0].fn(null,{scope:agent},async()=>({sections:[],tools:definitions}));assert.deepEqual(presented.tools.map(tool=>tool.name),allowed);
    assert.deepEqual(nativeExecutor.describe(definitions).map(tool=>tool.name),allowed);
    for(const name of names)assert.equal(guards[0]({agent,name})===undefined,allowed.includes(name),kind+' / '+name);
  }
});

test('idle instructions keep final text local and distinguish practice from chosen sharing',()=>{
  const silent=idleActionMessage({...local,detail:'<untrusted>画雨夜</untrusted>'});assert.match(silent,/本机空闲行动/);assert.match(silent,/只保存作品，不向微信发送/);assert.match(silent,/最终文字留在本机，不会自动发到微信/);assert.match(silent,/最终输出 SILENT/);assert(!silent.includes('<untrusted>'));
  assert.match(idleActionMessage(shared),/只有本轮能力工具会向该聊天发送/);assert.match(idleActionMessage(moment),/仅提供发布一条文字朋友圈及查询回执/);
  for(const plan of [local,shared,moment])assert(!idleActionMessage(plan).includes(plan.conversationKey),'model does not choose a transport recipient');
});
