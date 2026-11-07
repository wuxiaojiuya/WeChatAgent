import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HEX=/^[a-f0-9]{64}$/,WXID=/^[A-Za-z0-9_-]{1,128}$/;
const read=(file,fallback={})=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')):fallback;
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=file+'.'+process.pid+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temporary,file);};
const fail=()=>{throw Error('HOOK_CONNECTION_STATE_INVALID');};
const stateFiles=['voices','files','social-messages.json','sticker-delivery-pending.json','text-deliveries','proactive','search','media'];
const chatFeatures=['stickers','search','proactive','context','memeLibrary','memberMemory','fishNotebook'];
const valid=value=>value?.version===1&&value.backend==='supplier-http'&&value.wechatVersion==='4.1.8.27'&&WXID.test(value.ownWxid??'')&&Object.keys(value).every(key=>['version','backend','wechatVersion','ownWxid'].includes(key));
const normalize=value=>{if(!valid(value))fail();return {version:1,backend:'supplier-http',wechatVersion:'4.1.8.27',ownWxid:value.ownWxid};};
function scoped(root,relative){
  const base=path.resolve(root,'state'),target=path.resolve(base,relative);
  if(!target.startsWith(base+path.sep))fail();
  for(let current=target;;current=path.dirname(current)){if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())fail();if(current===base)break;}
  return target;
}
export function connectionScope(root,connection){
  if(!connection?.ownWxid)return '';
  normalize(connection);
  let directory=path.resolve(root,'state/hook/accounts',connection.ownWxid);
  if(process.platform==='win32')directory=directory.toLowerCase();
  return crypto.createHash('sha256').update(directory).digest('hex');
}
export function connectionChatSettings(config){return {assistant:structuredClone(config.wechat.assistant??{}),whitelist:structuredClone(config.wechat.whitelist),personaChats:structuredClone(config.persona.chats??{}),workModes:structuredClone(config.wechat.workModes??{}),modeSettings:structuredClone(config.wechat.modeSettings??{}),chatModes:structuredClone(config.wechat.chatModes??{}),dshChats:structuredClone(config.wechat.dshAccess?.chats??{}),featureChats:Object.fromEntries(chatFeatures.map(name=>[name,structuredClone(config.wechat[name]?.chats??{})]))};}
// One-time migration reads only this project's previous supplier JSON. It never
// examines client files, derives a key or adopts a legacy database connection.
export function ensureConnectionMigration(root){
  const target=scoped(root,'hook/connection.json');
  if(fs.existsSync(target)){normalize(read(target));return false;}
  const legacyFile=scoped(root,'weflow/WeFlow-config.json');
  const legacy=read(legacyFile);
  if(legacy.backend!=='supplier-http'||!WXID.test(legacy.myWxid??'')||typeof legacy.dbPath!=='string'||path.resolve(root,legacy.dbPath)!==path.resolve(root,'state/hook/accounts'))return false;
  const connection=normalize({version:1,backend:'supplier-http',wechatVersion:'4.1.8.27',ownWxid:legacy.myWxid});
  const id=connectionScope(root,connection),oldIdentity=read(scoped(root,'weflow/active-account.json'));
  const config=read(path.join(root,'config/wechatagent.json'));
  const entries={};
  const oldStore=read(scoped(root,'weflow/reader-accounts.json'));
  if(oldStore.version===1&&oldStore.entries&&typeof oldStore.entries==='object')for(const entry of Object.values(oldStore.entries)){
    const item=entry?.reader;
    if(item?.backend!=='supplier-http'||!WXID.test(item.myWxid??'')||typeof item.dbPath!=='string'||path.resolve(root,item.dbPath)!==path.resolve(root,'state/hook/accounts'))continue;
    const converted=normalize({version:1,backend:'supplier-http',wechatVersion:'4.1.8.27',ownWxid:item.myWxid});
    entries[connectionScope(root,converted)]={connection:converted,chats:structuredClone(entry.chats??{})};
  }
  if(config.wechat)entries[id]={connection,chats:connectionChatSettings(config)};
  write(scoped(root,'hook/connections.json'),{version:1,entries});
  write(scoped(root,'hook/active-connection.json'),{id,legacyId:HEX.test(oldIdentity.legacyId??'')?oldIdentity.legacyId:''});
  write(target,connection);
  write(scoped(root,'migrations/hook-connection-v1.json'),{version:1,source:'project-supplier-json',completedAt:new Date().toISOString()});
  return true;
}
export function activeConnection(root){
  ensureConnectionMigration(root);
  const value=read(scoped(root,'hook/active-connection.json'),{id:'',legacyId:''});
  if([value.id,value.legacyId].some(id=>id&&!HEX.test(id)))fail();
  return {id:value.id||'',legacyId:value.legacyId||''};
}
export function cachedConnection(root,id){if(!HEX.test(id??''))return undefined;ensureConnectionMigration(root);return read(scoped(root,'hook/connections.json')).entries?.[id];}
function noLinks(file){if(!fs.existsSync(file))return;const stat=fs.lstatSync(file);if(stat.isSymbolicLink())fail();if(stat.isDirectory())for(const item of fs.readdirSync(file))noLinks(path.join(file,item));}
export function applyConnection(root,previous,next,config){
  const connection=normalize(next),previousId=connectionScope(root,previous),id=connectionScope(root,connection);
  if(config.hook?.backend!=='supplier-http')fail();
  const changed=!!previousId&&previousId!==id,storeFile=scoped(root,'hook/connections.json'),store=read(storeFile,{version:1,entries:{}});
  if(store.version!==1||!store.entries||typeof store.entries!=='object'||Array.isArray(store.entries))fail();
  const current=activeConnection(root),selected=structuredClone(config),incoming=store.entries[id];
  if(previousId)store.entries[previousId]={connection:normalize(previous),chats:connectionChatSettings(config)};
  const paths=stateFiles.map(file=>({active:scoped(root,file),previous:previousId?scoped(root,`accounts/${previousId}/runtime/${file}`):'',next:scoped(root,`accounts/${id}/runtime/${file}`)}));
  if(changed){
    for(const item of paths){noLinks(item.active);noLinks(item.previous);noLinks(item.next);}
    const chats=incoming?.chats??{whitelist:{private:[],groups:[]}};
    selected.wechat.assistant=structuredClone(chats.assistant??{});selected.wechat.whitelist=structuredClone(chats.whitelist??{private:[],groups:[]});selected.persona.chats=structuredClone(chats.personaChats??{});
    for(const [field,key] of [['workModes','workModes'],['modeSettings','modeSettings'],['chatModes','chatModes']])selected.wechat[field]=structuredClone(chats[key]??{});
    selected.wechat.dshAccess={chats:structuredClone(chats.dshChats??{})};
    for(const feature of chatFeatures)if(selected.wechat[feature])selected.wechat[feature].chats=structuredClone(chats.featureChats?.[feature]??{});
  }
  const configFile=path.join(root,'config/wechatagent.json'),connectionFile=scoped(root,'hook/connection.json'),identityFile=scoped(root,'hook/active-connection.json'),ioFile=scoped(root,'wechat-io-config.json');
  const originals=[connectionFile,configFile,identityFile,ioFile,storeFile].map(file=>({file,data:fs.existsSync(file)?fs.readFileSync(file):null})),switched=[];
  try{
    if(changed)for(const item of paths){const hadActive=fs.existsSync(item.active);fs.rmSync(item.previous,{recursive:true,force:true});if(hadActive){fs.mkdirSync(path.dirname(item.previous),{recursive:true});fs.cpSync(item.active,item.previous,{recursive:true,dereference:false});}switched.push({...item,hadActive});fs.rmSync(item.active,{recursive:true,force:true});if(fs.existsSync(item.next)){fs.mkdirSync(path.dirname(item.active),{recursive:true});fs.cpSync(item.next,item.active,{recursive:true,dereference:false});}}
    store.entries[id]={connection,chats:connectionChatSettings(selected)};write(storeFile,store);write(connectionFile,connection);if(changed)write(configFile,selected);
    write(ioFile,{...read(ioFile),self_wxid:connection.ownWxid});write(identityFile,{id,legacyId:current.legacyId||(!current.id&&previousId?previousId:'')});
    return {changed,connection,id,needsDshReload:current.id!==id};
  }catch(error){for(const item of switched.reverse()){fs.rmSync(item.active,{recursive:true,force:true});if(item.hadActive){fs.mkdirSync(path.dirname(item.active),{recursive:true});fs.cpSync(item.previous,item.active,{recursive:true,dereference:false});}}for(const {file,data} of originals){if(data===null)fs.rmSync(file,{force:true});else fs.writeFileSync(file,data);}throw error;}
}
