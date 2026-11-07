import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeConfigDraft,rebasePendingConfig,saveConfigDraft,assertConfigScope} from '../public/console/config-draft.mjs';

const account='a'.repeat(64),otherAccount='b'.repeat(64);
const base=()=>({persona:{default:'Original',chats:{}},wechat:{whitelist:{private:['123'],groups:[]},assistant:{administrators:['wxid_existing']},identityMind:{enabled:true,idleMinutes:20}},social:{batch_ms:1000}});
const conflict=()=>Object.assign(new Error('revision changed'),{status:409});

test('background persona changes and an unsaved new friend merge without losing either edit',()=>{
  const before=base(),draft=structuredClone(before),remote=structuredClone(before);
  draft.wechat.whitelist.private.push('456');remote.persona.chats['wechat:private:123']='Autonomous';
  const merged=mergeConfigDraft(before,draft,remote);
  assert.deepEqual(merged.conflicts,[]);assert.deepEqual(merged.config.wechat.whitelist.private,['123','456']);assert.equal(merged.config.persona.chats['wechat:private:123'],'Autonomous');
  assert.deepEqual(before,base());assert.equal(draft.persona.chats['wechat:private:123'],undefined);assert.deepEqual(remote.wechat.whitelist.private,['123']);
});

test('same-field divergent edits remain conflicts, while identical changes and object key ordering do not',()=>{
  const before=base(),draft=structuredClone(before),remote=structuredClone(before);draft.social.batch_ms=500;remote.social.batch_ms=600;
  assert.deepEqual(mergeConfigDraft(before,draft,remote).conflicts,['social.batch_ms']);remote.social.batch_ms=500;assert.deepEqual(mergeConfigDraft(before,draft,remote).conflicts,[]);
  assert.deepEqual(mergeConfigDraft({a:1,b:2},{b:2,a:1},{a:3,b:2}),{config:{a:3,b:2},conflicts:[]});
});

test('new nested objects merge, deletions stay deleted and delete-versus-edit is reported',()=>{
  assert.deepEqual(mergeConfigDraft({}, {new:{a:1}}, {new:{b:2}}),{config:{new:{a:1,b:2}},conflicts:[]});
  assert.deepEqual(mergeConfigDraft({old:1,stay:2},{stay:2},{old:1,stay:3}),{config:{stay:3},conflicts:[]});
  assert.deepEqual(mergeConfigDraft({old:{a:1}},{},{old:{a:2}}).conflicts,['old']);
  assert.deepEqual(mergeConfigDraft({x:null},{x:{}},{x:null}),{config:{x:{}},conflicts:[]});
});

test('whitelist and administrator membership retain concurrent additions and never revive unchanged revoked members',()=>{
  const before=base(),draft=structuredClone(before),remote=structuredClone(before);
  draft.wechat.whitelist.private.push('456');remote.wechat.whitelist.private=['789'];
  draft.wechat.assistant.administrators.push('wxid_local');remote.wechat.assistant.administrators=['wxid_remote'];
  const merged=mergeConfigDraft(before,draft,remote);assert.deepEqual(merged.conflicts,[]);
  assert.deepEqual(merged.config.wechat.whitelist.private,['789','456']);assert.deepEqual(merged.config.wechat.assistant.administrators,['wxid_remote','wxid_local']);
});

test('ordinary ordered arrays and incompatible object types are not silently merged',()=>{
  assert.deepEqual(mergeConfigDraft({names:['a']},{names:['a','b']},{names:['a','c']}).conflicts,['names']);
  assert.deepEqual(mergeConfigDraft({x:{a:1}},{x:null},{x:{a:2}}).conflicts,['x']);
});

test('untrusted object keys do not modify JavaScript prototypes while rebasing',()=>{
  const value=JSON.parse('{"__proto__":{"polluted":true},"constructor":{"value":1}}');
  const merged=mergeConfigDraft({},value,{other:1});assert.equal({}.polluted,undefined);assert(Object.hasOwn(merged.config,'__proto__'));assert.equal(merged.config.__proto__.polluted,true);assert.equal(merged.config.other,1);
});

test('a stale revision retries exactly once with merged settings and the same connection scope',async()=>{
  const before=base(),draft=structuredClone(before),remote=structuredClone(before),requests=[];draft.wechat.whitelist.private.push('456');remote.persona.default='Autonomous';
  const result=await saveConfigDraft({base:before,draft,revision:'old',accountScope:account,read:async()=>({config:remote,revision:'latest',accountScope:account}),save:async body=>{requests.push(body);if(requests.length===1)throw conflict();return {...body,revision:'saved'};}});
  assert.equal(requests.length,2);assert.equal(requests[1].revision,'latest');assert.equal(requests[1].accountScope,account);assert.equal(result.config.persona.default,'Autonomous');assert.deepEqual(result.config.wechat.whitelist.private,['123','456']);assert.equal(before.persona.default,'Original');
});

test('a repeated stale revision or ordinary save error is surfaced without unbounded retries',async()=>{
  let writes=0,reads=0;const before=base(),draft=structuredClone(before);draft.social.batch_ms=500;
  await assert.rejects(saveConfigDraft({base:before,draft,revision:'old',accountScope:account,read:async()=>{reads++;return {config:before,revision:'new',accountScope:account};},save:async()=>{writes++;throw conflict();}}),error=>error.status===409&&error.code==='CONFIG_CHANGED_AGAIN'&&error.message.includes('草稿已保留'));assert.equal(writes,2);assert.equal(reads,1);
  writes=0;reads=0;await assert.rejects(saveConfigDraft({base:before,draft,revision:'old',read:async()=>{reads++;},save:async()=>{writes++;throw Object.assign(new Error('network'),{status:503});}}),/network/);assert.equal(writes,1);assert.equal(reads,0);
});

test('real conflicts preserve captured drafts and do not retry or reveal field values',async()=>{
  const before=base(),draft=structuredClone(before),remote=structuredClone(before);draft.persona.default='LOCAL_PRIVATE_VALUE';remote.persona.default='REMOTE_PRIVATE_VALUE';let writes=0;
  await assert.rejects(saveConfigDraft({base:before,draft,revision:'old',accountScope:account,read:async()=>({config:remote,revision:'new',accountScope:account}),save:async()=>{writes++;throw conflict();}}),error=>error.code==='CONFIG_DRAFT_CONFLICT'&&error.paths[0]==='persona.default'&&!error.message.includes('PRIVATE_VALUE'));
  assert.equal(writes,1);assert.equal(draft.persona.default,'LOCAL_PRIVATE_VALUE');assert.equal(before.persona.default,'Original');
});

test('connection switches cannot merge or save another account, and null supports older snapshots',async()=>{
  const before=base();let writes=0;
  for(const next of [otherAccount,null]){
    await assert.rejects(saveConfigDraft({base:before,draft:before,revision:'old',accountScope:account,read:async()=>({config:before,revision:'new',accountScope:next}),save:async()=>{writes++;throw conflict();}}),{code:'CONFIG_SCOPE_CHANGED'});
  }
  assert.equal(writes,2);assert.throws(()=>assertConfigScope(null,account),{code:'CONFIG_SCOPE_CHANGED'});assert.doesNotThrow(()=>assertConfigScope(null,undefined));
  assert.equal((await saveConfigDraft({base:before,draft:before,revision:'old',save:async body=>({...body,accountScope:undefined})})).revision,'old');
});

test('inputs typed while saving remain unsaved edits after adopting the confirmed server result',async()=>{
  const before=base(),pending=structuredClone(before);pending.wechat.whitelist.private.push('456');const submitted=structuredClone(pending);
  let entered,release;const entering=new Promise(resolve=>{entered=resolve;}),waiting=new Promise(resolve=>{release=resolve;});
  const promise=saveConfigDraft({base:before,draft:pending,revision:'old',accountScope:account,save:async body=>{entered();await waiting;return {...body,revision:'saved'};}});
  await entering;pending.social.batch_ms=700;pending.wechat.whitelist.private.push('789');release();const saved=await promise;
  const kept=rebasePendingConfig(submitted,pending,saved.config);assert.equal(saved.config.social.batch_ms,1000);assert.equal(kept.social.batch_ms,700);assert.deepEqual(saved.config.wechat.whitelist.private,['123','456']);assert.deepEqual(kept.wechat.whitelist.private,['123','456','789']);
});

test('mid-save edits are kept on top of unrelated server changes and may be submitted later',()=>{
  const submitted=base(),pending=structuredClone(submitted),saved=structuredClone(submitted);pending.social.batch_ms=500;saved.persona.default='Autonomous';saved.social.batch_ms=700;
  const kept=rebasePendingConfig(submitted,pending,saved);assert.equal(kept.persona.default,'Autonomous');assert.equal(kept.social.batch_ms,500);assert.equal(saved.social.batch_ms,700);
});
