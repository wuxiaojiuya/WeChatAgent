import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createConsole} from './console-server.mjs';
import {conversationId} from './hook-onebot.mjs';
import {chatContactNames} from './chat-contact-names.mjs';

const friend='wxid_fixture_friend',stranger='wxid_fixture_stranger',id=String(conversationId(friend)),key='wechat:private:'+id;
test('current contact names override message history without altering IDs, scope or sessions',()=>{
  const wechat={whitelist:{private:[id],groups:['123']}},before=JSON.stringify(wechat);
  const contacts=[{username:friend,displayName:'新备注'}, {username:'room@chatroom',conversationId:'123',displayName:'新群名'}, {username:stranger,displayName:'未允许'}];
  const rows=chatContactNames(wechat,contacts,{chats:{[key]:[{conversation_name:'旧名',timestamp:99}]}});
  assert.deepEqual(rows,[{key,name:'新备注',lastAt:99},{key:'wechat:group:123',name:'新群名',lastAt:0}]);
  assert.equal(JSON.stringify(wechat),before);
  assert.equal(chatContactNames(wechat,[],{}, {[key]:'离线备注'})[0].name,'离线备注');
});

test('console discovers only friends and resolves allowed names before any message or DSH session exists',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechatagent-contact-test-'));
  const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));
  config.wechat.whitelist={private:[id],groups:[]};
  const write=(relative,value)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
  write('config/wechatagent.json',config);fs.mkdirSync(path.join(root,'roles'));
  fs.writeFileSync(path.join(root,'roles',config.persona.default+'.md'),'Fixture persona');
  write('state/wechat-io-config.json',{self_wxid:'wxid_self',receiver_token:'fixture-contacts-token'});
  write('state/hook/active-connection.json',{id:'a'.repeat(64)});
  const calls=[];let offline=false,name='新好友昵称';
  const app=createConsole({root,port:0,fetchImpl:async(input,options)=>{
    if(offline)throw Error('offline');
    const url=new URL(input);calls.push(url);assert.equal(options.headers.Authorization,'Bearer fixture-contacts-token');
    assert.equal(url.pathname,'/api/v1/contacts');
    return Response.json({success:true,contacts:[{username:friend,displayName:name,isFriend:true}, ...(url.searchParams.has('selected')?[]:[{username:stranger,displayName:'群成员',isFriend:false},{username:'wxid_self',displayName:'Self',isFriend:true}])]});
  }});
  t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(r=>app.server.close(r));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const address=await app.start(),base='http://127.0.0.1:'+address.port,info=await (await fetch(base+'/api/info')).json();
  const get=async route=>{const response=await fetch(base+route,{headers:{'X-Console-Token':info.token}});assert.equal(response.status,200);return response.json();};
  const contacts=(await get('/api/contacts?kind=private&includeIdentity=1')).contacts;
  assert.deepEqual(contacts.map(c=>c.id),[id]);assert.equal(contacts[0].name,'新好友昵称');assert.equal(contacts[0].wechatId,friend);
  assert.equal((await get('/api/chats')).chats[0].name,'新好友昵称');
  name='新备注';assert.equal((await get('/api/chats')).chats[0].name,name);
  assert(calls.some(url=>url.searchParams.get('selected')==='1'&&url.searchParams.get('refresh')==='1'));
  offline=true;assert.equal((await get('/api/chats')).chats[0].name,name);
  write('state/hook/active-connection.json',{id:'b'.repeat(64)});
  assert.equal((await get('/api/chats')).chats[0].name,''); // Never reuse A's name cache in account B.
  assert.equal((await fetch(base+'/api/contacts')).status,401);
});
