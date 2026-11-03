import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {configuration,updatePlugin} from '../packages/plugin-api/catalog.mjs';
const root=path.resolve(import.meta.dirname,'..');
const runtime=path.join(root,'state/media-runtime');
if(!fs.existsSync(path.join(runtime,'models/whisper-small/model.bin')))throw Error('LOCAL_ASR_MODEL_NOT_INSTALLED');
const folder=path.join(root,'plugins/speech-recognition');
if(!fs.existsSync(folder))fs.cpSync(path.join(root,'optional-extensions/speech-recognition'),folder,{recursive:true,errorOnExist:true});
const tokenFile=path.join(runtime,'asr-token.txt');
if(!fs.existsSync(tokenFile))fs.writeFileSync(tokenFile,crypto.randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
const saved=configuration(root),previous=saved.config.plugins['speech-recognition'];
if(previous?.enabled&&previous.settings?.endpoint&&!previous.settings.endpoint.startsWith('http://127.0.0.1:9881'))throw Error('EXISTING_SPEECH_CONFIGURATION_PRESERVED');
const configFile=path.join(root,'config/plugins.json');
if(fs.existsSync(configFile))fs.copyFileSync(configFile,path.join(runtime,'plugins-before-local-asr-'+Date.now()+'.json'));
const project=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,''));
const chats=['private','groups'].flatMap(kind=>(project.wechat.whitelist[kind]??[]).map(id=>'wechat:'+(kind==='groups'?'group:':'private:')+id));
updatePlugin(root,'speech-recognition',{revision:saved.revision,enabled:true,permissions:['audio_read'],chats,
  settings:{apiProtocol:'openai-transcriptions',endpoint:'http://127.0.0.1:9881/v1',model:'whisper-small',
    apiKey:fs.readFileSync(tokenFile,'utf8').trim(),audioFormat:'wav',timeoutMs:25000,language:'',cacheResults:false}});
console.log(JSON.stringify({installed:true,enabled:true,local:true,chatCount:chats.length,secretsPrinted:false}));
