import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {HookOneBot, onebotId} from './hook-onebot.mjs';
import {WechatOneBotAdapter} from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {conversationSnapshot} from '../components/qq-bridge/src/core/proactive-policy.js';

const projectRoot=fileURLToPath(new URL('..',import.meta.url));
const account='wxid_api_receipt_self',peer='wxid_api_receipt_peer',target=onebotId(peer);
const text='API receipt fixture text',hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const acknowledged={ret:0,submitted:true,confirmed:false,apiAcknowledged:true};
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
async function until(check){
  for(let index=0;index<600;index++){if(check())return;await wait(3);}
  assert.fail('isolated API receipt fixture timed out');
}

function fixture(t,{backend='supplier-http',reply=acknowledged,rows,forbidMessages=backend==='supplier-http'}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'text-api-receipt-'));
  for(const directory of ['config','state/hook'])fs.mkdirSync(path.join(root,directory),{recursive:true});
  t.after(()=>{assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  const supplier=backend==='supplier-http',version=supplier?'4.1.8.27':'4.1.15.13';
  const config={runtime:{sender:'wechat-hook',weflowMode:'nt'},
    hook:{backend,baseUrl:'http://127.0.0.1:30001',expectedVersion:version,requestTimeoutMs:1000},
    wechat:{whitelist:{private:[target],groups:[]}}};
  fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(root,'state/wechat-io-config.json'),JSON.stringify({reader_base_url:'http://127.0.0.1:5031',reader_token:'isolated-fixture'}));
  fs.writeFileSync(path.join(root,'state/hook/native-token.txt'),'a'.repeat(64));
  const sent=[],requests=[];let messageReads=0;
  const fetchImpl=async(url,init)=>{
    const route=new URL(url).pathname;requests.push(route);let body;
    if(route==='/WeChatAgent/health')body={integration:supplier?'WeChatAgent-supplier-v1':'WeChatAgent-1',
      backend:'wechat-hook',...(supplier?{provider:'supplier-http'}:{profile:'4.1.15.13-text-v1'}),
      version,startupState:'ready',nativeTextSend:true,databaseAccounts:[account]};
    else if(route==='/api/v1/reader/status')body={backend:supplier?'supplier-http':'weflow-cli-nt',ownWxid:account,accountDirectory:account};
    else if(route==='/api/v1/sessions')body={sessions:[{username:peer,displayName:'Fixture peer'}]};
    else if(route==='/api/v1/messages'){
      messageReads++;assert.equal(forbidMessages,false,'ordinary supplier text must not require the message database');
      body={messages:rows?rows(sent):sent.map((item,index)=>({localId:51+index,serverId:String(123456789+index),isSend:true,localType:1,createTime:Math.floor(Date.now()/1000),fullText:item.msg}))};
    }else if(route==='/SendTextMsg'){
      assert.equal(init.headers.Authorization,'Bearer '+'a'.repeat(64));
      assert.equal(init.headers['X-WeChatAgent-Account'],supplier?undefined:account);
      const submission=JSON.parse(init.body);assert.equal(submission.wxidorgid,peer);sent.push(submission);
      body=typeof reply==='function'?await reply(submission,sent.length):reply;
    }else throw new Error('Unexpected isolated fixture route: '+route);
    return new Response(JSON.stringify(body));
  };
  const rebuild=()=>new HookOneBot({directory:root,fetchImpl,receiptTimeoutMs:4,pollMs:1});
  const adapter=rebuild();
  return {root,config,sent,requests,adapter,rebuild,get messageReads(){return messageReads;}};
}

test('supplier text success envelopes explicitly identify an API acknowledgement without relaxing other media',async()=>{
  const configFile=path.join(projectRoot,'config/wechatagent.json');
  const config=fs.existsSync(configFile)?JSON.parse(fs.readFileSync(configFile,'utf8').replace(/^\uFEFF/,'')):{};
  const python=process.env.WECHATAGENT_TEST_PYTHON??config.runtime?.python??'python';
  const program=[
    'import json,sys',
    'sys.path.insert(0, "scripts")',
    'from supplier_reader import normalize_send_response',
    'envelopes=[{"code":1,"data":None,"msg":"success"},{"account_wxid":"fixture_self","errCode":1,"data":{},"errMsg":"success"}]',
    'text=[normalize_send_response("/SendTextMsg",value,"fixture_self","fixture_peer") for value in envelopes]',
    'media=[normalize_send_response(route,envelopes[0],"fixture_self","fixture_peer") for route in ("/SendImageMsg","/SendFileMsg","/SendStickerMsg","/SendVoiceMsg")]',
    'print(json.dumps({"text":text,"media":media}))',
  ].join('\n');
  const {stdout}=await promisify(execFile)(python,['-B','-c',program],{cwd:projectRoot,windowsHide:true,timeout:15000,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}});
  const result=JSON.parse(stdout);
  assert.deepEqual(result.text,[acknowledged,acknowledged]);
  assert.deepEqual(result.media,Array.from({length:4},()=>({ret:0,submitted:true,confirmed:false})));
});

test('ordinary supplier text finishes from its API receipt and never reads message rows',async t=>{
  const f=fixture(t),id=hash('api-success'),operation=f.adapter.textDeliveries.key('private',target,id,text);
  const expected={message_id:'api-text:'+operation,receipt:'supplier-api',delivered:'api-acknowledged'};
  assert.deepEqual(await f.adapter.send('private',target,text,id),expected);
  const saved=f.adapter.textDeliveries.get(operation);
  assert.equal(saved.state,'confirmed');assert.deepEqual(saved.baseline,[]);assert.deepEqual(saved.response,expected);
  assert.equal(f.sent.length,1);assert.equal(f.messageReads,0);
});

test('a saved API receipt deduplicates the same operation after rebuilding the adapter',async t=>{
  const f=fixture(t),id=hash('api-restart-dedupe'),first=await f.adapter.send('private',target,text,id);
  const restored=f.rebuild();
  assert.deepEqual(await restored.send('private',target,text,id),{...first,reused:true});
  assert.equal(f.sent.length,1);assert.equal(f.messageReads,0);
  await assert.rejects(restored.send('private',target,text+' changed',id),/TEXT_DELIVERY_ID_CONFLICT/);
  assert.equal(f.sent.length,1);
});

test('an API-acknowledged operation cannot be reused under another bound account',async t=>{
  const f=fixture(t),id=hash('api-account-bound');await f.adapter.send('private',target,text,id);
  const key=f.adapter.textDeliveries.key('private',target,id,text),saved=f.adapter.textDeliveries.get(key);
  f.adapter.textDeliveries.put({...saved,account:'different-fixture-account'});
  await assert.rejects(f.rebuild().send('private',target,text,id),/TEXT_DELIVERY_ACCOUNT_MISMATCH/);
  assert.equal(f.sent.length,1);assert.equal(f.messageReads,0);
});

test('revoking a conversation blocks the OneBot action even when the API receipt is already persisted',async t=>{
  const f=fixture(t),id=hash('api-allowlist-bound');await f.adapter.send('private',target,text,id);
  f.config.wechat.whitelist.private=[];fs.writeFileSync(path.join(f.root,'config/wechatagent.json'),JSON.stringify(f.config));
  const response=await f.adapter.action({action:'send_private_msg',params:{user_id:target,message:[{type:'text',data:{text}}],wechatagent_delivery_id:id}});
  assert.equal(response.status,'failed');assert.equal(response.message,'CONVERSATION_NOT_ALLOWED');
  assert.equal(f.sent.length,1);assert.equal(f.messageReads,0);
});

test('pre-upgrade unknown, accepted and interrupted submissions without a server receipt are not retroactively API-acknowledged or resubmitted',async t=>{
  for(const state of ['unconfirmed','accepted','dispatching']){
    await t.test(state,async t=>{
      const f=fixture(t,{forbidMessages:false,rows:()=>[]}),id=hash('legacy-'+state);
      const key=f.adapter.textDeliveries.key('private',target,id,text);
      f.adapter.textDeliveries.put({version:1,key,deliveryId:id,account,wxid:peer,text,baseline:[],startedAt:Date.now(),state});
      await assert.rejects(f.adapter.send('private',target,text,id),/TEXT_DELIVERY_UNCONFIRMED/);
      await assert.rejects(f.rebuild().send('private',target,text,id),/TEXT_DELIVERY_UNCONFIRMED/);
      assert.equal(f.sent.length,0);assert.notEqual(f.adapter.textDeliveries.get(key).state,'confirmed');
    });
  }
});

test('a pre-upgrade unknown submission can still be confirmed by its exact real database server receipt',async t=>{
  const f=fixture(t,{forbidMessages:false,rows:()=>[{localId:51,serverId:'123456789',isSend:true,localType:1,createTime:Math.floor(Date.now()/1000),fullText:text}]}),id=hash('legacy-real-server');
  const key=f.adapter.textDeliveries.key('private',target,id,text);
  f.adapter.textDeliveries.put({version:1,key,deliveryId:id,account,wxid:peer,text,baseline:[],startedAt:Date.now(),state:'unconfirmed'});
  assert.deepEqual(await f.adapter.send('private',target,text,id),{message_id:51,receipt:'wechat-server-id',delivered:'database-confirmed'});
  assert.equal(f.sent.length,0);assert(f.messageReads>0);
});

test('a transport timeout stays unknown across restart and never submits the operation twice',async t=>{
  const f=fixture(t,{reply:()=>{throw Object.assign(new Error('isolated fixture deadline'),{name:'TimeoutError'});},forbidMessages:false,rows:()=>[]}),id=hash('api-timeout');
  await assert.rejects(f.adapter.send('private',target,text,id),/TEXT_DELIVERY_UNCONFIRMED/);
  const key=f.adapter.textDeliveries.key('private',target,id,text);
  assert.equal(f.adapter.textDeliveries.get(key).state,'unconfirmed');
  await assert.rejects(f.rebuild().send('private',target,text,id),/TEXT_DELIVERY_UNCONFIRMED/);
  assert.equal(f.sent.length,1);assert.notEqual(f.adapter.textDeliveries.get(key).state,'confirmed');
});

test('an explicit native rejection is not an API acknowledgement and is not retried',async t=>{
  const f=fixture(t,{reply:{ret:-1,submitted:false,confirmed:false}}),id=hash('api-rejected');
  await assert.rejects(f.adapter.send('private',target,text,id),/NATIVE_SEND_REJECTED/);
  await assert.rejects(f.rebuild().send('private',target,text,id),/NATIVE_SEND_REJECTED/);
  assert.equal(f.sent.length,1);assert.equal(f.messageReads,0);
  assert.equal(f.adapter.textDeliveries.get(f.adapter.textDeliveries.key('private',target,id,text)).state,'rejected');
});

test('a bare supplier submission result without its explicit API receipt never counts as API success',async t=>{
  const f=fixture(t,{reply:{ret:0,submitted:true,confirmed:false},forbidMessages:false,rows:()=>[]}),id=hash('supplier-bare-ret');
  await assert.rejects(f.adapter.send('private',target,text,id),/TEXT_DELIVERY_UNCONFIRMED/);
  await assert.rejects(f.rebuild().send('private',target,text,id),/TEXT_DELIVERY_UNCONFIRMED/);
  assert.equal(f.sent.length,1);
});

test('a new API-only attempt never confirms a recent pre-existing same-text SQL row, even after timeout and restart',async t=>{
  for(const variant of ['bare-response','timeout']){
    await t.test(variant,async t=>{
      const f=fixture(t,{forbidMessages:false,rows:()=>[{localId:51,serverId:'123456789',isSend:true,localType:1,createTime:Math.floor(Date.now()/1000)-10,fullText:text}],
        reply:variant==='bare-response'?{ret:0,submitted:true,confirmed:false}:()=>{throw new Error('fixture lost API response');}});
      const id=hash('api-only-'+variant),key=f.adapter.textDeliveries.key('private',target,id,text);
      await assert.rejects(f.adapter.send('private',target,text,id),/TEXT_DELIVERY_UNCONFIRMED/);
      await assert.rejects(f.rebuild().send('private',target,text,id),/TEXT_DELIVERY_UNCONFIRMED/);
      const saved=f.adapter.textDeliveries.get(key);
      assert.equal(saved.confirmationMode,'supplier-api');assert.equal(saved.state,'unconfirmed');
      assert.equal(f.messageReads,0);assert.equal(f.sent.length,1);
    });
  }
});

test('an interrupted API-only attempt stays unknown without SQL reconciliation or resubmission',async t=>{
  for(const state of ['dispatching','accepted','unconfirmed']){
    const f=fixture(t),id=hash('api-only-interrupted-'+state),key=f.adapter.textDeliveries.key('private',target,id,text);
    f.adapter.textDeliveries.put({version:1,key,deliveryId:id,account,wxid:peer,text,baseline:[],startedAt:Date.now(),state,confirmationMode:'supplier-api'});
    await assert.rejects(f.rebuild().send('private',target,text,id),/TEXT_DELIVERY_UNCONFIRMED/);
    assert.equal(f.sent.length,0);assert.equal(f.messageReads,0);
  }
});

test('a corrupt text confirmation mode fails closed instead of falling back to SQL',async t=>{
  const f=fixture(t),id=hash('api-only-corrupt-mode'),key=f.adapter.textDeliveries.key('private',target,id,text);
  f.adapter.textDeliveries.put({version:1,key,deliveryId:id,account,wxid:peer,text,baseline:[],startedAt:Date.now(),state:'unconfirmed',confirmationMode:'unknown-mode'});
  await assert.rejects(f.adapter.send('private',target,text,id),/TEXT_DELIVERY_STATE_INVALID/);
  assert.equal(f.sent.length,0);assert.equal(f.messageReads,0);
});

test('project-native text keeps database confirmation rather than acquiring a supplier API receipt',async t=>{
  const f=fixture(t,{backend:'project-native',reply:{ret:0}}),id=hash('native-still-database');
  assert.deepEqual(await f.adapter.send('private',target,text,id),{message_id:51,receipt:'wechat-server-id',delivered:'database-confirmed'});
  assert(f.messageReads>=2);assert.equal(f.sent.length,1);
});

test('project-native acceptance without a database receipt remains unknown and is not resent',async t=>{
  const f=fixture(t,{backend:'project-native',reply:{ret:0},rows:()=>[]}),id=hash('native-no-database');
  await assert.rejects(f.adapter.send('private',target,text,id),/TEXT_DELIVERY_UNCONFIRMED/);
  await assert.rejects(f.rebuild().send('private',target,text,id),/TEXT_DELIVERY_UNCONFIRMED/);
  assert.equal(f.sent.length,1);assert(f.messageReads>=2);
});

function downstream(f){
  const adapter=new WechatOneBotAdapter();
  adapter.server.action=async(action,params)=>{
    const result=await f.adapter.action({action,params});
    if(result.status!=='ok')throw Object.assign(new Error(result.message),{code:result.message,data:result.data});
    return result;
  };
  return adapter;
}

test('the real downstream text adapter preserves the API receipt source as a successful terminal result',async t=>{
  const f=fixture(t),adapter=downstream(f),id=hash('downstream-api');
  const result=await adapter.sendText({kind:'private',target,text,deliveryId:id});
  assert.equal(result.accepted,true);assert.equal(result.confirmed,true);assert.equal(result.apiAcknowledged,true);
  assert.equal(result.delivered,'api-acknowledged');assert.equal(result.response.data.receipt,'supplier-api');
  assert.match(result.response.data.message_id,/^api-text:[a-f0-9]{64}$/);assert.equal(f.messageReads,0);
});

test('the downstream adapter rejects incomplete or mismatched API receipt metadata',async()=>{
  for(const data of [
    {receipt:'supplier-api'},
    {receipt:'supplier-api',delivered:'database-confirmed',message_id:'api-text:'+'a'.repeat(64)},
    {receipt:'supplier-api',delivered:'api-acknowledged',message_id:51},
    {receipt:'supplier-api',delivered:'api-acknowledged',message_id:'api-text:bad'},
  ]){
    const adapter=new WechatOneBotAdapter();adapter.server.action=async()=>({data});
    await assert.rejects(adapter.sendText({kind:'private',target,text}),/no verified.*receipt/);
    assert.equal(adapter.stats.sends,0);
  }
});

test('multi-paragraph replies pass through both real adapters without database polling or losing later parts',async t=>{
  const f=fixture(t),adapter=downstream(f),buffer=new MessageBuffer(path.join(f.root,'state/social-messages.json'));
  const texts=['第一条模拟回复。','第二条模拟回复。','第三条模拟回复。'],key='wechat:private:'+target;let modelCalls=0;
  const engine=new SocialEngine({buffer,workModeFor:()=> 'assistant',assistantAccess:()=>true,
    assistantBatchMs:1,batchMs:1,minIntervalMs:0,privateMinIntervalMs:0,maxPerMinute:100,maxPerTenMinutes:100,
    maxTextPartsFor:()=>0,stickerPolicyFor:()=>({enabled:false}),
    decide:async()=>{modelCalls++;return 'RESPOND: '+texts.join('\n\n');},
    send:(message,body,options)=>adapter.sendText({kind:message.kind,target:message.conversation_id,text:body,deliveryId:options.deliveryId})});
  t.after(()=>engine.stop());
  engine.receive({platform:'wechat',kind:'private',conversation_id:String(target),sender_id:String(target),
    sender_wxid:peer,self_id:String(onebotId(account)),message_id:'api-receipt-incoming',text:'请分段说明。',timestamp:Date.now()/1000});
  await until(()=>f.sent.length===texts.length&&!engine.running.has(key)&&buffer.unread(key).length===0);
  assert.equal(modelCalls,1);assert.deepEqual(f.sent.map(row=>row.msg),texts);assert.equal(f.messageReads,0);
  assert.equal(adapter.stats.sends,3);assert.equal(buffer.pendingReplies.size,0);
  const outgoing=buffer.recent(key).filter(row=>row.outgoing);
  assert.deepEqual(outgoing.map(row=>row.text),texts);assert(outgoing.every(row=>row.delivery_status==='confirmed'));
  assert.equal(new Set(outgoing.map(row=>row.delivery_id)).size,3);assert.equal(buffer.contextNotices.has(key),false);
});

function enableProactive(f,history=[]){
  const key='wechat:private:'+target,local=new Date(Date.now()+8*3600000),minute=local.getUTCHours()*60+local.getUTCMinutes();
  const clock=value=>String(Math.floor((value+1440)%1440/60)).padStart(2,'0')+':'+String((value+1440)%60).padStart(2,'0');
  f.config.wechat.proactive={enabled:true,idleMinutes:5,startTime:clock(minute-1),endTime:clock(minute+1),chats:{[key]:true}};
  fs.writeFileSync(path.join(f.root,'config/wechatagent.json'),JSON.stringify(f.config));
  fs.writeFileSync(path.join(f.root,'state/social-messages.json'),JSON.stringify({chats:{[key]:history}}));
  return {contextId:conversationSnapshot(history)};
}

test('proactive API-acknowledged text still reads the current conversation before submitting',async t=>{
  const f=fixture(t,{forbidMessages:false,rows:()=>[]}),proactive=enableProactive(f),id=hash('proactive-preflight');
  assert.equal((await f.adapter.send('private',target,text,id,proactive)).receipt,'supplier-api');
  assert.equal(f.messageReads,1);assert.equal(f.sent.length,1);
  assert.equal(f.adapter.textDeliveries.get(f.adapter.textDeliveries.key('private',target,id,text)).proactiveContextId,proactive.contextId);
});

test('a fresh incoming message blocks proactive submission even when API text acknowledgements are enabled',async t=>{
  const f=fixture(t,{forbidMessages:false,rows:()=>[{localId:41,serverId:'123456788',isSend:false,localType:1,createTime:Math.floor(Date.now()/1000),fullText:'fresh isolated fixture'}]});
  await assert.rejects(f.adapter.send('private',target,text,hash('proactive-changed'),enableProactive(f)),/PROACTIVE_CONTEXT_CHANGED/);
  assert.equal(f.messageReads,1);assert.equal(f.sent.length,0);
});

test('a subsequent proactive part may bind only the unique exact server row of its preceding API receipt',async t=>{
  const f=fixture(t,{forbidMessages:false}),proactive=enableProactive(f),firstId=hash('proactive-first');
  await f.adapter.send('private',target,text,firstId,proactive);
  const second=await f.adapter.send('private',target,text+' second',hash('proactive-second'),{...proactive,precedingDeliveryId:firstId});
  assert.equal(second.receipt,'supplier-api');assert.equal(f.sent.length,2);assert.equal(f.messageReads,2);
});

test('ambiguous, unconfirmed or changed recent rows prevent a later proactive part',async t=>{
  for(const variant of ['duplicate','no-server-id','other-incoming']){
    await t.test(variant,async t=>{
      const f=fixture(t,{forbidMessages:false,rows:sent=>{
        if(!sent.length)return [];
        const row={localId:51,serverId:'123456789',isSend:true,localType:1,createTime:Math.floor(Date.now()/1000),fullText:sent[0].msg};
        if(variant==='duplicate')return [row,{...row,localId:52}];
        if(variant==='no-server-id')return [{...row,serverId:'0'}];
        return [row,{...row,localId:52,isSend:false,fullText:'new fixture incoming'}];
      }}),proactive=enableProactive(f),firstId=hash('proactive-guard-'+variant);
      await f.adapter.send('private',target,text,firstId,proactive);
      await assert.rejects(f.adapter.send('private',target,text+' second',hash('proactive-blocked-'+variant),{...proactive,precedingDeliveryId:firstId}),/PROACTIVE_CONTEXT_CHANGED/);
      assert.equal(f.sent.length,1);assert.equal(f.messageReads,2);
    });
  }
});

test('an API receipt from a different proactive context cannot exempt a recent row',async t=>{
  const f=fixture(t,{forbidMessages:false}),proactive=enableProactive(f),firstId=hash('proactive-old-context');
  await f.adapter.send('private',target,text,firstId,proactive);
  const next=enableProactive(f,[{id:'changed',message_id:'changed',timestamp:1}]);
  await assert.rejects(f.adapter.send('private',target,text+' second',hash('proactive-cross-context'),{...next,precedingDeliveryId:firstId}),/INVALID_PROACTIVE_CONTEXT/);
  assert.equal(f.sent.length,1);
});

test('a preceding API receipt cannot silently rebind to a different SQL message after restart',async t=>{
  let localId=51;
  const f=fixture(t,{forbidMessages:false,rows:sent=>sent.length?[{localId,serverId:'123456789',isSend:true,localType:1,createTime:Math.floor(Date.now()/1000),fullText:text}]:[]});
  const proactive=enableProactive(f),firstId=hash('proactive-stable-binding');
  await f.adapter.send('private',target,text,firstId,proactive);
  await f.adapter.send('private',target,text+' second',hash('proactive-bind-second'),{...proactive,precedingDeliveryId:firstId});
  const key=f.adapter.textDeliveries.key('private',target,firstId,text);
  assert.equal(f.adapter.textDeliveries.get(key).candidateId,'51');
  localId=52;
  await assert.rejects(f.rebuild().send('private',target,text+' third',hash('proactive-bind-third'),{...proactive,precedingDeliveryId:firstId}),/PROACTIVE_CONTEXT_CHANGED/);
  assert.equal(f.sent.length,2);assert.equal(f.adapter.textDeliveries.get(key).candidateId,'51');
});
