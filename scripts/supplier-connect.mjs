import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {applyReaderAccount} from './reader-account-state.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')):{};
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const atomic=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.tmp',file);};
try{
  const configFile=path.join(root,'config/wechatagent.json'),raw=fs.readFileSync(configFile),config=read(configFile);
  const readerFile=path.join(root,'state/weflow/WeFlow-config.json'),previous=read(readerFile),readerHash=digest(JSON.stringify(previous));
  if(config.hook.backend!=='supplier-http'||config.hook.expectedVersion!=='4.1.8.27')throw Error('HOOK_PROVIDER_CONFIG_INVALID');
  if(process.argv[2]&&process.argv[2]!==readerHash)throw Error('HOOK_READER_CONFIG_CHANGED');
  console.log('正在通过新 Hook 核验微信进程、4.1.8.27 版本、已加载组件和当前登录账号…');
  const {stdout}=await promisify(execFile)(config.runtime.python,['-B',path.join(root,'scripts/supplier-probe.py')],{windowsHide:true,timeout:60000,maxBuffer:32768,env:{...process.env,PYTHONUTF8:'1'}}).catch(error=>{
    let code;try{code=JSON.parse(error.stdout).code;}catch{}throw Error(code??'HOOK_PROBE_FAILED');
  });
  const result=JSON.parse(stdout);
  if(!result.ok||result.version!=='4.1.8.27'||!/^[A-Za-z0-9_-]{1,128}$/.test(result.wxid))throw Error('HOOK_ACCOUNT_METADATA_INVALID');
  if(!fs.readFileSync(configFile).equals(raw)||readerHash!==digest(JSON.stringify(read(readerFile))))throw Error('HOOK_READER_CONFIG_CHANGED');
  // Binding is performed only with the old reader/adapter stopped. Never switch
  // account identity underneath an active message queue.
  const net=await import('node:net');
  const open=port=>new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port});const done=v=>{s.destroy();resolve(v);};s.setTimeout(500);s.once('connect',()=>done(true));s.once('error',()=>done(false));s.once('timeout',()=>done(false));});
  if((await Promise.all([config.ports.weflow,config.ports.adapter,config.ports.onebot].map(open))).some(Boolean))throw Error('HOOK_STOP_SERVICES_BEFORE_BIND');
  const settings={backend:'supplier-http',dbPath:path.join(root,'state/hook/accounts'),myWxid:result.wxid};
  const backup=path.join(root,'state/hook/migration-backups',new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(backup,{recursive:true});
  for(const [file,name] of [[readerFile,'reader.json'],[configFile,'config.json']])if(fs.existsSync(file))fs.copyFileSync(file,path.join(backup,name));
  const applied=applyReaderAccount(root,previous,settings,config);
  const prefsFile=path.join(root,'state/console-state.json');
  atomic(prefsFile,{...read(prefsFile),readerVerifiedRevision:digest(JSON.stringify(applied.reader)),pendingApply:true,dshRestartRequired:applied.needsDshRestart});
  console.log('新 Hook 的账号与数据库接口已验证并绑定，无需数据库密钥。可以启动服务；本次没有发送任何微信消息。');
}catch(error){
  const code=/^[A-Z][A-Z0-9_]{2,79}$/.test(error.message)?error.message:'HOOK_CONNECT_FAILED';
  const help={HOOK_NOT_LISTENING:'请先打开带新 Hook 的微信 4.1.8.27。',HOOK_LOGIN_REQUIRED:'请在微信 4.1.8.27 中登录后再连接。',HOOK_STOP_SERVICES_BEFORE_BIND:'请先停止助手服务，再绑定账号。',HOOK_VERSION_MISMATCH:'当前监听接口的微信不是 4.1.8.27。',HOOK_NON_LOOPBACK_LISTENER:'Hook HTTP 服务必须只监听 127.0.0.1，请重新应用组件配置。',HOOK_SUPPLIED_DLL_NOT_LOADED:'当前微信没有加载你提供的 DLL，请从项目页面打开微信。'};
  console.error('['+code+'] '+(help[code]??'新 Hook 连接未完成，请检查组件配置与操作记录。'));
  process.exitCode=1;
}
