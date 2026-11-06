import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createAudioRuntimeInstaller} from './audio-runtime-installer.mjs';
import {prepareAudioBootstrap} from './audio-bootstrap.mjs';
import {createConsole} from './console-server.mjs';
import {audioRuntimeMarkup} from '../public/console/audio-runtime.js';
import {consoleRoute} from '../public/console/layout-model.mjs';
import http from 'node:http';
import {downloadAudioAsset} from './download-audio-asset.mjs';

const fixture=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'audio-installer-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const waitUntil=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('job did not settle');};
function worker(){const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>c.emit('close',1);return c;}
const options=root=>({root,platform:'win32',arch:'x64',portProbe:async()=>false,processCheck:async()=>{},bootstrap:async()=>'/independent/python.exe'});

test('asset downloader resumes interrupted downloads and rejects a corrupted package',async t=>{
  const root=fixture(t),bytes=Buffer.from('verified data for resumable download'),offsets=[];
  const server=http.createServer((req,res)=>{const offset=Number(/^bytes=(\d+)-$/.exec(req.headers.range??'')?.[1]??0);offsets.push(offset);res.writeHead(offset?206:200,{'Content-Length':bytes.length-offset,'Content-Range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`});res.end(bytes.subarray(offset));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const target=path.join(root,'package.zip'),url=`http://127.0.0.1:${server.address().port}/package.zip`,sha=crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(target+'.partial',bytes.subarray(0,8));await downloadAudioAsset(url,target,sha,bytes.length);
  assert.deepEqual(offsets,[8]);assert.deepEqual(fs.readFileSync(target),bytes);fs.unlinkSync(target);
  await assert.rejects(downloadAudioAsset(url,target,'0'.repeat(64),bytes.length),/HASH_MISMATCH/);assert(!fs.existsSync(target));assert(!fs.existsSync(target+'.partial'));
});

test('official HTTP rejection is distinct from connection failure and preserves partial downloads',async t=>{
  const root=fixture(t),target=path.join(root,'official.fst');fs.writeFileSync(target+'.partial','partial');
  for(const status of [403,429])await assert.rejects(downloadAudioAsset('https://modelscope.cn/test',target,'0'.repeat(64),100,{fetchImpl:async()=>new Response('limited',{status})}),error=>error.message==='AUDIO_DOWNLOAD_ACCESS_DENIED'&&error.status===status);
  assert.equal(fs.readFileSync(target+'.partial','utf8'),'partial');assert(!fs.existsSync(target));
});

test('large official assets continue bounded ranges and resume without losing validated bytes',async t=>{
  const root=fixture(t),bytes=Buffer.from('official model ranged payload'),target=path.join(root,'model.pt'),requests=[];
  const sha=crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(target+'.partial',bytes.subarray(0,3));
  await downloadAudioAsset('https://huggingface.co/official/model.pt',target,sha,bytes.length,{rangeBytes:7,fetchImpl:async(url,options)=>{
    const match=/bytes=(\d+)-(\d+)/.exec(options.headers.Range),start=Number(match[1]),end=Number(match[2]);requests.push([start,end]);
    assert.equal(new URL(url).searchParams.get('range_start'),String(start));
    return new Response(bytes.subarray(start,end+1),{status:206,headers:{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}});
  }});
  assert.equal(requests[0][0],3);assert(requests.length>1);assert.deepEqual(fs.readFileSync(target),bytes);
  fs.unlinkSync(target);
  await assert.rejects(downloadAudioAsset('https://huggingface.co/official/model.pt',target,sha,bytes.length,{rangeBytes:7,fetchImpl:async()=>new Response(bytes.subarray(0,7),{status:206,headers:{'Content-Range':`bytes 7-13/${bytes.length}`}})}),/RANGE_INVALID/);
  assert(!fs.existsSync(target));
});

test('official download denial reports the source and HTTP status in the console job',async t=>{
  const root=fixture(t),c=worker();const service=createAudioRuntimeInstaller({...options(root),launch:()=>c});
  await service.start({kind:'tts',action:'install'});await waitUntil(()=>service.status().job.state==='running'&&fs.existsSync(path.join(root,'state/audio-install/operation.lock')));
  await new Promise(resolve=>setImmediate(resolve));
  c.stdout.write(JSON.stringify({phase:'diagnostic',message:'download denied',httpStatus:403,sourceHost:'modelscope.cn'})+'\n');
  c.stdout.write(JSON.stringify({phase:'failed',message:'failed',code:'AUDIO_DOWNLOAD_ACCESS_DENIED'})+'\n');c.emit('close',1);
  assert.equal(service.status().job.code,'AUDIO_DOWNLOAD_ACCESS_DENIED');assert.match(service.status().job.message,/modelscope\.cn.*HTTP 403/);
});

test('bootstrap verifies downloaded bytes before any extraction or execution',async t=>{
  const root=fixture(t);fs.mkdirSync(path.join(root,'scripts'));const bytes=Buffer.from('trusted archive');
  fs.writeFileSync(path.join(root,'scripts/audio-runtime-manifest.json'),JSON.stringify({baseUrl:'http://packages.invalid/',bootstrap:{file:'bootstrap.zip',bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}}));
  let executions=0;const execute=async()=>{executions++;};
  await assert.rejects(prepareAudioBootstrap(root,()=>{},{execute,fetchImpl:async()=>new Response(Buffer.from('untrusted file!'))}),/HASH_MISMATCH/);
  assert.equal(executions,0);assert(!fs.existsSync(path.join(root,'state/audio-install/bootstrap')));
  const python=await prepareAudioBootstrap(root,()=>{},{fetchImpl:async()=>new Response(bytes),execute:async(exe,args)=>{executions++;assert(!args.some(arg=>arg.includes('packages.invalid')));const dest=args.at(-1);fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(dest,'python.exe'),'fixture');}});
  assert.equal(executions,1);assert(python.endsWith(path.join('bootstrap','python.exe')));
});

test('jobs stay busy during bootstrap, reject concurrent actions and persist only verified success',async t=>{
  const root=fixture(t),c=worker();let release;const gate=new Promise(r=>release=r);let launches=0;
  const app=createAudioRuntimeInstaller({...options(root),bootstrap:async()=>{await gate;return '/independent/python.exe';},launch:(exe,args)=>{launches++;assert.equal(exe,'/independent/python.exe');assert(args.includes('--root'));return c;}});
  await app.start({kind:'all',action:'repair'});assert(app.isBusy());assert.equal(launches,0);
  await assert.rejects(app.start({kind:'tts',action:'check'}),e=>e.status===409);
  const other=createAudioRuntimeInstaller({...options(root),launch:()=>{assert.fail('must not launch twice');}});
  await assert.rejects(other.start({kind:'rvc',action:'repair'}),e=>e.status===409);
  release();await waitUntil(()=>launches===1);
  c.stdout.write(JSON.stringify({phase:'validation',message:'生成音频',downloaded:5,total:10})+'\n');
  assert.equal(app.status().job.phase,'validation');assert.equal(app.status().job.state,'running');
  c.stdout.write(JSON.stringify({phase:'failed',message:'失败',code:'AUDIO_MODEL_HASH_MISMATCH'})+'\n');c.emit('close',1);
  assert.equal(app.status().job.state,'failed');assert.match(app.status().job.message,/模型/);assert(!fs.existsSync(path.join(root,'state/audio-install/operation.lock')));
  const next=createAudioRuntimeInstaller(options(root));assert.equal(next.status().job.state,'failed');
});

test('running service blocks repair while read-only checks remain available; invalid input never launches',async t=>{
  const root=fixture(t);let launches=0;const c=worker();
  const app=createAudioRuntimeInstaller({...options(root),portProbe:async()=>true,launch:()=>{launches++;return c;}});
  await assert.rejects(app.start({kind:'all',action:'repair',url:'http://untrusted.invalid'}),e=>e.status===400);
  await app.start({kind:'rvc',action:'repair'});await waitUntil(()=>!app.isBusy());assert.equal(launches,0);assert.equal(app.status().job.code,'AUDIO_SERVICES_RUNNING');
  await app.start({kind:'tts',action:'check'});await waitUntil(()=>launches===1);c.emit('close',0);
  assert.equal(app.status().job.state,'success');assert.match(app.status().job.message,/检查通过/);
});

test('settings expose install, repair, progress and failure without claiming an installed model from file presence',()=>{
  assert.deepEqual(consoleRoute('#settings/audio'),{page:'settings',section:'audio'});
  const data={supported:true,busy:true,environments:[{name:'TTS',label:'已有环境 · 待检查'}],job:{state:'running',message:'下载中',downloaded:25,total:100,events:[]}};
  const html=audioRuntimeMarkup(data,x=>String(x));assert.match(html,/一键安装/);assert.match(html,/一键修复/);assert.match(html,/value="25"/);assert.equal((html.match(/data-audio-runtime="[a-z]+" disabled/g)??[]).length,3);assert(!html.includes('API Key'));
});

test('console API authenticates, validates enums, has read-only GETs and blocks starts during installation',async t=>{
  const root=fixture(t);fs.mkdirSync(path.join(root,'config'));fs.copyFileSync(new URL('../config/wechatagent.example.json',import.meta.url),path.join(root,'config/wechatagent.json'));
  const c=worker();let launches=0;
  const nodeExecutable=path.join(root,'bundled-node.exe');
  const app=createConsole({root,port:0,nodeExecutable,audioInstallerOptions:{...options(root),launch:(_python,_args,launchOptions)=>{assert.equal(launchOptions.env.WECHATAGENT_INSTALL_NODE,nodeExecutable);launches++;return c;}},runner:()=>{assert.fail('must not start project services');}});
  t.after(()=>app.close());const address=await app.start(),base='http://127.0.0.1:'+address.port;
  assert.equal((await fetch(base+'/api/audio-runtime/status')).status,401);
  const info=await fetch(base+'/api/info').then(r=>r.json());
  const request=(route,body)=>fetch(base+route,{headers:{'X-Console-Token':info.token,...(body?{'Content-Type':'application/json'}:{})},method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await request('/api/audio-runtime/status')).status,200);assert.equal(launches,0);
  assert.equal((await request('/api/audio-runtime/start')).status,404);assert.equal(launches,0);
  assert.equal((await request('/api/audio-runtime/start',{kind:'arbitrary',action:'install'})).status,400);
  assert.equal((await request('/api/audio-runtime/start',{kind:'all',action:'check'})).status,202);await waitUntil(()=>launches===1);assert(app.isBusy());
  assert.equal((await request('/api/jobs',{action:'start'})).status,409);
  assert.equal((await request('/api/audio-runtime/start',{kind:'tts',action:'repair'})).status,409);
  c.emit('close',0);assert(!app.isBusy());
});

test('installed Electron host passes its bundled Node through Python to the real downloader',async t=>{
  const root=fixture(t),source=path.resolve(import.meta.dirname,'..'),scripts=path.join(root,'scripts');fs.mkdirSync(scripts);
  const runtime=path.join(source,'state/installer-stage/runtime');
  const python=path.join(runtime,'python/python.exe'),nodeExecutable=path.join(runtime,'node.exe');
  assert(fs.existsSync(python));assert(fs.existsSync(nodeExecutable));assert.notEqual(nodeExecutable,process.execPath);
  const bytes=Buffer.alloc(256*1024,42),sha=crypto.createHash('sha256').update(bytes).digest('hex');let requests=0;
  const server=http.createServer((_req,res)=>{requests++;res.writeHead(200,{'Content-Length':bytes.length});res.end(bytes);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  for(const name of ['audio-runtime-manifest.json','download-audio-asset.mjs'])fs.copyFileSync(path.join(source,'scripts',name),path.join(scripts,name));
  fs.copyFileSync(path.join(source,'scripts/install-audio-runtime.py'),path.join(scripts,'installer-lib.py'));
  fs.writeFileSync(path.join(scripts,'fixture.json'),JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/test.zip',sha,size:bytes.length}));
  fs.writeFileSync(path.join(scripts,'install-audio-runtime.py'),`import json,runpy\nfrom pathlib import Path\nfolder=Path(__file__).parent\nfixture=json.loads((folder/'fixture.json').read_text())\ninstaller=runpy.run_path(str(folder/'installer-lib.py'))\ninstaller['download'](fixture['url'],folder/'verified.zip',fixture['sha'],fixture['size'])\nprint(json.dumps({'phase':'complete','message':'verified real download'}),flush=True)\n`);
  const service=createAudioRuntimeInstaller({...options(root),nodeExecutable,bootstrap:async()=>python});t.after(()=>service.close());
  await service.start({kind:'tts',action:'install'});
  for(let i=0;i<200&&service.isBusy();i++)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(service.status().job.state,'success',JSON.stringify(service.status().job));assert.equal(requests,1);assert.deepEqual(fs.readFileSync(path.join(scripts,'verified.zip')),bytes);
});
