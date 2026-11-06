import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateDefaultPersona} from '../packages/dsh-social-bridge-plugin/persona-generation.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'persona-generation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'roles'));fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify({persona:{default:'Original'}}));fs.writeFileSync(path.join(root,'roles/Original.md'),'# 原卡\n自然真诚');
  const options={root,account:'a'.repeat(64),allowed:()=>true,signal:new AbortController().signal,generateText:async()=>JSON.stringify({content:'# 阿澜\n温柔而有主见，熟悉时爱开小玩笑。',reason:'形成自己的稳定表达风格。'})};
  return {root,options};
}
test('default generation uses the local model without writing the card or sending messages',async t=>{
  const f=fixture(t),result=await generateDefaultPersona({...f.options,generateText:async request=>{assert.equal(request.pluginId,'persona-generation');assert.equal(request.key,'persona:default');assert.match(request.prompt,/无需审批/);assert.match(request.prompt,/不要回复微信/);return f.options.generateText(request);}});
  assert.equal(result.expectedBase.name,'Original');assert.match(result.expectedBase.revision,/^[a-f0-9]{64}$/);assert.equal(result.accountScope,f.options.account);
  assert.equal(fs.readFileSync(path.join(f.root,'roles/Original.md'),'utf8'),'# 原卡\n自然真诚');assert(!fs.existsSync(path.join(f.root,'state/persona-approvals')));
});
test('manual card or binding changes during generation discard the stale result',async t=>{
  for(const mutate of [f=>fs.writeFileSync(path.join(f.root,'roles/Original.md'),'# 新的手工编辑'),f=>fs.writeFileSync(path.join(f.root,'config/wechatagent.json'),JSON.stringify({persona:{default:'Changed'}}))]){
    const f=fixture(t);await assert.rejects(()=>generateDefaultPersona({...f.options,generateText:async request=>{mutate(f);return f.options.generateText(request);}}),/BASE_CHANGED/);
  }
});
test('extra model fields, malformed JSON and invalid content cannot be applied',async t=>{
  const f=fixture(t);for(const result of ['not json','{"content":"","reason":"空卡"}','{"content":"新卡","reason":"修改","permissions":true}'])await assert.rejects(()=>generateDefaultPersona({...f.options,generateText:async()=>result}),/INVALID/);
});
test('account authorization and cancellation are checked after generation',async t=>{
  const f=fixture(t);let allowed=true;
  await assert.rejects(()=>generateDefaultPersona({...f.options,allowed:()=>allowed,generateText:async request=>{allowed=false;return f.options.generateText(request);}}),/SCOPE_CHANGED/);
});
