import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';

const sourceRoot=path.resolve(import.meta.dirname,'..'),key='wechat:private:123';
function copyModules(root,file,seen=new Set()){
 if(seen.has(file))return;seen.add(file);
 const source=path.resolve(sourceRoot,file),relative=path.relative(sourceRoot,source);
 assert(!relative.startsWith('..')&&!path.isAbsolute(relative));
 const text=fs.readFileSync(source,'utf8'),target=path.join(root,relative);
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);
 for(const match of text.matchAll(/(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"](\.[^'"]+)['"]/g)){
  copyModules(root,path.relative(sourceRoot,path.resolve(path.dirname(source),match[1])),seen);
 }
}
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-sessions-cli-'));
 t.after(()=>{assert(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 copyModules(root,'scripts/manage-dsh-sessions.mjs');
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({type:'module'}));
 const calls=[],sessions=[{conversationKey:key,sessionId:'fixture-session',title:'测试好友'}];
 let error;
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  calls.push({route:req.url,method:req.method,authorization:req.headers.authorization,body:raw?JSON.parse(raw):undefined});
  res.setHeader('content-type','application/json');
  if(error){res.statusCode=error.status;res.end(JSON.stringify({error:error.message}));return;}
  const result=req.url==='/health'?{contextMode:'native-session-v1'}:
   req.url==='/sessions'?{sessions}:
   req.url.startsWith('/api/v1/sessions')?{sessions:[{username:'fixture-user',displayName:'测试好友',conversationId:123}]}:
   req.url==='/configure'?{conversationKey:key,sessionId:'fixture-session',title:'测试好友'}:
   req.url==='/compact'?{compacted:true}:undefined;
  if(!result)res.statusCode=404;
  res.end(JSON.stringify(result??{error:'unexpected route'}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 for(const directory of ['config','state','roles'])fs.mkdirSync(path.join(root,directory),{recursive:true});
 const config={ports:{dshPlugin:server.address().port},wechat:{whitelist:{private:['123'],groups:[]}},persona:{default:'测试人格'}};
 fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));
 fs.writeFileSync(path.join(root,'state/wechat-io-config.json'),JSON.stringify({reader_base_url:`http://127.0.0.1:${server.address().port}`,reader_token:'fixture-reader'}));
 fs.writeFileSync(path.join(root,'state/social-dsh-token.txt'),'fixture-dsh');
 fs.writeFileSync(path.join(root,'roles/测试人格.md'),'# 测试人格\n仅用于本地测试。');
 const run=(...args)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(root,'scripts/manage-dsh-sessions.mjs'),...args],{cwd:os.tmpdir(),windowsHide:true,timeout:10000});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
  child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
 });
 return {root,calls,run,server,setError(value){error=value;}};
}
function friendlyFailure(result,pattern){
 assert.equal(result.code,1);assert.equal(result.stdout,'');
 assert.match(result.stderr,/WeChatAgent 会话管理：/);assert.match(result.stderr,pattern);
 assert.doesNotMatch(result.stderr,/\n\s+at |node:internal|file:\/\//);
}
test('invalid action and missing config return Chinese errors and exit code 1',async t=>{
 const f=await fixture(t);fs.unlinkSync(path.join(f.root,'config/wechatagent.json'));
 friendlyFailure(await f.run('invalid-action'),/用法/);friendlyFailure(await f.run('status'),/尚未完成首次配置/);
 assert.equal(f.calls.length,0);
});
test('invalid JSON and missing plugin token have actionable errors',async t=>{
 const f=await fixture(t),file=path.join(f.root,'config/wechatagent.json'),original=fs.readFileSync(file);
 fs.writeFileSync(file,'{');friendlyFailure(await f.run('status'),/不是有效的 JSON/);
 fs.writeFileSync(file,original);fs.unlinkSync(path.join(f.root,'state/social-dsh-token.txt'));
 friendlyFailure(await f.run('status'),/DSH 插件尚未加载/);assert.equal(f.calls.length,0);
});
test('status preserves JSON lines on stdout and authenticates only to DSH',async t=>{
 const f=await fixture(t),result=await f.run('status');
 assert.equal(result.code,0);assert.equal(result.stderr,'');
 assert.equal(JSON.parse(result.stdout.trim()).sessionId,'fixture-session');
 assert.deepEqual(f.calls.map(call=>call.route),['/health','/sessions']);
 assert(f.calls.every(call=>call.authorization==='Bearer fixture-dsh'));
});
test('configure and compact preserve conversation, persona and request order',async t=>{
 const f=await fixture(t);
 for(const action of ['configure','compact']){
  f.calls.length=0;const result=await f.run(action,key);
  assert.equal(result.code,0,result.stderr);assert.equal(result.stderr,'');
  const data=JSON.parse(result.stdout);assert.equal(data.title,'测试好友');
  assert.deepEqual(f.calls.map(call=>call.route),['/health','/api/v1/sessions?limit=500','/configure',...(action==='compact'?['/compact']:[])]);
  assert.equal(f.calls[1].authorization,'Bearer fixture-reader');
  assert.equal(f.calls[2].body.conversationKey,key);assert.equal(f.calls[2].body.personaName,'测试人格');
  assert.match(f.calls[2].body.persona,/仅用于本地测试/);
  if(action==='compact')assert.equal(data.compacted,true);
 }
});
test('unapproved conversation and missing persona never configure a session',async t=>{
 const f=await fixture(t);
 friendlyFailure(await f.run('configure','wechat:private:999'),/只允许管理/);
 fs.unlinkSync(path.join(f.root,'roles/测试人格.md'));
 friendlyFailure(await f.run('configure',key),/找不到人格/);
 assert(!f.calls.some(call=>call.route==='/configure'));
});
test('server session failures provide recovery guidance without deletion instructions',async t=>{
 const f=await fixture(t);f.setError({status:404,message:'session "fixture" not found'});
 const result=await f.run('status');friendlyFailure(result,/会话映射/);assert.doesNotMatch(result.stderr,/删除/);
});
test('connection refusal returns a friendly error and nonzero exit code',async t=>{
 const f=await fixture(t);await new Promise(resolve=>f.server.close(resolve));
 friendlyFailure(await f.run('status'),/DSH 插件端口没有响应/);
});
