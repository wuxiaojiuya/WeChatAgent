import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {dshConfigurationMatches,dshPluginMatches,sameProjectPath} from './dsh-configuration.mjs';
import {activeReaderAccount} from './reader-account-state.mjs';

// Reload only this project's authenticated bridge; never terminate the DSH desktop.
export async function refreshDsh({root,config,previousPort,waitForIdle=false,fetchImpl=fetch,timeoutMs=90000,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  const tokenFile=path.join(root,'state/social-dsh-token.txt');
  if(!fs.existsSync(tokenFile))return {status:'offline'};
  const headers={Authorization:'Bearer '+fs.readFileSync(tokenFile,'utf8').trim()};
  const call=(port,route,method='GET')=>fetchImpl(`http://127.0.0.1:${port}${route}`,{method,headers,signal:AbortSignal.timeout(3000)});
  const health=async port=>{try{const r=await call(port,'/health');return r.ok?await r.json():null;}catch{return null;}};
  const port=config.ports.dshPlugin,account=activeReaderAccount(root).id;
  const matches=value=>dshConfigurationMatches(root,config,value)&&value.accountScope===account;
  let sourcePort,initial;
  for(const candidate of [...new Set([previousPort,port].filter(Number.isInteger))]){
    const value=await health(candidate);
    if(value?.project==='WeChatAgent'&&sameProjectPath(value.projectRoot,root)){sourcePort=candidate;initial=value;break;}
    if(value)throw Error('DSH_PROJECT_MISMATCH');
  }
  if(!initial)return {status:'offline'};
  // A runtime reload cannot replace Cordis modules or install the new capability service.
  if(!dshPluginMatches(root,initial))throw Error('DSH_RELOAD_UPGRADE_REQUIRED');
  if(sourcePort===port&&matches(initial)){
    if(waitForIdle){
      const deadline=Date.now()+timeoutMs;
      while(initial.pendingTurns>0){
        if(Date.now()>=deadline)throw Error('DSH_CONFIGURATION_BUSY');
        await delay(500);initial=await health(port);
        if(initial&&!dshPluginMatches(root,initial))throw Error('DSH_RELOAD_UPGRADE_REQUIRED');
        if(!matches(initial))throw Error('DSH_CONNECTION_CHANGED');
      }
    }
    return {status:'current'};
  }
  if(initial.configurationReload!=='native-runtime-v1')throw Error('DSH_RELOAD_UPGRADE_REQUIRED');
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const r=await call(sourcePort,'/reload-config','POST');
    if(r.status===409){await delay(500);continue;}
    if(r.status!==202)throw Error('DSH_RELOAD_FAILED');
    while(Date.now()<deadline){
      await delay(150);
      const current=await health(port);
      if(current?.project==='WeChatAgent'&&sameProjectPath(current.projectRoot,root)&&!dshPluginMatches(root,current))throw Error('DSH_RELOAD_UPGRADE_REQUIRED');
      if(current?.instanceId!==initial.instanceId&&matches(current))return {status:'reloaded'};
    }
    throw Error('DSH_RELOAD_TIMEOUT');
  }
  throw Error('DSH_CONFIGURATION_BUSY');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=path.resolve(import.meta.dirname,'..');
  const config=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,''));
  refreshDsh({root,config}).then(result=>console.log('DSH configuration: '+result.status)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
