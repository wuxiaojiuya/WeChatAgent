import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createIdentityMindUI} from '../public/console/identity-mind.js';
import {createMemoryUI} from '../public/console/memory-view.js';
import {consoleRoute} from '../public/console/layout-model.mjs';
import {createConsole,validateConsoleConfig} from './console-server.mjs';
import {createIdentityMindStore} from '../packages/dsh-social-bridge-plugin/identity-mind-store.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const key='wechat:private:123',account='a'.repeat(64);
const fingerprint=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-mind-ui-'));
  t.after(()=>{assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  const config=JSON.parse(fs.readFileSync('config/wechatagent.example.json','utf8'));
  config.wechat.whitelist={private:['123'],groups:[]};
  for(const dir of ['config','roles','state/hook'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  const file=path.join(root,'config/wechatagent.json');fs.writeFileSync(file,JSON.stringify(config));
  fs.writeFileSync(path.join(root,'roles',config.persona.default+'.md'),'Fixture');
  fs.writeFileSync(path.join(root,'state/hook/active-connection.json'),JSON.stringify({id:account,legacyId:account}));
  return {root,config,file};
}

test('mind page shows defaults and saved drafts without writing or waking the model',async()=>{
  const state={draft:{wechat:{identityMind:{idleMinutes:35}},unrelated:'KEEP'},names:new Map()},before=JSON.stringify(state.draft),requests=[];
  const ui=createIdentityMindUI({state,escapeHtml:esc,api:async route=>{requests.push(route);return {available:false,accountScope:account};}});
  const html=await ui.page();
  assert(html.includes('id="mind-enabled" data-path="wechat.identityMind.enabled" checked'));
  assert(html.includes('data-path="wechat.identityMind.idleMinutes" value="35"'));
  assert(html.includes('data-path="wechat.identityMind.reflectionMinutes" value="5"'));
  assert(html.includes('data-path="wechat.identityMind.dailyActionLimit" value="4"'));
  assert(html.includes('23:00'));assert(html.includes('尚无共同状态记录'));assert(html.includes('保存设置'));
  assert(html.includes('data-layout-control="save-button">保存设置</button>'));assert(!html.includes('????'));
  assert.equal(JSON.stringify(state.draft),before);assert.deepEqual(requests,['/api/identity-mind/status']);
});

test('mind status escapes mood, ideas, plans, relationships, names and errors',async()=>{
  const hostile='<img src=x onerror=alert(1)>',state={draft:{wechat:{}},names:new Map([[key,hostile]])};
  const data={available:true,mood:{feeling:hostile,reason:hostile},thoughts:[{text:hostile,sourceKey:key}],plans:[{title:hostile,detail:hostile,kind:'singing',conversationKey:key,status:'pending',reason:hostile}],relationships:[{personId:'wxid_example',sourceKey:key,name:hostile,address:hostile,relationship:hostile,agreements:[hostile]}],interactions:2,actionsToday:1};
  const html=await createIdentityMindUI({state,escapeHtml:esc,api:async()=>data}).page();
  assert(!html.includes(hostile));assert(html.includes(esc(hostile)));assert(html.includes('待考虑'));assert(html.includes('最近回顾'));assert(html.includes('模型的内部推理'));
  const failed=await createIdentityMindUI({state,escapeHtml:esc,api:async()=>{throw Error(hostile);}}).page();
  assert(!failed.includes(hostile));assert(failed.includes(esc(hostile)));assert(failed.includes('状态暂时无法读取'));
});

test('mind route reuses memory navigation and bypasses conversation-specific memory requests',async()=>{
  assert.deepEqual(consoleRoute('#memory/mind'),{page:'memory',section:'mind'});
  const ui=createMemoryUI({state:{memorySection:'mind'},escapeHtml:esc,api:async()=>{throw Error('NO_OTHER_READS');},icon:()=>'',renderPage(){},toast(){},mindPage:async()=>'<p>MIND_PAGE</p>'});
  const html=await ui.page();assert(html.includes('href="#memory/mind" aria-current="page"'));assert(html.includes('MIND_PAGE'));assert(html.includes('群友记忆'));
});

test('plans distinguish local practice, chat sharing and external Moments without upgrading submitted to completed',async()=>{
  const base={title:'计划',detail:'简短想法',status:'submitted',conversationKey:key};
  const state={draft:{wechat:{}},names:new Map([[key,'小海']])},data={available:true,policy:{enabled:true,idleEnabled:true,dailyActionLimit:0},plans:[{...base,kind:'singing',delivery:'local',jobId:'local-job'},{...base,kind:'drawing',delivery:'chat',jobId:'shared-job'},{...base,kind:'moment',delivery:'local',jobId:'moment-request'}]};
  const html=await createIdentityMindUI({state,escapeHtml:esc,api:async()=>data}).page();
  assert(html.includes('本地练习，不发送微信'));assert(html.includes('分享至 小海'));assert(html.includes('发布朋友圈（对外）'));
  assert.equal((html.match(/已提交，待结果/g)??[]).length,3);assert(!html.includes('>已完成<'));
  assert(html.includes('已提交不代表生成完成或微信已发送'));assert(html.includes('local-job'));assert(html.includes('对外行动上限为 0'));
});

test('saved pause switches explain preserved records and event-driven state updates',async()=>{
  const state={draft:{wechat:{}},names:new Map()};
  const disabled=await createIdentityMindUI({state,escapeHtml:esc,api:async()=>({available:true,policy:{enabled:false}})}).page();assert(disabled.includes('总开关已关闭'));assert(disabled.includes('保留展示此前状态'));
  const noIdle=await createIdentityMindUI({state,escapeHtml:esc,api:async()=>({available:true,policy:{enabled:true,idleEnabled:false}})}).page();assert(noIdle.includes('空闲回顾已关闭'));assert(noIdle.includes('聊天之后仍可整理状态'));
});

test('mind status API requires local console authentication and never creates mind storage',async t=>{
  const f=fixture(t),app=createConsole({root:f.root,port:0,runner:async()=>{throw Error('NO_COMMANDS');},fetchImpl:async()=>{throw Error('NO_NETWORK');}});
  const address=await app.start();t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
  const base='http://127.0.0.1:'+address.port,info=await fetch(base+'/api/info').then(r=>r.json()),before=fingerprint(f.file);
  assert.equal((await fetch(base+'/api/identity-mind/status')).status,401);
  const response=await fetch(base+'/api/identity-mind/status',{headers:{'X-Console-Token':info.token}});assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.accountScope,account);assert.equal(body.policy.enabled,true);assert.equal(body.policy.idleMinutes,20);
  assert.equal(body.available,true);assert(!fs.existsSync(path.join(f.root,'state/identity-mind')));assert.equal(fingerprint(f.file),before);
  assert.equal((await fetch(base+'/identity-mind.js')).status,200);
});

test('console validates mind settings with a useful message before saving',t=>{
  const f=fixture(t);for(const patch of [{enabled:'yes'},{idleMinutes:1},{reflectionMinutes:0},{dailyActionLimit:21},{quietStart:'25:00'}]){
    const config=structuredClone(f.config);config.wechat.identityMind={...config.wechat.identityMind,...patch};
    assert.throws(()=>validateConsoleConfig(config,f.root),/自主思考/);
  }
  const valid=structuredClone(f.config);valid.wechat.identityMind.dailyActionLimit=0;assert.doesNotThrow(()=>validateConsoleConfig(valid,f.root));
});

test('status API filters revoked conversations and does not recover or mutate an in-flight plan',async t=>{
  const f=fixture(t),revoked='wechat:private:456',store=createIdentityMindStore({root:f.root,account,allowed:()=>true});
  store.applyReflection({mood:{feeling:'平静',reason:'刚聊完音乐'},thoughts:[{text:'保留想法',sourceKey:key},{text:'REVOKED_THOUGHT',sourceKey:revoked}],relationships:[{personId:'wxid_fixture',sourceKey:revoked,name:'REVOKED_NAME'}],plans:[{title:'练歌',kind:'singing',detail:'试一小段',status:'pending',conversationKey:key},{title:'REVOKED_PLAN',kind:'drawing',detail:'旧聊天计划',status:'pending',conversationKey:revoked}]},{reflectionId:'ui-fixture',allowedKeys:[key,revoked]});
  store.claimPlan(store.snapshot().plans[0].id);
  const file=path.join(f.root,'state/identity-mind',account+'.json'),before=fingerprint(file);
  const app=createConsole({root:f.root,port:0,runner:async()=>{throw Error('NO_COMMANDS');},fetchImpl:async()=>{throw Error('NO_NETWORK');}});
  const address=await app.start();t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
  const base='http://127.0.0.1:'+address.port,info=await fetch(base+'/api/info').then(r=>r.json());
  const data=await fetch(base+'/api/identity-mind/status',{headers:{'X-Console-Token':info.token}}).then(r=>r.json());
  assert.equal(data.plans.length,1);assert.equal(data.plans[0].status,'running');assert.equal(data.thoughts.length,1);assert.equal(data.relationships.length,0);
  assert(!JSON.stringify(data).includes('REVOKED_'));assert(!('events' in data));assert(!('seen' in data));assert.equal(fingerprint(file),before);
});
