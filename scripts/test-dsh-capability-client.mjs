import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {createDshCapabilityClient} from './dsh-capability-client.mjs';
import {CAPABILITY_EXECUTION_VERSION} from '../packages/dsh-capabilities-plugin/contract.mjs';

const account='b'.repeat(64),token='fixture-private-rpc-token';
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-capability-client-'));fs.mkdirSync(path.join(root,'state'));fs.writeFileSync(path.join(root,'state/social-dsh-token.txt'),token);
  const state={scope:account,token,instanceId:crypto.randomUUID(),health:{},healthRequests:0,posts:0,accepted:0,bodies:[],onPost:null};
  const server=http.createServer(async(req,res)=>{try{
    if(req.headers.authorization!=='Bearer '+state.token){res.writeHead(401);res.end('{}');return;}
    assert.equal(req.headers.host,'127.0.0.1:'+server.address().port);
    if(req.url==='/health'){state.healthRequests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,project:'WeChatAgent',projectRoot:root,capabilityExecution:CAPABILITY_EXECUTION_VERSION,accountScope:account,instanceId:state.instanceId,...state.health}));return;}
    assert.equal(req.url,'/capability-execution');assert.equal(req.method,'POST');state.posts++;const parts=[];for await(const part of req)parts.push(part);const body=JSON.parse(Buffer.concat(parts));state.bodies.push(body);
    if(body.dshInstanceId!==state.instanceId){res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({error:'DSH_CONNECTION_CHANGED'}));return;}
    state.accepted++;if(state.onPost)return await state.onPost(req,res,body);
    res.writeHead(200,{'content-type':'application/x-ndjson'});res.end(JSON.stringify({event:'result',value:{ok:true}})+'\n');
  }catch(error){if(!res.headersSent)res.writeHead(500);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  const config=()=>({ports:{dshPlugin:server.address().port}}),client=createDshCapabilityClient({root,config,accountScope:()=>state.scope});
  return {root,state,server,config,client};
}

test('DSH client authenticates localhost health, binds root scope instance and issuedAt, then reads fragmented NDJSON progress and result',async t=>{
  const f=await fixture(t),progress=[];
  f.state.onPost=(req,res,body)=>{assert.match(body.requestId,/^[a-f0-9-]{36}$/);assert(Number.isSafeInteger(body.issuedAt));assert(Math.abs(Date.now()-body.issuedAt)<5000);assert.equal(body.accountScope,account);assert.deepEqual(body.payload,{prompt:'fixture'});
    res.writeHead(200,{'content-type':'application/x-ndjson; charset=utf-8'});const bytes=Buffer.from(JSON.stringify({event:'progress',stage:'正在绘画'})+'\n'+JSON.stringify({event:'result',value:{image:'fixture',width:2,height:2}})+'\n');res.write(bytes.subarray(0,29));res.end(bytes.subarray(29));};
  assert.deepEqual(await f.client.execute('drawing.generate',{prompt:'fixture'},{onProgress:stage=>progress.push(stage)}),{image:'fixture',width:2,height:2});assert.deepEqual(progress,['正在绘画']);assert.equal(f.state.healthRequests,1);assert.equal(f.state.posts,1);
});

test('DSH client fails closed for missing token, wrong token, account, project root or execution version without provider submission',async t=>{
  const missing=await fixture(t);fs.unlinkSync(path.join(missing.root,'state/social-dsh-token.txt'));await assert.rejects(missing.client.execute('drawing.check',{}),{code:'DSH_CAPABILITY_UNAVAILABLE'});assert.equal(missing.state.posts,0);
  const wrongToken=await fixture(t);wrongToken.state.token='different-fixture-token';await assert.rejects(wrongToken.client.execute('drawing.check',{}),{code:'DSH_CAPABILITY_UNAVAILABLE'});assert.equal(wrongToken.state.posts,0);
  for(const health of [{ok:false},{project:'AnotherProject'},{projectRoot:path.resolve(os.tmpdir(),'different-root')},{accountScope:'c'.repeat(64)},{capabilityExecution:'old-generation-v0'},{instanceId:null}]){
    const f=await fixture(t);f.state.health=health;await assert.rejects(f.client.execute('drawing.check',{}),{code:'DSH_CAPABILITY_UNAVAILABLE'});assert.equal(f.state.posts,0);
  }
});

test('DSH instance changes between health and POST reject once and never resubmit',async t=>{
  const f=await fixture(t);f.state.health.instanceId=crypto.randomUUID();await assert.rejects(f.client.execute('drawing.generate',{}),error=>error.code==='DSH_CAPABILITY_REJECTED'&&error.message.includes('重新加载'));
  assert.equal(f.state.posts,1);assert.equal(f.state.accepted,0);
});

test('DSH NDJSON provider error preserves its fixed code and HTTP status without retry',async t=>{
  const f=await fixture(t);f.state.onPost=(req,res)=>{res.writeHead(200,{'content-type':'application/x-ndjson'});res.end(JSON.stringify({event:'error',code:'DRAWING_KEY_INVALID',message:'DRAWING_KEY_INVALID',status:502})+'\n');};
  await assert.rejects(f.client.execute('drawing.generate',{}),{code:'DRAWING_KEY_INVALID',message:'DRAWING_KEY_INVALID',status:502});assert.equal(f.state.posts,1);
});

test('NDJSON EOF, malformed frames, lost connection and wrong content type each fail once without retry or fallback',async t=>{
  for(const mode of ['eof','truncated','invalid','disconnect','content-type']){
    const f=await fixture(t);f.state.onPost=(req,res)=>{res.writeHead(200,{'content-type':mode==='content-type'?'application/json':'application/x-ndjson'});
      if(mode==='disconnect'){res.write(JSON.stringify({event:'progress',stage:'正在处理'})+'\n');res.destroy();}
      else res.end(mode==='eof'?'':mode==='truncated'?'{"event":"result","value":':mode==='invalid'?'not-json\n':'{}');};
    await assert.rejects(f.client.execute('drawing.generate',{}),error=>error.code===(mode==='content-type'?'CAPABILITY_PROTOCOL_INVALID':'CAPABILITY_RESULT_UNCONFIRMED'));
    assert.equal(f.state.posts,1);assert.equal(f.state.accepted,1);
  }
});

test('client cancellation disconnects a running stream and account changes suppress a returned result',async t=>{
  const cancelled=await fixture(t),controller=new AbortController();let started,closed;const submitted=new Promise(resolve=>started=resolve),disconnected=new Promise(resolve=>closed=resolve);
  cancelled.state.onPost=(req,res)=>{res.writeHead(200,{'content-type':'application/x-ndjson'});res.write(JSON.stringify({event:'progress',stage:'正在生成'})+'\n');res.once('close',closed);started();};
  const pending=cancelled.client.execute('drawing.generate',{}, {signal:controller.signal});await submitted;controller.abort();await assert.rejects(pending,{code:'CAPABILITY_RESULT_UNCONFIRMED'});await disconnected;assert.equal(cancelled.state.posts,1);
  const changed=await fixture(t);changed.state.onPost=(req,res)=>{changed.state.scope='c'.repeat(64);res.writeHead(200,{'content-type':'application/x-ndjson'});res.end(JSON.stringify({event:'result',value:{image:'late'}})+'\n');};
  await assert.rejects(changed.client.execute('drawing.generate',{}),{code:'CAPABILITY_ACCOUNT_CHANGED'});assert.equal(changed.state.posts,1);
});

test('NDJSON accepts a full bounded image result and rejects transport bodies larger than 48 MiB',async t=>{
  const f=await fixture(t),large=Buffer.alloc(16*1024*1024,1).toString('base64');f.state.onPost=(req,res)=>{res.writeHead(200,{'content-type':'application/x-ndjson'});res.end(JSON.stringify({event:'result',value:{image:large,width:2,height:2}})+'\n');};
  const result=await f.client.execute('drawing.generate',{});assert.equal(result.image.length,large.length);assert.equal(result.image,large);assert.equal(f.state.posts,1);
  let posts=0;const tooLarge=createDshCapabilityClient({root:f.root,config:f.config,accountScope:()=>account,fetchImpl:async(url)=>{
    if(url.endsWith('/health'))return Response.json({ok:true,project:'WeChatAgent',projectRoot:f.root,capabilityExecution:CAPABILITY_EXECUTION_VERSION,accountScope:account,instanceId:f.state.instanceId});
    posts++;let chunks=0;return new Response(new ReadableStream({pull(controller){if(chunks++<49)controller.enqueue(new Uint8Array(1024*1024).fill(32));else controller.close();}}),{headers:{'content-type':'application/x-ndjson'}});
  }});
  await assert.rejects(tooLarge.execute('drawing.generate',{}),{code:'CAPABILITY_RESULT_TOO_LARGE'});assert.equal(posts,1);
});
