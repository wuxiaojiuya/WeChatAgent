import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createNativeVoiceDelivery,audioFileToSilk} from './native-voice-delivery.mjs';
import {conversationId} from './hook-onebot.mjs';
import {createConsole} from './console-server.mjs';
import {createVoiceExecutor} from '../packages/dsh-capabilities-plugin/voice.mjs';
import {setTimeout as delay} from 'node:timers/promises';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-voice-'));
  fs.mkdirSync(path.join(root,'state/hook'),{recursive:true});fs.writeFileSync(path.join(root,'state/hook/native-token.txt'),'a'.repeat(64));
  const target='wxid_friend',key='wechat:private:'+conversationId(target),account='wxid_self_abcd';
  const config={hook:{baseUrl:'http://127.0.0.1:30001',voiceBaseUrl:'http://127.0.0.1:30002',expectedVersion:'4.1.10.27'},wechat:{whitelist:{private:[key.split(':')[2]],groups:[]}}};
  const settings={voice:{enabled:true,chats:[key]},singing:{enabled:true,chats:[key]}};
  const main={integration:'WeChatAgent-1',backend:'wechat-hook',version:'4.1.10.27',startupState:'ready',databaseAccounts:[account],pid:44};
  const health={backend:'wechat-voice',version:'4.1.10.27',databaseAccounts:[account],pid:44,ready:true};
  const state={rows:[],posts:0,failReply:false,confirm:true,health,main,own:{backend:'weflow-cli-nt',ownWxid:'wxid_self',accountDirectory:account}};
  const options={root,settings:()=>settings,config:()=>config,receiptTimeoutMs:12,pollMs:1,
    convert:async()=>({silk:Buffer.from('fixture-silk'),durationMs:1000}),
    reader:async route=>route.includes('/reader/status')?state.own:route.includes('/sessions')?{sessions:[{username:target,displayName:'Friend'}]}:{messages:state.rows},
    fetchImpl:async(url,o)=>{
      assert.equal(o.headers.Authorization,'Bearer '+'a'.repeat(64));
      if(url.endsWith('/WeChatAgent/health'))return Response.json(main);
      if(url.endsWith('/health'))return Response.json(health);
      assert.equal(url,(config.hook.backend==='supplier-http'?config.hook.baseUrl:config.hook.voiceBaseUrl)+'/SendVoiceMsg');assert.equal(o.headers['X-WeChatAgent-Account'],config.hook.backend==='supplier-http'?undefined:state.own.accountDirectory);
      const body=JSON.parse(o.body);assert.equal(body.wxidorgid,target);assert.equal(body.duration,1000);assert.match(body.path,/\.silk$/);
      state.posts++;
      const saved=JSON.parse(fs.readFileSync(body.path.replace(/\.silk$/,'.json'),'utf8'));assert.equal(saved.state,'dispatching');assert.ok(Array.isArray(saved.baseline));
      if(state.confirm)state.rows=[{localId:2,localType:34,isSend:state.integerIsSend?1:true,fullText:`<msg><voicemsg voicelength="1000"/></msg>`,createTime:Math.floor(Date.now()/1000),serverId:'8047442179716189588'}];
      if(state.failReply)throw Error('socket lost');return Response.json({ret:state.rejectReply?-1:0});
    }};
  const service=createNativeVoiceDelivery(options);t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,key,settings,state,config,options,service,send:async(sourceId='test',extra={})=>{const result=await service.enqueue({key,kind:'voice',file:'fixture.wav',sourceId,...extra});return service.settled(result.id,key);}};
}
test('voice uses reviewed native endpoint, canonical conversation mapping and durable intent before submission',async t=>{
  const f=fixture(t);assert.equal((await f.service.check()).ready,true);
  const result=await f.send();assert.equal(result.sent,true);assert.equal(result.serverId,'8047442179716189588');
  assert.equal((await f.send()).sent,true);assert.equal(f.state.posts,1);assert.ok(!JSON.stringify(result).includes(f.root));
});
test('lost HTTP reply is reconciled without a second native call',async t=>{
  const f=fixture(t);f.state.failReply=true;const result=await f.send();assert.equal(result.sent,true);assert.equal(f.state.posts,1);
});
test('supplied 4.1.8.27 gateway supports voice and singing with real integer reader receipts',async t=>{
  const f=fixture(t);
  Object.assign(f.config.hook,{backend:'supplier-http',expectedVersion:'4.1.8.27',voiceBaseUrl:f.config.hook.baseUrl});
  Object.assign(f.state.main,{integration:'WeChatAgent-supplier-v1',provider:'supplier-http',version:'4.1.8.27',databaseAccounts:['wxid_self']});
  Object.assign(f.state.health,{version:'4.1.8.27',databaseAccounts:['wxid_self']});
  Object.assign(f.state.own,{backend:'supplier-http',accountDirectory:'wxid_self'});f.state.integerIsSend=true;
  const check=await f.service.check();assert.equal(check.ready,true);assert.equal(check.accountVerified,false);assert.equal(check.accountVerification,'not-required');assert.equal(check.singleAccount,true);assert.match(check.message,/单账号模式/);assert.doesNotMatch(check.message,/账号与微信进程一致/);
  const result=await f.send();assert.equal(result.sent,true);assert.equal(f.state.posts,1);
  assert.equal((await f.send()).sent,true);assert.equal(f.state.posts,1);
  const sing=await f.service.enqueue({key:f.key,kind:'singing',file:'cover.mp3',sourceId:'cover'});
  f.state.rows=[];assert.equal((await f.service.settled(sing.id,f.key)).sent,true);assert.equal(f.state.posts,2);
});

test('supplier voice ignores Hook account lists and omits the account header while retaining delivery context',async t=>{
  for(const databaseAccounts of [undefined,null,[],['another-account'],['first','second']]){
    const f=fixture(t);
    Object.assign(f.config.hook,{backend:'supplier-http',expectedVersion:'4.1.8.27',voiceBaseUrl:f.config.hook.baseUrl});
    Object.assign(f.state.main,{integration:'WeChatAgent-supplier-v1',provider:'supplier-http',version:'4.1.8.27',databaseAccounts});
    Object.assign(f.state.health,{version:'4.1.8.27',databaseAccounts});Object.assign(f.state.own,{backend:'supplier-http'});
    const check=await f.service.check();assert.equal(check.ready,true,JSON.stringify(check));assert.equal(check.accountVerified,false);assert.equal(check.singleAccount,true);
    const context=await f.service.capture(f.key,'voice');assert.equal(context.account,f.state.own.accountDirectory);
    const result=await f.send('single-account',{context});assert.equal(result.sent,true);assert.equal(f.state.posts,1);
  }
});
test('timeout and restart never resubmit; late receipt can be reconciled',async t=>{
  const f=fixture(t);f.state.confirm=false;f.state.failReply=true;
  const result=await f.send();assert.equal(result.state,'unconfirmed');assert.equal(result.sent,false);
  f.service.close();const recovered=createNativeVoiceDelivery(f.options);t.after(()=>recovered.close());
  await recovered.enqueue({key:f.key,kind:'voice',sourceId:'test',file:'unused'});assert.equal(f.state.posts,1);
  f.state.rows=[{localId:8,localType:34,isSend:true,fullText:`<msg><voicemsg voicelength="1000"/></msg>`,createTime:Math.floor(Date.now()/1000),serverId:'999999999999999999'}];
  assert.equal((await recovered.refresh(result.id,f.key,{wait:true})).sent,true);assert.equal(f.state.posts,1);
});

test('receipt status returns immediately while a single background reconciliation checks a late receipt without resending',async t=>{
  const f=fixture(t);f.state.confirm=false;f.state.failReply=true;
  const prior=await f.send();assert.equal(prior.state,'unconfirmed');
  assert.equal(prior.submissionCode,'VOICE_SUBMISSION_TRANSPORT_ERROR');
  const saved=JSON.parse(fs.readFileSync(path.join(f.root,'state/voice-output/deliveries',prior.id+'.json')));
  assert.equal(saved.submission.code,'VOICE_SUBMISSION_TRANSPORT_ERROR');
  assert.ok(saved.submission.completedAt>=saved.submission.startedAt);
  f.service.close();let release,entered,reads=0;
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const recovered=createNativeVoiceDelivery({...f.options,reader:async route=>{
    if(route.includes('/messages')){reads++;entered();await gate;}
    return f.options.reader(route);
  }});t.after(()=>{release();recovered.close();});
  const timer=new AbortController();
  const quick=await Promise.race([recovered.refresh(prior.id,f.key),delay(250,undefined,{signal:timer.signal}).then(()=>assert.fail('status waited for receipt polling'))]);timer.abort();
  assert.equal(quick.state,'unconfirmed');await started;
  for(let i=0;i<5;i++)assert.equal((await recovered.refresh(prior.id,f.key)).sent,false);
  assert.equal(reads,1);assert.equal(f.state.posts,1);
  f.state.rows=[{localId:8,localType:34,isSend:true,fullText:'<msg><voicemsg voicelength="1000"/></msg>',createTime:Math.floor(Date.now()/1000),serverId:'999999999999999999'}];
  release();assert.equal((await recovered.settled(prior.id,f.key)).sent,true);assert.equal(f.state.posts,1);
});

test('recent ambiguous delivery is rejected before generation, while old ambiguity does not permanently block new requests',async t=>{
  const f=fixture(t);f.state.confirm=false;f.state.failReply=true;
  const prior=await f.send('old-cover');assert.equal(prior.state,'unconfirmed');
  await assert.rejects(f.service.capture(f.key,'voice'),/VOICE_PREVIOUS_DELIVERY_UNCONFIRMED/);
  assert.equal(f.state.posts,1);
  f.service.close();const file=path.join(f.root,'state/voice-output/deliveries',prior.id+'.json'),record=JSON.parse(fs.readFileSync(file));
  record.startedAt=Date.now()-120000;fs.writeFileSync(file,JSON.stringify(record));
  const before=fs.readFileSync(file,'utf8'),recovered=createNativeVoiceDelivery(f.options);t.after(()=>recovered.close());
  const context=await recovered.capture(f.key,'voice');assert.equal(context.account,f.state.own.accountDirectory);
  f.state.confirm=true;f.state.failReply=false;
  const next=await recovered.enqueue({key:f.key,kind:'voice',sourceId:'fresh-request',file:'fixture.wav',context});
  assert.equal((await recovered.settled(next.id,f.key)).sent,true);assert.equal(f.state.posts,2);
  assert.equal((await recovered.enqueue({key:f.key,kind:'voice',sourceId:'old-cover',file:'unused'})).state,'unconfirmed');
  assert.equal(f.state.posts,2);assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.equal((await recovered.enqueue({key:f.key,kind:'voice',sourceId:'fresh-request',file:'unused'})).sent,true);assert.equal(f.state.posts,2);
});

test('changing synthesis settings after submission does not prevent reading a late receipt or submit the audio again',async t=>{
  const f=fixture(t);f.state.confirm=false;
  const prior=await f.send();assert.equal(prior.state,'unconfirmed');
  f.settings.voice.emotion='warm';
  f.state.rows=[{localId:9,localType:34,isSend:true,fullText:'<msg><voicemsg voicelength="1000"/></msg>',createTime:Math.floor(Date.now()/1000),serverId:'999999999999999998'}];
  assert.equal((await f.service.refresh(prior.id,f.key,{wait:true})).sent,true);assert.equal(f.state.posts,1);
});

test('supplier final upload acknowledgement confirms without a local SQL row only when all bound fields match',async t=>{
 for(const invalid of [null,'account','target','durationMs','serverId','receipt']){
  const f=fixture(t);f.service.close();Object.assign(f.config.hook,{backend:'supplier-http',expectedVersion:'4.1.8.27'});
  Object.assign(f.state.main,{integration:'WeChatAgent-supplier-v1',provider:'supplier-http',version:'4.1.8.27',databaseAccounts:['wxid_self']});Object.assign(f.state.health,{version:'4.1.8.27',databaseAccounts:['wxid_self']});Object.assign(f.state.own,{backend:'supplier-http',accountDirectory:'wxid_self'});f.state.confirm=false;
  const service=createNativeVoiceDelivery({...f.options,fetchImpl:async(url,o)=>{
   if(!url.endsWith('/SendVoiceMsg'))return f.options.fetchImpl(url,o);
   const result={ret:0,confirmed:true,receipt:'wechat-uploadvoice-response',serverId:'5254719564166250390',account:'wxid_self',target:'wxid_friend',durationMs:1000};
   if(invalid)result[invalid]=invalid==='durationMs'?5000:'wrong';return Response.json(result);
  }});t.after(()=>service.close());
  const first=await service.enqueue({key:f.key,kind:'voice',sourceId:'final-ack',file:'fixture.wav'}),result=await service.settled(first.id,f.key);
  assert.equal(result.confirmed,!invalid,invalid??'valid');if(!invalid)assert.equal(result.receipt,'wechat-uploadvoice-response');
 }
});
test('account/version/process mismatch prevents native submission',async t=>{
  const f=fixture(t);
  for(const mutation of [()=>{f.state.health.pid=55;},()=>{f.state.health.version='4.1.15.13';},()=>{f.state.health.databaseAccounts=['other'];}]){
    Object.assign(f.state.health,{pid:44,version:'4.1.10.27',databaseAccounts:[f.state.own.accountDirectory]});mutation();
    assert.equal((await f.send(crypto.randomUUID())).sent,false);assert.equal(f.state.posts,0);
  }
});
test('revocation or account switch during conversion prevents submission',async t=>{
  const f=fixture(t);f.service.close();
  const service=createNativeVoiceDelivery({...f.options,convert:async()=>{f.settings.voice.enabled=false;return {silk:Buffer.from('silk'),durationMs:1000};}});t.after(()=>service.close());
  const result=await service.enqueue({key:f.key,kind:'voice',sourceId:'revoke',file:'unused'});assert.equal(result.sent,false);assert.equal(f.state.posts,0);
});
test('a generation context cannot be delivered from a different account',async t=>{
  const f=fixture(t),context=await f.service.capture(f.key,'singing');context.wxid='different';
  assert.equal((await f.send('switched',{context})).sent,false);assert.equal(f.state.posts,0);
});
test('wrong message type, old rows and missing server receipt never confirm a voice send',async t=>{
  const f=fixture(t);f.state.confirm=false;
  f.state.rows=[{localId:2,localType:34,isSend:true,fullText:`<msg><voicemsg voicelength="1000"/></msg>`,createTime:Math.floor(Date.now()/1000),serverId:'333'}];
  const result=await f.send();assert.equal(result.sent,false);assert.equal(result.state,'unconfirmed');
});
test('real WAV conversion produces a bounded valid SILK clip',async t=>{
  const f=fixture(t),file=path.join(f.root,'tone.wav'),pcm=Buffer.alloc(24000*2);for(let i=0;i<24000;i++)pcm.writeInt16LE(Math.round(1200*Math.sin(2*Math.PI*440*i/24000)),i*2);
  const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(24000,24);h.writeUInt32LE(48000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);fs.writeFileSync(file,Buffer.concat([h,pcm]));
  const result=await audioFileToSilk(file);assert.equal(result.durationMs,1000);assert.ok(result.silk.includes(Buffer.from('#!SILK_V3')));
});

test('console recovers a completed song and returns its pending receipt promptly after restart without sending again',async t=>{
  const f=fixture(t),jobId=crypto.randomUUID();f.state.confirm=false;
  const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));
  config.hook={...config.hook,backend:'supplier-http',baseUrl:f.config.hook.baseUrl,voiceBaseUrl:f.config.hook.baseUrl,expectedVersion:'4.1.8.27'};config.wechat.whitelist=f.config.wechat.whitelist;
  Object.assign(f.config,{hook:config.hook,wechat:config.wechat});
  Object.assign(f.state.main,{integration:'WeChatAgent-supplier-v1',provider:'supplier-http',version:'4.1.8.27',databaseAccounts:['wxid_self']});
  Object.assign(f.state.health,{version:'4.1.8.27',databaseAccounts:['wxid_self']});Object.assign(f.state.own,{backend:'supplier-http',accountDirectory:'wxid_self'});
  const created=await f.service.enqueue({key:f.key,kind:'singing',sourceId:jobId,file:'cover.mp3'});
  assert.equal((await f.service.settled(created.id,f.key)).state,'unconfirmed');f.service.close();
  fs.mkdirSync(path.join(f.root,'config'),{recursive:true});fs.writeFileSync(path.join(f.root,'config/wechatagent.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(f.root,'state/wechat-io-config.json'),JSON.stringify({reader_token:'reader-fixture'}));
  fs.writeFileSync(path.join(f.root,'state/voice-output/capabilities.json'),JSON.stringify({singing:{provider:'feiyu-rvc',enabled:true,chats:[f.key]}}));
  const output=path.join(f.root,'state/music-jobs',jobId);fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'preview.mp3'),'ID3fixture');
  const accountScope='b'.repeat(64);fs.mkdirSync(path.join(f.root,'state/weflow'),{recursive:true});fs.writeFileSync(path.join(f.root,'state/weflow/active-account.json'),JSON.stringify({id:accountScope}));
  fs.writeFileSync(path.join(output,'job.json'),JSON.stringify({version:1,id:jobId,state:'success',stage:'试听已生成',sourceKind:'video',conversationKey:f.key,accountScope,seconds:30,startedAt:new Date().toISOString(),completedAt:new Date().toISOString()}));
  let release,entered,reads=0;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const app=createConsole({root:f.root,port:0,fetchImpl:async(url,options)=>{
    const u=new URL(url);if(u.port==='5031'){
      if(u.pathname.includes('/messages')){reads++;entered();await gate;}
      return Response.json(await f.options.reader(u.pathname+u.search));
    }return f.options.fetchImpl(url,options);
  }});t.after(()=>{release();app.close();});
  const address=await app.start(),origin='http://127.0.0.1:'+address.port;
  const {token}=await fetch(origin+'/api/info').then(r=>r.json()),headers={'X-Console-Token':token};
  const get=()=>fetch(origin+'/api/audio-capabilities/music/jobs/'+jobId,{headers,signal:AbortSignal.timeout(2000)}).then(r=>r.json());
  const status=await get();assert.equal(status.state,'success');assert.equal(status.delivery.state,'unconfirmed');assert.equal(status.sent,false);
  await Promise.race([started,delay(250).then(async()=>assert.fail(JSON.stringify((await get()).delivery)))]);assert.equal(reads,1);assert.equal(f.state.posts,1);
  f.state.rows=[{localId:8,localType:34,isSend:true,fullText:'<msg><voicemsg voicelength="1000"/></msg>',createTime:Math.floor(Date.now()/1000),serverId:'999999999999999997'}];release();
  let result;for(let i=0;i<30;i++){result=await get();if(result.sent)break;await delay(5);}
  assert.equal(result.sent,true);assert.equal(f.state.posts,1);
  const latest=()=>fetch(origin+'/api/audio-capabilities/music/latest?conversationKey='+encodeURIComponent(f.key),{headers}).then(r=>r.json());
  assert.equal((await latest()).id,jobId);
  fs.writeFileSync(path.join(f.root,'state/weflow/active-account.json'),JSON.stringify({id:'c'.repeat(64)}));assert.equal((await latest()).state,'none');assert.equal(f.state.posts,1);
});

test('console voice endpoint generates, converts and confirms a scoped reply, while retries and preview do not duplicate sends',async t=>{
  const f=fixture(t),key=f.key;
  Object.assign(f.config.hook,{backend:'supplier-http',expectedVersion:'4.1.8.27',voiceBaseUrl:f.config.hook.baseUrl});
  Object.assign(f.state.main,{integration:'WeChatAgent-supplier-v1',provider:'supplier-http',version:'4.1.8.27',databaseAccounts:['wxid_self']});
  Object.assign(f.state.health,{version:'4.1.8.27',databaseAccounts:['wxid_self']});
  Object.assign(f.state.own,{backend:'supplier-http',accountDirectory:'wxid_self'});f.state.integerIsSend=true;
  fs.mkdirSync(path.join(f.root,'config'),{recursive:true});
  const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));config.hook={...config.hook,...f.config.hook};config.wechat.whitelist=f.config.wechat.whitelist;
  fs.writeFileSync(path.join(f.root,'config/wechatagent.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(f.root,'state/wechat-io-config.json'),JSON.stringify({reader_token:'reader-fixture'}));
  fs.mkdirSync(path.join(f.root,'state/voice-output'),{recursive:true});
  fs.writeFileSync(path.join(f.root,'state/voice-output/capabilities.json'),JSON.stringify({voice:{provider:'feiyu',enabled:true,chats:[key]}}));
  const runtime=path.join(f.root,'state/maintenance/audio-capabilities/feiyu-tts'),data=path.join(runtime,'service-data');fs.mkdirSync(data,{recursive:true});
  fs.writeFileSync(path.join(runtime,'voice-service.json'),JSON.stringify({schema:'feiyu-voice-service-v1',data_dir:data}));
  fs.writeFileSync(path.join(data,'api_key.txt'),'managed-tts-fixture');
  const pcm=Buffer.alloc(48000),wav=Buffer.alloc(48044);wav.write('RIFF');wav.writeUInt32LE(48036,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);
  let generated=0,converted=0;
  const voice=createVoiceExecutor({root:f.root,speechRvc:{available:()=>true,convert:async({audio,modelId})=>{converted++;assert.deepEqual(audio,wav);assert.equal(modelId,'FeiyuVoice-RVC-v1');return {audio:audio.toString('base64'),mime:'audio/wav',runtimeRvc:true};}},fetchImpl:async(url,options)=>{
    const u=new URL(url);assert.equal(u.port,'9880');assert.equal(options.headers.Authorization,'Bearer managed-tts-fixture');
    if(u.pathname==='/v1/speech'){generated++;return Response.json({id:'job-fixture'});}
    if(u.pathname.endsWith('/audio'))return new Response(wav);return Response.json({status:'success'});
  }});t.after(()=>voice.close());
  const app=createConsole({root:f.root,port:0,capabilityExecution:(operation,payload,options)=>voice[operation.slice(6)](payload,options),fetchImpl:async(url,options)=>{
    const u=new URL(url);
    if(u.port==='9880'){
      assert.equal(options.headers.Authorization,'Bearer managed-tts-fixture');
      if(u.pathname==='/v1/speech'){generated++;return Response.json({id:'job-fixture'});}
      if(u.pathname.endsWith('/audio'))return new Response(wav);return Response.json({status:'success'});
    }
    if(u.port==='5031')return Response.json(await f.options.reader(u.pathname+u.search));
    return f.options.fetchImpl(url,options);
  }});
  const address=await app.start();t.after(()=>app.close());const origin='http://127.0.0.1:'+address.port;
  const {token}=await fetch(origin+'/api/info').then(r=>r.json()),requestId=crypto.randomUUID(),body={conversationKey:key,text:'Hello',requestId};
  const post=(route,body)=>fetch(origin+route,{method:'POST',headers:{'X-Console-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await fetch(origin+'/api/audio-capabilities/voice/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);
  assert.equal((await post('/api/audio-capabilities/voice/request',{...body,conversationKey:'wechat:private:999'})).status,403);
  const response=await post('/api/audio-capabilities/voice/request',body),result=await response.json();assert.equal(response.status,202,JSON.stringify(result));assert.match(result.id,/^[a-f0-9]{64}$/);
  assert.equal(result.state,'confirmed');assert.equal(result.sent,true,'the tool must receive the final delivery receipt in its initial response');
  let status;
  for(let i=0;i<80;i++){
    status=await fetch(origin+'/api/audio-capabilities/voice/deliveries/'+result.id+'?conversationKey='+encodeURIComponent(key),{headers:{'X-Console-Token':token}}).then(r=>r.json());
    if(status.sent)break;await delay(5);
  }
  assert.equal(status.sent,true);assert.equal(f.state.posts,1);
  assert.equal((await (await post('/api/audio-capabilities/voice/request',body)).json()).sent,true);assert.equal(f.state.posts,1);assert.equal(generated,1);assert.equal(converted,1);
  const saved=await fetch(origin+'/api/audio-capabilities',{headers:{'X-Console-Token':token}}).then(r=>r.json());
  const preview=await post('/api/audio-capabilities/voice/preview',{revision:saved.revision,text:'Preview'});assert.equal(preview.status,200);assert.equal((await preview.json()).sent,false);assert.equal(f.state.posts,1);assert.equal(converted,2);
  f.state.confirm=false;f.state.rejectReply=true;
  const failedBody={...body,requestId:crypto.randomUUID()},failed=await (await post('/api/audio-capabilities/voice/request',failedBody)).json();
  assert.equal(failed.state,'failed');assert.equal(failed.sent,false);assert.equal(failed.code,'NATIVE_VOICE_REJECTED');
  const count=generated;assert.equal((await (await post('/api/audio-capabilities/voice/request',failedBody)).json()).state,'failed');assert.equal(generated,count);assert.equal(f.state.posts,2);
});
