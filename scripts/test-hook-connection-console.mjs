import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createConsole} from './console-server.mjs';

const connection={version:1,backend:'supplier-http',wechatVersion:'4.1.8.27',ownWxid:'wxid_fixture'};
async function fixture(t,{prepared=false,runner}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hook-console-'));
  const write=(name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
  const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));
  write('config/wechatagent.json',config);if(prepared)write('state/hook/connection.json',connection);
  const commands=[],app=createConsole({root,port:0,runner:async(spec,output)=>{commands.push(spec);return runner?runner({root,write,spec,output}):0;},fetchImpl:async()=>{throw Error('No live requests');},filePicker:async()=>{throw Error('No native dialogs');}});
  t.after(()=>{app.close();fs.rmSync(root,{recursive:true,force:true});});
  const address=await app.start(),origin='http://127.0.0.1:'+address.port,info=await fetch(origin+'/api/info').then(r=>r.json());
  const request=async(route,body)=>{const response=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{'X-Console-Token':info.token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
  const wait=async id=>{for(let i=0;i<50;i++){const {body}=await request('/api/job?id='+id);if(body.state!=='running')return body;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Fixture job did not finish');};
  return{root,write,commands,request,wait};
}

test('connection API exposes only Hook metadata for prepared and unprepared installations',async t=>{
  for(const prepared of [false,true])await t.test(String(prepared),async t=>{
    const f=await fixture(t,{prepared}),result=await f.request('/api/hook/connection');
    assert.equal(result.status,200);assert.equal(result.body.prepared,prepared);assert.equal(result.body.ownWxid,prepared?connection.ownWxid:'');
    assert.deepEqual(Object.keys(result.body).sort(),['backend','ownWxid','prepared','revision','version','wechatVersion']);assert.match(result.body.revision,/^[a-f0-9]{64}$/);
    assert.equal((await f.request('/api/deployment')).body.configured,prepared);assert.equal(f.commands.length,0);
  });
});

test('removed database APIs and actions reject stale clients without scanning, writing or starting commands',async t=>{
  const f=await fixture(t,{prepared:true});
  const files=['config/wechatagent.json','state/hook/connection.json'],before=files.map(name=>fs.readFileSync(path.join(f.root,name)));
  for(const route of ['/api/reader-accounts','/api/reader-config']){
    for(const body of [undefined,{dbPath:'C:/DoNotReadWeChat',myWxid:'do-not-select',decryptKey:'do-not-protect'}])assert.equal((await f.request(route,body)).status,410);
  }
  for(const action of ['reader-connect','reader-check'])assert.equal((await f.request('/api/jobs',{action,dbPath:'C:/DoNotReadWeChat',autoKey:true})).status,410);
  assert.equal((await f.request('/api/hook/connection',{...connection,dbPath:'C:/DoNotReadWeChat'})).status,404);
  assert.equal(f.commands.length,0);files.forEach((name,index)=>assert.deepEqual(fs.readFileSync(path.join(f.root,name)),before[index]));
  assert(!fs.existsSync(path.join(f.root,'state/weflow')));
});

test('overview start prepares the Hook connection through the supervisor and publishes its new state',async t=>{
  const f=await fixture(t,{runner:({write})=>{write('state/hook/connection.json',connection);return 0;}});
  const response=await f.request('/api/jobs',{action:'start'});assert.equal(response.status,202);
  const job=await f.wait(response.body.id);assert.equal(job.state,'succeeded',JSON.stringify(job));assert.equal(job.connectionPrepared,true);assert(!('readerConfigured' in job));
  assert.equal(f.commands.length,1);assert(f.commands[0].args.includes(path.join(f.root,'scripts/manage.ps1')));
  assert.equal((await f.request('/api/hook/connection')).body.prepared,true);
});

test('receiver credentials remain hidden in console job output',async t=>{
  const secret='fixture-private-receiver-token';
  const f=await fixture(t,{runner:({output})=>{output(JSON.stringify({receiver_token:secret}));return 1;}});
  const response=await f.request('/api/jobs',{action:'start'});assert.equal(response.status,202);
  const job=await f.wait(response.body.id);assert.equal(job.state,'failed');assert(!job.output.includes(secret));assert.match(job.output,/已隐藏/);
});

test('production UI and console no longer import database setup or expose database fields',()=>{
  const server=fs.readFileSync(new URL('console-server.mjs',import.meta.url),'utf8');
  const ui=fs.readFileSync(new URL('../public/console/console.js',import.meta.url),'utf8');
  const layout=fs.readFileSync(new URL('../public/console/workspace-layout.js',import.meta.url),'utf8');
  assert.doesNotMatch(server,/from ['"].*(?:reader-setup|reader-account-state|wechat-account-check)|runReaderSetup|readerRequest\(|accountVerifier/);
  assert.doesNotMatch(ui,/dbPath|decryptKey|reader-connect|reader-check|reader-accounts|reader-config|weflowMode|ports\.weflow/);
  assert.doesNotMatch(layout,/reader-check|reader-connect|ack-dsh|dbPath|decryptKey/);
  assert.match(ui,/\/api\/hook\/connection/);assert.match(ui,/ports\.receiver/);
});
