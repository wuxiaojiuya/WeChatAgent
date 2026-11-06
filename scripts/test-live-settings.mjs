import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createConsole} from './console-server.mjs';
import {refreshDsh} from './dsh-refresh.mjs';
import {applyLiveChatSettings} from '../components/qq-bridge/src/core/live-settings.js';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-live-settings-'));
  for(const dir of ['config','roles','state'])fs.mkdirSync(path.join(root,dir));
  const config=JSON.parse(fs.readFileSync('config/wechatagent.example.json','utf8'));
  fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(root,'roles',config.persona.default+'.md'),'Fixture persona');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,config};
}

test('saved chat, persona, history and rhythm settings do not start or restart stopped services',async t=>{
  const f=fixture(t),commands=[],app=createConsole({root:f.root,port:0,runner:async spec=>{commands.push(spec);return 0;},fetchImpl:async()=>{throw Error('offline');}});
  const address=await app.start();t.after(()=>app.close());const base='http://127.0.0.1:'+address.port;
  const {token}=await fetch(base+'/api/info').then(r=>r.json()),headers={'X-Console-Token':token,'Content-Type':'application/json'};
  let current=await fetch(base+'/api/config',{headers}).then(r=>r.json());
  const changed=structuredClone(current.config);changed.wechat.wake_words=['新名字'];changed.wechat.whitelist.private=['123'];changed.account.nicknames=['新名字'];changed.social.batch_ms=500;changed.wechat.history.recentMessages=12;
  const r=await fetch(base+'/api/config',{method:'POST',headers,body:JSON.stringify({revision:current.revision,config:changed})});assert.equal(r.status,200);current=await r.json();assert(!current.pendingApply);assert.equal(commands.length,0);
  const role=await fetch(base+'/api/roles',{method:'POST',headers,body:JSON.stringify({name:'新人格',content:'测试新人格内容'})});assert.equal(role.status,200);assert(!(await fetch(base+'/api/config',{headers}).then(r=>r.json())).pendingApply);
  const stale=await fetch(base+'/api/config',{method:'POST',headers,body:JSON.stringify({revision:'stale',config:changed})});assert.equal(stale.status,409);
});

test('wake changes take effect on the existing engine without resetting cooldowns or buffered messages',t=>{
  const f=fixture(t),buffer=new MessageBuffer(path.join(f.root,'state/messages.json')),engine=new SocialEngine({buffer,batchMs:60000,mode:'mention',wakeWords:['旧名字'],decide:async()=>{assert.fail('no model call');},send:async()=>{assert.fail('no send');}});t.after(()=>engine.stop());
  const groups=new Set(['old']),friends=new Set(['old']),key='wechat:group:123';engine.sentAt.set(key,[Date.now()]);
  const message={platform:'wechat',kind:'group',conversation_id:'123',sender_id:'9',text:'新名字 在吗',timestamp:Date.now()/1000};engine.receive({...message,message_id:'before'});assert.equal(buffer.recent(key,1)[0].direct_mention,false);
  f.config.wechat.wake_words=['新名字'];f.config.wechat.whitelist={groups:['123'],private:['456']};f.config.social.batch_ms=60000;f.config.social.max_per_minute=7;
  applyLiveChatSettings(f.config,[engine],groups,friends);engine.receive({...message,message_id:'after'});
  assert.equal(buffer.recent(key,1)[0].direct_mention,true);assert.equal(engine.maxPerMinute,7);assert.equal(engine.sentAt.get(key).length,1);assert.equal(buffer.recent(key,10).length,2);assert.deepEqual([...groups],['123']);assert.deepEqual([...friends],['456']);
});

test('model changes automatically prepare and apply configuration without starting stopped services',async t=>{
  const f=fixture(t),commands=[],app=createConsole({root:f.root,port:0,runner:async spec=>{commands.push(spec);return 0;},fetchImpl:async()=>{throw Error('offline');}});
  const address=await app.start();t.after(()=>app.close());const base='http://127.0.0.1:'+address.port,{token}=await fetch(base+'/api/info').then(r=>r.json()),headers={'X-Console-Token':token,'Content-Type':'application/json'};
  const previous=await fetch(base+'/api/config',{headers}).then(r=>r.json());previous.config.dsh.model='new-model';
  const response=await fetch(base+'/api/config',{method:'POST',headers,body:JSON.stringify(previous)});assert.equal(response.status,200);const saved=await response.json();assert.equal(saved.applyJob.action,'apply-settings');
  let status;for(let i=0;i<50;i++){status=await fetch(base+'/api/status',{headers}).then(r=>r.json());if(!status.activeJob)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(status.latestJob.state,'succeeded');assert.equal(status.pendingApply,false);assert.equal(commands.length,1);
  assert.deepEqual(JSON.parse(Buffer.from(commands[0].args.at(-1),'base64').toString()),['prepare']);
});

test('DSH reload authenticates the owning project, waits through busy turns and verifies the new instance',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'state/social-dsh-token.txt'),'fixture-token');let attempts=0,reloaded=false;
  const initial={ok:true,project:'WeChatAgent',projectRoot:f.root,provider:f.config.dsh.provider,model:'old-model',accountScope:'',instanceId:'old',configurationReload:'native-runtime-v1'};
  const fetchImpl=async(url,options)=>{assert.equal(options.headers.Authorization,'Bearer fixture-token');if(url.endsWith('/health'))return Response.json(reloaded?{...initial,instanceId:'new',model:f.config.dsh.model}:initial);attempts++;if(attempts===1)return Response.json({error:'CONFIGURATION_BUSY'},{status:409});reloaded=true;return Response.json({ok:true},{status:202});};
  assert.equal((await refreshDsh({...f,fetchImpl,delay:async()=>{}})).status,'reloaded');assert.equal(attempts,2);
  attempts=0;assert.equal((await refreshDsh({...f,fetchImpl,delay:async()=>{}})).status,'current');assert.equal(attempts,0);
  await assert.rejects(refreshDsh({...f,fetchImpl:async()=>Response.json({...initial,projectRoot:path.dirname(f.root)})}),/DSH_PROJECT_MISMATCH/);
});
