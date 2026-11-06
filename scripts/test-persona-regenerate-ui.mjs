import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../public/console/console.js',import.meta.url),'utf8');
const implementation=source.slice(source.indexOf('async function regenerateDefaultPersona(){'),source.indexOf('\nfunction importRole()',source.indexOf('async function regenerateDefaultPersona(){')));
function fixture({duringGenerate=()=>{},applyError}={}){
  const state={roleDrafts:new Map(),roles:[{name:'Original',content:'旧卡'}]},calls=[],toasts=[],button={},generated={content:'新卡',reason:'自己的风格',accountScope:'a'.repeat(64),expectedBase:{name:'Original',revision:'b'.repeat(64)}};
  let renders=0;
  const api=async(route,body)=>{calls.push({route,body});if(route.endsWith('/generate')){duringGenerate(state);return generated;}if(route.endsWith('/apply')){if(applyError)throw Error(applyError);return {state:'applied',message:'默认人格已更新'};}if(route==='/api/roles')return {roles:[{name:'Original',content:'新卡'}],categories:{}};throw Error('unexpected route');};
  const run=new Function('state','roleSaves','configDirty','$','api','personaCategoryUI','renderPage','refreshStatus','toast',implementation+';return regenerateDefaultPersona;')(state,new Map(),()=>false,()=>button,api,{setData(){},reveal(){}},async()=>{renders++;},async()=>{},value=>toasts.push(value));
  return {state,calls,toasts,button,generated,run,get renders(){return renders;}};
}
test('regeneration applies the exact generated card with its original revision and refreshes the editor',async()=>{
  const f=fixture();await f.run();assert.deepEqual(f.calls.map(x=>x.route),['/api/persona/default/generate','/api/persona/default/apply','/api/roles']);assert.equal(f.calls[1].body,f.generated);assert.equal(f.state.selectedRole,'Original');assert.equal(f.state.roles[0].content,'新卡');assert.equal(f.state.personaGenerating,false);assert.equal(f.button.disabled,false);assert.equal(f.renders,1);
});
test('unsaved drafts before or during generation are preserved and never overwritten',async()=>{
  const before=fixture();before.state.roleDrafts.set('Original',{content:'手工草稿'});await before.run();assert.equal(before.calls.length,0);assert.equal(before.state.roleDrafts.get('Original').content,'手工草稿');
  const during=fixture({duringGenerate:state=>state.roleDrafts.set('Original',{content:'刚编辑的新草稿'})});await during.run();assert.equal(during.calls.length,1);assert.equal(during.state.roleDrafts.get('Original').content,'刚编辑的新草稿');assert.match(during.toasts[0],/未覆盖/);
});
test('a revision conflict keeps the original editor and shows the actual error',async()=>{
  const f=fixture({applyError:'默认人格已经改变，未覆盖手动修改。'});await f.run();assert.equal(f.calls.length,2);assert.equal(f.state.roles[0].content,'旧卡');assert.equal(f.renders,0);assert.match(f.toasts[0],/已经改变/);assert.equal(f.button.disabled,false);
});
