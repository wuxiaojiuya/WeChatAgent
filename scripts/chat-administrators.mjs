import crypto from 'node:crypto';
import {validWechatIdentity} from '../packages/dsh-social-bridge-plugin/assistant-policy.mjs';

export const privateChatId=wxid=>String(Number(crypto.createHash('sha256').update(wxid).digest().readBigUInt64BE(0)%2147483647n+1n));
export const administratorFriend=wxid=>validWechatIdentity(wxid)&&!['filehelper','fmessage','medianote','newsapp','weixin'].includes(wxid)&&!wxid.startsWith('gh_');
export function administratorForChat(wechat,key,contacts,self='') {
  if(!/^wechat:private:[1-9]\d*$/.test(key))return null;
  const matches=contacts.filter(c=>c.username&&privateChatId(c.username)===key.split(':')[2]);
  if(matches.length!==1||matches[0].ambiguous||matches[0].username===self||!administratorFriend(matches[0].username))return null;
  const wxid=matches[0].username;
  return {wechatId:wxid,isAdministrator:(wechat.assistant?.administrators??[]).includes(wxid)};
}
