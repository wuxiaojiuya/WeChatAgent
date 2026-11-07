import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import {VoiceIngress} from '../components/qq-bridge/src/core/voice-ingress.js';
import {createVideoIngress,douyinLink,turnVideos} from '../components/qq-bridge/src/core/video-ingress.js';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {normalizeOneBotEvent} from '../components/qq-bridge/src/onebot/normalize.js';
import {quoteReplyText,normalizeQuoteReply} from '../components/qq-bridge/src/core/wechat-events.js';
import {speechEmotion} from './voice-emotion.mjs';
import {visualInputStatus,understandImages} from '../packages/dsh-social-bridge-plugin/image-input.mjs';
import {HookOneBot} from './hook-onebot.mjs';

const id='a'.repeat(64),key='wechat:private:123';
test('a later request can use the recent same-chat video while explicit quotes take priority',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'video-followup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const buffer=new MessageBuffer(path.join(root,'buffer.json')),now=Date.now();
  const input={platform:'wechat',kind:'private',conversation_id:'123',self_id:'me',sender_wxid:'friend',timestamp:(now-5000)/1000};
  buffer.append({...input,message_id:'video',video:{id,context:'message'},text:'视频'});
  buffer.append({...input,message_id:'reply',text:'收到了。'},{outgoing:true});
  const request=buffer.append({...input,message_id:'request',text:'这段唱给我听'});
  assert.deepEqual(turnVideos([request],buffer.recent(key,20),{now}),[{id,context:'recent'}]);
  assert.deepEqual(turnVideos([{...request,quoteReply:{reference:{kind:'text'}}}],buffer.recent(key,20),{now}),[]);
  assert.deepEqual(turnVideos([request],buffer.recent(key,20),{now:now+600000}),[]);
  assert.deepEqual(turnVideos([{...request,self_id:'another-account'}],buffer.recent(key,20),{now}),[]);
  assert.deepEqual(turnVideos([{...request,conversation_id:'456'}],buffer.recent(key,20),{now}),[]);
  const quoted={...request,video:{id:'b'.repeat(64),context:'quote'}};
  assert.deepEqual(turnVideos([{...request,video:{id,context:'message'}},quoted],[],{now}),[quoted.video]);
  const group={...input,kind:'group',conversation_id:'456',video:{id,context:'message'}};
  assert.deepEqual(turnVideos([{...group,video:undefined,sender_wxid:'other'}],[group],{now}),[]);
});
const quote=()=>({version:1,reply:'你怎么看',truncated:false,reference:{senderId:'wxid_source',senderName:'原作者',conversationId:'',messageId:'1234',time:'',kind:'34',text:'[语音]',unavailable:true,truncated:false}});
const message=()=>({platform:'wechat',kind:'private',conversation_id:'123',sender_id:'123',message_id:'one',text:'你怎么看',images:[],quoteReply:quote(),voice:{id,durationSeconds:2},voiceContext:'quote'});

test('reader video and quoted voice references survive the actual Hook-to-OneBot mapping',()=>{
  const hook=Object.create(HookOneBot.prototype);hook.reload=()=>{};hook.ownWxid='wxid_self';hook.allowed=()=>true;hook.project={account:{nicknames:[]}};
  const base={event:'message.new',sessionId:'wxid_friend',talkerId:'wxid_friend',content:'[视频]',type:43,video:{id},rawid:'event',timestamp:1};
  const video=normalizeOneBotEvent('wechat','wechat-onebot',hook.incoming(base));assert.equal(video.video.id,id);
  const quoted=normalizeOneBotEvent('wechat','wechat-onebot',hook.incoming({...base,type:49,quoteReply:quote(),quotedMedia:{kind:'voice',id,durationSeconds:2}}));
  assert.equal(quoted.voice.id,id);assert.equal(quoted.voiceContext,'quote');assert.equal(quoted.quoteReply.reply,'你怎么看');
});

test('quoted voice transcription preserves the current speaker and new reply',async()=>{
  const delivered=[];const ingress=new VoiceIngress({recognize:async()=>({ok:true,text:'原语音内容'}),deliver:value=>delivered.push(value)});
  await ingress.push(message());ingress.stop();
  const result=delivered[0];assert.equal(result.text,'你怎么看');assert.equal(result.quoteReply.reply,'你怎么看');
  assert.match(quoteReplyText(normalizeQuoteReply(result.quoteReply)),/原语音内容/);
  assert.match(quoteReplyText(result.quoteReply),/当前发言人的新回复：你怎么看/);
});

test('video preparation and transcription preserve order and sampled frames',async()=>{
  const delivered=[];let release;const ready=new Promise(resolve=>release=resolve);
  const ingress=new VoiceIngress({prepareMedia:async m=>{if(m.video){await ready;return {...m,images:[{id}],voice:{id,durationSeconds:2},voiceContext:'video'};}return m;},recognize:async()=>({ok:true,text:'视频中的对白'}),deliver:m=>delivered.push(m)});
  const first=ingress.push({...message(),quoteReply:undefined,voice:undefined,video:{id,context:'message'},text:'[视频]'});
  const second=ingress.push({...message(),quoteReply:undefined,voice:undefined,message_id:'two',text:'你看到了吗'});
  release();await Promise.all([first,second]);ingress.stop();
  assert.equal(delivered.length,2);assert.match(delivered[0].text,/视频中的对白/);assert.deepEqual(delivered[0].images,[{id}]);assert.equal(delivered[1].message_id,'two');
});

test('stop during video preparation never admits a partial message',async()=>{
  let finish,entered;const started=new Promise(resolve=>entered=resolve),waiting=new Promise(resolve=>finish=resolve);let delivered=0;
  const ingress=new VoiceIngress({prepareMedia:async m=>{entered();await waiting;return m;},recognize:async()=>({ok:true,text:'x'}),deliver:()=>delivered++});
  const pending=ingress.push({...message(),video:{id}});await started;ingress.stop();finish();await pending;assert.equal(delivered,0);
});

test('video adapter checks response chat binding and retains an honest failure',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-video-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'state'));
  fs.writeFileSync(path.join(root,'state/wechat-io-config.json'),JSON.stringify({reader_base_url:'http://127.0.0.1:1',reader_token:'fixture'}));
  let bound=key;const prepare=createVideoIngress({root,fetchImpl:async()=>Response.json({id,conversationKey:bound,images:[{id}],voice:null,text:'[采样画面]'})});
  const input={...message(),voice:undefined,quoteReply:undefined,video:{id,context:'message'}};
  assert.deepEqual((await prepare(input)).images,[{id}]);bound='wechat:private:456';
  const rejected=await prepare(input);assert.equal(rejected.images.length,0);assert.match(rejected.text,/不能猜测/);
});

test('Douyin sharing text enters the ordered video path and rejects unavailable or cross-chat results',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-video-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'state'));fs.writeFileSync(path.join(root,'state/wechat-io-config.json'),JSON.stringify({reader_base_url:'http://127.0.0.1:1',reader_token:'fixture'}));
  const text='复制打开抖音 https://v.douyin.com/ABCDE123/ 这段可以唱吗';
  assert.equal(douyinLink({text}).url,'https://v.douyin.com/ABCDE123/');
  assert.equal(douyinLink({text:'不要联网 '+text}),null);assert.equal(douyinLink({text:'https://douyin.com.evil.test/video/123'}),null);
  let wrong=false,received=0;
  const prepare=createVideoIngress({root,fetchImpl:async url=>{
    assert(new URL(url).pathname==='/api/v1/video-link');received++;
    return Response.json({id,conversationKey:wrong?'wechat:private:456':key,images:[{id}],voice:null,text:'[视频引用 ID：'+id+']'});
  }});
  const delivered=[],ingress=new VoiceIngress({prepareMedia:prepare,deliver:value=>delivered.push(value),recognize:()=>assert.fail()});
  await ingress.push({...message(),text,quoteReply:undefined,voice:undefined});ingress.stop();
  assert.equal(received,1);assert.equal(delivered[0].video.id,id);assert.equal(delivered[0].video.source,'douyin');
  wrong=true;const result=await prepare({...message(),text,quoteReply:undefined,voice:undefined});
  assert.equal(result.video,undefined);assert.match(result.text,/不能猜测.*直接发到微信/);
});

test('quote files stay separate from general assistant file capabilities',()=>{
  const result=normalizeOneBotEvent('wechat','wechat-onebot',{post_type:'message',message_type:'private',user_id:123,message:[{type:'text',data:{text:'看看这个'}},{type:'file',data:{id,name:'a.pdf',size:50,context:'quote'}}],wechatagent:{quoteReply:quote()}});
  assert.deepEqual(result.files,[]);assert.deepEqual(result.quotedFiles,[{id,name:'a.pdf',size:50}]);
});

test('emotion policy validates model choices and honors forced neutral',()=>{
  assert.deepEqual(speechEmotion({emotionMode:'auto',emotionStrength:'gentle'},'happy'),{emotion:'happy',emotionStrength:'gentle'});
  assert.equal(speechEmotion({emotionMode:'neutral'},'angry').emotion,'neutral');
  assert.throws(()=>speechEmotion({},'arbitrary instruction'));
});

test('vision selection uses modality metadata and only the current provider',async()=>{
  const llm={resolveModelInfo:async()=>({inputModalities:['text']}),listModels:async()=>[{provider:'other',id:'foreign',inputModalities:['image']},{provider:'same',id:'vision',inputModalities:['text','image']}]};
  const ctx={get:()=>llm};assert.deepEqual(await visualInputStatus(ctx,'same','text'),{ready:true,provider:'same',model:'vision',mode:'description'});
  llm.listModels=async()=>[{provider:'same',id:'vision-by-name',inputModalities:['text']}];assert.equal((await visualInputStatus(ctx,'same','text')).ready,false);
});

test('visual helper receives only verified current images, no tools or chat history, and fails honestly',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-visual-helper-'));fs.mkdirSync(path.join(root,'state'));
  const bytes=Buffer.from('synthetic-image'),calls=[];let fail=false;
  const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer fixture');res.setHeader('content-type','application/json');res.end(JSON.stringify({imageId:id,conversationKey:key,mime:'image/jpeg',b64:bytes.toString('base64'),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),frameTime:1}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  fs.writeFileSync(path.join(root,'state/wechat-io-config.json'),JSON.stringify({reader_base_url:'http://127.0.0.1:'+server.address().port,reader_token:'fixture'}));
  const llm={resolveModelInfo:async(_p,m)=>({inputModalities:m==='vision'?['image']:['text']}),listModels:async()=>[{provider:'same',id:'vision',inputModalities:['image']}],stream:async function*(request){calls.push(request);if(fail)throw Error('fixture');yield {type:'text-delta',text:'画面是红色的。'};}};
  class BlockAssembler{constructor(){this.text='';this.finish={kind:'stop'};}push(chunk){this.text+=chunk.text??'';}blocks(){return [{type:'text',text:this.text}];}}
  const services={llm,attachments:{saveImage:async()=>({attachmentId:'synthetic'})}},ctx={get:name=>services[name]},options={createUserMessage:value=>value,BlockAssembler};
  const result=await understandImages(ctx,root,key,[{id}],'same','text',options);
  assert.match(result[0].text,/画面是红色/);assert.equal(calls[0].provider,'same');assert.equal(calls[0].model,'vision');assert.deepEqual(calls[0].tools,[]);assert.equal(calls[0].messages.length,1);
  assert(calls[0].messages[0].content.some(block=>block.type==='image'));assert(calls[0].messages[0].content.some(block=>block.text?.includes('1.0 秒')));
  fail=true;assert.match((await understandImages(ctx,root,key,[{id}],'same','text',options))[0].text,/未完成.*不能猜测/);
  await understandImages(ctx,root,key,[],'same','text',options);assert.equal(calls.length,2);
});

test('Python media contracts cover exact quotes, synthetic video, CDN variants and emotional inference',()=>{
  const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
  for(const name of ['test-media-input.py','test-supplier-video.py','test-local-speech.py']){
    const result=spawnSync(process.env.WECHATAGENT_TEST_PYTHON??config.runtime.python,['-B','-c',
      'import runpy,sys; sys.path.insert(0,sys.argv[1]); target=sys.argv[2]; sys.argv=[target]; runpy.run_path(target,run_name="__main__")',
      import.meta.dirname,path.join(import.meta.dirname,name)],{encoding:'utf8',timeout:45000,windowsHide:true,env:{...process.env,PYTHONUTF8:'1'}});
    assert.equal(result.status,0,result.stderr||result.stdout||result.error?.message);
  }
});
