import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8').replace(/^\uFEFF/,''));
const project=read('config/wechatagent.json'),io=read('state/wechat-io-config.json'),keyword=process.argv.slice(2).join(' ').trim();
try{
  const response=await fetch(io.receiver_base_url+'/api/v1/contacts?keyword='+encodeURIComponent(keyword)+'&limit=500',{headers:{Authorization:'Bearer '+io.receiver_token},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('CONTACT_API_UNAVAILABLE');
  const data=await response.json();if(data.success===false||!Array.isArray(data.contacts))throw Error('CONTACT_RESPONSE_INVALID');
  const contacts=data.contacts.filter(contact=>contact.username&&!String(contact.username).includes('@chatroom')&&contact.username!==io.self_wxid&&contact.isFriend===true);
  for(const contact of contacts){const id=(crypto.createHash('sha256').update(contact.username).digest().readBigUInt64BE(0)%2147483647n+1n).toString();console.log(JSON.stringify({name:contact.remark||contact.displayName||contact.nickname||contact.username,onebotId:id,alreadyAllowed:project.wechat.whitelist.private.map(String).includes(id)}));}
  if(!contacts.length)console.log('No matching friends returned by the Hook friend-list API.');
}catch(error){console.error(error.message);process.exitCode=1;}