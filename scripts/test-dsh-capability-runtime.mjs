import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createCapabilityRuntime} from '../packages/dsh-capabilities-plugin/runtime.mjs';
import {CAPABILITY_EXECUTION_VERSION,CAPABILITY_OPERATIONS} from '../packages/dsh-capabilities-plugin/contract.mjs';

const scope='b'.repeat(64);
function fixture(t,overrides={}){
  const state={scope,clock:1_000_000,calls:[],closed:0};
  const drawing=async(operation,payload,options)=>{state.calls.push({operation,payload});options.onProgress('正在处理');return {image:'fixture',width:2,height:2};};
  const voice={check:async payload=>{state.calls.push({operation:'voice.check',payload});return {ok:true};},generate:async payload=>{state.calls.push({operation:'voice.generate',payload});return {audio:'fixture'};},close:()=>state.closed++};
  const singing=async(operation,payload)=>{state.calls.push({operation,payload});return {ok:true};};
  const runtime=createCapabilityRuntime({root:process.cwd(),now:()=>state.clock,accountScope:()=>state.scope,executors:{drawing,voice,singing,...overrides}});
  t.after(()=>runtime.close());const request=(changes={})=>({operation:'drawing.generate',payload:{prompt:'fixture'},requestId:crypto.randomUUID(),issuedAt:state.clock,accountScope:state.scope,...changes});
  return {state,runtime,request};
}

test('capability runtime exposes the DSH contract and routes every supported operation to an injected executor',async t=>{
  const f=fixture(t);assert.equal(f.runtime.status().version,CAPABILITY_EXECUTION_VERSION);assert.equal(f.runtime.status().host,'dsh');
  assert.deepEqual(f.runtime.status().operations,Object.keys(CAPABILITY_OPERATIONS));
  for(const operation of Object.keys(CAPABILITY_OPERATIONS))await f.runtime.execute(f.request({operation}));
  assert.deepEqual(f.state.calls.map(row=>row.operation),Object.keys(CAPABILITY_OPERATIONS));assert.equal(f.runtime.isBusy(),false);
});

test('capability runtime shares an identical in-flight request and rejects changed payload, operation, timestamp or scope without reexecution',async t=>{
  let release,calls=0;const gate=new Promise(resolve=>release=resolve),f=fixture(t,{drawing:async()=>{calls++;return gate;}}),request=f.request();
  const first=f.runtime.execute(request),duplicate=f.runtime.execute(structuredClone(request));assert.equal(f.runtime.isBusy(),true);assert.equal(calls,1);
  for(const changed of [{payload:{prompt:'different'}},{operation:'drawing.check'},{issuedAt:request.issuedAt+1}])await assert.rejects(f.runtime.execute({...request,...changed}),{code:'CAPABILITY_REQUEST_CONFLICT',status:409});
  await assert.rejects(f.runtime.execute({...request,accountScope:'c'.repeat(64)}),{code:'CAPABILITY_REQUEST_INVALID'});
  release({image:'fixture'});assert.deepEqual(await first,{image:'fixture'});assert.deepEqual(await duplicate,{image:'fixture'});
  assert.deepEqual(await f.runtime.execute(request),{image:'fixture'});assert.equal(calls,1);assert.equal(f.runtime.isBusy(),false);
});

test('issuedAt bounds first admission and recycles 512 completed fingerprints without allowing an expired paid request to execute again',async t=>{
  const f=fixture(t),old=f.request();await f.runtime.execute(old);
  for(let index=1;index<512;index++)await f.runtime.execute(f.request());
  await assert.rejects(f.runtime.execute(f.request()),{code:'CAPABILITY_EXECUTION_LIMIT',status:429});assert.equal(f.state.calls.length,512);assert.equal(f.runtime.status().running,0);
  f.state.clock+=120001;await assert.rejects(f.runtime.execute(old),{code:'CAPABILITY_REQUEST_EXPIRED',status:409});assert.equal(f.state.calls.length,512);
  await f.runtime.execute(f.request());assert.equal(f.state.calls.length,513);
  await assert.rejects(f.runtime.execute(f.request({issuedAt:f.state.clock+120001})),{code:'CAPABILITY_REQUEST_EXPIRED'});
  for(const issuedAt of [undefined,NaN,1.25,'1000000'])await assert.rejects(f.runtime.execute(f.request({issuedAt})),{code:'CAPABILITY_REQUEST_INVALID'});
});

test('completed large results are evicted after three successors while their fingerprints still prevent another paid execution',async t=>{
  const f=fixture(t),first=f.request();await f.runtime.execute(first);
  for(let index=0;index<3;index++)await f.runtime.execute(f.request());
  await assert.rejects(f.runtime.execute(first),{code:'CAPABILITY_RESULT_EXPIRED'});assert.equal(f.state.calls.length,4);
});

test('external cancellation settles even when an executor ignores abort, clears busy and withholds all late results',async t=>{
  let release,calls=0;const gate=new Promise(resolve=>release=resolve),f=fixture(t,{drawing:async()=>{calls++;return gate;}}),controller=new AbortController(),request=f.request();
  const pending=f.runtime.execute(request,{signal:controller.signal}),reason=Error('fixture cancellation');controller.abort(reason);
  await assert.rejects(pending,error=>error===reason);assert.equal(f.runtime.isBusy(),false);
  await assert.rejects(f.runtime.execute(request),error=>error===reason);assert.equal(calls,1);
  release({image:'late'});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.runtime.status().running,0);
});

test('close cancels outstanding requests and closes owned voice execution without accepting new work',async t=>{
  let release;const f=fixture(t,{drawing:()=>new Promise(resolve=>release=resolve)}),pending=f.runtime.execute(f.request());f.runtime.close();
  await assert.rejects(pending);assert.equal(f.runtime.isBusy(),false);assert.equal(f.state.closed,1);
  await assert.rejects(f.runtime.execute(f.request()),{code:'CAPABILITY_PLUGIN_CLOSED'});release({image:'late'});
});

test('scope changes withhold generated results, and progress rejects paths or multiline provider text',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve),progress=[],f=fixture(t,{drawing:async(operation,payload,{onProgress})=>{
    for(const stage of ['正在合成','https://private.invalid/key','C:\\private\\key','bad\nline','x'.repeat(201)])onProgress(stage);await gate;return {image:'late'};
  }}),pending=f.runtime.execute(f.request(),{onProgress:stage=>progress.push(stage)});
  f.state.scope='c'.repeat(64);release();await assert.rejects(pending,{code:'CAPABILITY_ACCOUNT_CHANGED'});assert.deepEqual(progress,['正在合成']);assert.equal(f.runtime.isBusy(),false);
});
