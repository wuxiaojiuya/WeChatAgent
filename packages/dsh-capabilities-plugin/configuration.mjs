import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {CAPABILITY_PLUGIN_FILES} from './contract.mjs';
export function capabilityPluginRevision(root){
  const directory=path.join(root,'packages/dsh-capabilities-plugin');
  return crypto.createHash('sha256').update(Buffer.concat(CAPABILITY_PLUGIN_FILES.map(file=>fs.readFileSync(path.join(directory,file))))).digest('hex').slice(0,16);
}
export function upsertCapabilitiesPatch(input,root){
  const base=input.replace(/\r?\n- insert:\r?\n    - \{"id":"wechat-capabilities-plugin",[^\r\n]+\}\r?\n?/g,'');
  if(base.includes('"id":"wechat-capabilities-plugin"'))throw Error('CAPABILITY_PLUGIN_CONFIG_UNSUPPORTED');
  const name=pathToFileURL(path.join(root,'packages/dsh-capabilities-plugin/index.mjs')).href+'?wechatagent='+capabilityPluginRevision(root);
  return base+'\n- insert:\n    - '+JSON.stringify({id:'wechat-capabilities-plugin',name,config:{projectRoot:path.resolve(root)}})+'\n';
}
