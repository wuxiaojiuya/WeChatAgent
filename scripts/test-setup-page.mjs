import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/console/console.js', import.meta.url), 'utf8');
function declaration(name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0);
  const rest = source.slice(start);
  const next = /\n(?:async )?function /.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

test('first setup renders a browsable WeChat path from the saved draft with a save action before launch', () => {
  const config = {hook:{backend:'supplier-http',expectedVersion:'4.1.8.27',wechatExecutable:'D:\\微信\\Weixin.exe'}};
  const state = {config, draft:structuredClone(config), reader:{verified:false}};
  state.draft.hook.wechatExecutable = 'E:\\微信 & 测试\\Weixin.exe';
  const before = JSON.stringify(state);
  const escapeHtml = value => String(value??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const context = vm.createContext({state,escapeHtml,getPath:(value,key)=>key.split('.').reduce((v,k)=>v?.[k],value),
    header:title=>'<h2>'+title+'</h2>',icon:()=>'',dshInstallCard:()=>'',pluginPathField:()=>''});
  const html = vm.runInContext([declaration('field'),declaration('readerConfigurationCard'),declaration('setupPage'),'setupPage()'].join('\n'),context);
  assert.match(html,/微信程序位置/);
  assert.equal([...html.matchAll(/data-path="hook.wechatExecutable"/g)].length,1);
  assert.match(html,/data-browse="exe" data-target="field-hook-wechatExecutable"/);
  assert.match(html,/E:\\微信 &amp; 测试\\Weixin.exe/);
  const save = html.indexOf('data-layout-control="save-button"');
  assert(save > 0 && save < html.indexOf('data-action="wechat-open"'));
  assert(!html.includes('data-path="hook.baseUrl"'));
  assert(!html.includes('data-path="hook.sourceDirectory"'));
  assert.equal(JSON.stringify(state),before);
});
