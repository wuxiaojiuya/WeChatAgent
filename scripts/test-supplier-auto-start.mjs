import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {windowsPowerShellExecutable,windowsPowerShellEnvironment} from './console-process.mjs';

test('supplier startup prepares one stopped connection, reuses live services, and never rebinds them',{skip:process.platform!=='win32'},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'supplier auto start '));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const fixture=path.join(root,'startup-fixture.ps1');
  fs.writeFileSync(fixture,'\uFEFF'+String.raw`
param([string]$Manage)
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Manage,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Invalid supervisor syntax'}
$definition=$ast.Find({param($item)$item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Initialize-SupplierConnection'},$true)
if(-not $definition){throw 'Missing automatic Hook preparation'}
Invoke-Expression $definition.Extent.Text
$root=$PSScriptRoot;$stateDir=Join-Path $root 'state';$bindingFile=Join-Path $stateDir 'hook\connection.json'
$null=New-Item -ItemType Directory -Path (Split-Path -Parent $bindingFile) -Force
$script:runningPorts=@();$script:connectCalls=0;$script:mode='success';$script:sequence=@()
$config=[pscustomobject]@{hook=[pscustomobject]@{backend='supplier-http'};ports=[pscustomobject]@{receiver=5031;adapter=8766;onebot=8585}}
function Test-Port([int]$Port){return $Port -in $script:runningPorts}
function Set-FixtureBinding([string]$Wxid='wxid_fixture'){
  @{version=1;backend='supplier-http';wechatVersion='4.1.8.27';ownWxid=$Wxid}|ConvertTo-Json|Set-Content -LiteralPath $bindingFile -Encoding UTF8
}
function Invoke-ConnectFixture([string]$Entry){
  if($Entry -ne (Join-Path $root 'supplier-connect.mjs')){throw 'Incorrect connection entry'}
  $script:sequence+='connect';$script:connectCalls++
  if($script:mode -eq 'failed'){$global:LASTEXITCODE=1;Write-Output 'HOOK_LOGIN_REQUIRED';return}
  Set-FixtureBinding $(if($script:mode -eq 'invalid'){'invalid@chatroom'}else{'wxid_fixture'})
  $global:LASTEXITCODE=0
}
# A clean installation must work without any manually created account binding.
Initialize-SupplierConnection $config 'Invoke-ConnectFixture' $root
if($script:connectCalls -ne 1 -or -not(Test-Path -LiteralPath $bindingFile)){throw 'First start did not prepare the connection'}
# An explicitly stopped connection may capture fresh single-login metadata once.
Initialize-SupplierConnection $config 'Invoke-ConnectFixture' $root
if($script:connectCalls -ne 2){throw 'Stopped connection metadata was not prepared'}
# An already running reader, adapter or bridge must not query profile or rebind.
foreach($port in @(5031,8766,8585)){
  $script:runningPorts=@($port)
  Initialize-SupplierConnection $config 'Invoke-ConnectFixture' $root
}
if($script:connectCalls -ne 2){throw 'Running services triggered a connection probe'}
Remove-Item -LiteralPath $bindingFile
$rejected=$false
try{Initialize-SupplierConnection $config 'Invoke-ConnectFixture' $root}catch{if($_.Exception.Message -notmatch 'HOOK_STOP_SERVICES_BEFORE_BIND'){throw};$rejected=$true}
if(-not $rejected -or $script:connectCalls -ne 2){throw 'Live services without a binding were silently rebound'}
Set-FixtureBinding
$binding=Get-Content -LiteralPath $bindingFile -Raw -Encoding UTF8|ConvertFrom-Json
$binding.wechatVersion='4.1.10.27';$binding|ConvertTo-Json|Set-Content -LiteralPath $bindingFile -Encoding UTF8
$rejected=$false
try{Initialize-SupplierConnection $config 'Invoke-ConnectFixture' $root}catch{if($_.Exception.Message -notmatch 'HOOK_STOP_SERVICES_BEFORE_BIND'){throw};$rejected=$true}
if(-not $rejected -or $script:connectCalls -ne 2){throw 'A legacy Hook version was accepted as a prepared connection'}
$script:runningPorts=@();$script:mode='failed'
$rejected=$false
try{Initialize-SupplierConnection $config 'Invoke-ConnectFixture' $root}catch{if($_.Exception.Message -notmatch 'HOOK_STARTUP_CONNECT_FAILED'){throw};$rejected=$true}
if(-not $rejected -or $script:connectCalls -ne 3){throw 'Failed login preparation did not stop startup'}
$script:mode='invalid';$rejected=$false
try{Initialize-SupplierConnection $config 'Invoke-ConnectFixture' $root}catch{if($_.Exception.Message -notmatch 'HOOK_ACCOUNT_METADATA_INVALID'){throw};$rejected=$true}
if(-not $rejected){throw 'Invalid metadata was accepted after preparation'}
$before=$script:connectCalls;$config.hook.backend='legacy-reader'
Initialize-SupplierConnection $config 'Invoke-ConnectFixture' $root
if($script:connectCalls -ne $before){throw 'Legacy startup was changed'}
# Execute the actual startup preparation block in isolation. A restart must
# stop services before connecting and reload restored per-account chat settings.
$source=Get-Content -LiteralPath $Manage -Raw -Encoding UTF8
$begin=$source.IndexOf('if ($Action -eq ''restart'') { Stop-Services }')
$end=$source.IndexOf('$python = (Get-Command',$begin)
if($begin -lt 0 -or $end -lt 0){throw 'Startup preparation block missing'}
function Stop-Services{$script:sequence+='stop';$script:runningPorts=@()}
function Initialize-SupplierConnection($Config,[string]$Node,[string]$ScriptsDirectory){
  if($script:sequence[-1] -ne 'stop'){throw 'Restart tried to bind before stopping services'}
  $script:sequence+='connect'
  @{hook=@{backend='supplier-http'};wechat=@{restored='current-account-chats'}}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $root 'config\wechatagent.json') -Encoding UTF8
}
function Invoke-PrepareFixture([string]$Entry){
  if((Split-Path -Leaf $Entry) -ne 'project-config.mjs'){throw 'Unexpected startup command'}
  $script:sequence+='prepare';$global:LASTEXITCODE=0
}
$null=New-Item -ItemType Directory -Path (Join-Path $root 'config') -Force
$Action='restart';$script:sequence=@();$node='Invoke-PrepareFixture';$startupConfiguration='{}';$config.hook.backend='supplier-http'
$fixtureScriptsDirectory=$root
Invoke-Expression ($source.Substring($begin,$end-$begin).Replace('$PSScriptRoot','$fixtureScriptsDirectory'))
if(($script:sequence -join ',') -ne 'stop,connect,prepare' -or $config.wechat.restored -ne 'current-account-chats'){throw 'Restart did not regenerate and reload the prepared account settings'}
'Automatic supplier startup fixtures passed; no Hook or WeChat process was contacted.'
`);
  const {stdout}=await promisify(execFile)(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fixture,'-Manage',path.join(import.meta.dirname,'manage.ps1')],{windowsHide:true,timeout:15000,env:windowsPowerShellEnvironment()});
  assert.match(stdout,/Automatic supplier startup fixtures passed/);
});
