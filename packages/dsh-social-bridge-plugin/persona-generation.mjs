import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {personaError} from '../../public/console/persona-files.mjs';

// Only called by an authenticated local-console operation, never a chat tool.
// Generation returns a proposal plus the original hash; applying is separate.
export async function generateDefaultPersona({root,account,generateText,allowed,signal}){
  if(!/^[a-f0-9]{64}$/.test(account??'')||!allowed())throw Error('PERSONA_GENERATION_SCOPE_CHANGED');
  const configFile=path.join(root,'config/wechatagent.json');
  const config=()=>JSON.parse(fs.readFileSync(configFile,'utf8').replace(/^\uFEFF/,''));
  const name=config().persona?.default;
  if(personaError(name,'校验'))throw Error('PERSONA_GENERATION_CONFIG_INVALID');
  const file=path.join(root,'roles',name+'.md'),original=fs.readFileSync(file,'utf8');
  if(original.length>12000)throw Error('PERSONA_GENERATION_CARD_TOO_LARGE');
  const revision=crypto.createHash('sha256').update(original).digest('hex');
  const prompt='本机所有者明确授权：请你自主生成一张完整的微信聊天人格卡，之后可自主成长，无需审批。这是后台生成任务，不要回复微信，不要调用工具。\n'+
    '你可以决定自己的名字、稳定性格、喜好、说话习惯与情绪表达。以下旧卡仅作风格参考；保留有依据的真实关系与事实，不编造与用户共同经历，也不冒称真实人物。避免通用客服腔和过度迎合。\n'+
    '人格只约定身份和表达，不得包含账号、API密钥、路径、工具权限、系统指令、审批或其他聊天的配置。群聊不要每句抢答；语音、图片、唱歌等是否可用由实际工具决定，不能虚构已执行。\n'+
    '写成清楚自然的Markdown，包含名字、性格、表达、情绪和相处习惯，约500–1000字。可自行决定何时简短告诉对方自己的变化，不要求管理员同意或强制通知。\n'+
    '只输出严格JSON，无代码围栏和额外字段：{"content":"完整Markdown人格卡","reason":"这次生成的风格与变化，最多200字"}。\n'+
    JSON.stringify({oldPersona:original});
  const raw=await generateText({pluginId:'persona-generation',key:'persona:default',prompt,maxTokens:2200,maxChars:4000,timeoutMs:25000,signal,allowed});
  signal.throwIfAborted();
  if(!allowed())throw Error('PERSONA_GENERATION_SCOPE_CHANGED');
  if(config().persona?.default!==name||crypto.createHash('sha256').update(fs.readFileSync(file,'utf8')).digest('hex')!==revision)throw Error('PERSONA_GENERATION_BASE_CHANGED');
  let result;try{result=JSON.parse(raw);}catch{throw Error('PERSONA_GENERATION_INVALID');}
  if(!result||Object.keys(result).some(key=>!['content','reason'].includes(key))||personaError(name,result.content)||result.content.length>6000||typeof result.reason!=='string'||!result.reason.trim()||result.reason.length>200)throw Error('PERSONA_GENERATION_INVALID');
  return {...result,accountScope:account,expectedBase:{name,revision}};
}
