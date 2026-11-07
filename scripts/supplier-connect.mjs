import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {applyConnection,ensureConnectionMigration} from './hook-connection-state.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')):{};
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const atomic=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.tmp',file);};
try{
  const configFile=path.join(root,'config/wechatagent.json'),raw=fs.readFileSync(configFile),config=read(configFile);
  ensureConnectionMigration(root);
  const connectionFile=path.join(root,'state/hook/connection.json'),previous=read(connectionFile),connectionHash=digest(JSON.stringify(previous));
  if(config.hook.backend!=='supplier-http'||config.hook.expectedVersion!=='4.1.8.27')throw Error('HOOK_PROVIDER_CONFIG_INVALID');
  if(process.argv[2]&&process.argv[2]!==connectionHash)throw Error('HOOK_CONNECTION_CONFIG_CHANGED');
  // Never query or replace connection metadata under a running message queue.
  const net=await import('node:net');
  const open=port=>new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port});const done=v=>{s.destroy();resolve(v);};s.setTimeout(500);s.once('connect',()=>done(true));s.once('error',()=>done(false));s.once('timeout',()=>done(false));});
  if((await Promise.all([config.ports.receiver,config.ports.adapter,config.ports.onebot].map(open))).some(Boolean))throw Error('HOOK_STOP_SERVICES_BEFORE_BIND');
  console.log('正在准备内置 Hook 连接，检查微信 4.1.8.27 组件并读取单账号信息…');
  const {stdout}=await promisify(execFile)(config.runtime.python,['-B',path.join(root,'scripts/supplier-probe.py')],{windowsHide:true,timeout:60000,maxBuffer:32768,env:{...process.env,PYTHONUTF8:'1'}}).catch(error=>{
    let code;try{const result=JSON.parse(error.stdout);if(/^HOOK_[A-Z0-9_]{2,79}$/.test(result.code))code=result.code;}catch{}
    throw Error(code??(error.code==='ENOENT'?'HOOK_PROBE_PYTHON_MISSING':error.killed?'HOOK_PROBE_TIMEOUT':'HOOK_PROBE_STARTUP_FAILED'));
  });
  const result=JSON.parse(stdout);
  if(!result.ok||result.version!=='4.1.8.27'||!/^[A-Za-z0-9_-]{1,128}$/.test(result.wxid))throw Error('HOOK_ACCOUNT_METADATA_INVALID');
  if(!fs.readFileSync(configFile).equals(raw)||connectionHash!==digest(JSON.stringify(read(connectionFile))))throw Error('HOOK_CONNECTION_CONFIG_CHANGED');
  // Connection preparation runs only with the receiver/adapter stopped. Never switch
  // account identity underneath an active message queue.
  if((await Promise.all([config.ports.receiver,config.ports.adapter,config.ports.onebot].map(open))).some(Boolean))throw Error('HOOK_STOP_SERVICES_BEFORE_BIND');
  const settings={version:1,backend:'supplier-http',wechatVersion:'4.1.8.27',ownWxid:result.wxid};
  const backup=path.join(root,'state/hook/migration-backups',new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(backup,{recursive:true});
  for(const [file,name] of [[connectionFile,'connection.json'],[configFile,'config.json']])if(fs.existsSync(file))fs.copyFileSync(file,path.join(backup,name));
  const applied=applyConnection(root,previous,settings,config);
  const prefsFile=path.join(root,'state/console-state.json');
  atomic(prefsFile,{...read(prefsFile),hookVerifiedRevision:digest(JSON.stringify(applied.connection)),pendingApply:true,dshReloadRequired:applied.needsDshReload});
  console.log('内置 Hook 连接已准备，使用当前登录账号；收发时不再比对登录账号。本次没有发送任何微信消息。');
}catch(error){
  const code=/^[A-Z][A-Z0-9_]{2,79}$/.test(error.message)?error.message:'HOOK_CONNECT_FAILED';
  const help={HOOK_NOT_LISTENING:'微信组件接口尚未启动。请从托盘完整退出当前微信，再从设置页打开微信 4.1.8.27 并登录，然后到概览启动助手。',HOOK_LOGIN_REQUIRED:'请先在微信 4.1.8.27 中完成登录，再到概览启动助手。',HOOK_STOP_SERVICES_BEFORE_BIND:'消息服务正在运行，请先停止助手；再次启动时会自动准备 Hook 连接。',HOOK_VERSION_MISMATCH:'当前监听接口的微信不是 4.1.8.27。',HOOK_NON_LOOPBACK_LISTENER:'Hook HTTP 监听地址不符合当前组件校验要求，请重新应用组件配置。',HOOK_SUPPLIED_DLL_NOT_LOADED:'当前微信没有加载内置组件，请从设置页打开微信。',
    HOOK_CONTACTS_RESPONSE_INVALID:'Hook 好友列表接口 /api/get_frien_lists 返回格式不兼容，消息接收服务尚未启动。请更新程序后重试。',HOOK_GROUPS_RESPONSE_INVALID:'Hook 群列表接口 /api/get_chatroom_list 返回格式不兼容，消息接收服务尚未启动。请更新程序后重试。',
    HOOK_PROBE_DEPENDENCY_MISSING:'连接检查脚本缺少 Python 模块，请先运行“验证内置环境”并查看具体缺失项。',HOOK_PROBE_PYTHON_MISSING:'找不到配置的 Python，请检查内置运行环境路径。',HOOK_PROBE_TIMEOUT:'微信组件核验超时，请检查微信是否已登录及组件接口是否启动。',HOOK_PROBE_STARTUP_FAILED:'微信连接检查脚本未能启动，请先运行“验证内置环境”；本次未绑定账号。'};
  console.error('['+code+'] '+(help[code]??'新 Hook 连接未完成，请检查组件配置与操作记录。'));
  process.exitCode=1;
}
