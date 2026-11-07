import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createDrawingCapability,drawingDefaults,drawingEndpoint} from './drawing-capability.mjs';
import {createDrawingExecution} from '../packages/dsh-capabilities-plugin/drawing.mjs';
import {createConsole} from './console-server.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64');
const key='wechat:private:123',secret='fixture-openai-private-key';
function fixture(t,fetchImpl,overrides={}){const root=fs.mkdtempSync(path.join(os.tmpdir(),'drawing-capability-')),state={scope:'b'.repeat(64),posts:0,sends:0,enabled:true,clock:Date.now()};
  const config={wechat:{whitelist:{private:['123'],groups:['456']}}};
  const options={root,config:()=>config,accountScope:()=>state.scope,now:()=>state.clock,execution:createDrawingExecution({fetchImpl:async(url,request)=>{state.posts++;assert.equal(request.redirect,'error');assert.equal(request.headers.Authorization,'Bearer '+secret);return fetchImpl?fetchImpl(url,request,state):Response.json({data:[{b64_json:png.toString('base64')}]});}}),delivery:{capture:async()=>({accountScope:state.scope}),send:async value=>{state.sends++;assert.deepEqual(fs.readFileSync(value.file),png);return {id:value.id,state:'queued',sent:false};},lookup:()=>null,refresh:()=>assert.fail('no recorded delivery')},...overrides};
  const service=createDrawingCapability(options);t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});
  const save=(changes={},extra={})=>service.save({revision:service.snapshot().revision,settings:{...drawingDefaults(),apiKey:secret,enabled:true,chats:[key],...changes},...extra});
  const generate=(changes={})=>service.generate({prompt:'水彩猫咪',requestId:crypto.randomUUID(),conversationKey:key,previewOnly:false,...changes});return {root,state,config,options,service,save,generate};}

test('drawing credentials are masked, revision protected, and never silently sent to a changed endpoint',t=>{
  const f=fixture(t),initial=f.service.snapshot();assert.equal(initial.settings.enabled,false);assert.equal(f.service.catalog()[0].configured,false);
  f.save();const saved=f.service.snapshot();assert.equal(saved.settings.apiKeyConfigured,true);assert(!JSON.stringify(saved).includes(secret));assert.equal(saved.settings.apiKey,'');
  assert.throws(()=>f.service.save({revision:initial.revision,settings:drawingDefaults()}),/已变化/);
  f.save({apiKey:''});assert.equal(f.service.snapshot().settings.apiKeyConfigured,true);
  assert.throws(()=>f.save({endpoint:'https://other.example/v1',apiKey:''}),/重新填写/);assert.equal(f.state.posts,0);
  f.save({endpoint:'https://other.example/v1',apiKey:''},{clearApiKey:true});assert.equal(f.service.snapshot().settings.apiKeyConfigured,false);
  const credentialUrl=new URL('https://api.example/v1');credentialUrl.username='fixture-user';credentialUrl.password='fixture-password';
  for(const endpoint of ['http://evil.example/v1','https://api.example/v1?key=x',credentialUrl.href,'https://api.example/v1/images/generations'])assert.throws(()=>drawingEndpoint(endpoint));
});

test('GPT generation uses base64 PNG contract once, persists result and dispatches only to bound conversation',async t=>{
  const f=fixture(t,async(url,request)=>{assert.equal(url,'https://api.openai.com/v1/images/generations');assert.deepEqual(JSON.parse(request.body),{model:'gpt-image-2',prompt:'水彩猫咪',n:1,size:'1024x1024',quality:'auto',output_format:'png'});return Response.json({data:[{b64_json:png.toString('base64')}]});});f.save();
  const requestId=crypto.randomUUID(),{job}=await f.generate({requestId});assert.equal(job.state,'running');await f.service.settled(job.id);
  const result=await f.service.get(job.id,key);assert.equal(result.state,'success');assert.equal(result.width,2);assert.equal(result.sent,false);assert.equal(f.state.sends,1);assert.deepEqual(f.service.image(job.id,key),png);
  assert.equal((await f.generate({requestId})).job.id,job.id);assert.equal(f.state.posts,1);assert.equal(f.state.sends,1);
  await assert.rejects(f.generate({requestId,prompt:'另一个画面'}),/其他画面/);
  await assert.rejects(f.service.get(job.id,'wechat:private:456'),/不属于/);f.state.scope='c'.repeat(64);await assert.rejects(f.service.get(job.id,key),/不属于/);
  const saved=fs.readFileSync(path.join(f.root,'state/drawing/jobs',job.id,'job.json'),'utf8');assert(!saved.includes(secret));assert(!saved.includes('水彩猫咪'));
});

test('drawing jobs retain the image API success receipt across lookups and recovery without a second generation or send',async t=>{
  let acknowledgement,sends=0;
  const delivery={capture:async()=>({accountScope:'b'.repeat(64)}),send:async value=>{sends++;assert.deepEqual(fs.readFileSync(value.file),png);
    acknowledgement={id:value.id,state:'api-acknowledged',sent:true,confirmed:false,apiAcknowledged:true,receipt:'supplier-api',delivered:'api-acknowledged'};return acknowledgement;},
    lookup:()=>acknowledgement,refresh:async()=>acknowledgement};
  const f=fixture(t,undefined,{delivery});f.save();const requestId=crypto.randomUUID(),{job}=await f.generate({requestId});await f.service.settled(job.id);
  const result=await f.service.get(job.id,key);assert.equal(result.state,'success');assert.equal(result.sent,true);assert.deepEqual(result.delivery,acknowledgement);
  assert.equal(result.delivery.confirmed,false);assert.equal(Object.hasOwn(result.delivery,'serverId'),false);assert.equal(sends,1);assert.equal(f.state.posts,1);
  f.service.close();const restored=createDrawingCapability(f.options);t.after(()=>restored.close());
  const recovered=await restored.get(job.id,key);assert.equal(recovered.sent,true);assert.deepEqual(recovered.delivery,acknowledgement);
  assert.equal((await restored.generate({prompt:'水彩猫咪',requestId,conversationKey:key,previewOnly:false})).job.id,job.id);assert.equal(sends,1);assert.equal(f.state.posts,1);
});

test('drawing jobs do not infer API success from incomplete or contradictory delivery metadata',async t=>{
  const valid={state:'api-acknowledged',sent:true,confirmed:false,apiAcknowledged:true,receipt:'supplier-api',delivered:'api-acknowledged'};
  for(const mutate of [r=>delete r.sent,r=>r.sent=false,r=>delete r.confirmed,r=>r.confirmed=true,r=>delete r.apiAcknowledged,
    r=>r.apiAcknowledged=false,r=>delete r.receipt,r=>r.receipt='wechat-image-server-id',r=>delete r.delivered,r=>r.delivered='server-confirmed']){
    const acknowledgement={...valid};mutate(acknowledgement);let sends=0;
    const delivery={capture:async()=>({accountScope:'b'.repeat(64)}),send:async()=>{sends++;return acknowledgement;},lookup:()=>acknowledgement,refresh:async()=>acknowledgement};
    const f=fixture(t,undefined,{delivery});f.save();const {job}=await f.generate();await f.service.settled(job.id);
    const result=await f.service.get(job.id,key);assert.equal(result.state,'success');assert.equal(result.sent,false);assert.equal(sends,1);assert.equal(f.state.posts,1);
  }
});

test('local preview is independent of WeChat and never invokes native image send',async t=>{const f=fixture(t);f.save({enabled:false,chats:[]});
  const {job}=await f.generate({previewOnly:true,conversationKey:undefined,revision:f.service.snapshot().revision});await f.service.settled(job.id);assert.equal((await f.service.get(job.id)).state,'success');assert.equal(f.state.sends,0);assert.deepEqual(f.service.image(job.id),png);
  await assert.rejects(f.generate(),/未开启/);await assert.rejects(f.service.get(job.id,key),/不属于/);
});

test('malformed image, URL-only provider response and rejected credentials fail without fetching URLs or retries',async t=>{
  for(const response of [()=>Response.json({data:[{url:'http://127.0.0.1:1234/private'}]}),()=>Response.json({data:[{b64_json:Buffer.from('not png').toString('base64')}]}),()=>new Response('secret provider payload',{status:401})]){
    const f=fixture(t,response);f.save();const {job}=await f.generate();await f.service.settled(job.id);const failed=await f.service.get(job.id,key);assert.equal(failed.state,'failed');assert.equal(f.state.posts,1);assert.equal(f.state.sends,0);assert(!JSON.stringify(failed).includes('secret provider payload'));assert(!JSON.stringify(failed).includes('http:'));
  }
});

test('settings or account change during generation preserves the local artifact without sending',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);const f=fixture(t,async()=>{await gate;return Response.json({data:[{b64_json:png.toString('base64')}]});});f.save();
  const {job}=await f.generate();await assert.rejects(f.generate(),/已有一张/);f.save({enabled:false});release();await f.service.settled(job.id);assert.equal(f.state.sends,0);
  const record=JSON.parse(fs.readFileSync(path.join(f.root,'state/drawing/jobs',job.id,'job.json'),'utf8'));assert.equal(record.state,'success');assert.equal(record.delivery.state,'not-sent');
});

test('restart restores results and never resubmits interrupted or completed paid requests',async t=>{
  const f=fixture(t);f.save();const requestId=crypto.randomUUID(),{job}=await f.generate({requestId});await f.service.settled(job.id);f.service.close();
  const recovered=createDrawingCapability(f.options);t.after(()=>recovered.close());assert.equal((await recovered.get(job.id,key)).state,'success');assert.equal((await recovered.generate({prompt:'水彩猫咪',requestId,conversationKey:key,previewOnly:false})).job.id,job.id);assert.equal(f.state.posts,1);assert.equal(f.state.sends,1);
  const record=path.join(f.root,'state/drawing/jobs',job.id,'job.json'),value=JSON.parse(fs.readFileSync(record,'utf8'));value.state='running';value.stage='GPT 正在绘画';for(const field of ['completedAt','width','height','delivery'])delete value[field];fs.writeFileSync(record,JSON.stringify(value));
  const interrupted=createDrawingCapability(f.options);t.after(()=>interrupted.close());assert.equal((await interrupted.get(job.id,key)).state,'failed');assert.equal(f.state.posts,1);assert.equal(f.state.sends,1);
});

test('model check verifies identity while keeping provider errors and credentials private',async t=>{
  const f=fixture(t,async url=>{assert.equal(url,'https://api.openai.com/v1/models/gpt-image-2');return Response.json({id:'gpt-image-2'});});f.save();assert.equal((await f.service.check({revision:f.service.snapshot().revision})).ok,true);assert.equal(f.service.catalog()[0].ready,true);f.save({quality:'high'});assert.equal(f.service.catalog()[0].ready,false);
});

test('drawing requires the injected DSH executor and never uses a local provider fallback',async t=>{
  for(const execution of [undefined,async()=>{throw Object.assign(Error(secret),{code:'DSH_OFFLINE'});},async()=>{throw Object.assign(Error(secret),{code:'toString'});}]){
    const f=fixture(t,()=>assert.fail('console must not call provider'),{execution});f.save();
    await assert.rejects(f.service.check({revision:f.service.snapshot().revision}),error=>error.status>=500&&!error.message.includes(secret));
    const {job}=await f.generate();await f.service.settled(job.id);const result=await f.service.get(job.id,key);
    assert.equal(result.state,'failed');assert.equal(f.state.posts,0);assert.equal(f.state.sends,0);assert(!JSON.stringify(result).includes(secret));
  }
});

test('the transport verifies executor PNG data and dimensions before saving or delivering',async t=>{
  for(const result of [{image:png.toString('base64'),width:3,height:2},{image:Buffer.from('invalid').toString('base64'),width:2,height:2},{image:png.toString('base64'),width:'2',height:2}]){
    const f=fixture(t,undefined,{execution:async()=>result});f.save();const {job}=await f.generate();await f.service.settled(job.id);
    assert.equal((await f.service.get(job.id,key)).state,'failed');assert.equal(f.state.sends,0);assert.equal(fs.existsSync(path.join(f.root,'state/drawing/jobs',job.id,'image.png')),false);
  }
});

test('private execution settings stay outside job records and the executor receives no chat identity',async t=>{
  const received=[],executor=createDrawingExecution({fetchImpl:async()=>Response.json({data:[{b64_json:png.toString('base64')}]})});
  const f=fixture(t,undefined,{execution:async(operation,payload,options)=>{received.push({operation,payload});return executor(operation,payload,options);}});f.save();
  const {job}=await f.generate();await f.service.settled(job.id);assert.equal(received[0].operation,'drawing.generate');assert.deepEqual(Object.keys(received[0].payload).sort(),['prompt','settings']);
  assert.equal(received[0].payload.settings.apiKey,secret);assert(!JSON.stringify(received).includes(key));assert(!JSON.stringify(received).includes(f.state.scope));
  const saved=fs.readFileSync(path.join(f.root,'state/drawing/jobs',job.id,'job.json'),'utf8');assert(!saved.includes(secret));assert(!saved.includes('水彩猫咪'));
});

test('closing during channel capture never starts a paid request, even if the capture ignores abort',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve),f=fixture(t);f.save();f.options.delivery.capture=()=>gate;
  const pending=f.generate();f.service.close();await assert.rejects(pending,error=>error.status===503);release({accountScope:f.state.scope});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.state.posts,0);assert.equal(f.state.sends,0);assert.equal(f.service.isBusy(),false);
});

test('changing credentials or authorization while checking the channel stops before provider submission',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve),f=fixture(t);f.save();f.options.delivery.capture=()=>gate;
  const pending=f.generate();f.save({apiKey:'replacement-key'});release({accountScope:f.state.scope});await assert.rejects(pending,error=>error.status===409);
  assert.equal(f.state.posts,0);assert.equal(f.state.sends,0);assert.equal(f.service.isBusy(),false);
});

test('closing a running request cancels it without late images or sends when a provider ignores abort',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve),f=fixture(t,async()=>{await gate;return Response.json({data:[{b64_json:png.toString('base64')}]});});f.save();
  const {job}=await f.generate();f.service.close();await f.service.settled(job.id);release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.service.get(job.id,key)).state,'failed');assert.equal(f.state.posts,1);assert.equal(f.state.sends,0);assert.equal(f.service.isBusy(),false);
  assert.equal(fs.existsSync(path.join(f.root,'state/drawing/jobs',job.id,'image.png')),false);
  await assert.rejects(f.service.check({revision:f.service.snapshot().revision}),error=>error.status===503);
});

test('disk errors leave a readable failed state and settle without unhandled task rejection or a paid retry',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve),f=fixture(t,async()=>{await gate;return Response.json({data:[{b64_json:png.toString('base64')}]});});f.save();
  const {job}=await f.generate(),dir=path.join(f.root,'state/drawing/jobs',job.id);fs.renameSync(dir,dir+'.held');fs.writeFileSync(dir,'not a directory');release();await f.service.settled(job.id);
  const failed=await f.service.get(job.id,key);assert.equal(failed.state,'failed');assert.match(failed.error,/无法保存/);assert(!JSON.stringify(failed).includes(f.root));assert(!JSON.stringify(failed).includes(secret));
  await assert.rejects(f.generate(),error=>error.status===503);assert.equal(f.state.posts,1);assert.equal(f.state.sends,0);assert.equal(f.service.isBusy(),false);
});

test('retention removes old artifacts while preserving bounded request fingerprints across restart',async t=>{
  const f=fixture(t,undefined,{retention:{maxJobs:2,maxRequests:3}});f.save();const results=[];
  for(let i=0;i<4;i++){f.state.clock++;const requestId=crypto.randomUUID(),{job}=await f.generate({requestId});await f.service.settled(job.id);results.push({job,requestId});}
  const dir=path.join(f.root,'state/drawing/jobs'),ledger=path.join(f.root,'state/drawing/retired.json');assert.equal(fs.readdirSync(dir).length,2);assert.equal(JSON.parse(fs.readFileSync(ledger)).entries.length,2);
  assert.equal(fs.existsSync(path.join(dir,results[0].job.id)),false);await assert.rejects(f.generate({requestId:results[0].requestId}),error=>error.status===410);assert.equal(f.state.posts,4);
  f.service.close();const recovered=createDrawingCapability(f.options);t.after(()=>recovered.close());
  await assert.rejects(recovered.generate({prompt:'水彩猫咪',requestId:results[0].requestId,conversationKey:key,previewOnly:false}),error=>error.status===410);
  await assert.rejects(recovered.get(results[0].job.id,key),error=>error.status===410);f.state.scope='c'.repeat(64);await assert.rejects(recovered.get(results[0].job.id,key),error=>error.status===403);f.state.scope='b'.repeat(64);
  for(let i=0;i<3;i++){f.state.clock++;const {job}=await recovered.generate({prompt:'watercolor',requestId:crypto.randomUUID(),conversationKey:key,previewOnly:false});await recovered.settled(job.id);}
  assert.equal(fs.readdirSync(dir).length,2);assert.equal(JSON.parse(fs.readFileSync(ledger)).entries.length,3);assert(!fs.readFileSync(ledger,'utf8').includes(secret));assert.equal(f.state.posts,7);
});

test('age and byte limits clean cached images without generating an expired request again',async t=>{
  const f=fixture(t,undefined,{retention:{maxAgeMs:1000,maxBytes:24000}});f.save();const requestId=crypto.randomUUID(),{job}=await f.generate({requestId});await f.service.settled(job.id);
  f.state.clock+=1001;await assert.rejects(f.generate({requestId}),error=>error.status===410);assert.equal(fs.existsSync(path.join(f.root,'state/drawing/jobs',job.id)),false);assert.equal(f.state.posts,1);
  const small=fixture(t,undefined,{retention:{maxBytes:1}});small.save();const first=crypto.randomUUID(),value=await small.generate({requestId:first});await small.service.settled(value.job.id);
  assert.equal(fs.readdirSync(path.join(small.root,'state/drawing/jobs')).length,0);await assert.rejects(small.generate({requestId:first}),error=>error.status===410);assert.equal(small.state.posts,1);
});

test('malformed or contradictory recovered jobs are withheld and cannot cause another paid request',async t=>{
  for(const mutate of [job=>job.completedAt='not-a-date',job=>job.width=99,job=>job.stage='untrusted injected stage',job=>{job.previewOnly=true;},job=>{job.state='running';}]){
    const f=fixture(t);f.save();const requestId=crypto.randomUUID(),{job}=await f.generate({requestId});await f.service.settled(job.id);f.service.close();
    const file=path.join(f.root,'state/drawing/jobs',job.id,'job.json'),value=JSON.parse(fs.readFileSync(file));mutate(value);fs.writeFileSync(file,JSON.stringify(value));const recovered=createDrawingCapability(f.options);t.after(()=>recovered.close());
    await assert.rejects(recovered.get(job.id,key),error=>error.status===404);await assert.rejects(recovered.generate({prompt:'水彩猫咪',requestId,conversationKey:key,previewOnly:false}),error=>error.status===503);assert.equal(f.state.posts,1);
  }
});

test('a job directory junction cannot expose an image or redirect cleanup outside drawing storage',async t=>{
  const f=fixture(t);f.save();const {job}=await f.generate();await f.service.settled(job.id);const dir=path.join(f.root,'state/drawing/jobs',job.id),outside=fs.mkdtempSync(path.join(os.tmpdir(),'drawing-external-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.writeFileSync(path.join(outside,'image.png'),png);fs.writeFileSync(path.join(outside,'keep.txt'),'external content');fs.renameSync(dir,dir+'.held');fs.symlinkSync(outside,dir,'junction');
  assert.throws(()=>f.service.image(job.id,key),error=>error.status===503);await assert.rejects(f.generate(),error=>error.status===503);assert.equal(fs.readFileSync(path.join(outside,'keep.txt'),'utf8'),'external content');assert.equal(f.state.posts,1);
});

test('console exposes the drawing card and assets while requiring console authentication for settings',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'drawing-console-'));fs.mkdirSync(path.join(root,'config'));fs.copyFileSync(new URL('../config/wechatagent.example.json',import.meta.url),path.join(root,'config/wechatagent.json'));
  const instance=createConsole({root,port:0,fetchImpl:async()=>{throw Error('not running');},capabilityExecution:createDrawingExecution({fetchImpl:async()=>{throw Error('not running');}})});await instance.start();t.after(()=>{instance.close();fs.rmSync(root,{recursive:true,force:true});});const base='http://127.0.0.1:'+instance.server.address().port;
  const info=await(await fetch(base+'/api/info')).json(),headers={'X-Console-Token':info.token};assert.equal((await fetch(base+'/api/drawing-capability')).status,401);
  const catalog=await(await fetch(base+'/api/extensions',{headers})).json();assert.equal(catalog.extensions.find(row=>row.id==='native-gpt-drawing').management,'drawing');
  for(const file of ['/drawing-capability.js','/drawing-capability.css'])assert.equal((await fetch(base+file)).status,200);
  const result=await(await fetch(base+'/api/drawing-capability',{headers})).json();assert.equal(result.settings.enabled,false);assert.equal(result.settings.apiKeyConfigured,false);
});
