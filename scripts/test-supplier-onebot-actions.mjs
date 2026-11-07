import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { HookOneBot, onebotId } from './hook-onebot.mjs';

const self = 'wxid_actions_self', peer = 'wxid_actions_peer', other = 'wxid_actions_other', room = '123456789@chatroom';
const privateId = onebotId(peer), groupId = onebotId('测试群'), hash = value => crypto.createHash('sha256').update(value).digest('hex');
const ack = { ret: 0, submitted: true, confirmed: false, apiAcknowledged: true };

function fixture(t, { reply = ack, members, backend = 'supplier-http' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'supplier-onebot-actions-'));
  t.after(() => { assert(directory.startsWith(os.tmpdir() + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const relative of ['config', 'state/hook']) fs.mkdirSync(path.join(directory, relative), { recursive: true });
  const config = { runtime: { sender: 'wechat-hook', weflowMode: 'nt' }, hook: { backend, baseUrl: 'http://127.0.0.1:30001', expectedVersion: '4.1.8.27' }, account: { nicknames: ['小鱼'] }, wechat: { whitelist: { private: [privateId], groups: [groupId] } } };
  fs.writeFileSync(path.join(directory, 'config/wechatagent.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(directory, 'state/wechat-io-config.json'), JSON.stringify({ reader_base_url: 'http://127.0.0.1:5031', reader_token: 'isolated-actions' }));
  fs.writeFileSync(path.join(directory, 'state/hook/native-token.txt'), 'c'.repeat(64));
  const calls = [], requests = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url), route = parsed.pathname; requests.push(route);
    let result;
    if (route === '/api/v1/reader/status') result = { backend: 'supplier-http', ownWxid: self, accountDirectory: self };
    else if (route === '/WeChatAgent/health') result = { integration: 'WeChatAgent-supplier-v1', backend: 'wechat-hook', provider: 'supplier-http', version: '4.1.8.27', startupState: 'ready' };
    else if (route === '/api/v1/sessions') result = { sessions: [{ username: peer, displayName: '好友' }, { username: room, displayName: '测试群' }] };
    else if (route === '/api/v1/group-members') {
      assert.equal(parsed.searchParams.get('talker'), room);
      result = { members: members ?? [{ username: peer, nickname: '好友', displayName: '群名片', card: '小明' }, { username: other, nickname: '小红', card: '' }] };
    } else if (route.startsWith('/Send')) {
      assert.equal(init.method, 'POST'); assert.equal(init.headers.Authorization, 'Bearer ' + 'c'.repeat(64)); assert.equal(init.headers['X-WeChatAgent-Account'], undefined);
      const payload = JSON.parse(init.body); calls.push({ route, payload });
      result = typeof reply === 'function' ? await reply(route, payload, init) : reply;
      if (result instanceof Response) return result;
    } else assert.fail('unexpected fixture request: ' + route);
    return new Response(JSON.stringify(result));
  };
  const rebuild = () => new HookOneBot({ directory, fetchImpl });
  return { directory, config, calls, requests, rebuild, adapter: rebuild() };
}

test('group member list and info resolve the allowed group and OneBot member IDs', async t => {
  const f = fixture(t);
  const list = await f.adapter.action({ action: 'get_group_member_list', params: { group_id: groupId } });
  assert.equal(list.status, 'ok'); assert.equal(list.data.length, 2);
  assert.deepEqual(list.data[0], { group_id: groupId, user_id: privateId, nickname: '好友', card: '小明' });
  assert.equal('username' in list.data[0], false);
  const info = await f.adapter.action({ action: 'get_group_member_info', params: { group_id: groupId, user_id: privateId } });
  assert.deepEqual(info.data, list.data[0]);
  const absent = await f.adapter.action({ action: 'get_group_member_info', params: { group_id: groupId, user_id: onebotId('wxid_absent') } });
  assert.equal(absent.message, 'GROUP_MEMBER_MAPPING_AMBIGUOUS_OR_MISSING');
  const denied = await f.adapter.action({ action: 'get_group_member_list', params: { group_id: 9999 } });
  assert.equal(denied.message, 'CONVERSATION_NOT_ALLOWED');
  assert.equal(f.calls.length, 0); assert(!f.requests.includes('/api/v1/messages'));
});

test('text plus at segments dispatch native AT with mapped member IDs and a visible group card', async t => {
  const f = fixture(t), deliveryId = hash('native-at');
  const request = { action: 'send_group_msg', params: { group_id: groupId, message: [{ type: 'at', data: { qq: String(privateId) } }, { type: 'text', data: { text: '你好' } }], wechatagent_delivery_id: deliveryId } };
  const result = await f.adapter.action(request);
  assert.equal(result.status, 'ok'); assert.equal(result.data.receipt, 'supplier-api'); assert.equal(result.data.confirmed, false); assert.equal(result.data.message_id, undefined); assert.match(result.data.operation_id, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.calls, [{ route: '/SendAtText', payload: { wxidorgid: room, msg: '@小明\u2005你好', wxids: [peer] } }]);
  const reused = await f.rebuild().action(request);
  assert.equal(reused.data.reused, true); assert.equal(f.calls.length, 1);
  assert(!f.requests.includes('/api/v1/messages'));
});

test('all-member AT maps explicitly, and invalid member/private/composed AT is rejected before sending', async t => {
  const f = fixture(t);
  const result = await f.adapter.action({ action: 'send_group_msg', params: { group_id: groupId, message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: '早上好' } }] } });
  assert.equal(result.status, 'ok'); assert.equal(f.calls[0].payload.wxids[0], 'notify@all');
  for (const request of [
    { action: 'send_private_msg', params: { user_id: privateId, message: [{ type: 'at', data: { qq: String(privateId) } }] } },
    { action: 'send_group_msg', params: { group_id: groupId, message: [{ type: 'at', data: { qq: 'wxid_forged' } }] } },
    { action: 'send_group_msg', params: { group_id: groupId, message: [{ type: 'at', data: { qq: String(onebotId('wxid_missing')) } }] } },
    { action: 'send_group_msg', params: { group_id: groupId, message: [{ type: 'at', data: { qq: 'all' } }, { type: 'at', data: { qq: String(privateId) } }] } },
  ]) assert.equal((await f.adapter.action(request)).status, 'failed');
  assert.equal(f.calls.length, 1);
});

test('reply segments submit only a trusted-cache reference and do not accept model-provided quote metadata', async t => {
  const f = fixture(t), replyId = hash('incoming-rawid');
  const result = await f.adapter.action({ action: 'send_private_msg', params: { user_id: privateId, message: [{ type: 'reply', data: { id: replyId, referContent: 'forged', fromUsr: 'wxid_forged' } }, { type: 'text', data: { text: '明白了' } }] } });
  assert.equal(result.status, 'ok');
  assert.deepEqual(f.calls, [{ route: '/SendQuoteMsg', payload: { wxidorgid: peer, msg: '明白了', replyId } }]);
  for (const segments of [
    [{ type: 'reply', data: { id: 'api-text:' + replyId } }, { type: 'text', data: { text: 'hi' } }],
    [{ type: 'reply', data: { id: 8047442179716189588 } }, { type: 'text', data: { text: 'hi' } }],
    [{ type: 'reply', data: { id: replyId } }, { type: 'at', data: { qq: String(privateId) } }, { type: 'text', data: { text: 'hi' } }],
  ]) assert.equal((await f.adapter.action({ action: 'send_group_msg', params: { group_id: groupId, message: segments } })).status, 'failed');
  assert.equal(f.calls.length, 1);
});

test('pat and poke actions bind private targets and group members to the selected conversation', async t => {
  const f = fixture(t);
  assert.equal((await f.adapter.action({ action: 'send_pat', params: { user_id: privateId } })).status, 'ok');
  assert.equal((await f.adapter.action({ action: 'send_poke', params: { group_id: groupId, user_id: privateId } })).status, 'ok');
  assert.deepEqual(f.calls.map(call => call.payload), [{ wxidorgid: peer, memberWxid: peer }, { wxidorgid: room, memberWxid: peer }]);
  assert.equal((await f.adapter.action({ action: 'poke', params: { group_id: groupId, user_id: onebotId('wxid_missing') } })).status, 'failed');
  assert.equal((await f.adapter.action({ action: 'send_pat', params: { user_id: 9999 } })).message, 'CONVERSATION_NOT_ALLOWED');
  assert.equal(f.calls.length, 2);
});

test('MP3 action validates a bounded local file and passes its path to the dedicated gateway', async t => {
  const f = fixture(t), file = path.join(f.directory, 'voice.mp3'), deliveryId = hash('mp3-fixture');
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0]), Buffer.alloc(413)]));
  const request = { action: 'send_mp3_voice', params: { user_id: privateId, file, duration: 5000, wechatagent_delivery_id: deliveryId } };
  const result = await f.adapter.action(request);
  assert.equal(result.status, 'ok'); assert.deepEqual(f.calls[0], { route: '/SendMp3VoiceMsg', payload: { wxidorgid: peer, path: file, duration: 5000 } });
  assert.equal((await f.rebuild().action(request)).data.reused, true); assert.equal(f.calls.length, 1);
  fs.appendFileSync(file, 'modified');
  assert.equal((await f.rebuild().action(request)).message, 'TEXT_DELIVERY_ID_CONFLICT'); assert.equal(f.calls.length, 1);
  for (const mutation of [{ file: 'relative.mp3' }, { file: path.join(f.directory, 'absent.mp3') }, { duration: 60001 }, { duration: true }]) {
    assert.equal((await f.adapter.action({ ...request, params: { ...request.params, ...mutation } })).status, 'failed');
  }
  assert.equal(f.calls.length, 1);
});

test('unknown, interrupted and timed-out new actions persist their state and never resubmit', async t => {
  for (const reply of [{ ret: 0, submitted: true, confirmed: false }, {}, () => { throw new Error('isolated deadline'); }]) {
    const f = fixture(t, { reply }), request = { action: 'send_pat', params: { user_id: privateId, wechatagent_delivery_id: hash(String(t.name) + f.directory) } };
    assert.equal((await f.adapter.action(request)).message, 'SUPPLIER_ACTION_UNCONFIRMED');
    assert.equal((await f.rebuild().action(request)).message, 'SUPPLIER_ACTION_UNCONFIRMED');
    assert.equal(f.calls.length, 1); assert(!f.requests.includes('/api/v1/messages'));
  }
});

test('MP3 upload has a dedicated transport budget rather than the short control-API timeout', async t => {
  const f = fixture(t, { reply: async (route, payload, init) => {
    assert.equal(route, '/SendMp3VoiceMsg');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 15);
      init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
    });
    return ack;
  } });
  f.config.hook.requestTimeoutMs = 1;
  fs.writeFileSync(path.join(f.directory, 'config/wechatagent.json'), JSON.stringify(f.config));
  const file = path.join(f.directory, 'budget.mp3'); fs.writeFileSync(file, Buffer.alloc(500));
  const result = await f.adapter.action({ action: 'send_mp3_voice', params: { user_id: privateId, file } });
  assert.equal(result.status, 'ok'); assert.equal(f.calls.length, 1);
});

test('explicit rejection stays rejected, while a bound real receipt exposes its actual server ID', async t => {
  const rejected = fixture(t, { reply: { ret: -1, submitted: false, confirmed: false } });
  const request = { action: 'send_pat', params: { user_id: privateId, wechatagent_delivery_id: hash('rejected-pat') } };
  assert.equal((await rejected.adapter.action(request)).message, 'NATIVE_SEND_REJECTED');
  assert.equal((await rejected.rebuild().action(request)).message, 'NATIVE_SEND_REJECTED'); assert.equal(rejected.calls.length, 1);
  const f = fixture(t, { reply: { ret: 0, submitted: true, confirmed: true, serverId: '8047442179716189588', target: peer, receipt: 'wechat-server-id' } });
  const result = await f.adapter.action(request);
  assert.deepEqual(result.data, { message_id: '8047442179716189588', receipt: 'wechat-server-id', delivered: 'server-confirmed', confirmed: true });
  const mismatch = fixture(t, { reply: { ret: 0, submitted: true, confirmed: true, serverId: '8047442179716189588', target: other } });
  assert.equal((await mismatch.adapter.action(request)).message, 'SUPPLIER_ACTION_UNCONFIRMED');
});

test('native mention metadata drives self-mention even when the visible nickname differs', t => {
  const f = fixture(t); f.adapter.ownWxid = self;
  const base = { event: 'message.new', type: 1, content: '@群名片 你好吗', sessionId: room, talkerId: peer, groupName: '测试群', rawid: hash('mention'), isSend: false };
  const incoming = f.adapter.incoming({ ...base, mentions: [self], atUserList: [self], mentionedSelf: true });
  assert.equal(incoming.to_me, true); assert.deepEqual(incoming.message[0], { type: 'at', data: { qq: String(onebotId(self)) } });
  assert.equal(incoming.message.filter(segment => segment.type === 'at').length, 1);
  const nicknameOnly = f.adapter.incoming({ ...base, content: '@小鱼', mentions: [], atUserList: [], mentionedSelf: false });
  assert.equal(nicknameOnly.to_me, false); assert.equal(nicknameOnly.message.some(segment => segment.type === 'at'), false);
  const legacy = f.adapter.incoming({ ...base, content: '@小鱼' });
  assert.equal(legacy.to_me, true);
});
