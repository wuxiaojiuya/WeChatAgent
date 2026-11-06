import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {turnImages} from '../components/qq-bridge/src/core/image-context.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {imageBlocks} from '../packages/dsh-social-bridge-plugin/image-input.mjs';

const id = 'a'.repeat(64), otherId = 'b'.repeat(64), key = 'wechat:private:123';
const now = Date.now();
const base = {platform:'wechat',kind:'private',conversation_id:'123',self_id:'self',sender_id:'123',sender_wxid:'wxid_friend',timestamp:(now-1000)/1000};
const picture = {...base,id:'picture',text:'[图片]',images:[{id}]};
const request = {...base,id:'followup',text:'描述一下',images:[],timestamp:now/1000};

test('image follow-ups re-read recent ordinary images while ordinary chat stays text-only', () => {
  for (const text of ['描述一下','请详细描述一下','这张图里有什么','她的头发什么颜色','describe this picture']) {
    assert.deepEqual(turnImages([{...request,text}],[picture,request],{now}),[{id,context:'recent'}]);
  }
  for (const text of ['早上好','你会唱歌吗','给我讲个笑话','今天吃什么']) {
    assert.deepEqual(turnImages([{...request,text}],[picture,request],{now}),[]);
  }
});

test('current pictures and explicit quote targets never get replaced by an earlier picture', () => {
  const current = {...request,images:[{id:otherId,context:'quote'}],quoteReply:{reference:{kind:'image'}}};
  assert.deepEqual(turnImages([current],[picture,current],{now}),current.images);
  for (const target of [{quoteReply:{reference:{kind:'text'}}},{video:{id:otherId}},{files:[{id:otherId}]},
    {forwardedRecord:{items:[]}},{text:'看看这张图 https://example.com/picture'},{images:[{id:'C:/private.png'}]}]) {
    assert.deepEqual(turnImages([{...request,...target}],[picture,request],{now}),[]);
  }
});

test('recent images remain bound to account, conversation, sender, work mode and freshness', () => {
  for (const change of [{self_id:'other'},{self_id:''},{platform:'qq'},{conversation_id:'456'},{sender_wxid:'other'},
    {work_mode:'assistant'}]) {
    assert.deepEqual(turnImages([{...request,...change}],[picture],{now}),[]);
  }
  assert.deepEqual(turnImages([request],[{...picture,timestamp:(now-600001)/1000}],{now}),[]);
  assert.deepEqual(turnImages([request],[{...picture,timestamp:(now+1000)/1000}],{now}),[]);
  assert.deepEqual(turnImages([request],[{...picture,reply_skip_reason:'dsh_offline'}],{now}),[]);
  const group = {...picture,kind:'group'}, groupRequest = {...request,kind:'group'};
  assert.deepEqual(turnImages([groupRequest],[group],{now}),[{id,context:'recent'}]);
  assert.deepEqual(turnImages([{...groupRequest,sender_wxid:'another-member'}],[group],{now}),[]);
  assert.deepEqual(turnImages([{...groupRequest,sender_wxid:undefined}],[{...group,sender_wxid:undefined}],{now}),[]);
});

test('a later media target blocks an older image and future queued images are never substituted', () => {
  for (const target of [{images:[{id:otherId,kind:'sticker'}]},{video:{id:otherId},images:[{id:otherId}]},
    {images:[{id:otherId}],sender_wxid:'another-member'},{images:[{id:otherId,context:'quote'}]},
    {images:[],text:'[图片]'},{images:[],text:'https://example.com/item'},{images:[{id:'invalid'}]}]) {
    const newer = {...picture,id:'newer',...target};
    assert.deepEqual(turnImages([request],[picture,newer,request],{now}),[]);
  }
  assert.deepEqual(turnImages([request],[picture,request,{...picture,id:'future',images:[{id:otherId}]}],{now}),[{id,context:'recent'}]);
  assert.deepEqual(turnImages([request],[picture,...Array.from({length:20},(_,i)=>({...base,id:'text'+i,text:'聊天'})),request],{now}),[]);
});

async function until(predicate) {
  const deadline = Date.now()+3000;
  while (!predicate() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,5));
  assert(predicate(),'bridge did not finish the isolated request');
}

function fixture(t,decide) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'wechat-image-followup-'));
  const buffer = new MessageBuffer(path.join(root,'messages.json'));
  const engine = new SocialEngine({buffer,privateMinIntervalMs:0,batchMs:1,maxPerMinute:100,maxPerTenMinutes:100,
    stickerPolicyFor:()=>({enabled:false}),decide,send:()=>assert.fail('isolated image test must not send messages')});
  t.after(()=>{engine.stop();fs.rmSync(root,{recursive:true,force:true});});
  const old = buffer.append({...base,message_id:'original',text:'[图片]',images:[{id}]});
  buffer.markProcessed(key,old.id);
  return {root,buffer,engine,old};
}

test('actual bridge follow-up metadata fetches and attaches the original image bytes', async t => {
  const bytes = Buffer.from('verified previous image bytes'),saved=[],inputs=[];
  const f = fixture(t,async(_key,prompt,meta)=>{
    inputs.push({prompt,meta});
    const blocks = await imageBlocks({get:name=>name==='llm'?{resolveModelInfo:async()=>({inputModalities:['image']})}:
      {saveImage:async image=>{saved.push(image.data);return {attachmentId:'sha256:fixture'};}}},f.root,key,meta.images,'fixture','vision');
    assert(blocks.some(block=>block.type==='image'));
    return 'SILENT';
  });
  const server = http.createServer((req,res)=>{
    assert.equal(req.url,'/api/v1/images/'+id);assert.equal(req.headers.authorization,'Bearer fixture');
    res.setHeader('content-type','application/json');res.end(JSON.stringify({imageId:id,conversationKey:key,mime:'image/jpeg',
      b64:bytes.toString('base64'),sha256:crypto.createHash('sha256').update(bytes).digest('hex')}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));});
  fs.mkdirSync(path.join(f.root,'state'));
  fs.writeFileSync(path.join(f.root,'state/wechat-io-config.json'),JSON.stringify({reader_base_url:'http://127.0.0.1:'+server.address().port,reader_token:'fixture'}));
  // A previous unrelated video must not become the target of this image question.
  f.buffer.chats.get(key).unshift({...f.old,id:'older-video',video:{id:otherId},images:[]});
  f.engine.receive({...base,message_id:'question',text:'描述一下'});
  await until(()=>inputs.length===1&&!f.engine.running.size);
  assert.deepEqual(inputs[0].meta.images,[{id,context:'recent'}]);assert.deepEqual(inputs[0].meta.videos,[]);
  assert.match(inputs[0].prompt,/最近图片/);assert.match(inputs[0].prompt,/历史记录中的附件占位不代表本轮图片读取失败/);
  assert.equal(saved.length,1);assert.deepEqual(saved[0],bytes);assert.equal(f.buffer.unread(key).length,0);
});

test('persisted bridge retries preserve the image and batch identity after the source image expires', async t => {
  const calls=[];
  const f = fixture(t,async(_key,prompt,meta)=>{
    calls.push({prompt,meta:structuredClone(meta)});
    if (calls.length===1) throw Object.assign(Error('fixture transport lost'),{admitted:false});
    return 'SILENT';
  });
  f.engine.receive({...base,message_id:'question',text:'描述一下'});
  await until(()=>calls.length===1&&!f.engine.running.size);
  assert.equal(f.buffer.pendingRequests.size,1);
  f.old.timestamp = (Date.now()-660000)/1000;
  f.engine.replay(key);
  await until(()=>calls.length===2&&!f.engine.running.size);
  assert.deepEqual(calls[0],calls[1]);assert.deepEqual(calls[1].meta.images,[{id,context:'recent'}]);
  assert.equal(f.buffer.pendingRequests.size,0);
});
