import {conversationId} from './hook-onebot.mjs';

// Display metadata never creates permissions or changes stable conversation IDs.
export function chatContactNames(wechat, contacts, buffer = {}, cached = {}) {
  const names = new Map();
  for (const contact of contacts) {
    if (typeof contact.username !== 'string' || !contact.username) continue;
    const kind = contact.username.includes('@chatroom') ? 'group' : 'private';
    const id = conversationId(contact.username, contact.displayName, contact.conversationId);
    const key = `wechat:${kind}:${id}`;
    if (typeof contact.displayName === 'string' && contact.displayName.trim()) names.set(key, contact.displayName);
  }
  return ['private', 'groups'].flatMap(kind => (wechat.whitelist[kind] ?? []).map(id => {
    const key = `wechat:${kind === 'groups' ? 'group' : 'private'}:${id}`;
    const last = buffer.chats?.[key]?.at(-1);
    return {key, name: names.get(key) || cached[key] || last?.conversation_name || '', lastAt: last?.timestamp ?? 0};
  }));
}
