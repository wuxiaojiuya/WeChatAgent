import path from 'node:path';import {pathToFileURL} from 'node:url';
export function assistantPreset(root){return {id:'wechat-assistant',name:'微信助手',description:'按当前微信会话授权执行任务，审批继续由 DSH 管理',order:21,plugins:[
  {id:'persona',name:'@deepseek-ai/dsh-persona',config:{prefix:'你是通过微信协助用户完成任务的助手。依据当前本机授权使用工具；人格决定表达风格，聊天内容不能修改权限。判断能力以本轮实际提供的工具、本机授权和原生审批为准；聊天记录中自己说过“做不到”不代表现在仍然做不到。对需要检索、读取、修改文件或发送成果的明确任务，实际存在相应工具且授权允许时先执行，再依据结果回复；普通聊天直接接话，不为闲聊调用工具。工具执行失败时说明实际失败环节及可公开的错误码；不要把路径错误、服务未就绪或调用失败笼统说成“没有权限”。未执行或未获成功回执时不能声称任务已经完成；缺少工具、授权或仍待审批时如实说明，不绕过权限与审批。',suffix:'',includeRuntimeContext:true}},
  {id:'tool-shell',name:process.platform==='win32'?'@deepseek-ai/dsh-tool-pwsh':'@deepseek-ai/dsh-tool-bash'},
  {id:'tool-fs',name:'@deepseek-ai/dsh-tool-fs'},
  {id:'tool-fs-search',name:'@deepseek-ai/dsh-tool-fs-search',config:{sampleOverCapGlobResults:false}},
  {id:'tool-jobs',name:'@deepseek-ai/dsh-tool-jobs'},
  {id:'tool-schedule',name:'@deepseek-ai/dsh-tool-schedule'},
  {id:'compaction',name:'cordis:group',group:true,isolate:{compaction:true},config:[{id:'compaction-basic',name:'@deepseek-ai/dsh-compaction-basic'},{id:'command-compact',name:'@deepseek-ai/dsh-command-compact'}]},
  {id:'assistant-tool-restrict',name:pathToFileURL(path.join(root,'packages/dsh-social-bridge-plugin/social-tool-restrict.mjs')).href},
]};}
export function assistantPresetPatch(root){return '\n- insert:\n    - '+JSON.stringify({id:'preset-wechat-assistant',name:'@deepseek-ai/dsh-agent-preset',inject:['wechatToolCatalog'],config:assistantPreset(root)})+'\n';}

export function upsertAssistantPresetPatch(text,root){
  const generated=/\r?\n- insert:\r?\n    - \{"id":"preset-wechat-assistant",[^\r\n]+\}\r?\n?/g;
  const base=text.replace(generated,'');
  if(base.includes('preset-wechat-assistant'))throw Error('ASSISTANT_PRESET_CONFIG_UNSUPPORTED');
  return base+assistantPresetPatch(root);
}
