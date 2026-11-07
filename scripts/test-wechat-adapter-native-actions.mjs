import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { WechatOneBotAdapter } from '../components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js';
import { HookOneBot } from './hook-onebot.mjs';

const operation = 'a'.repeat(64), rawid = 'b'.repeat(64), serverId = '8047442179716189588';
const ack = () => ({ operation_id: operation, receipt: 'supplier-api', delivered: 'api-acknowledged', apiAcknowledged: true, confirmed: false });
const receipt = () => ({ message_id: serverId, receipt: 'wechat-message-response', delivered: 'server-confirmed', confirmed: true });
function fixture(data = ack()) {
  const adapter = new WechatOneBotAdapter(), calls = [];
  adapter.server.action = async (action, params) => { calls.push({ action, params }); return { status: 'ok', retcode: 0, data }; };
  return { adapter, calls };
}

test('catalog methods expose dedicated OneBot actions and synthetic IDs only', async () => {
  const { adapter, calls } = fixture();
  adapter.server.action = async (action, params) => {
    calls.push({ action, params });
    return { data: action === 'get_friend_list' ? [{ user_id: 12, nickname: 'Friend', remark: 'Remark', username: 'private-upstream-id' }]
      : action === 'get_group_list' ? [{ group_id: 34, group_name: 'Room' }]
        : [{ group_id: 34, user_id: 56, nickname: 'Member', card: 'Card', username: 'private-member-id' }] };
  };
  assert.deepEqual(await adapter.getFriendList(), [{ user_id: 12, nickname: 'Friend', remark: 'Remark' }]);
  assert.deepEqual(await adapter.getGroupList(), [{ group_id: 34, group_name: 'Room' }]);
  assert.deepEqual(await adapter.getGroupMembers({ target: '34' }), [{ group_id: 34, user_id: 56, nickname: 'Member', card: 'Card' }]);
  assert.deepEqual(calls, [{ action: 'get_friend_list', params: {} }, { action: 'get_group_list', params: {} }, { action: 'get_group_member_list', params: { group_id: 34 } }]);
  await assert.rejects(adapter.getGroupMembers('wxid_private'), /synthetic integer/);
  assert.equal(calls.length, 3);
  adapter.server.action = async () => ({ data: [{ group_id: 99, user_id: 56 }] });
  await assert.rejects(adapter.getGroupMembers(34), /member conversation/);
});

test('mention text sends member IDs through native at segments and accepts an operation acknowledgement', async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.sendMentionText({ target: 34, text: ' Hello ', mentions: [56, '56', 78], deliveryId: operation });
  assert.deepEqual(calls[0], { action: 'send_group_msg', params: { group_id: 34, message: [
    { type: 'at', data: { qq: '56' } }, { type: 'at', data: { qq: '78' } }, { type: 'text', data: { text: 'Hello' } }], wechatagent_delivery_id: operation } });
  assert.equal(result.accepted, true); assert.equal(result.confirmed, false); assert.equal(result.apiAcknowledged, true);
  assert.equal(result.operationId, operation); assert.equal(result.delivered, 'api-acknowledged');
  assert.equal('messageId' in result, false); assert.equal(adapter.stats.sends, 1);
});

test('native replies preserve raw callback references and full server IDs without number rounding', async () => {
  const { adapter, calls } = fixture(receipt());
  const result = await adapter.sendReply({ kind: 'private', target: '12', messageId: rawid, text: 'Answer' });
  await adapter.reply({ kind: 'group', conversation_id: '34', message_id: serverId }, 'Group answer', { deliveryId: operation });
  assert.deepEqual(calls[0].params.message, [{ type: 'reply', data: { id: rawid } }, { type: 'text', data: { text: 'Answer' } }]);
  assert.equal(calls[1].params.message[0].data.id, serverId); assert.equal(calls[1].params.group_id, 34);
  assert.equal(calls[1].params.wechatagent_delivery_id, operation);
  assert.equal(result.confirmed, true); assert.equal(result.delivered, 'server-confirmed'); assert.equal(result.messageId, serverId);
  await assert.rejects(adapter.sendReply({ kind: 'private', target: 12, messageId: Number(serverId), text: 'No rounded ID' }), /quote reference/);
  assert.equal(calls.length, 2);
});

test('pat, poke alias and native MP3 voice route through the supplier actions', async () => {
  const { adapter, calls } = fixture();
  await adapter.sendPat({ kind: 'private', target: 12, deliveryId: operation });
  await adapter.sendPoke({ kind: 'group', target: 34, userId: 56 });
  const file = path.resolve('offline-fixture.mp3');
  await adapter.sendMp3Voice({ kind: 'private', target: 12, path: file, duration: 30000 });
  assert.deepEqual(calls, [
    { action: 'send_pat', params: { message_type: 'private', user_id: 12, wechatagent_delivery_id: operation } },
    { action: 'send_pat', params: { message_type: 'group', group_id: 34, user_id: 56 } },
    { action: 'send_mp3_voice', params: { message_type: 'private', user_id: 12, path: file, duration: 30000 } }]);
  assert.equal(adapter.stats.sends, 3);
});

test('new send methods reject invalid destinations, member IDs and local voice inputs before dispatch', async () => {
  const { adapter, calls } = fixture();
  for (const params of [{ kind: 'private', target: 34, text: 'x', mentions: [56] }, { target: true, text: 'x', mentions: [56] },
    { target: 34, text: 'x', mentions: ['wxid_private'] }, { target: 34, text: 'x', mentions: [] }]) await assert.rejects(adapter.sendMentionText(params), TypeError);
  await assert.rejects(adapter.sendPat({ kind: 'private', target: 12, userId: 56 }), /pat target/);
  await assert.rejects(adapter.sendPat({ kind: 'group', target: 34 }), /synthetic integer/);
  await assert.rejects(adapter.sendReply({ kind: 'channel', target: 12, messageId: rawid, text: 'x' }), /kind/);
  await assert.rejects(adapter.sendReply({ kind: 'private', target: 12, messageId: 'local-unknown', text: 'x' }), /quote reference/);
  for (const params of [{ path: 'relative.mp3' }, { path: path.resolve('x.wav') }, { path: path.resolve('x.mp3'), duration: 60001 }])
    await assert.rejects(adapter.sendMp3Voice({ kind: 'private', target: 12, ...params }), TypeError);
  assert.equal(calls.length, 0);
});

test('an uncertain supplier submission is returned once without automatic retry', async () => {
  const { adapter, calls } = fixture();
  adapter.server.action = async (action, params) => { calls.push({ action, params }); throw Object.assign(new Error('uncertain'), { code: 'SUPPLIER_ACTION_UNCONFIRMED', data: { attempted: true } }); };
  const result = await adapter.sendReply({ kind: 'private', target: 12, messageId: rawid, text: 'x', deliveryId: operation });
  assert.deepEqual(result, { accepted: false, attempted: true, confirmed: false, delivered: 'unconfirmed', deliveryId: operation });
  assert.equal(calls.length, 1); assert.equal(adapter.stats.sends, 0);
});

test('incomplete and fabricated acknowledgement metadata cannot count as delivery', async () => {
  for (const data of [{ receipt: 'supplier-api' }, { ...ack(), operation_id: undefined }, { ...ack(), confirmed: true },
    { ...receipt(), message_id: Number(serverId) }, { ...receipt(), receipt: 'supplier-api' }, { ...receipt(), confirmed: false }]) {
    const { adapter } = fixture(data);
    await assert.rejects(adapter.sendPat({ kind: 'private', target: 12 }), /verified receipt/);
    assert.equal(adapter.stats.sends, 0);
  }
});

test('capabilities follow supplier health and are cleared on disconnect', async () => {
  const { adapter } = fixture();
  for (const key of ['groupMember', 'nativeReply', 'quoteReply', 'poke', 'nativeMp3Voice']) assert.equal(adapter.getCapabilities()[key], false);
  const backend = Object.create(HookOneBot.prototype);
  backend.hook = { backend: 'supplier-http' };
  backend.status = { hook_ready: true, native_at_send: true, native_quote_send: true, native_pat_send: false, native_mp3_voice_send: true };
  const capabilities = backend.capabilities();
  assert.deepEqual(capabilities, { groupMember: true, mention: true, nativeReply: true, quoteReply: true, poke: false, nativeMp3Voice: true });
  adapter.server.emit('event', { post_type: 'meta_event', wechatagent: { capabilities } });
  assert.equal(adapter.getCapabilities().nativeReply, true); assert.equal(adapter.getCapabilities().poke, false);
  adapter.server.emit('close');
  for (const key of Object.keys(capabilities)) assert.equal(adapter.getCapabilities()[key], false);
  adapter.server.action = async () => ({ data: { capabilities } });
  await adapter.refreshCapabilities(); assert.equal(adapter.getCapabilities().nativeMp3Voice, true);
  backend.status.hook_ready = false; assert(Object.values(backend.capabilities()).every(value => value === false));
  backend.status.hook_ready = true; backend.hook.backend = 'project-native'; assert(Object.values(backend.capabilities()).every(value => value === false));
});
