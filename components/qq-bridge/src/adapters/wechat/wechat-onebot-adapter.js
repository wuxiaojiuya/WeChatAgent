import crypto from 'node:crypto';
import path from 'node:path';
import { BaseAdapter } from '../base-adapter.js';
import { ReverseOneBotServer } from '../../onebot/reverse-ws-server.js';
import { normalizeOneBotEvent } from '../../onebot/normalize.js';

const nativeCapabilityKeys = ['groupMember', 'mention', 'nativeReply', 'quoteReply', 'poke', 'nativeMp3Voice'];
function syntheticId(value, label = 'target') {
  if (!['number', 'string'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new TypeError(`WeChat ${label} must be a synthetic integer ID`);
  return Number(value);
}
function destination(kind, target) {
  if (!['private', 'group'].includes(kind)) throw new TypeError('invalid WeChat kind');
  return { [kind === 'group' ? 'group_id' : 'user_id']: syntheticId(target) };
}
function messageText(text) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 16000) throw new TypeError('invalid WeChat message');
  return text.trim();
}
function deliveryParams({ deliveryId, source, contextId } = {}) {
  if (deliveryId !== undefined && !/^[a-f0-9]{64}$/.test(deliveryId)) throw new TypeError('invalid WeChat delivery ID');
  if (source !== undefined && source !== 'proactive') throw new TypeError('invalid WeChat send source');
  if (source === 'proactive' && (!deliveryId || !/^[a-f0-9]{64}$/.test(contextId ?? ''))) throw new TypeError('invalid WeChat proactive context');
  return { ...(deliveryId ? { wechatagent_delivery_id: deliveryId } : {}), ...(source === 'proactive' ? { wechatagent_source: source, wechatagent_context_id: contextId } : {}) };
}

export class WechatOneBotAdapter extends BaseAdapter {
  constructor(config = {}, log = () => {}) {
    super('wechat', { nativeMp3Voice: false });
    this.log = log;
    this.server = new ReverseOneBotServer(config.server ?? {});
    this.recentOutgoing = new Map();
    this.recentIncoming = new Map();
    this.antiLoopTtlMs = Math.max(1000, Number(config.antiLoopTtlMs) || 60000);
    this.server.on('open', () => { this.stats.connected = true; this.emit('open'); });
    this.server.on('close', () => { this.stats.connected = false; this.#updateCapabilities({}); this.emit('close'); });
    this.server.on('error', (error) => { this.stats.errors++; this.emit('error', error); });
    this.server.on('invalid', (kind) => { this.stats.errors++; this.log(`[WeChat] ${kind}`); });
    this.server.on('event', (event) => this.#receive(event));
  }

  #fingerprint(kind, target, content) {
    return crypto.createHash('sha256').update(JSON.stringify([kind, String(target), String(content).trim()])).digest('hex');
  }

  #prune(now) {
    for (const cache of [this.recentOutgoing, this.recentIncoming]) {
      for (const [key, expires] of cache) if (expires <= now) cache.delete(key);
      while (cache.size > 1000) cache.delete(cache.keys().next().value);
    }
  }

  #receive(event) {
    if (event?.post_type === 'meta_event') {if(event.self_id)this.selfId=String(event.self_id);if(event.wechatagent?.capabilities || event.capabilities)this.#updateCapabilities(event.wechatagent?.capabilities ?? event.capabilities);this.emit('meta', event); return; }
    const message = normalizeOneBotEvent('wechat', 'wechat-onebot', event);
    if (!message) return;
    if (!['text','image','file','record','video'].includes(message.message_type)||message.message_type==='video'&&!message.video||message.message_type==='record'&&!message.voice||message.message_type==='file'&&!message.files.length&&!message.quotedFiles?.length || message.message_type === 'image' && !message.images.length) { this.log(`[WeChat] unsupported_message_type=${message.message_type}`); return; }
    if (!message.text) return;
    const now = Date.now(); this.#prune(now);
    const key = this.#fingerprint(message.kind, message.conversation_id, message.text);
    const selfId = message.self_id;
    if(selfId)this.selfId=selfId;
    if (selfId && (message.sender_id === selfId || String(event.user_id ?? '') === selfId)) return;
    if (this.recentOutgoing.has(key)) return;
    const incomingKey = `${message.message_id}:${key}`;
    if (this.recentIncoming.has(incomingKey)) return;
    this.recentIncoming.set(incomingKey, now + this.antiLoopTtlMs);
    this.stats.messages++; this.emit('message', message);
  }

  async start() { await this.server.start(); }
  async stop() { await this.server.stop(); }
  #updateCapabilities(value) {
    this.capabilities = Object.freeze({ ...this.capabilities, ...Object.fromEntries(nativeCapabilityKeys.map(key => [key, value?.[key] === true])) });
  }
  async refreshCapabilities() {
    const result = await this.server.action('get_status', {});
    this.#updateCapabilities(result.data?.capabilities);
    return this.capabilities;
  }
  async getFriendList() {
    const result = await this.server.action('get_friend_list', {});
    if (!Array.isArray(result.data)) throw new Error('invalid WeChat friend list');
    return result.data.map(friend => ({ user_id: syntheticId(friend?.user_id, 'friend'), nickname: String(friend.nickname ?? ''), remark: String(friend.remark ?? '') }));
  }
  async getGroupList() {
    const result = await this.server.action('get_group_list', {});
    if (!Array.isArray(result.data)) throw new Error('invalid WeChat group list');
    return result.data.map(group => ({ group_id: syntheticId(group?.group_id, 'group'), group_name: String(group.group_name ?? '') }));
  }
  async getGroupMembers(target) {
    const id = syntheticId(typeof target === 'object' && target !== null ? target.target ?? target.group_id : target, 'group');
    const result = await this.server.action('get_group_member_list', { group_id: id });
    if (!Array.isArray(result.data)) throw new Error('invalid WeChat group member list');
    const members = result.data.map(member => {
      if (syntheticId(member?.group_id, 'group') !== id) throw new Error('invalid WeChat group member conversation');
      return { group_id: id, user_id: syntheticId(member.user_id, 'member'), nickname: String(member.nickname ?? ''), card: String(member.card ?? '') };
    });
    if (new Set(members.map(member => member.user_id)).size !== members.length) throw new Error('ambiguous WeChat group member IDs');
    return members;
  }
  async #sendNativeAction(action, params, { kind, target, text, deliveryId }) {
    let result;
    try { result = await this.server.action(action, params); }
    catch (error) {
      if (error.code !== 'SUPPLIER_ACTION_UNCONFIRMED' || error.data?.attempted !== true) throw error;
      return { accepted: false, attempted: true, confirmed: false, delivered: 'unconfirmed', deliveryId };
    }
    const data = result.data;
    const acknowledged = data?.receipt === 'supplier-api' && data.delivered === 'api-acknowledged' && data.apiAcknowledged === true && data.confirmed === false && /^[a-f0-9]{64}$/.test(data.operation_id ?? '');
    const confirmed = data?.receipt === 'wechat-message-response' && data.delivered === 'server-confirmed' && data.confirmed === true && typeof data.message_id === 'string' && /^[1-9]\d{0,19}$/.test(data.message_id);
    if (!acknowledged && !confirmed) throw new Error('WeChat send response has no verified receipt');
    if (text) { this.#prune(Date.now()); this.recentOutgoing.set(this.#fingerprint(kind, target, text), Date.now() + this.antiLoopTtlMs); }
    this.stats.sends++;
    return { accepted: true, confirmed, delivered: data.delivered, response: result, ...(acknowledged ? { apiAcknowledged: true, operationId: data.operation_id } : { messageId: data.message_id }) };
  }
  async sendMentionText({ kind = 'group', target, text, mentions, deliveryId, source, contextId }) {
    if (kind !== 'group') throw new TypeError('WeChat mentions require a group');
    const to = destination(kind, target), content = messageText(text);
    if (!Array.isArray(mentions) || !mentions.length || mentions.length > 100) throw new TypeError('invalid WeChat mentions');
    const ids = [...new Set(mentions.map(value => syntheticId(value, 'member')))];
    const message = [...ids.map(id => ({ type: 'at', data: { qq: String(id) } })), { type: 'text', data: { text: content } }];
    return this.#sendNativeAction('send_group_msg', { ...to, message, ...deliveryParams({ deliveryId, source, contextId }) }, { kind, target: to.group_id, text: content, deliveryId });
  }
  async sendReply({ kind, target, text, messageId, replyTo, deliveryId, source, contextId }) {
    const to = destination(kind, target), content = messageText(text), reference = messageId ?? replyTo;
    // Keep full server IDs as strings; the gateway resolves this reference only
    // from the requested conversation's callback cache.
    if (!['string', 'number'].includes(typeof reference) || typeof reference === 'number' && !Number.isSafeInteger(reference) || !/^(?:[a-f0-9]{64}|[1-9]\d{0,19})$/.test(String(reference))) throw new TypeError('invalid WeChat quote reference');
    const message = [{ type: 'reply', data: { id: String(reference) } }, { type: 'text', data: { text: content } }];
    return this.#sendNativeAction(kind === 'group' ? 'send_group_msg' : 'send_private_msg', { ...to, message, ...deliveryParams({ deliveryId, source, contextId }) }, { kind, target: Number(target), text: content, deliveryId });
  }
  async sendPat({ kind, target, userId, deliveryId }) {
    const to = destination(kind, target), member = userId === undefined && kind === 'private' ? syntheticId(target) : syntheticId(userId, 'member');
    if (kind === 'private' && member !== Number(target)) throw new TypeError('invalid WeChat pat target');
    return this.#sendNativeAction('send_pat', { message_type: kind, ...to, user_id: member, ...deliveryParams({ deliveryId }) }, { kind, target: Number(target), deliveryId });
  }
  async sendPoke(options) { return this.sendPat(options); }
  async sendMp3Voice({ kind, target, path: file, duration, deliveryId }) {
    const to = destination(kind, target);
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.mp3') throw new TypeError('invalid WeChat MP3 path');
    if (duration !== undefined && (!Number.isSafeInteger(duration) || duration < 1 || duration > 60000)) throw new TypeError('invalid WeChat voice duration');
    return this.#sendNativeAction('send_mp3_voice', { message_type: kind, ...to, path: file, ...(duration === undefined ? {} : { duration }), ...deliveryParams({ deliveryId }) }, { kind, target: Number(target), deliveryId });
  }
  async sendText({ kind, target, text, deliveryId, source, contextId }) {
    if (kind !== 'private' && kind !== 'group') throw new TypeError('invalid WeChat kind');
    const content = String(text ?? '').trim();
    if (!content) throw new TypeError('empty WeChat message');
    const id = Number(target);
    // Only synthetic numeric IDs resolved by the WeChat I/O service are accepted.
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('WeChat target must be a synthetic integer ID');
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params = { [kind === 'group' ? 'group_id' : 'user_id']: id,
      message: [{ type: 'text', data: { text: content } }],...(deliveryId?{wechatagent_delivery_id:deliveryId}:{}),
      ...(source==='proactive'?{wechatagent_source:'proactive',wechatagent_context_id:contextId}:{}) };
    let result;
    try{result=await this.server.action(action,params);}
    catch(error){
      if(error.code!=='TEXT_DELIVERY_UNCONFIRMED'||error.data?.attempted!==true)throw error;
      this.#prune(Date.now());this.recentOutgoing.set(this.#fingerprint(kind,id,content),Date.now()+this.antiLoopTtlMs);
      this.log(`[WeChat] text_delivery_unconfirmed operation=${String(deliveryId??'').slice(0,12)}`);
      return {accepted:false,attempted:true,confirmed:false,delivered:'unconfirmed',deliveryId};
    }
    // Supplier text may complete on its documented API success acknowledgement.
    // Keep API acceptance distinct from a final server receipt.
    const apiAcknowledged=result.data?.receipt==='supplier-api'&&result.data?.delivered==='api-acknowledged'&&/^api-text:[a-f0-9]{64}$/.test(result.data?.message_id??'');
    const serverConfirmed=result.data?.receipt==='wechat-message-response'&&result.data.delivered==='server-confirmed'&&result.data.confirmed===true&&typeof result.data.message_id==='string'&&/^[1-9]\d{0,19}$/.test(result.data.message_id);
    if (!serverConfirmed&&!apiAcknowledged) throw new Error('WeChat send response has no verified receipt');
    this.#prune(Date.now());
    this.recentOutgoing.set(this.#fingerprint(kind, id, content), Date.now() + this.antiLoopTtlMs);
    this.stats.sends++; return { accepted: true, confirmed: true, serverConfirmed, response: result, delivered: apiAcknowledged?'api-acknowledged':'server-confirmed',...(apiAcknowledged?{apiAcknowledged:true}:{}) };
  }
  async stickerChoices({kind,target,query}){
    const result=await this.server.action('get_sticker_list',{kind,target:String(target),...(typeof query==='string'&&query.trim()?{query:query.slice(0,500)}:{})});
    return result.data?.enabled?(result.data.stickers??[]):[];
  }
  async sendSticker({kind,target,id,deliveryId,receiptOnly=false,deferReceipt=false,deadlineAt,abandon=false}){
    if(!['private','group'].includes(kind)||!/^[a-f0-9]{64}$/.test(id))throw new TypeError('invalid sticker target');
    let result;
    try{result=await this.server.action(kind==='group'?'send_group_msg':'send_private_msg',{
      [kind==='group'?'group_id':'user_id']:Number(target),message:[{type:'wechat_sticker',data:{id}}],...(deliveryId?{wechatagent_delivery_id:deliveryId}:{}),...(receiptOnly?{wechatagent_receipt_only:true}:{}),...(deferReceipt?{wechatagent_defer_receipt:true}:{}),...(abandon?{wechatagent_abandon_delivery:true}:{}),...(deadlineAt!==undefined?{wechatagent_deadline_at:deadlineAt}:{})});}
    catch(error){
      if(error.code!=='STICKER_DELIVERY_UNCONFIRMED'||error.data?.attempted!==true)throw error;
      this.log(`[WeChat] sticker_delivery_unconfirmed operation=${String(deliveryId??'').slice(0,12)}`);
      return {accepted:false,attempted:true,delivered:'unconfirmed',deliveryId};
    }
    if(abandon&&result.data?.released===true)return result.data;
    if(result.data?.receipt!=='wechat-message-response'||result.data?.media_type!=='wechat-sticker'||result.data.confirmed!==true||typeof result.data.message_id!=='string'||!/^[1-9]\d{0,19}$/.test(result.data.message_id))throw new Error('Sticker send has no server receipt');
    this.stats.sends++;return result;
  }
  async stickerLabels({kind,target,ids}){return (await this.server.action('get_sticker_labels',{kind,target:String(target),ids})).data?.labels??[];}
  async saveStickerLabels({kind,target,labels}){return this.server.action('save_sticker_labels',{kind,target:String(target),labels});}
  async sendPrivateMessage(target, text) { return this.sendText({ kind: 'private', target, text }); }
  async sendGroupMessage(target, text) { return this.sendText({ kind: 'group', target, text }); }
  async reply(message, text, options = {}) {
    if (text === undefined) return this.sendReply(message);
    return this.sendReply({ ...options, kind: message?.kind, target: message?.conversation_id ?? message?.target, messageId: message?.message_id ?? message?.rawid ?? message?.serverId, text });
  }
  getCapabilities() { return this.capabilities; }
}
