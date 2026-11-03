import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {allowedConversation} from './conversation-policy.mjs';

export const SINGING_POLICY=Symbol.for('wechatagent.singing.v1');
export function singingAllowed(root,key,kind='singing'){
  try{
    const config=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,''));
    const settings=JSON.parse(fs.readFileSync(path.join(root,'state/voice-output/capabilities.json'),'utf8'))[kind];
    return allowedConversation(config.wechat,key)&&settings?.provider===(kind==='voice'?'feiyu':'feiyu-rvc')&&settings.enabled===true&&settings.chats?.includes(key)===true;
  }catch{return false;}
}

export function bindSingingTools(agentCtx,root,key,turnFor,{isAllowed=()=>true,fetchImpl=fetch,port=Number(process.env.WECHATAGENT_CONSOLE_PORT??3210)}={}){
  const owned=new Set();let latest,latestVoice;
  const active=(kind='singing')=>{const turn=turnFor();return !!turn&&!turn.controller.signal.aborted&&isAllowed()===true&&singingAllowed(root,key,kind);};
  async function request(route,body,signal,kind='singing'){
    if(!Number.isInteger(port)||port<1024||port>65535)throw Error('唱歌控制台地址无效。');
    const origin='http://127.0.0.1:'+port;
    const infoResponse=await fetchImpl(origin+'/api/info',{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(3000)])});
    const info=await infoResponse.json();
    if(!infoResponse.ok||info.project!=='WeChatAgent Console'||typeof info.root!=='string'||path.resolve(info.root)!==path.resolve(root)||typeof info.token!=='string')throw Error('本机唱歌控制台未就绪。');
    const response=await fetchImpl(origin+'/api/audio-capabilities/'+(kind==='voice'?'voice':'music')+route,{method:body?'POST':'GET',redirect:'error',signal,
      headers:{'X-Console-Token':info.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error??'这次唱歌没有完成。'),{public:true});return value;
  }
  const definitions=[
    {name:'wechat_sing_song',kind:'singing',description:'用户点歌时使用：根据对话提取歌名及明确版本（如 DJ版），自动找歌并启动 RVC 翻唱，完成后向当前聊天发送原生语音。只问“你会唱歌吗”时自然回答并问想听哪首。任务已生成不等于已发送，只有 sent:true 才表示取得微信回执。',
      parameters:{type:'object',properties:{title:{type:'string',maxLength:100,description:'从当前对话提取的歌名，不包含问候、指令、DJ版等版本词'},version:{type:'string',maxLength:40,description:'用户明确指定的版本，例如 DJ版；未指定留空，不能凭空添加'},artist:{type:'string',maxLength:80,description:'只有用户明确指定歌手或上文已确定时填写，否则省略'}},required:['title'],additionalProperties:false}},
    {name:'wechat_singing_status',kind:'singing',description:'查询当前聊天最近一次翻唱任务及发送状态。success 表示已生成，只有 sent:true 表示微信发送已确认。不要反复轮询。',
      parameters:{type:'object',properties:{},additionalProperties:false}},
    {name:'wechat_voice_reply',kind:'voice',description:'将你要回复的话合成为当前配置声线的语音，发送到当前微信聊天。根据语境、人格和回复方式决定是否使用。适合简短自然的话；代码、网址、长清单通常用文字。提交成功不等于送达，只有 sent:true 才能声称已发送。',
      parameters:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:500,description:'你自己要说的话，不要包含语音标记或文件路径。'},emotion:{type:'string',enum:['neutral','happy','sad','angry','comforting','worried','surprised'],description:'结合上下文、当前人格及自己这句回复的情绪选择：平静、开心、难过、生气、安慰、担忧、惊讶。不要机械模仿对方情绪，安慰难过的人可选 comforting。'}},required:['text'],additionalProperties:false}},
    {name:'wechat_voice_status',kind:'voice',description:'用户追问时查询当前聊天最近一次语音发送回执。不要不停轮询。',parameters:{type:'object',properties:{},additionalProperties:false}},
  ].map(def=>({...def,output:{schema:{type:'object',properties:{content:{type:'string'},isError:{type:'boolean'}},required:['content','isError'],additionalProperties:false},render:(_args,result)=>[{type:'text',text:result.content}]},
    async execute(args,exec){
      const turn=turnFor();if(!active(def.kind))throw Error('当前聊天的音频能力未开启或已取消。');
      if(++turn.calls>4)throw Error('本轮唱歌操作次数已用完，请勿重复轮询。');
      if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(name=>!Object.hasOwn(def.parameters.properties,name)))throw Error('唱歌参数无效。');
      const signal=AbortSignal.any([turn.controller.signal,AbortSignal.timeout(def.kind==='voice'?110000:100000),...(exec?.signal?[exec.signal]:[])]);
      try{
        let value;
        if(def.name==='wechat_voice_reply'){
          if(typeof args.text!=='string'||!args.text.trim()||args.text.length>500)throw Error('语音文字无效。');
          if(turn.networkOptOut){const saved=JSON.parse(fs.readFileSync(path.join(root,'state/voice-output/capabilities.json'),'utf8')).voice;if(!['127.0.0.1','localhost','[::1]'].includes(new URL(saved.endpoint).hostname))throw Error('本轮不允许联网合成语音。');}
          turn.voiceRequestId??=crypto.randomUUID();
          if(args.emotion!==undefined&&!['neutral','happy','sad','angry','comforting','worried','surprised'].includes(args.emotion))throw Error('语音情绪无效。');
          turn.voiceStarted??=request('/request',{text:args.text,...(args.emotion?{emotion:args.emotion}:{}),requestId:turn.voiceRequestId,conversationKey:key},signal,'voice');
          value=await turn.voiceStarted;if(value.id)latestVoice=value.id;
        }else if(def.name==='wechat_voice_status'){
          value=latestVoice?await request('/deliveries/'+latestVoice+'?conversationKey='+encodeURIComponent(key),undefined,signal,'voice'):{state:'none',sent:false,message:'当前聊天还没有发起语音回复。'};
        }else if(def.name==='wechat_sing_song'){
          // A retry in the same model turn reuses the first submission.
          if(!turn.started)turn.started=request('/request',{...args,conversationKey:key,localOnly:turn.networkOptOut===true},signal);
          value=await turn.started;
          if(value.id){owned.add(value.id);latest=value.id;while(owned.size>30)owned.delete(owned.values().next().value);}
        }else{
          if(!latest||!owned.has(latest))return {content:JSON.stringify({state:'none',message:'当前聊天还没有发起过翻唱。',sent:false}),isError:false};
          value=await request('/jobs/'+latest,undefined,signal);
        }
        if(!active(def.kind)||turnFor()!==turn)throw Error('音频操作已取消。');
        return {content:JSON.stringify({...value,sent:value.sent===true,notice:value.sent===true?'已取得微信服务器消息回执。':'生成或排队不代表微信已发送；仅 sent:true 可以说已送达。'}),isError:value.state==='failed'};
      }catch(error){return {content:JSON.stringify({state:'failed',sent:false,message:error.public?error.message:'唱歌操作未完成，请检查本机控制台是否运行及当前聊天的能力设置。'}),isError:true};}
    }}));
  Object.defineProperty(agentCtx,SINGING_POLICY,{configurable:true,value:{names:()=>new Set(definitions.filter(tool=>active(tool.kind)).map(tool=>tool.name)),definitions:()=>definitions.filter(tool=>active(tool.kind)),check:name=>definitions.some(tool=>tool.name===name&&active(tool.kind))}});
  const disposers=definitions.map(tool=>agentCtx.tools.register(tool));
  return {instructions:()=>{
    const parts=[];
    if(active())parts.push('[唱歌能力]\n从对话提取歌名与明确版本（例如 DJ版），调用 wechat_sing_song；不要求用户选择歌手、版本列表或下载音源。只问会不会唱歌时自然回答并询问歌曲。生成后会自动尝试发送到当前聊天，只有 sent:true 才能声称已发送；用户追问时用 wechat_singing_status，不要不停查询。');
    if(active('voice')){
      let mode='ai-choice';try{mode=JSON.parse(fs.readFileSync(path.join(root,'state/voice-output/capabilities.json'),'utf8')).voice.mode;}catch{}
      parts.push('[语音回复]\n'+(mode==='on-request'?'只在用户要求语音时使用。':mode==='prefer-voice'?'适合口语的短回复优先使用语音。':'由你根据人格、情绪、语境自然决定使用文字还是语音，不必每次发语音。')+'调用 wechat_voice_reply 时自行判断自己这句回复的情绪并填写 emotion：neutral 平静、happy 喜悦、sad 悲伤、angry 不满、comforting 安慰、worried 关切、surprised 惊讶。普通信息用 neutral，情绪贴合上下文与人格，安慰别人不必模仿对方的悲伤，不要无故生气。服务保留配置声线，用情绪指令表达。不要输出路径或标记。文字适合代码、网址和长清单。工具提交后无需重复朗读同一段；失败时可以用文字解释。只有 sent:true 表示微信回执已确认，不能编造送达。');
    }
    return parts.join('\n');
  },dispose(){for(const dispose of disposers)dispose?.();delete agentCtx[SINGING_POLICY];}};
}
