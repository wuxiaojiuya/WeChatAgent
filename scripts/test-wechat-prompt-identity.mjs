import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {withoutDshIdentity} from '../packages/dsh-social-bridge-plugin/social-tool-policy.mjs';
import {apply} from '../packages/dsh-social-bridge-plugin/social-tool-restrict.mjs';
const native='You are an AI agent powered by DeepSeek Harness.',coding='You are a coding agent powered by the deepseek-flash model.';
const guardPolicy=Symbol.for('wechatagent.dsh-access.v1');
const sample=prefix=>({sections:[{name:'harness:identity',text:native},{name:'deployment:persona-prefix',text:prefix,interpolate:true},{name:'wechatagent:fixed-window-prefix',text:'本机人格：蓝色大肥鱼。保留我的身份和语气。'},{name:'tool:read',text:'Use the read tool to inspect text files.'},{name:'tool:pwsh',text:'Non-zero exits are reported as exit markers.'},{name:'tool:jobs',text:'Track every background job id you start.'}],contexts:[{name:'approval-policy',text:'Approval is required for protected operations.',required:true},{name:'working-directory',text:'fixture workspace'}],variables:{model:'deepseek-flash'},tools:[{name:'read',parameters:{type:'object'}},{name:'pwsh',parameters:{type:'object'}}]});
const rendered=assembly=>assembly.sections.map(section=>section.text??'').join('\n\n');
test('chat and default assistant lose only the Harness identity while their local persona remains intact',()=>{
 for(const prefix of ['你是微信聊天参与者，按本机当前人格自然交流。','你是通过微信协助用户完成任务的助手。']){
  const original=sample(prefix),before=JSON.stringify(original),result=withoutDshIdentity(original);assert(!rendered(result).includes(native));assert(rendered(result).includes(prefix));assert(rendered(result).includes('蓝色大肥鱼'));assert.equal(result.tools,original.tools);assert.equal(result.contexts,original.contexts);assert.equal(result.variables,original.variables);assert.equal(JSON.stringify(original),before);
 }
});
test('standard preset loses its coding-agent declaration but keeps all operational instructions',()=>{
 const rules='Complete the authorized task. Preserve working files and obey approvals.',original=sample(coding+'\n\n'+rules),result=withoutDshIdentity(original);assert(!rendered(result).includes(coding));assert(!rendered(result).includes(native));assert(rendered(result).includes(rules));for(const name of ['tool:read','tool:pwsh','tool:jobs'])assert.equal(result.sections.find(s=>s.name===name),original.sections.find(s=>s.name===name));assert.equal(result.contexts,original.contexts);
 const template=withoutDshIdentity(sample('You are a coding agent powered by the {{model}} model.\r\nKeep tool results factual.'));assert(rendered(template).includes('Keep tool results factual.'));assert(!rendered(template).includes('coding agent'));
});
test('quoted user or persona text and tool descriptions are not globally rewritten',()=>{
 const original={sections:[{name:'wechatagent:fixed-window-prefix',text:'人设引用：\n'+native+'\n'+coding},{name:'tool:example',text:native},{name:'deployment:persona-prefix',text:'Quote: '+coding}],tools:[],contexts:[]};assert.equal(withoutDshIdentity(original),original);assert.equal(withoutDshIdentity(null),null);const old={sections:['legacy identity'],tools:[]};assert.equal(withoutDshIdentity(old),old);
});
test('the WeChat-scoped middleware filters after other providers without changing authorizations',async()=>{
 let hook,options,guard;const scope={ctx:{[guardPolicy]:{names:()=>new Set(['read']),check:name=>name==='read'}}},context={tools:{presentAs(){},guard(fn){guard=fn;}},on(name,fn,value){assert.equal(name,'system-prompt/assemble');hook=fn;options=value;}};
 apply(context);apply(context);assert.equal(options.global,undefined);assert.equal(options.prepend,true);const original=sample(coding),result=await hook({}, {scope},async()=>original);assert(!rendered(result).includes(native));assert(!rendered(result).includes(coding));assert.deepEqual(result.tools.map(tool=>tool.name),['read']);assert.equal(result.contexts,original.contexts);assert.equal(guard({agent:scope,name:'read'}),undefined);assert.equal(typeof guard({agent:scope,name:'pwsh'}),'string');assert(rendered(original).includes(native),'the shared/global assembly must stay untouched');
});
test('both native WeChat presets and selected standard assistants mount the scoped guard',()=>{
 const preset=fs.readFileSync('packages/dsh-social-bridge-plugin/assistant-preset.mjs','utf8'),nativeContext=fs.readFileSync('packages/dsh-social-bridge-plugin/native-context.mjs','utf8'),patch=fs.readFileSync('packages/dsh-social-bridge-plugin/cordis.patch.yml','utf8');assert(preset.includes('social-tool-restrict.mjs'));assert(patch.includes('id: social-tool-restrict'));assert(nativeContext.includes("preset!==ASSISTANT_PRESET)applyAssistantToolGuard(agentCtx)"));assert(nativeContext.includes('applyAssistantToolGuard(agent.ctx)'));assert(!nativeContext.includes('includeHarnessIdentity:false'));
});
