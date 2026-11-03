import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import crypto from 'node:crypto';
import {createMemeLibrary,bindMemeLibrary,memeImageRoute,extractMemeImages} from '../packages/dsh-social-bridge-plugin/meme-library.mjs';
import {MEME_LIBRARY_POLICY,memeLibraryPolicy} from '../packages/dsh-social-bridge-plugin/meme-library-policy.mjs';
import {DshPluginClient} from '../components/qq-bridge/src/dsh/plugin-client.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {applyBuiltinUpdate,builtinCatalog} from './extension-status.mjs';
const key='wechat:private:123',id='a'.repeat(64),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
function fixture(t,{pending=false,legacyReader=false,recognitionFailed=false,wrongPreview=false,uploadFailed=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-meme-test-'));t.after(()=>{assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});});fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'state'));
  const config={wechat:{whitelist:{private:['123'],groups:[]},stickers:{enabled:true},memeLibrary:{enabled:true,allowImport:false},search:{enabled:true}}};
  const save=()=>fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));save();fs.writeFileSync(path.join(root,'state/wechat-io-config.json'),JSON.stringify({reader_base_url:'http://127.0.0.1:5031',reader_token:'fixture'}));
  const calls=[],fetchImpl=async(input,options={})=>{
    const url=new URL(input),body=options.body?JSON.parse(options.body):null;calls.push({url,body});
    if(url.pathname==='/dsh-memes-api'&&body?.op==='getMemeRoot')return Response.json({ok:true,packId:'enabled',packs:[{id:'enabled'},{id:'disabled'}],enabledPacks:['enabled']});
    if(url.pathname==='/dsh-memes-api'&&!body)return Response.json({ok:true,memes:[{url:'/dsh-memes/enabled/memes/happy/a.png',caption:'猫猫比心',tag:'happy'}]});
    if(url.pathname==='/dsh-memes/enabled/memes/happy/a.png')return new Response(png);
    if(url.pathname==='/api/v1/stickers/import')return Response.json(legacyReader?{admitted:false,pending:true}:pending?{ready:true,admitted:false,pending:true,id,collection:'review-pending'}:{ready:true,admitted:true,id,collection:'saved'});
    if(url.pathname==='/api/v1/stickers/inspect'){const data=Buffer.from([255,216,255,217]);return Response.json({conversationKey:wrongPreview?'wechat:private:999':body.conversationKey,mime:'image/jpeg',b64:data.toString('base64'),sha256:crypto.createHash('sha256').update(data).digest('hex')});}
    if(url.pathname==='/dsh-memes-api'&&body?.op==='upload')return uploadFailed?Response.json({ok:false},{status:503}):Response.json({ok:true});
    if(url.pathname==='/dsh-memes-api'&&body?.op==='recognize')return recognitionFailed?Response.json({ok:false,error:'fixture invalid image request'},{status:400}):Response.json({ok:true,tag:'happy',caption:'已识别的猫猫比心',keywords:'猫 比心'});
    throw Error('unexpected fixture request');
  };
  const library=createMemeLibrary({ctx:{get:()=>({port:19387})},root,fetchImpl,download:async()=>({buffer:png}),readPage:async url=>({url,body:'<img src="https://cdn.example.com/cat.png" alt="猫 比心">'})});
  return {root,config,save,calls,library};
}
test('meme policy needs an allowed chat, explicit integration and sticker sending',()=>{
  const w={whitelist:{private:['123'],groups:[]},memeLibrary:{enabled:true},stickers:{enabled:true}};
  assert(memeLibraryPolicy(w,key).enabled);assert(!memeLibraryPolicy(w,'wechat:private:456').enabled);w.stickers.enabled=false;assert(!memeLibraryPolicy(w,key).enabled);
});

test('stable meme guidance survives per-turn availability changes without publishing disabled tools',t=>{
 const f=fixture(t),tools=new Map(),ctx={tools:{register(def){tools.set(def.name,def);return()=>tools.delete(def.name);}}};let turn={controller:new AbortController(),calls:0,choices:[]};
 const dispose=bindMemeLibrary(ctx,f.library,f.root,key,()=>turn),stable=dispose.instructions({stable:true});assert(stable.includes('本轮实际提供'));
 turn={...turn,disabled:true};assert.equal(dispose.instructions({stable:true}),stable);assert.equal(dispose.instructions(),'');assert.equal(ctx[MEME_LIBRARY_POLICY].names().size,0);
 turn.controller.abort();assert.equal(dispose.instructions({stable:true}),stable);assert.equal(ctx[MEME_LIBRARY_POLICY].names().size,0);
 f.config.wechat.memeLibrary.enabled=false;f.save();assert.equal(dispose.instructions({stable:true}),'');dispose();
});
test('library search only reads enabled packs; selected bytes use the account reader import endpoint',async t=>{
  const f=fixture(t),items=await f.library.search(key,'猫 比心');assert.equal(items.length,1);assert(f.calls.every(call=>call.url.searchParams.get('packId')!=='disabled'));
  const selected=await f.library.select(key,items[0]);assert.equal(selected.id,id);assert.equal(selected.source,'dsh-meme');
  const imported=f.calls.find(call=>call.url.pathname==='/api/v1/stickers/import');assert.equal(imported.body.conversationKey,key);assert.equal(imported.body.b64,png.toString('base64'));assert.equal(imported.body.description,'猫猫比心');
});
test('a full pool still prepares current-turn sending while collection waits for review',async t=>{
  const f=fixture(t,{pending:true}),tools=new Map(),turn={controller:new AbortController(),calls:0,choices:[]};
  bindMemeLibrary({tools:{register(def){tools.set(def.name,def);return()=>{};}}},f.library,f.root,key,()=>turn);
  const items=JSON.parse((await tools.get('wechat_meme_search').execute({query:'猫'})).content).candidates;
  const result=await tools.get('wechat_meme_select').execute({candidateId:items[0].candidateId});
  assert.equal(result.isError,false);assert.equal(turn.choices[0].id,id);assert.equal(turn.choices[0].collection,'review-pending');
  assert.equal(JSON.parse(result.content).reply,'RESPOND: [STICKER:'+id+']');
});
test('an old reader cannot pretend that an unprepared pending item is sendable',async t=>{
  const f=fixture(t,{legacyReader:true}),items=await f.library.search(key,'猫');await assert.rejects(f.library.select(key,items[0]),/READER_UPDATE_REQUIRED/);
});
test('gallery upload failure does not discard a verified current-send resource',async t=>{
  const f=fixture(t,{pending:true,uploadFailed:true});f.config.wechat.memeLibrary.allowImport=true;f.save();
  const selected=await f.library.importUrl(key,{imageUrl:'https://example.com/cat.png',description:'猫',query:'猫'});
  assert.equal(selected.id,id);assert.equal(selected.collection,'review-pending');assert.equal(selected.librarySaved,false);
});
test('network import requires both explicit opt-in and current conversation search permission',async t=>{
  const f=fixture(t);await assert.rejects(f.library.importUrl(key,{imageUrl:'https://example.com/a.png',description:'测试'}),/IMPORT_DISABLED/);
  f.config.wechat.memeLibrary.allowImport=true;f.save();const item=await f.library.importUrl(key,{imageUrl:'https://example.com/a.png',description:'猫猫',query:'猫'});assert.equal(item.id,id);assert(f.calls.some(call=>call.body?.op==='upload'));
  f.config.wechat.search.enabled=false;f.save();await assert.rejects(f.library.importUrl(key,{imageUrl:'https://example.com/a.png'}),/IMPORT_DISABLED/);
});
test('resource routes reject traversal, unrelated endpoints and encoded escapes',()=>{
  for(const value of ['http://localhost/a','/dsh-memes-api','/dsh-memes/../x','/dsh-memes/%2e%2e/x','/dsh-memes/%252e%252e/x','/dsh-memes/a?x=1'])assert.throws(()=>memeImageRoute(value));
});
test('new image model rejection never admits or publishes an unusable image',async t=>{
  const f=fixture(t,{recognitionFailed:true});f.config.wechat.memeLibrary.allowImport=true;f.save();
  await assert.rejects(f.library.importUrl(key,{imageUrl:'https://example.com/cat.png',description:'猫',query:'猫'}),/MEME_RECOGNITION_FAILED/);
  assert(!f.calls.some(call=>call.url.pathname==='/api/v1/stickers/import'||call.body?.op==='upload'));assert(f.calls.some(call=>call.body?.op==='recognize'&&call.body.fileName.endsWith('.jpg')));
});
test('preview identity and integrity are checked before submitting image material to the model',async t=>{
  const f=fixture(t,{wrongPreview:true});f.config.wechat.memeLibrary.allowImport=true;f.save();
  await assert.rejects(f.library.importUrl(key,{imageUrl:'https://example.com/cat.gif',description:'猫',query:'猫'}),/MEME_INVALID_PREVIEW/);
  assert(!f.calls.some(call=>call.body?.op==='recognize'||call.url.pathname==='/api/v1/stickers/import'));
});
test('page discovery is limited to this turn search sources before a new image is downloaded and recognized',async t=>{
  const f=fixture(t);f.config.wechat.memeLibrary.allowImport=true;f.save();const tools=new Map(),ctx={tools:{register(def){tools.set(def.name,def);return()=>{};}}};
  let turn={controller:new AbortController(),calls:0,choices:[],allowedUrls:new Set(['https://example.com/page'])};bindMemeLibrary(ctx,f.library,f.root,key,()=>turn);
  assert.equal((await tools.get('wechat_meme_search').execute({query:'猫',sourceUrl:'https://other.example.com/unknown'})).isError,true);assert.equal(f.calls.length,0);
  const result=JSON.parse((await tools.get('wechat_meme_search').execute({query:'猫',sourceUrl:'https://example.com/page'})).content);assert.equal(result.candidates[0].origin,'web');
  const selected=await tools.get('wechat_meme_select').execute({candidateId:result.candidates[0].candidateId});assert.equal(selected.isError,false);assert.equal(turn.choices[0].id,id);assert(f.calls.some(call=>call.body?.op==='recognize'));
});
test('search pages yield bounded public image candidates, without running scripts or treating metadata as visual verification',()=>{
  const items=extractMemeImages('<meta property="og:image" content="https://cdn.example.com/cat.gif"><img src="data:image/png;base64,xx"><img src="/cat.png" alt="猫 比心"><script>fetch("https://example.com/no")</script>','https://example.com/page','猫');
  assert.equal(items.length,2);assert.equal(items[0].visualVerified,false);assert.equal(items[1].imageUrl,'https://example.com/cat.png');
});
test('tool candidates belong only to the current turn, and selected resources travel out of band',async t=>{
  const f=fixture(t),tools=new Map(),ctx={tools:{register(def){tools.set(def.name,def);return()=>tools.delete(def.name);}}};let turn={controller:new AbortController(),calls:0,choices:[]};
  const dispose=bindMemeLibrary(ctx,f.library,f.root,key,()=>turn);assert(ctx[MEME_LIBRARY_POLICY].names().has('wechat_meme_search'));assert(!ctx[MEME_LIBRARY_POLICY].names().has('wechat_meme_import'));
  const searched=JSON.parse((await tools.get('wechat_meme_search').execute({query:'猫'})).content);assert.equal(searched.candidates.length,1);
  const result=await tools.get('wechat_meme_select').execute({candidateId:searched.candidates[0].candidateId});assert.equal(result.isError,false);assert.equal(turn.choices[0].id,id);
  turn={controller:new AbortController(),calls:0,choices:[]};assert.equal((await tools.get('wechat_meme_select').execute({candidateId:searched.candidates[0].candidateId})).isError,true);
  f.config.wechat.memeLibrary.enabled=false;f.save();assert.equal(ctx[MEME_LIBRARY_POLICY].names().size,0);dispose();assert.equal(tools.size,0);
});
test('integration controls preserve other config and validate per-chat and import switches',t=>{
  const f=fixture(t),next=applyBuiltinUpdate(f.config,'dsh-meme',{enabled:true,chatSettings:{[key]:true},settings:{allowImport:true}});
  assert.equal(next.wechat.memeLibrary.allowImport,true);assert.equal(next.wechat.memeLibrary.chats[key],true);assert.deepEqual(next.wechat.search,f.config.wechat.search);
  assert(builtinCatalog(next,'fixture',false).extensions.some(item=>item.id==='dsh-meme'));assert.throws(()=>applyBuiltinUpdate(f.config,'dsh-meme',{enabled:true,chatSettings:{'wechat:private:999':true}}));
});
test('ready Bridge candidates send in one model decision with bounded prompt overhead',async t=>{
  const f=fixture(t),sent=[],texts=[],requests=[];
  const choices=['a','b','c'].map(letter=>({id:letter.repeat(64),description:'猫猫比心',tags:['happy']}));
  const buffer=new MessageBuffer(path.join(f.root,'ready-candidate-buffer.json'));
  const engine=new SocialEngine({buffer,batchMs:1,privateMinIntervalMs:0,
    stickerPolicyFor:()=>({enabled:true,labelCache:true}),stickerChoicesFor:async()=>choices,
    modelSearchReady:async()=>true,searchPolicyFor:()=>({enabled:true}),
    decide:async(_key,prompt,meta)=>{requests.push({prompt,meta});return 'RESPOND: [STICKER:S1]';},
    send:async(_target,value)=>texts.push(value),
    sendSticker:async(_target,selected)=>{sent.push(selected);return {delivered:'database-confirmed'};},
  });
  t.after(()=>engine.stop());
  engine.receive({platform:'wechat',kind:'private',conversation_id:'123',sender_id:'123',message_id:'ready-candidate',text:'发个猫猫比心表情',timestamp:Date.now()/1000});
  for(let i=0;i<150&&!sent.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(buffer.unread(key).length,0);
  assert.equal(requests.length,1,'ready candidates must not require a format-repair or selection turn');
  assert.deepEqual(sent,[id]);assert.deepEqual(texts,[]);
  assert(requests[0].prompt.includes('无需图库搜索或选图工具'));
  assert(requests[0].prompt.includes('<untrusted_chat>'));
  assert(requests[0].prompt.length<600,'fixed wrapper must stay bounded for a short message and three labelled candidates');
  assert.deepEqual(requests[0].meta.images,[]);
});

test('DSH-selected media becomes an approved native send, without leaking a marker as text',async t=>{
  const f=fixture(t),choice={id,description:'猫猫比心',tags:['happy'],source:'dsh-meme'},sent=[],texts=[];
  const server=http.createServer(async(req,res)=>{for await(const _chunk of req){}res.setHeader('content-type','application/json');res.end(JSON.stringify({text:'RESPOND: [STICKER:'+id+']',memeChoices:[choice]}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const client=new DshPluginClient({url:'http://127.0.0.1:'+server.address().port,token:'fixture'});
  const engine=new SocialEngine({buffer:new MessageBuffer(path.join(f.root,'messages.json')),batchMs:1,privateMinIntervalMs:0,stickerPolicyFor:()=>({enabled:true,labelCache:true}),decide:(k,prompt,meta)=>client.followup(k,prompt,meta),send:async(_target,text)=>texts.push(text),sendSticker:async(_target,selected)=>{sent.push(selected);return {delivered:'database-confirmed'};}});t.after(()=>engine.stop());
  engine.receive({platform:'wechat',kind:'private',conversation_id:'123',sender_id:'123',message_id:'fixture-meme',text:'来张猫猫比心',timestamp:Date.now()/1000});
  for(let i=0;i<150&&sent.length===0;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(sent,[id]);assert.deepEqual(texts,[]);
});
