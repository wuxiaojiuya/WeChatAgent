import test from 'node:test';
import assert from 'node:assert/strict';
import {fixedWindowPrefix,inspectWindowSystemPrefix} from '../packages/dsh-social-bridge-plugin/request-window.mjs';
const profile={persona:'Current owner persona',instructions:'Current local rules'};
const system=text=>({role:'system',content:[{type:'text',text}]});
test('an in-history system update validates the latest native prefix rather than the protected old head',()=>{
  const prefix=fixedWindowPrefix(profile),messages=[system('Old owner persona'),{role:'user',content:[{type:'text',text:'Evidence only'}]},system('Native guard\n\n'+prefix)];
  const checked=inspectWindowSystemPrefix(messages,profile);assert(checked.matches);assert.equal(checked.index,2);
  assert.equal(inspectWindowSystemPrefix([...messages,system('')],profile).matches,true);
  assert.equal(inspectWindowSystemPrefix([system(prefix),system('A newer but wrong persona')],profile).matches,false);
});
test('user, assistant, tool and reasoning content cannot substitute for a missing native system prefix',()=>{
  const prefix=fixedWindowPrefix(profile);
  for(const role of ['user','assistant','tool'])assert.equal(inspectWindowSystemPrefix([system('Wrong persona'),{role,content:[{type:'text',text:prefix}]}],profile).matches,false);
  assert.equal(inspectWindowSystemPrefix([{role:'system',content:[{type:'reasoning',text:prefix}]}],profile).matches,false);
  assert.equal(inspectWindowSystemPrefix([],profile).matches,false);
  assert.equal(inspectWindowSystemPrefix([{role:'system',content:null}],profile).matches,false);
  const split=Math.floor(prefix.length/2);assert(inspectWindowSystemPrefix([{role:'system',content:[{type:'text',text:prefix.slice(0,split)},{type:'text',text:prefix.slice(split)}]}],profile).matches);
});
