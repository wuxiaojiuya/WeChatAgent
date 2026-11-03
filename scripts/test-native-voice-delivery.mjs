import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createNativeVoiceDelivery,audioFileToSilk} from './native-voice-delivery.mjs';
import {conversationId} from './hook-onebot.mjs';
import {createConsole} from './console-server.mjs';
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
      assert.equal(url,(config.hook.backend==='supplier-http'?config.hook.baseUrl:config.hook.voiceBaseUrl)+'/SendVoiceMsg');assert.equal(o.headers['X-WeChatAgent-Account'],state.own.accountDirectory);
      const body=JSON.parse(o.body);assert.equal(body.wxidorgid,target);assert.equal(body.duration,1000);assert.match(body.path,/\.silk$/);
      state.posts++;
      const saved=JSON.parse(fs.readFileSync(body.path.replace(/\.silk$/,'.json'),'utf8'));assert.equal(saved.state,'dispatching');assert.ok(Array.isArray(saved.baseline));
      if(state.confirm)state.rows=[{localId:2,localType:34,isSend:state.integerIsSend?1:true,fullText:`<msg><voicemsg voicelength="1000"/></msg>`,createTime:Math.floor(Date.now()/1000),serverId:'8047442179716189588'}];
      if(state.failReply)throw Error('socket lost');return Response.json({ret:0});
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
  assert.equal((await f.service.check()).ready,true);
  const result=await f.send();assert.equal(result.sent,true);assert.equal(f.state.posts,1);
  assert.equal((await f.send()).sent,true);assert.equal(f.state.posts,1);
  const sing=await f.service.enqueue({key:f.key,kind:'singing',file:'cover.mp3',sourceId:'cover'});
  f.state.rows=[];assert.equal((await f.service.settled(sing.id,f.key)).sent,true);assert.equal(f.state.posts,2);
});
test('timeout and restart never resubmit; late receipt can be reconciled',async t=>{
  const f=fixture(t);f.state.confirm=false;f.state.failReply=true;
  const result=await f.send();assert.equal(result.state,'unconfirmed');assert.equal(result.sent,false);
  f.service.close();const recovered=createNativeVoiceDelivery(f.options);t.after(()=>recovered.close());
  await recovered.enqueue({key:f.key,kind:'voice',sourceId:'test',file:'unused'});assert.equal(f.state.posts,1);
  f.state.rows=[{localId:8,localType:34,isSend:true,fullText:`<msg><voicemsg voicelength="1000"/></msg>`,createTime:Math.floor(Date.now()/1000),serverId:'999999999999999999'}];
  assert.equal((await recovered.refresh(result.id,f.key)).sent,true);assert.equal(f.state.posts,1);
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

test('console voice endpoint generates, converts and confirms a scoped reply, while retries and preview do not duplicate sends',async t=>{
  const f=fixture(t),key=f.key;
  fs.mkdirSync(path.join(f.root,'config'),{recursive:true});
  const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));config.hook={...config.hook,...f.config.hook};config.wechat.whitelist=f.config.wechat.whitelist;
  fs.writeFileSync(path.join(f.root,'config/wechatagent.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(f.root,'state/wechat-io-config.json'),JSON.stringify({reader_token:'reader-fixture'}));
  fs.mkdirSync(path.join(f.root,'state/voice-output'),{recursive:true});
  fs.writeFileSync(path.join(f.root,'state/voice-output/capabilities.json'),JSON.stringify({voice:{provider:'feiyu',enabled:true,chats:[key],apiKey:'tts-fixture'}}));
  const pcm=Buffer.alloc(48000),wav=Buffer.alloc(48044);wav.write('RIFF');wav.writeUInt32LE(48036,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);
  let generated=0;
  const app=createConsole({root:f.root,port:0,fetchImpl:async(url,options)=>{
    const u=new URL(url);
    if(u.port==='9880'){
      assert.equal(options.headers.Authorization,'Bearer tts-fixture');
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
  let status;
  for(let i=0;i<80;i++){
    status=await fetch(origin+'/api/audio-capabilities/voice/deliveries/'+result.id+'?conversationKey='+encodeURIComponent(key),{headers:{'X-Console-Token':token}}).then(r=>r.json());
    if(status.sent)break;await delay(5);
  }
  assert.equal(status.sent,true);assert.equal(f.state.posts,1);
  assert.equal((await (await post('/api/audio-capabilities/voice/request',body)).json()).sent,true);assert.equal(f.state.posts,1);assert.equal(generated,1);
  const saved=await fetch(origin+'/api/audio-capabilities',{headers:{'X-Console-Token':token}}).then(r=>r.json());
  const preview=await post('/api/audio-capabilities/voice/preview',{revision:saved.revision,text:'Preview'});assert.equal(preview.status,200);assert.equal((await preview.json()).sent,false);assert.equal(f.state.posts,1);
});
