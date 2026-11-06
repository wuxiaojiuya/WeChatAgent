import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {refreshDsh} from './dsh-refresh.mjs';
import {dshConfigurationMatches} from './dsh-configuration.mjs';
import {createConsole} from './console-server.mjs';
import {CAPABILITY_EXECUTION_VERSION} from '../packages/dsh-capabilities-plugin/contract.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-dsh-upgrade-'));
  for(const dir of ['config','roles','state','packages/dsh-social-bridge-plugin'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  const config=JSON.parse(fs.readFileSync(new URL('../config/wechatagent.example.json',import.meta.url),'utf8'));
  fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(root,'roles',config.persona.default+'.md'),'Fixture persona');
  fs.writeFileSync(path.join(root,'state/social-dsh-token.txt'),'fixture-token');
  fs.writeFileSync(path.join(root,'packages/dsh-social-bridge-plugin/cordis.patch.yml'),'wechatagent=aaaaaaaaaaaaaaaa');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const health={ok:true,project:'WeChatAgent',projectRoot:root,provider:config.dsh.provider,model:config.dsh.model,accountScope:'',pluginRevision:'aaaaaaaaaaaaaaaa',capabilityExecution:CAPABILITY_EXECUTION_VERSION,instanceId:'fixture-instance',pendingTurns:0,configurationReload:'native-runtime-v1',contextMode:'native-session-v1',behaviorPolicy:'local-config-only-v1',imageInput:'native-attachment-v1'};
  return {root,config,health};
}

test('the matching plugin revision and capability service are required before reporting current',async t=>{
  const f=fixture(t),calls=[];
  const result=await refreshDsh({...f,fetchImpl:async(url,options)=>{calls.push(options.method);assert.equal(options.headers.Authorization,'Bearer fixture-token');return Response.json(f.health);}});
  assert.equal(result.status,'current');assert.deepEqual(calls,['GET']);assert(dshConfigurationMatches(f.root,f.config,f.health));
});

test('old or missing plugin revisions and missing or obsolete capability services require reopening DSH',async t=>{
  const f=fixture(t);
  for(const change of [{pluginRevision:'bbbbbbbbbbbbbbbb'},{pluginRevision:undefined},{capabilityExecution:undefined},{capabilityExecution:'old-generation-v0'}]){
    const calls=[],health={...f.health,...change};
    await assert.rejects(refreshDsh({...f,fetchImpl:async(url,options)=>{calls.push(options.method);return Response.json(health);}}),/DSH_RELOAD_UPGRADE_REQUIRED/);
    assert.deepEqual(calls,['GET'],'runtime reload cannot replace already loaded Cordis modules');
    assert.equal(dshConfigurationMatches(f.root,f.config,health),false);
  }
});

test('an unprepared patch cannot confirm the loaded plugin version',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'packages/dsh-social-bridge-plugin/cordis.patch.yml'),'name: fixture');
  await assert.rejects(refreshDsh({...f,fetchImpl:async()=>Response.json(f.health)}),/DSH_RELOAD_UPGRADE_REQUIRED/);
});

test('reload success requires a new instance with the current revision and capability service',async t=>{
  const f=fixture(t);
  for(const change of [{pluginRevision:'bbbbbbbbbbbbbbbb'},{capabilityExecution:undefined}]){
    let reloaded=false,posts=0;
    const fetchImpl=async(url,options)=>{
      if(options.method==='POST'){posts++;reloaded=true;return Response.json({ok:true},{status:202});}
      return Response.json(reloaded?{...f.health,instanceId:'replacement-instance',...change}:{...f.health,model:'old-model'});
    };
    await assert.rejects(refreshDsh({...f,fetchImpl,delay:async()=>{}}),/DSH_RELOAD_UPGRADE_REQUIRED/);assert.equal(posts,1);
  }
});

test('an idle wait also rejects a plugin version or capability change',async t=>{
  const f=fixture(t);let polls=0;
  await assert.rejects(refreshDsh({...f,waitForIdle:true,delay:async()=>{},fetchImpl:async()=>Response.json(++polls===1?{...f.health,pendingTurns:1}:{...f.health,capabilityExecution:undefined})}),/DSH_RELOAD_UPGRADE_REQUIRED/);
  assert.equal(polls,2);
});

test('console apply retains the reopen requirement until the actual new DSH plugin is loaded',async t=>{
  const f=fixture(t),commands=[];let health={...f.health,pluginRevision:'bbbbbbbbbbbbbbbb',capabilityExecution:undefined};
  const app=createConsole({root:f.root,port:0,runner:async spec=>{commands.push(spec);return 0;},fetchImpl:async url=>{
    const target=new URL(url);if(target.port===String(f.config.ports.dshPlugin)&&target.pathname==='/health')return Response.json(health);throw Error('offline fixture');
  }});
  const address=await app.start();t.after(()=>app.close());const base='http://127.0.0.1:'+address.port;
  const {token}=await fetch(base+'/api/info').then(r=>r.json()),headers={'X-Console-Token':token,'Content-Type':'application/json'};
  const run=async()=>{
    const response=await fetch(base+'/api/jobs',{method:'POST',headers,body:JSON.stringify({action:'apply-settings'})});assert.equal(response.status,202);const started=await response.json();
    for(let i=0;i<100;i++){
      const job=await fetch(base+'/api/job?id='+started.id,{headers}).then(r=>r.json());if(job.state!=='running')return job;await delay(10);
    }
    assert.fail('offline apply job did not settle');
  };
  const failed=await run();assert.equal(failed.state,'failed');assert.match(failed.output,/DSH_RELOAD_UPGRADE_REQUIRED/);assert.match(failed.message,/托盘退出并重开/);
  let status=await fetch(base+'/api/status',{headers}).then(r=>r.json());assert.equal(status.pendingApply,true);assert.equal(status.dshRestartRequired,true);assert.equal(status.services.find(item=>item.id==='dsh').ready,false);
  const premature=await fetch(base+'/api/dsh-reopened',{method:'POST',headers,body:'{}'});assert.equal(premature.status,409);
  const preferences=JSON.parse(fs.readFileSync(path.join(f.root,'state/console-state.json'),'utf8'));assert.equal(preferences.pendingApply,true);assert.equal(preferences.dshRestartRequired,true);
  health=f.health;
  assert.equal((await fetch(base+'/api/dsh-reopened',{method:'POST',headers,body:'{}'})).status,200);
  assert.equal((await run()).state,'succeeded');
  status=await fetch(base+'/api/status',{headers}).then(r=>r.json());assert.equal(status.pendingApply,false);assert.equal(status.dshRestartRequired,false);assert.equal(status.services.find(item=>item.id==='dsh').ready,true);assert.equal(commands.length,2);
});
