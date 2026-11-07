import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import http from 'node:http';import {spawn,execFile} from 'node:child_process';import {createInterface} from 'node:readline';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';
import {HookOneBot,adapterStartupMessage} from './hook-onebot.mjs';
import {EventEmitter} from 'node:events';
import {windowsPowerShellExecutable,windowsPowerShellEnvironment,taskFailureMessage} from './console-process.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'adapter-startup-'));
 for(const dir of ['config','state/hook'])fs.mkdirSync(path.join(directory,dir),{recursive:true});
 fs.writeFileSync(path.join(directory,'config/wechatagent.json'),JSON.stringify({runtime:{sender:'wechat-hook'},hook:{backend:'supplier-http',baseUrl:'http://127.0.0.1:30001',expectedVersion:'4.1.8.27'},ports:{adapter:0},wechat:{whitelist:{private:[],groups:[]}}}));
 fs.writeFileSync(path.join(directory,'state/wechat-io-config.json'),JSON.stringify({receiver_base_url:'http://127.0.0.1:5031',receiver_token:'fixture'}));fs.writeFileSync(path.join(directory,'state/hook/native-token.txt'),'a'.repeat(64));
 const calls=[],adapter=new HookOneBot({directory,fetchImpl:async input=>{
  const url=new URL(input);calls.push(url.pathname);
  return new Response(JSON.stringify(url.pathname==='/api/v1/receiver/status'?{backend:'supplier-http',ownWxid:'wxid_fixture'}:{backend:'wechat-hook',provider:'supplier-http',integration:'WeChatAgent-supplier-v1',version:'4.1.8.27',startupState:'ready'}));
 }});
 adapter.connectOneBot=async()=>{};adapter.receiveSse=async()=>{};
 t.after(async()=>{if(adapter.server?.listening)await adapter.stop();assert(directory.startsWith(os.tmpdir()+path.sep));fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 return {adapter,directory,calls};
}
async function boundSocket(t){
 const code='$s=[Net.Sockets.Socket]::new([Net.Sockets.AddressFamily]::InterNetwork,[Net.Sockets.SocketType]::Stream,[Net.Sockets.ProtocolType]::Tcp);$s.ExclusiveAddressUse=$true;$s.Bind([Net.IPEndPoint]::new([Net.IPAddress]::Loopback,0));[Console]::WriteLine($s.LocalEndPoint.Port);$null=[Console]::ReadLine();$s.Dispose()';
 const child=spawn(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{env:windowsPowerShellEnvironment(),windowsHide:true,stdio:['pipe','pipe','pipe']});
 const closed=new Promise(resolve=>child.once('close',resolve));let stderr='';child.stderr.on('data',data=>stderr+=data);
 const lines=createInterface({input:child.stdout});
 t.after(async()=>{child.stdin.end();await closed;});
 const port=Number(await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('bound fixture: '+stderr)),10000);lines.once('line',line=>{clearTimeout(timer);resolve(line);});child.once('error',reject);}));lines.close();
 assert(port>0);return {port,pid:child.pid};
}

test('adapter preserves an occupied-port error after a successful native precheck, without starting message loops',async t=>{
 const f=fixture(t),blocker=net.createServer();await new Promise(resolve=>blocker.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>blocker.close(resolve)));
 f.adapter.project.ports.adapter=blocker.address().port;await f.adapter.checkNative();
 await assert.rejects(f.adapter.start(),error=>{
  assert.equal(error.message,'ADAPTER_PORT_IN_USE');assert.equal(error.cause.code,'EADDRINUSE');
  const message=adapterStartupMessage(error);assert.match(message,/stage=adapter-port-bind/);assert(message.includes('port='+blocker.address().port));assert.match(message,/system=EADDRINUSE/);assert(!message.includes('BACKEND_UNAVAILABLE'));return true;
 });
 assert.equal(f.adapter.tasks,undefined);assert.equal(f.adapter.status.ready,false);
});

test('a Windows bound-but-not-listening socket is rejected with a concrete adapter bind error',{skip:process.platform!=='win32'},async t=>{
 const f=fixture(t),bound=await boundSocket(t);f.adapter.project.ports.adapter=bound.port;
 await f.adapter.checkNative();await assert.rejects(f.adapter.start(),error=>{
  assert.match(error.message,/^ADAPTER_PORT_(IN_USE|DENIED)$/);assert(['EADDRINUSE','EACCES'].includes(error.cause.code));assert(adapterStartupMessage(error).includes('port='+bound.port));return true;
 });assert.equal(f.adapter.tasks,undefined);
});

test('Windows bind denial is classified separately and retains EACCES without starting reply tasks',async t=>{
 const f=fixture(t);f.adapter.project.ports.adapter=8766;
 t.mock.method(http,'createServer',()=>{const server=new EventEmitter();server.listen=()=>{queueMicrotask(()=>server.emit('error',Object.assign(new Error('denied fixture'),{code:'EACCES'})));return server;};return server;});
 await assert.rejects(f.adapter.start(),error=>{assert.equal(error.message,'ADAPTER_PORT_DENIED');assert.match(adapterStartupMessage(error),/port=8766 system=EACCES/);return true;});assert.equal(f.adapter.tasks,undefined);
});

test('receiver resets and Hook failures retain their own stage and port instead of becoming a generic backend failure',async t=>{
 for(const [stage,code,expected]of [['receiver','ECONNRESET','RECEIVER_CONNECTION_RESET'],['hook','ECONNRESET','HOOK_CONNECTION_RESET'],['receiver','ECONNREFUSED','RECEIVER_NOT_LISTENING']]){
  const f=fixture(t),original=f.adapter.fetch;f.adapter.fetch=(url,options)=>{if(new URL(url).pathname===(stage==='receiver'?'/api/v1/receiver/status':'/WeChatAgent/health'))throw new TypeError('fetch failed',{cause:{code}});return original(url,options);};
  await assert.rejects(f.adapter.start(),error=>{assert.equal(error.message,expected);const message=adapterStartupMessage(error);assert(message.includes('stage='+(stage==='receiver'?'receiver-status':'hook-health')));assert(message.includes('port='+(stage==='receiver'?5031:30001)));assert(message.includes('system='+code));return true;});
 }
});

test('adapter status identifies the actual PID, project and readiness without exposing authentication material',async t=>{
 const f=fixture(t);await f.adapter.start();const response=await fetch('http://127.0.0.1:'+f.adapter.server.address().port+'/status'),data=await response.json();
 assert.equal(data.project,'WeChatAgent');assert.equal(data.component,'adapter');assert.equal(data.statusVersion,1);assert.equal(data.pid,process.pid);assert.equal(data.projectRoot,f.directory);assert.equal(data.ready,true);assert(!JSON.stringify(data).includes('a'.repeat(64)));
});

test('startup formatting keeps only diagnostic codes and never prints arbitrary error bodies or tokens',()=>{
 const secret='Bearer '+ 'f'.repeat(64),message=adapterStartupMessage(Object.assign(new Error(secret),{code:'EACCES'}),{stage:'configuration'});
 assert.match(message,/ADAPTER_START_FAILED/);assert.match(message,/system=EACCES/);assert(!message.includes('Bearer'));assert(!message.includes('f'.repeat(64)));
 assert.match(taskFailureMessage('Adapter startup failed: ADAPTER_PORT_DENIED stage=adapter-port-bind port=8766 system=EACCES',1),/Windows.*8766/);
 assert.match(taskFailureMessage('SERVICE_PORT_IN_USE service=adapter port=8766 owners=123',1),/再次确认/);
 assert.match(taskFailureMessage('Adapter startup failed: RECEIVER_CONNECTION_RESET stage=receiver-status port=5031 system=ECONNRESET',1),/消息接收服务/);
});

test('supplier list failures keep their API diagnosis when the receiver supervisor also reports an exit',()=>{
 for(const [code,route,label] of [['HOOK_CONTACTS_RESPONSE_INVALID','/api/get_frien_lists','好友列表'],['HOOK_GROUPS_RESPONSE_INVALID','/api/get_chatroom_list','群列表']]){
  const message=taskFailureMessage('receiver exited; see state/logs/receiver.stderr.log\nHook receiver initialization failed: '+code,1);
  assert(message.includes(route));assert(message.includes(label));assert.match(message,/消息接收服务/);assert(!/数据库|选择账号/.test(message));
 }
});

test('generic receiver startup failures do not ask Hook users to configure a WeChat database',()=>{
 for(const output of ['receiver exited; see state/logs/receiver.stderr.log','Hook receiver initialization failed: KeyError','Hook receiver initialization failed: FileNotFoundError']){
  const message=taskFailureMessage(output,1);assert.match(message,/消息接收服务/);assert(!/数据库|选择账号/.test(message));
 }
});

test('the PowerShell supervisor rejects bound sockets before spawning, and recovery inspection includes their owner',{skip:process.platform!=='win32'},async t=>{
 const f=fixture(t),bound=await boundSocket(t),file=path.join(f.directory,'supervisor-bound.ps1');
 fs.writeFileSync(file,'\uFEFF'+String.raw`
param([string]$Manage,[int]$Port,[int]$Owner)
$ErrorActionPreference='Stop';$errors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Manage,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'invalid supervisor syntax'}
foreach($name in @('Test-Port','Get-PortBindings','Assert-PortBindable','Test-ServiceReady','Start-ServiceProcess')){$node=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $node.Extent.Text}
$root=$PSScriptRoot;$stateDir=$PSScriptRoot;$script:record=@{};$script:spawned=0
function Owned-Process{param($Item)return $null}
function Start-Process{$script:spawned++;throw 'must not spawn a service'}
if(Test-Port $Port){throw 'bound socket unexpectedly accepted a connection'}
$failed=$false;try{Assert-PortBindable 'adapter' $Port}catch{if($_.Exception.Message -notmatch 'SERVICE_PORT_(IN_USE|DENIED)'){throw};$failed=$true}
if(-not $failed){throw 'bound socket was accepted'}
$failed=$false;try{Start-ServiceProcess 'adapter' 'unused.exe' '' $root 'unused' $Port $false}catch{if($_.Exception.Message -notmatch 'SERVICE_PORT_(IN_USE|DENIED)'){throw};$failed=$true}
if(-not $failed -or $script:spawned){throw 'foreign bound socket was reused or caused a spawn'}
'Supervisor rejected the bound socket without stopping or launching processes'
`);
 const options={windowsHide:true,env:windowsPowerShellEnvironment(),timeout:25000};
 const run=await promisify(execFile)(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,'-Manage',path.join(root,'scripts/manage.ps1'),'-Port',String(bound.port),'-Owner',String(bound.pid)],options);assert.match(run.stdout,/rejected the bound socket/);
 const request={ports:[bound.port],wechatExecutable:'C:/fixture/not-Weixin.exe',protectedPids:[process.pid],includeMatchingWeChat:false};
 const inspection=await promisify(execFile)(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/process-recovery.ps1'),'-Mode','Inspect','-RequestBase64',Buffer.from(JSON.stringify(request)).toString('base64')],options);
 const item=JSON.parse(inspection.stdout).items.find(item=>item.pid===bound.pid);assert(item,'Bound owner must be offered for inspection');assert(item.ports.includes(bound.port));assert.match(item.reason,/绑定/);
});

test('supervisor readiness checks reject a foreign listener, wrong project and legacy status, including a startup race',{skip:process.platform!=='win32'},async t=>{
 const f=fixture(t),file=path.join(f.directory,'supervisor-identity.ps1');
 fs.writeFileSync(file,'\uFEFF'+String.raw`
param([string]$Manage)
$ErrorActionPreference='Stop';$errors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Manage,[ref]$tokens,[ref]$errors)
foreach($name in @('Get-PortBindings','Test-ServiceReady','Start-ServiceProcess')){$node=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $node.Extent.Text}
$root=$PSScriptRoot;$stateDir=$PSScriptRoot;$script:record=@{};$script:owner=777;$script:mode='ready';$script:queries=0;$script:spawned=0
function Get-NetTCPConnection{param($LocalPort,$ErrorAction)@([pscustomobject]@{State='Listen';LocalAddress='::';OwningProcess=999},[pscustomobject]@{State='Listen';LocalAddress='127.0.0.1';OwningProcess=777})}
$ipv4=@(Get-PortBindings 8766);if($ipv4.Count -ne 1 -or $ipv4[0].OwningProcess -ne 777){throw 'IPv6-only listener caused a false IPv4 conflict'}
function Get-PortBindings{param($Port)$script:queries++;if($script:mode -eq 'race' -and $script:queries -eq 1){return};[pscustomobject]@{State='Listen';OwningProcess=$script:owner}}
function Invoke-RestMethod{param($Uri,$TimeoutSec)if($script:mode -eq 'legacy'){return [pscustomobject]@{backend='wechat-hook'}};[pscustomobject]@{project='WeChatAgent';component='adapter';statusVersion=1;backend='wechat-hook';pid=$(if($script:mode -eq 'bad-pid'){'invalid'}else{777});projectRoot=$(if($script:mode -eq 'wrong-project'){$root+'-other'}elseif($script:mode -eq 'bad-root'){[string][char]0}else{$root});ready=$true}}
if(-not(Test-ServiceReady 'adapter' 8766 777)){throw 'owned ready service was rejected'}
foreach($case in @('wrong-project','legacy','bad-pid','bad-root')){$script:mode=$case;$failed=$false;try{Test-ServiceReady 'adapter' 8766 777|Out-Null}catch{if($_.Exception.Message -notmatch 'ADAPTER_IDENTITY_MISMATCH'){throw};$failed=$true};if(-not $failed){throw 'foreign or legacy identity accepted'}}
$script:mode='ready';$script:owner=999;$failed=$false;try{Test-ServiceReady 'adapter' 8766 777|Out-Null}catch{if($_.Exception.Message -notmatch 'SERVICE_PORT_OWNER_MISMATCH'){throw};$failed=$true};if(-not $failed){throw 'foreign listener accepted'}
function Assert-PortBindable{param($Name,$Port)}
function Save-Record{}
function Start-Process{$script:spawned++;$p=[pscustomobject]@{Id=777;HasExited=$false};$p|Add-Member ScriptMethod Refresh {};return $p}
$script:mode='race';$script:queries=0;$failed=$false
try{Start-ServiceProcess 'adapter' 'fixture.exe' '' $root 'fixture' 8766 $false}catch{if($_.Exception.Message -notmatch 'SERVICE_PORT_OWNER_MISMATCH'){throw};$failed=$true}
if(-not $failed -or $script:spawned -ne 1){throw 'startup race was accepted'}
'Supervisor identity and startup race checks passed'
`);
 const result=await promisify(execFile)(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,'-Manage',path.join(root,'scripts/manage.ps1')],{windowsHide:true,env:windowsPowerShellEnvironment(),timeout:20000});assert.match(result.stdout,/identity and startup race checks passed/);
});

test('supervisor starts and reuses the real owned child only after PID and HTTP identity match',{skip:process.platform!=='win32'},async t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.directory,'state/logs'),{recursive:true});
 const entry=path.join(f.directory,'owned-service.mjs'),script=path.join(f.directory,'supervisor-live.ps1');
 fs.writeFileSync(entry,"import http from 'node:http';const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({project:'WeChatAgent',component:'adapter',statusVersion:1,backend:'wechat-hook',pid:process.pid,projectRoot:process.cwd(),ready:true}));});server.listen(Number(process.argv[2]),'127.0.0.1');");
 const temporary=net.createServer();await new Promise(resolve=>temporary.listen(0,'127.0.0.1',resolve));const port=temporary.address().port;await new Promise(resolve=>temporary.close(resolve));
 fs.writeFileSync(script,'\uFEFF'+String.raw`
param([string]$Manage,[string]$Node,[string]$Entry,[int]$Port)
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Manage,[ref]$tokens,[ref]$errors)
foreach($name in @('Save-Record','Owned-Process','Stop-Services','Get-PortBindings','Assert-PortBindable','Test-ServiceReady','Start-ServiceProcess')){$definition=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $definition.Extent.Text}
$root=$PSScriptRoot;$stateDir=Join-Path $root 'state';$recordFile=Join-Path $stateDir 'runtime.json';$script:record=@{}
try{
 Start-ServiceProcess 'adapter' $Node ('"'+$Entry+'" '+$Port) $root $Entry $Port $false
 $first=$script:record['adapter'].pid
 $health=Invoke-RestMethod ('http://127.0.0.1:'+$Port+'/status') -TimeoutSec 2
 if($health.pid -ne $first -or $health.projectRoot -ne $root){throw 'wrong service became ready'}
 Start-ServiceProcess 'adapter' $Node ('"'+$Entry+'" '+$Port) $root $Entry $Port $false
 if($script:record['adapter'].pid -ne $first){throw 'owned service was duplicated'}
 'Real child startup and reuse passed'
}finally{Stop-Services}
`);
 const output=await promisify(execFile)(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Manage',path.join(root,'scripts/manage.ps1'),'-Node',process.execPath,'-Entry',entry,'-Port',String(port)],{windowsHide:true,env:windowsPowerShellEnvironment(),timeout:35000});assert.match(output.stdout,/Real child startup and reuse passed/);assert.match(output.stdout,/adapter stopped/);
});

test('Python redirector adoption requires the exact venv parent, base interpreter, marker and parent-child link',{skip:process.platform!=='win32'},async t=>{
 const f=fixture(t),file=path.join(f.directory,'python-owner.ps1');
 fs.mkdirSync(path.join(f.directory,'venv/Scripts'),{recursive:true});fs.mkdirSync(path.join(f.directory,'base'));
 fs.writeFileSync(path.join(f.directory,'venv/pyvenv.cfg'),'home = '+path.join(f.directory,'base'));
 fs.writeFileSync(file,'\uFEFF'+String.raw`
param([string]$Helper)
$ErrorActionPreference='Stop';. $Helper
$python=Join-Path $PSScriptRoot 'venv/Scripts/python.exe';$marker=Join-Path $PSScriptRoot 'hook-receiver.py'
$script:case='valid'
function Get-CimInstance{param($Class,$Filter)
 if($Filter -eq 'ProcessId=101'){return [pscustomobject]@{ExecutablePath=$(if($script:case -eq 'parent-exe'){'foreign.exe'}else{$python});CommandLine=$(if($script:case -eq 'parent-marker'){'foreign.py'}else{$marker})}}
 return [pscustomobject]@{ProcessId=202;ParentProcessId=$(if($script:case -eq 'parent-link'){999}else{101});ExecutablePath=$(if($script:case -eq 'child-exe'){'foreign.exe'}else{Join-Path $PSScriptRoot 'base/python.exe'});CommandLine=$(if($script:case -eq 'child-marker'){'foreign.py'}else{$marker})}
}
if((Resolve-PythonServiceOwner 101 202 $python $marker).ProcessId -ne 202){throw 'valid redirector child rejected'}
foreach($script:case in @('parent-exe','parent-marker','parent-link','child-exe','child-marker')){if(Resolve-PythonServiceOwner 101 202 $python $marker){throw ('foreign child accepted: '+$script:case)}}
if(Resolve-PythonServiceOwner 101 101 $python $marker){throw 'parent adopted as a redirector child'}
'Python redirector ownership verified'
`);
 const r=await promisify(execFile)(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,'-Helper',path.join(root,'scripts/python-service-owner.ps1')],{windowsHide:true,env:windowsPowerShellEnvironment(),timeout:15000});assert.match(r.stdout,/Python redirector ownership verified/);
});
