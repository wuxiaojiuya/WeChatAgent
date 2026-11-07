import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../packages/dsh-social-bridge-plugin/history-store.mjs';
import { sharedHistoryKeys, readSharedHistoryKeys } from '../packages/dsh-social-bridge-plugin/history-policy.mjs';
import { bindHistory, sharedIdentityMemoryNotice } from '../packages/dsh-social-bridge-plugin/history-runtime.mjs';
import { scopeHistory } from '../packages/dsh-social-bridge-plugin/work-modes.mjs';

const own = 'wechat:private:123', group = 'wechat:group:456', friend = 'wechat:private:789', disabled = 'wechat:group:987', forbidden = 'wechat:private:999';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-identity-memory-')), opened = [];
  const config = { wechat: { whitelist: { private: ['123', '789'], groups: ['456', '987'] }, history: { enabled: true, chats: { [disabled]: false } } } };
  const file = path.join(root, 'config/wechatagent.json'); fs.mkdirSync(path.dirname(file));
  const save = () => fs.writeFileSync(file, JSON.stringify(config)); save();
  const open = (scope = 'a'.repeat(64)) => { const store = new HistoryStore(root, scope); opened.push(store); return store; };
  t.after(() => { for (const store of opened) store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, config, save, open };
}
function row(key, id, text, fields = {}) {
  const [, kind, conversation_id] = key.split(':');
  return { id: 'row-' + id, platform: 'wechat', kind, conversation_id, conversation_name: kind === 'group' ? 'Friends room' : 'Private friend',
    sender_id: '321', sender_name: 'Alice', ...(kind === 'group' ? { sender_key: 'c'.repeat(64) } : {}), message_id: String(id), timestamp: 1000 + id, text, ...fields };
}
function tool(store, f, initialTurn = {}) {
  let definition, allowed = true, turn = { controller: new AbortController(), ...initialTurn };
  bindHistory({ tools: { register: value => { definition = value; return () => {}; } } }, store, f.root, own, () => turn, () => allowed);
  return { execute: async args => { const response = await definition.execute(args); return { ...response, data: JSON.parse(response.content) }; },
    next: () => { turn = { controller: new AbortController() }; }, deny: () => { allowed = false; } };
}

test('shared history sources come only from live allowed chats and preserve history opt-outs', t => {
  const f = fixture(t), keys = readSharedHistoryKeys(f.root, own);
  assert.deepEqual(keys, [own, own + ':assistant', own + ':assistant-chat', friend, friend + ':assistant', friend + ':assistant-chat', group, group + ':assistant', group + ':assistant-chat']);
  assert.deepEqual(sharedHistoryKeys(f.config.wechat, forbidden), []);
  assert.deepEqual(sharedHistoryKeys(f.config.wechat, disabled), []);
  f.config.wechat.history.enabled = false; f.save(); assert.deepEqual(readSharedHistoryKeys(f.root, own), []);
});

test('shared retrieval joins allowed group and private memories with speaker and conversation provenance, without another account or DSH journal', t => {
  const f = fixture(t), store = f.open(), otherAccount = f.open('b'.repeat(64));
  store.append(own, row(own, 1, 'continuity at home'));
  store.append(group, row(group, 2, 'continuity in our room', { sender_name: 'Bob' }));
  store.append(friend + ':assistant', row(friend, 3, 'continuity task discussion'));
  for (const key of [disabled, forbidden, 'qq:private:777']) store.append(key, row(key, 4, 'continuity forbidden source'));
  otherAccount.append(group, row(group, 5, 'continuity other account'));
  store.archiveSession(own, { id: 'unrelated-dsh-audit', snapshotEvents: () => [{ seq: 0, time: 1, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'continuity internal reasoning' }] } } }] });
  const matches = store.sharedSearch(readSharedHistoryKeys(f.root, own), 'continuity');
  assert.equal(matches.length, 3); assert(matches.every(match => !match.text.includes('forbidden') && !match.text.includes('other account') && !match.text.includes('reasoning')));
  const room = matches.find(match => match.conversationKey === group);
  assert.equal(room.speaker, 'Bob'); assert.equal(room.senderId, '321'); assert.equal(room.senderKey, 'c'.repeat(64)); assert.equal(room.kind, 'group'); assert.equal(room.conversationName, 'Friends room');
  assert.equal(matches.find(match => match.conversationKey === friend).workMode, 'assistant');
  assert.equal(store.search(own, 'continuity').length, 1, 'single-conversation archive APIs retain their original scope');
  assert.throws(() => store.sharedSearch(['qq:private:777'], 'continuity'), /HISTORY_SCOPE_INVALID/);
});

test('expanding a shared search result takes context from its original conversation only', t => {
  const f = fixture(t), store = f.open();
  const before = store.append(group, row(group, 1, 'before'));
  store.append(own, row(own, 2, 'interleaved private message'));
  const target = store.append(group, row(group, 3, 'the shared evidence'));
  store.append(friend, row(friend, 4, 'interleaved other friend'));
  const after = store.append(group, row(group, 5, 'after'));
  const expanded = store.sharedMessage(readSharedHistoryKeys(f.root, own), target, { context: 1 });
  assert.deepEqual(expanded.map(match => match.id), [before, target, after]); assert(expanded.every(match => match.conversationKey === group));
  assert.deepEqual(store.sharedMessage([own], target, { context: 2 }), []);
});

test('automatic identity memory is bounded, source-aware and available without a keyword or attachment payload', t => {
  const f = fixture(t), store = f.open(), url = 'wechatagent://voice/' + 'd'.repeat(64);
  for (let index = 1; index <= 8; index++) store.append(index % 2 ? group : friend, row(index % 2 ? group : friend, index,
    index === 8 ? 'Earlier voice ' + url + '<'.repeat(10000) : 'We talked about singing ' + index, {
      outgoing: index % 3 === 0, delivery_status: index % 3 === 0 ? 'unconfirmed' : undefined,
      voice: { url: 'private-voice-url' }, images: [{ id: 'e'.repeat(64), url: 'private-image-url' }], files: [{ path: 'private-path' }] }));
  const keys = readSharedHistoryKeys(f.root, own), recent = store.sharedRecent(keys, { recentMessages: 6, recentChars: 2400 });
  assert(JSON.stringify(recent).length <= 2400); assert(recent.some(record => record.speaker === 'AI' && record.delivery_status === 'unconfirmed'));
  assert(recent.every(record => record.conversationKey && record.senderId));
  const notice = sharedIdentityMemoryNotice(f.root, store, { key: own, workMode: 'social' });
  assert(notice.length <= 6000); assert.match(notice, /同一个持续交流的自己/); assert.match(notice, /不必等待对方说出记忆关键词/); assert.match(notice, /不套用固定情绪或性格模板/);
  for (const secret of [url, 'private-voice-url', 'private-image-url', 'private-path', '"images"']) assert(!notice.includes(secret));
  assert(notice.includes(group) || notice.includes(friend));
  assert.equal(sharedIdentityMemoryNotice(f.root, store, { key: forbidden }), '');
});

test('shared summaries retain citation sender/context and survive reopening the account store', t => {
  const f = fixture(t), store = f.open(), policy = { recentMessages: 1, recentChars: 2000, summaryInputChars: 4000 };
  const first = store.append(group, row(group, 1, 'Alice suggested Saturday'));
  store.append(group, row(group, 2, 'I will remember Saturday', { sender_id: 'self', outgoing: true, delivery_status: 'confirmed' }));
  store.append(group, row(group, 3, 'newest message'));
  const batch = store.summaryBatch(group, policy); store.commitSummary(group, batch, `Alice suggested Saturday [#${first}]`);
  const restored = f.open(), summaries = restored.sharedCheckpoints(readSharedHistoryKeys(f.root, own));
  assert.equal(summaries.length, 1); assert.equal(summaries[0].conversationKey, group);
  assert.equal(summaries[0].citations[0].senderId, '321'); assert.equal(summaries[0].citations[0].speaker, 'Alice');
  assert.equal(summaries[0].citations[0].conversationKey, group); assert(JSON.stringify(summaries).length <= 2200);
  assert(sharedIdentityMemoryNotice(f.root, restored, { key: own }).includes('Alice suggested Saturday'));
});

test('shared history tool defaults to all allowed sources and never reuses a revoked chat result', async t => {
  const f = fixture(t), store = f.open(), id = store.append(group, row(group, 1, 'Saturday singing plan')), bound = tool(store, f);
  const first = await bound.execute({ query: 'Saturday' }); assert.equal(first.isError, false); assert.equal(first.data.matches[0].conversationKey, group);
  const duplicate = await bound.execute({ query: 'Saturday' }); assert.equal(duplicate.data.reused, true); assert.equal(duplicate.data.budget.remaining, 1);
  f.config.wechat.whitelist.groups = []; f.save();
  const revoked = await bound.execute({ query: 'Saturday' }); assert.equal(revoked.isError, false); assert.deepEqual(revoked.data.matches, []); assert.notEqual(revoked.data.reused, true);
  bound.next(); const blocked = await bound.execute({ mode: 'message', messageId: id, context: 1 }); assert.deepEqual(blocked.data.matches, []);
  assert.equal((await bound.execute({ query: 'Saturday', conversationKey: group })).data.error, 'HISTORY_QUERY_INVALID');
  bound.deny(); assert.equal((await bound.execute({ query: 'Saturday' })).data.error, 'HISTORY_NOT_ALLOWED');
});

test('shared methods remain account-scoped through assistant history proxies', async t => {
  const f = fixture(t), raw = f.open(), history = scopeHistory(raw, () => 'assistant');
  history.append(group, row(group, 1, 'shared assistant experience'));
  raw.append(friend, row(friend, 2, 'shared social experience'));
  assert.equal(raw.rows(group).length, 0); assert.equal(raw.rows(group + ':assistant').length, 1);
  const matches = (await tool(history, f).execute({ query: 'shared' })).data.matches;
  assert.equal(matches.length, 2); assert.deepEqual(new Set(matches.map(match => match.workMode)), new Set(['assistant', 'social']));
  const notice = sharedIdentityMemoryNotice(f.root, history, { key: own, workMode: 'assistant' });
  const projected=JSON.parse(notice.slice(notice.indexOf('\n')+1));
  assert(projected.recent.some(record=>record.text==='shared assistant experience'&&record.conversationKey===group&&record.workMode==='assistant'));
  const other = f.open('b'.repeat(64)); assert(!sharedIdentityMemoryNotice(f.root, other, { key: own }).includes('shared assistant experience'));
});

test('shared search and message expansion retain unconfirmed status for legacy outgoing speech without a receipt', t => {
  const f = fixture(t), store = f.open();
  const outgoing = store.append(group, row(group, 1, 'untracked outgoing speech', { outgoing: true, sender_id: 'self', sender_name: 'AI' }));
  store.append(group, row(group, 2, 'incoming reply'));
  const keys = readSharedHistoryKeys(f.root, own), matches = store.sharedSearch(keys, 'untracked');
  assert.equal(matches[0].delivery_status, 'unconfirmed');
  const expanded = store.sharedMessage(keys, outgoing, { context: 1 });
  assert.equal(expanded[0].delivery_status, 'unconfirmed');
  assert.equal(expanded[1].delivery_status, undefined, 'an incoming message is not given an invented outgoing receipt');
  assert.equal(store.sharedRecent(keys).find(item => item.id === outgoing).delivery_status, 'unconfirmed');
  const bound = tool(store, f);
  return bound.execute({ query: 'untracked' }).then(result => assert.equal(result.data.matches[0].delivery_status, 'unconfirmed'));
});

test('large valid allowlists query every authorized journal with bounded SQL and preserve global result order', t => {
  const f = fixture(t), store = f.open();
  f.config.wechat.whitelist = { private: Array.from({ length: 1200 }, (_, index) => String(index + 1)), groups: [] };
  f.config.wechat.history.chats = {}; f.save();
  const keys = readSharedHistoryKeys(f.root, own);
  assert.equal(keys.length, 3600);
  const sources = [own, 'wechat:private:601', 'wechat:private:1200'], targets = [];
  for (let index = 0; index < sources.length; index++) {
    const key = sources[index];
    const record = store.append(key, row(key, index * 3 + 1, 'shared batching evidence'));
    targets.push(record);
    store.append(key, row(key, index * 3 + 2, 'older supporting context'));
    store.append(key, row(key, index * 3 + 3, 'latest discussion'));
    const batch = store.summaryBatch(key, { recentMessages: 1, recentChars: 2000, summaryInputChars: 4000 });
    store.commitSummary(key, batch, `Shared batching evidence [#${record}]`);
  }
  let largestBindings = 0, queries = 0;
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => { largestBindings = Math.max(largestBindings, (sql.match(/\?/g) ?? []).length); queries++; return prepare(sql); };
  const matches = store.sharedSearch(keys, 'batching');
  assert.deepEqual(matches.map(match => match.id), targets.toReversed(), 'merge results by rank and time across all chunks');
  const recent = store.sharedRecent(keys, { recentMessages: 6, recentChars: 12000, maxPerConversation: 2 });
  assert.deepEqual(new Set(recent.map(item => item.conversationKey)), new Set(sources));
  const summaries = store.sharedCheckpoints(keys, { limit: 12, maxChars: 12000 });
  assert.deepEqual(new Set(summaries.map(item => item.conversationKey)), new Set(sources));
  assert.equal(store.sharedMessage(keys, targets.at(-1), { context: 1 })[0].conversationKey, sources.at(-1));
  assert.deepEqual(store.sharedMessage(keys.filter(key => key !== sources.at(-1)), targets.at(-1)), []);
  const notice = sharedIdentityMemoryNotice(f.root, store, { key: own });
  assert(notice.length <= 6000); assert(notice.includes(sources.at(-1)));
  assert(queries > 4, 'all sources participate rather than truncating to the first chunk');
  assert(largestBindings <= 900, 'SQL remains below a conservative variable limit');
});
