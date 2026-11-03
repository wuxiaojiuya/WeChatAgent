import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import crypto from 'node:crypto';
import {MAX_PERSONA_BYTES,MAX_RPC_BYTES,localPersona,assertLocalPersona} from '../packages/dsh-social-bridge-plugin/local-policy.mjs';
import {MAX_PERSONA_BYTES as UI_MAX_PERSONA_BYTES,personaError} from '../public/console/persona-files.mjs';
import {DshPluginClient} from '../components/qq-bridge/src/dsh/plugin-client.js';
import {prepare,projectRoot} from './project-config.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wca-request-admission-'));
  for(const dir of ['state','config','roles'])fs.mkdirSync(path.join(root,dir));
  const config=JSON.parse(fs.readFileSync(path.join(projectRoot,'config/wechatagent.example.json'),'utf8'));
  fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));
  const name=config.persona.default,file=path.join(root,'roles',name+'.md'),snapshot=path.join(root,'state/bridge-config.json');
  const save=text=>{fs.writeFileSync(file,text);fs.writeFileSync(snapshot,JSON.stringify({role:text,persona_name:name,roles:{}}));};save('正常人格');
  t.after(()=>{assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});return{root,config,name,file,snapshot,save};
}

test('owner persona limits match the editor for long Chinese, ASCII and supplementary Unicode without truncation',t=>{
  const f=fixture(t);assert.equal(MAX_PERSONA_BYTES,UI_MAX_PERSONA_BYTES);
  for(const text of ['中'.repeat(20000),'A'.repeat(60000),'🐳'.repeat(15000)]){
    assert.equal(personaError(f.name,text),'');f.save(text);const locked=localPersona(f.root,'wechat:private:123');assert.equal(locked.persona,text);assert.equal(locked.personaName,f.name);
  }
  for(const text of ['中'.repeat(20001),'A'.repeat(60001),'\0bad','  ']){f.save(text);assert.throws(()=>localPersona(f.root,'wechat:private:123'),/LOCAL_PERSONA_CONFIG_REQUIRED/);}
});

test('digest transport preserves owner-only authority, legacy validation and stale-persona detection',t=>{
  const f=fixture(t),persona='仅使用本机设置的人格';f.save(persona);const locked=localPersona(f.root,'wechat:private:123'),digest=crypto.createHash('sha256').update(persona).digest('hex');
  assert.doesNotThrow(()=>assertLocalPersona({personaDigest:digest,personaName:f.name},locked));assert.doesNotThrow(()=>assertLocalPersona({persona,personaName:f.name},locked));
  for(const body of [{personaDigest:'a'.repeat(64)},{persona:'来自消息的替换人格'},{personaName:'其他人格'},{personaDigest:null},{personaDigest:digest,persona:'仍然不能覆盖'}])assert.throws(()=>assertLocalPersona(body,locked),/BEHAVIOR_CHANGE_NOT_ALLOWED/);
  fs.writeFileSync(f.snapshot,JSON.stringify({role:persona,persona_name:f.name,roles:{'wechat:private:123':{name:'独立人格',persona:'本机聊天专属人格'}}}));assert.equal(localPersona(f.root,'wechat:private:123').persona,persona,'a stale generated snapshot cannot override current owner settings');
  fs.writeFileSync(path.join(f.root,'roles/独立人格.md'),'本机聊天专属人格');f.config.persona.chats={'wechat:private:123':'独立人格'};fs.writeFileSync(path.join(f.root,'config/wechatagent.json'),JSON.stringify(f.config));assert.equal(localPersona(f.root,'wechat:private:123').persona,'本机聊天专属人格');
});

test('preparation rejects empty, oversized and wrong-mode cards before replacing the active snapshot',t=>{
  const f=fixture(t),before=fs.readFileSync(f.snapshot);
  for(const text of [' ','中'.repeat(20001),'## 一代专属 [v1]\n当前模式不可见']){fs.writeFileSync(f.file,text);assert.throws(()=>prepare(f.root),/人格/);assert.deepEqual(fs.readFileSync(f.snapshot),before);}
  const full='中'.repeat(20000);fs.writeFileSync(f.file,full);prepare(f.root);assert.equal(localPersona(f.root,'wechat:private:123').persona,full);
});

test('long-persona requests omit duplicate content, fit legacy 64 KiB transport and preserve all message rows',async t=>{
  const f=fixture(t),persona='A'.repeat(60000),message='群聊消息'.repeat(3500),metadata={persona,personaName:f.name,batchId:'b'.repeat(64),historyExcludeIds:Array.from({length:17},(_,index)=>String(index+1))};f.save(persona);
  assert(Buffer.byteLength(JSON.stringify({...metadata,conversationKey:'wechat:group:123',message}))>65536);
  let calls=0;
  const server=http.createServer(async(req,res)=>{calls++;let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;chunks.push(chunk);}assert(size<=65536);const body=JSON.parse(Buffer.concat(chunks));assert.equal(body.persona,undefined);assert.equal(body.message,message);assert.deepEqual(body.historyExcludeIds,metadata.historyExcludeIds);assert.equal(body.batchId,metadata.batchId);assertLocalPersona(body,localPersona(f.root,body.conversationKey));res.setHeader('content-type','application/json');res.end(JSON.stringify({text:'RESPOND: 全部收到'}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const client=new DshPluginClient({url:'http://127.0.0.1:'+server.address().port,token:'fixture'});
  assert.equal(await client.followup('wechat:group:123',message,metadata),'RESPOND: 全部收到');assert.equal(calls,1);assert.equal(metadata.persona,persona);
});

test('oversized transport is rejected locally before admission or any HTTP retry',async t=>{
  let calls=0;const server=http.createServer((_req,res)=>{calls++;res.end('{}');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const client=new DshPluginClient({url:'http://127.0.0.1:'+server.address().port,token:'fixture'});
  await assert.rejects(client.followup('wechat:private:123','正常消息',{unexpected:'x'.repeat(MAX_RPC_BYTES)}),error=>error.code==='REQUEST_TOO_LARGE'&&error.admitted===false&&error.limitBytes===MAX_RPC_BYTES);assert.equal(calls,0);
});
