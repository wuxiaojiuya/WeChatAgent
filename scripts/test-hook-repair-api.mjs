import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {createConsole} from './console-server.mjs';
import net from 'node:net';

test('receiver status explains an unavailable Hook API during polling or startup',async t=>{
 for(const stage of ['poll','startup'])await t.test(stage,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hook-receiver-health-'));
  fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'state/logs'),{recursive:true});
  const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));
  fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(root,'state/wechat-io-config.json'),JSON.stringify({receiver_token:'fixture'}));
  fs.mkdirSync(path.join(root,'state/hook'),{recursive:true});
  fs.writeFileSync(path.join(root,'state/hook/connection.json'),JSON.stringify({version:1,backend:'supplier-http',wechatVersion:'4.1.8.27',ownWxid:'wxid_fixture'}));
  fs.writeFileSync(path.join(root,'state/logs/receiver.stderr.log'),'Hook receiver initialization failed: HOOK_UPSTREAM_UNAVAILABLE');
  const app=createConsole({root,port:0,fetchImpl:async input=>{
   const url=new URL(input);
   if(stage==='poll'&&url.pathname==='/api/v1/receiver/status')return Response.json({success:true,lastError:'HOOK_UPSTREAM_UNAVAILABLE'});
   if(stage==='poll'&&url.pathname==='/api/v1/sessions')return Response.json({success:true,sessions:[]});
   throw Error('Fixture unavailable');
  }});
  t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  const address=await app.start(),base='http://127.0.0.1:'+address.port,info=await(await fetch(base+'/api/info')).json();
  const response=await fetch(base+'/api/status',{headers:{'X-Console-Token':info.token}}),status=await response.json();
  assert.equal(response.status,200);assert.equal(status.ready,false);
  const receiver=status.services.find(item=>item.id==='receiver');assert.equal(receiver.ready,false);
  assert.match(receiver.detail,/Hook 的联系人或消息接口暂未就绪/);assert.doesNotMatch(receiver.detail,/数据库/);
 });
});

test('supplier starts prepare the connection automatically while standalone checks require preparation',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'supplier-unbound-'));
 fs.mkdirSync(path.join(root,'config'));
 const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));
 Object.assign(config.hook,{backend:'supplier-http',expectedVersion:'4.1.8.27'});
 fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));
 const commands=[];
 const app=createConsole({root,port:0,runner:async spec=>{commands.push(spec);fs.mkdirSync(path.join(root,'state/hook'),{recursive:true});fs.writeFileSync(path.join(root,'state/hook/connection.json'),JSON.stringify({version:1,backend:'supplier-http',wechatVersion:'4.1.8.27',ownWxid:'wxid_fixture'}));return 0;}});
 t.after(async()=>{app.close();fs.rmSync(root,{recursive:true,force:true});});
 const address=await app.start(),base='http://127.0.0.1:'+address.port;
 const info=await fetch(base+'/api/info').then(r=>r.json());
 for(const [action,status] of [['reader-check',410],['hook-check',409]]){
   const response=await fetch(base+'/api/jobs',{method:'POST',headers:{'X-Console-Token':info.token,'Content-Type':'application/json'},body:JSON.stringify({action})});
   assert.equal(response.status,status);
   assert.match((await response.json()).error,/概览启动助手/);
 }
 assert.equal(commands.length,0);
 for(const action of ['start','restart']){
   const response=await fetch(base+'/api/jobs',{method:'POST',headers:{'X-Console-Token':info.token,'Content-Type':'application/json'},body:JSON.stringify({action})});
   assert.equal(response.status,202);const job=await response.json();
   let result;
   for(let i=0;i<40;i++){
     result=await fetch(base+'/api/job?id='+job.id,{headers:{'X-Console-Token':info.token}}).then(r=>r.json());
     if(result.state!=='running')break;
     await new Promise(resolve=>setTimeout(resolve,10));
   }
   assert.equal(result.state,'succeeded',JSON.stringify(result));assert.equal(result.connectionPrepared,true);
   assert(commands.at(-1).args.includes(path.join(root,'scripts/manage.ps1')));
   assert.deepEqual(JSON.parse(Buffer.from(commands.at(-1).args.at(-1),'base64').toString('utf8')),[action]);
 }
 assert.equal(commands.length,2);
});

test('supplier contact failures identify the dedicated API in both startup and polling status',async t=>{
 for(const [code,route] of [['HOOK_CONTACTS_RESPONSE_INVALID','/api/get_frien_lists'],['HOOK_GROUPS_RESPONSE_INVALID','/api/get_chatroom_list']]){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'supplier-contact-status-'));
  fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'state/logs'),{recursive:true});fs.mkdirSync(path.join(root,'state/hook'));
  const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));
  config.hook.backend='supplier-http';
  fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(root,'state/wechat-io-config.json'),JSON.stringify({receiver_token:'fixture'}));
  fs.writeFileSync(path.join(root,'state/hook/connection.json'),JSON.stringify({version:1,backend:'supplier-http',wechatVersion:'4.1.8.27',ownWxid:'wxid_fixture'}));
  fs.writeFileSync(path.join(root,'state/logs/receiver.stderr.log'),'Hook receiver initialization failed: '+code);
  const app=createConsole({root,port:0,fetchImpl:async input=>{
   const url=new URL(input);
   if(url.pathname==='/api/v1/receiver/status')return Response.json({success:true,lastError:code});
   if(url.pathname==='/api/v1/sessions')return Response.json({success:true,sessions:[]});
   throw Error('Fixture unavailable');
  }});
  t.after(async()=>{app.close();fs.rmSync(root,{recursive:true,force:true});});
  const address=await app.start(),base='http://127.0.0.1:'+address.port,info=await fetch(base+'/api/info').then(r=>r.json());
  const status=await fetch(base+'/api/status',{headers:{'X-Console-Token':info.token}}).then(r=>r.json());
  const receiver=status.services.find(item=>item.id==='receiver');assert.equal(receiver.label,'消息接收');assert.equal(receiver.ready,false);
  assert(receiver.detail.includes(route));assert.doesNotMatch(receiver.detail,/数据库|重新连接并验证/);
 }
});

test('automatic connection may restore account chat settings but cannot hide other configuration changes',async t=>{
 for(const unexpectedChange of [false,true])await t.test(unexpectedChange?'unrelated configuration change':'restored account chats',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'supplier-startup-config-'));
  fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'state/hook'),{recursive:true});
  const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));
  config.hook.backend='supplier-http';
  const configFile=path.join(root,'config/wechatagent.json'),connectionFile=path.join(root,'state/hook/connection.json');
  fs.writeFileSync(configFile,JSON.stringify(config));
  const binding={version:1,backend:'supplier-http',wechatVersion:'4.1.8.27',ownWxid:'wxid_before'};
  fs.writeFileSync(connectionFile,JSON.stringify(binding));
  const app=createConsole({root,port:0,runner:async()=>{
   const updated=structuredClone(config);updated.wechat.whitelist.private=['123'];
   if(unexpectedChange)updated.hook.wechatExecutable='C:/unrelated/Weixin.exe';
   fs.writeFileSync(configFile,JSON.stringify(updated));
   const next={...binding,ownWxid:'wxid_after'};fs.writeFileSync(connectionFile,JSON.stringify(next));
   return 0;
  }});
  t.after(async()=>{app.close();fs.rmSync(root,{recursive:true,force:true});});
  const address=await app.start(),base='http://127.0.0.1:'+address.port,info=await fetch(base+'/api/info').then(r=>r.json());
  const headers={'X-Console-Token':info.token,'Content-Type':'application/json'};
  const response=await fetch(base+'/api/jobs',{method:'POST',headers,body:JSON.stringify({action:'start'})});
  assert.equal(response.status,202);const job=await response.json();let result;
  for(let i=0;i<40;i++){
   result=await fetch(base+'/api/job?id='+job.id,{headers}).then(r=>r.json());
   if(result.state!=='running')break;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(result.state,unexpectedChange?'failed':'succeeded',JSON.stringify(result));
  if(unexpectedChange)assert.match(result.message,/设置在启动期间发生变化/);
  else assert.equal(result.accountSwitched,true,'The UI must refresh restored chat settings after automatic connection changes');
 });
});
test('a failed startup port stays inspectable even when cached status claims the adapter is healthy',async t=>{
 const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'port-recovery-api-'));
 fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'state'));const config=JSON.parse(fs.readFileSync(path.join(source,'config/wechatagent.example.json'),'utf8'));
 Object.assign(config.hook,{backend:'supplier-http',expectedVersion:'4.1.8.27'});
 const onebot=net.createServer(socket=>socket.end());await new Promise(resolve=>onebot.listen(0,'127.0.0.1',resolve));config.ports.onebot=onebot.address().port;t.after(()=>new Promise(resolve=>onebot.close(resolve)));
 fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));fs.writeFileSync(path.join(root,'state/wechat-io-config.json'),JSON.stringify({receiver_token:'fixture'}));
 fs.mkdirSync(path.join(root,'state/hook'));fs.writeFileSync(path.join(root,'state/hook/connection.json'),JSON.stringify({version:1,backend:'supplier-http',wechatVersion:'4.1.8.27',ownWxid:'wxid_fixture'}));
 const probes=[],app=createConsole({root,port:0,runner:async(_spec,output)=>{output('SERVICE_PORT_IN_USE service=adapter port=8766 owners=777');return 1;},fetchImpl:async input=>{
  const url=new URL(input);return new Response(JSON.stringify(url.pathname==='/status'?{ob_connected:true,receiver_connected:true,hook_connected:true,hook_ready:true,version:config.hook.expectedVersion}:{lastError:''}));
 },processProbe:async input=>{probes.push(input);return{items:[]};},processStop:async()=>{throw Error('Inspection must not terminate processes');}});
 t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 const address=await app.start(),base=`http://127.0.0.1:${address.port}`,info=await(await fetch(base+'/api/info')).json();
 const api=async(route,body)=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'X-Console-Token':info.token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
 const initial=await api('/api/status');assert(initial.body.services.find(service=>service.id==='bridge').ready);assert.match(initial.body.services.find(service=>service.id==='bridge').detail,/单账号模式/);assert.doesNotMatch(initial.body.services.find(service=>service.id==='bridge').detail,/账号已核验/);
 assert.equal((await api('/api/jobs',{action:'start'})).status,202);
 for(let i=0;i<30;i++){if((await api('/api/status')).body.latestJob?.state==='failed')break;await new Promise(resolve=>setTimeout(resolve,20));}
 const scan=await api('/api/process-recovery');assert.equal(scan.status,200);assert(probes.at(-1).ports.includes(8766),'Cached healthy status must not hide the failed port');assert(!probes.at(-1).ports.includes(config.ports.onebot),'Other healthy ports stay protected');
});
test('repair API scopes process termination to the configured client and requires a single-use second confirmation',async t=>{
 const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'hook-repair-api-'));
 fs.mkdirSync(path.join(root,'config'));const config=JSON.parse(fs.readFileSync(path.join(source,'config/wechatagent.example.json'),'utf8'));fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));
 const probes=[],stops=[];
 const app=createConsole({root,port:0,runner:async()=>{throw Error('No real commands allowed');},fetchImpl:async()=>{throw Error('No production API requests allowed');},processProbe:async input=>{probes.push(input);return{items:[{pid:777,name:'Weixin.exe',path:input.wechatExecutable,start:'123',commandHash:'fixture',ports:[],canStop:true},{pid:778,name:'Weixin.exe',path:'C:/unrelated/Weixin.exe',start:'124',commandHash:'fixture',ports:[],canStop:true}]};},processStop:async input=>{stops.push(input);return{stopped:input.items.map(i=>i.pid)};}});
 t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 const address=await app.start(),base=`http://127.0.0.1:${address.port}`,info=await(await fetch(base+'/api/info')).json();
 const api=async(route,body)=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'X-Console-Token':info.token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
 const scan=await api('/api/process-recovery?purpose=hook-repair');assert.equal(scan.status,200);assert.equal(scan.body.purpose,'hook-repair');assert.equal(scan.body.items.length,1);assert.deepEqual(probes[0].ports,[]);assert.equal(probes[0].matchingWeChatOnly,true);assert.equal(probes[0].includeMatchingWeChat,true);assert.equal(stops.length,0);
 const prepared=await api('/api/process-recovery/prepare',{scanId:scan.body.scanId,ids:[scan.body.items[0].id]});assert.equal(prepared.status,200);assert.equal(stops.length,0);
 const request={confirmation:prepared.body.confirmation};assert.equal((await api('/api/process-recovery/stop',request)).status,409);assert.equal(stops.length,0);
 assert.equal((await api('/api/process-recovery/stop',{...request,confirmed:true})).status,200);assert.equal(stops.length,1);assert.deepEqual(stops[0].items.map(i=>i.pid),[777]);
 assert.equal((await api('/api/process-recovery/stop',{...request,confirmed:true})).status,409);assert.equal(stops.length,1);
});
