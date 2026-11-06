import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {allowedConversation} from './conversation-policy.mjs';
const {performanceSchema,validatePerformance}=await import(new URL('./singing-performance.mjs'+new URL(import.meta.url).search,import.meta.url));
const {consolePort}=await import(new URL('./console-client.mjs'+new URL(import.meta.url).search,import.meta.url));

export const SINGING_POLICY=Symbol.for('wechatagent.singing.v1');
export function voiceReplyOutcome(text,turn){
  const outcome=turn?.voiceOutcome;
  if(!outcome||outcome.sent===true)return text;
  if(outcome.state==='unconfirmed')return 'RESPOND: 这条语音的送达情况还没确认，我先不重复发送。';
  if(outcome.code==='VOICE_PREVIOUS_DELIVERY_UNCONFIRMED')return 'RESPOND: 上一条语音还在等待发送确认，这次暂时没发出去，稍后再试。';
  if(['failed','none','closed-unconfirmed'].includes(outcome.state))return 'RESPOND: 这次语音没发出去，语音服务或发送环节出了问题。';
  return 'RESPOND: 语音还在处理中，暂时没有确认发出。';
}
export function singingReplyOutcome(text,turn){
  const outcome=turn?.singingOutcome;
  if(!outcome||outcome.sent===true)return text;
  if(outcome.state==='failed')return 'RESPOND: 这次翻唱生成失败了，还没有发出音频。';
  if(outcome.state==='none')return 'RESPOND: 当前没有已启动的翻唱任务，还没有生成音频。';
  if(outcome.state==='unconfirmed'||outcome.deliveryState==='unconfirmed')return 'RESPOND: 这次翻唱的处理或送达结果还没确认，我先不重复提交。';
  if(outcome.deliveryState==='failed')return 'RESPOND: 翻唱已生成，但微信发送失败了，还没有确认送达。';
  if(outcome.state==='success')return 'RESPOND: 翻唱已生成，正在等待微信发送结果，还没有确认送达。';
  return text;
}
export function singingAllowed(root,key,kind='singing'){
  try{
    const config=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,''));
    const settings=JSON.parse(fs.readFileSync(path.join(root,'state/voice-output/capabilities.json'),'utf8'))[kind];
    return allowedConversation(config.wechat,key)&&settings?.provider===(kind==='voice'?'feiyu':'feiyu-rvc')&&settings.enabled===true&&settings.chats?.includes(key)===true;
  }catch{return false;}
}

export function bindSingingTools(agentCtx,root,key,turnFor,{isAllowed=()=>true,fetchImpl=fetch,port}={}){
  const owned=new Set();let latest,latestVoice;
  const active=(kind='singing')=>{const turn=turnFor();return !!turn&&!turn.controller.signal.aborted&&isAllowed()===true&&singingAllowed(root,key,kind);};
  async function request(route,body,signal,kind='singing'){
    const currentPort=consolePort(root,port),label=kind==='voice'?'语音':'唱歌';
    if(!Number.isInteger(currentPort)||currentPort<1024||currentPort>65535)throw Object.assign(Error(label+'控制台地址无效。'),{public:true});
    const origin='http://127.0.0.1:'+currentPort;
    let infoResponse;
    try{infoResponse=await fetchImpl(origin+'/api/info',{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(3000)])});}
    catch{throw Object.assign(Error('本机'+label+'控制台连接失败，请确认项目页面正在运行。'),{public:true});}
    const info=await infoResponse.json();
    if(!infoResponse.ok||info.project!=='WeChatAgent Console'||typeof info.root!=='string'||path.resolve(info.root)!==path.resolve(root)||typeof info.token!=='string')throw Object.assign(Error('本机'+label+'控制台未就绪或项目不匹配。'),{public:true});
    let response,value;
    try{
      response=await fetchImpl(origin+'/api/audio-capabilities/'+(kind==='voice'?'voice':'music')+route,{method:body?'POST':'GET',redirect:'error',signal,
        headers:{'X-Console-Token':info.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      value=await response.json();
    }catch(error){
      if(kind==='voice')throw Object.assign(Error('语音请求的最终结果未能确认，请先检查发送状态，不要重复提交。'),{public:true,code:'VOICE_REQUEST_UNCONFIRMED'});
      throw error;
    }
    if(!response.ok)throw Object.assign(Error(value.error??'这次'+label+'没有完成。'),{public:true,...(/^VOICE_[A-Z0-9_]{1,64}$/.test(value.code??'')?{code:value.code}:{})});return value;
  }
  const definitions=[
    {name:'wechat_analyze_singing',kind:'singing',description:'唱参考视频之前必须先调用：取得已验证音轨，分离人声与伴奏，测量节拍、分句、音高、力度和起音密度。结合本轮画面、转写、人格与用户要求决定自己的演绎，再调用 wechat_sing_video 提交可执行编排。声学估计不能证明具体情绪、真假声或唱腔；不要声称已学会或唱出。分析不生成演唱、不发送微信。',
      parameters:{type:'object',properties:{videoId:{type:'string',pattern:'^[a-f0-9]{64}$'},startSeconds:{type:'number',minimum:0,maximum:14400},seconds:{type:'integer',minimum:10,maximum:30}},required:['videoId'],additionalProperties:false}},
    {name:'wechat_sing_song',kind:'singing',description:'用户点歌时使用：根据对话提取歌名及明确版本（如 DJ版），自动找歌并分析歌词、旋律、节奏和分句，由 AI 结合人格和 direction 自主编排，SoulX 按谱重新演唱、所选 .pth 统一音色、混入伴奏，完成后向当前聊天发送原生语音。不会直接把原唱换音。CPU 处理需数分钟。只问“你会唱歌吗”时自然回答并问想听哪首。任务已生成不等于已发送，只有 sent:true 才表示取得微信回执。',
      parameters:{type:'object',properties:{title:{type:'string',maxLength:100,description:'从当前对话提取的歌名，不包含问候、指令、DJ版等版本词'},version:{type:'string',maxLength:40,description:'用户明确指定的版本，例如 DJ版；未指定留空，不能凭空添加'},artist:{type:'string',maxLength:80,description:'只有用户明确指定歌手或上文已确定时填写，否则省略'},direction:{type:'string',maxLength:240,description:'结合当前对话简述自己的演绎意图或用户希望的情绪；未确定可省略，由后台 AI 结合真实音轨与人格编排。'}},required:['title'],additionalProperties:false}},
    {name:'wechat_singing_status',kind:'singing',description:'查询当前聊天最近一次翻唱任务及发送状态。success 表示已生成，只有 sent:true 表示微信发送已确认。不要反复轮询。',
      parameters:{type:'object',properties:{},additionalProperties:false}},
    {name:'wechat_sing_video',kind:'singing',description:'先完成 wechat_analyze_singing，再结合画面、音轨测量、歌词和人格编排自己的演唱。SoulX 按音符及重新安排的咬字/休止时值演唱，所选 .pth 统一音色，执行分句力度后混入参考伴奏。保留歌曲旋律，避免照搬参考 F0 细节。最多30秒。仅 sent:true 才表示已发送。',
      parameters:{type:'object',properties:{videoId:{type:'string',pattern:'^[a-f0-9]{64}$',description:'本轮视频引用 ID'},referenceId:{type:'string',description:'本轮 wechat_analyze_singing 成功返回的 referenceId'},performance:performanceSchema},required:['videoId','referenceId','performance'],additionalProperties:false}},
    {name:'wechat_voice_reply',kind:'voice',description:'将你要回复的话合成为当前配置声线的语音，发送到当前微信聊天。根据语境、人格和回复方式决定是否使用。通常用一两句简短自然的话，本地 CPU 合成较慢；代码、网址、长清单通常用文字。工具返回最终发送状态，只有 sent:true 才能声称已发送。',
      parameters:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:500,description:'你自己要说的话，不要包含语音标记或文件路径。'},emotion:{type:'string',enum:['neutral','happy','sad','angry','comforting','worried','surprised'],description:'结合上下文、当前人格及自己这句回复的情绪选择：平静、开心、难过、生气、安慰、担忧、惊讶。不要机械模仿对方情绪，安慰难过的人可选 comforting。'}},required:['text'],additionalProperties:false}},
    {name:'wechat_voice_status',kind:'voice',description:'用户追问时查询当前聊天最近一次语音发送回执。不要不停轮询。',parameters:{type:'object',properties:{},additionalProperties:false}},
  ].map(def=>({...def,output:{schema:{type:'object',properties:{content:{type:'string'},isError:{type:'boolean'}},required:['content','isError'],additionalProperties:false},render:(_args,result)=>[{type:'text',text:result.content}]},
    async execute(args,exec){
      const turn=turnFor();if(!active(def.kind))throw Error('当前聊天的音频能力未开启或已取消。');
      if(++turn.calls>4)throw Error('本轮唱歌操作次数已用完，请勿重复轮询。');
      if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(name=>!Object.hasOwn(def.parameters.properties,name)))throw Error('唱歌参数无效。');
      const signal=AbortSignal.any([turn.controller.signal,AbortSignal.timeout(def.kind==='voice'?300000:def.name==='wechat_analyze_singing'?160000:100000),...(exec?.signal?[exec.signal]:[])]);
      try{
        let value;
        if(def.name==='wechat_voice_reply'){
          turn.voiceOutcome={state:'preparing',sent:false};
          if(!turn.voiceStarted)turn.onVoiceStart?.();
          if(typeof args.text!=='string'||!args.text.trim()||args.text.length>500)throw Error('语音文字无效。');
          if(turn.networkOptOut){const saved=JSON.parse(fs.readFileSync(path.join(root,'state/voice-output/capabilities.json'),'utf8')).voice;if(!['127.0.0.1','localhost','[::1]'].includes(new URL(saved.endpoint).hostname))throw Error('本轮不允许联网合成语音。');}
          turn.voiceRequestId??=crypto.randomUUID();
          if(args.emotion!==undefined&&!['neutral','happy','sad','angry','comforting','worried','surprised'].includes(args.emotion))throw Error('语音情绪无效。');
          turn.voiceStarted??=request('/request',{text:args.text,...(args.emotion?{emotion:args.emotion}:{}),requestId:turn.voiceRequestId,conversationKey:key},signal,'voice');
          value=await turn.voiceStarted;if(value.id)latestVoice=value.id;
        }else if(def.name==='wechat_voice_status'){
          value=latestVoice?await request('/deliveries/'+latestVoice+'?conversationKey='+encodeURIComponent(key),undefined,signal,'voice'):{state:'none',sent:false,message:'当前聊天还没有发起语音回复。'};
        }else if(def.name==='wechat_analyze_singing'){
          if(!turn.videos?.some(video=>video.id===args.videoId))throw Object.assign(Error('本轮没有这个视频引用，请发送或引用需要参考的视频。'),{public:true});
          if(args.startSeconds!==undefined&&(!Number.isFinite(args.startSeconds)||args.startSeconds<0||args.startSeconds>14400)||args.seconds!==undefined&&(!Number.isInteger(args.seconds)||args.seconds<10||args.seconds>30))throw Object.assign(Error('视频片段参数无效。'),{public:true});
          turn.onReferenceStart?.();
          turn.referenceRequests??=new Map();
          const fingerprint=JSON.stringify([args.videoId,args.startSeconds??0,args.seconds??null]);
          if(!turn.referenceRequests.has(fingerprint))turn.referenceRequests.set(fingerprint,request('/video-reference',{...args,conversationKey:key,localOnly:turn.networkOptOut===true},signal));
          value=await turn.referenceRequests.get(fingerprint);
          if(typeof value.referenceId!=='string'||value.videoId!==args.videoId||!Number.isFinite(value.seconds)||value.seconds<=0||value.seconds>30||!value.analysis?.phrases?.length)throw Object.assign(Error('视频音轨分析未完成。'),{public:true});
          turn.references??=new Map();turn.references.set(value.referenceId,{...value,localOnly:turn.networkOptOut===true});
        }else if(def.name==='wechat_sing_video'){
          if(!turn.videos?.some(video=>video.id===args.videoId))throw Object.assign(Error('本轮没有这个视频引用，请直接发送或引用要翻唱的视频。'),{public:true});
          const reference=turn.references?.get(args.referenceId);
          if(!reference||reference.videoId!==args.videoId)throw Object.assign(Error('请先分析本轮对应的视频音轨，再编排自己的演唱方式。'),{public:true});
          const performance=validatePerformance(args.performance,reference.seconds);
          turn.started??=request('/video-request',{videoId:args.videoId,referenceId:args.referenceId,performance,startSeconds:reference.startSeconds,conversationKey:key,localOnly:turn.networkOptOut===true},signal);
          value=await turn.started;
          if(value.id){owned.add(value.id);latest=value.id;while(owned.size>30)owned.delete(owned.values().next().value);}
        }else if(def.name==='wechat_sing_song'){
          // A retry in the same model turn reuses the first submission.
          if(!turn.started)turn.started=request('/request',{...args,conversationKey:key,localOnly:turn.networkOptOut===true},signal);
          value=await turn.started;
          if(value.id){owned.add(value.id);latest=value.id;while(owned.size>30)owned.delete(owned.values().next().value);}
        }else{
          value=latest&&owned.has(latest)?await request('/jobs/'+latest,undefined,signal):{state:'none',message:'当前聊天还没有发起过翻唱。',sent:false};
        }
        if(def.kind==='voice')turn.voiceOutcome={state:value.state,sent:value.sent===true,code:value.code};
        else if(def.name!=='wechat_analyze_singing')turn.singingOutcome={state:value.state,sent:value.sent===true,deliveryState:value.delivery?.state};
        if(!active(def.kind)||turnFor()!==turn)throw Error('音频操作已取消。');
        return {content:JSON.stringify({...value,sent:value.sent===true,notice:def.name==='wechat_analyze_singing'?'音轨已分析，尚未生成或发送演唱。请结合画面、转写和人格提交自己的演唱编排。':value.sent===true?'已取得微信服务器消息回执。':'生成或排队不代表微信已发送；仅 sent:true 可以说已送达。'}),isError:value.state==='failed'};
      }catch(error){
        const state=error.code==='VOICE_REQUEST_UNCONFIRMED'?'unconfirmed':'failed',code=/^VOICE_[A-Z0-9_]{1,64}$/.test(error.code??'')?error.code:undefined;
        if(def.kind==='voice'&&turn.voiceOutcome?.sent!==true)turn.voiceOutcome={state,sent:false,code};
        if(def.kind==='singing'&&turn.singingOutcome?.sent!==true)turn.singingOutcome={state,sent:false};
        return {content:JSON.stringify({state,sent:false,...(code?{code}:{}),message:error.public?error.message:(def.kind==='voice'?'语音':'唱歌')+'操作未完成，请检查本机控制台是否运行及当前聊天的能力设置。'}),isError:true};
      }
    }}));
  const available=tool=>active(tool.kind)&&(!['wechat_sing_video','wechat_analyze_singing'].includes(tool.name)||turnFor()?.videos?.length>0);
  Object.defineProperty(agentCtx,SINGING_POLICY,{configurable:true,value:{names:()=>new Set(definitions.filter(available).map(tool=>tool.name)),definitions:()=>definitions.filter(available),check:name=>definitions.some(tool=>tool.name===name&&available(tool))}});
  const disposers=definitions.map(tool=>agentCtx.tools.register(tool));
  return {instructions:()=>{
    const parts=[];
    if(active())parts.push('[唱歌能力]\n从对话提取歌名与明确版本（例如 DJ版），调用 wechat_sing_song，并可用 direction 简述结合语境的演绎意图。后台会分析真实歌词、谱面与节奏，由 AI 结合人格自主编排，SoulX 按谱重新演唱、RVC 统一音色、混入伴奏；原唱仅作分析参考，不直接换音；分析或编排失败不会回退旧方式。不要求用户选择歌手、版本列表或下载音源。只问会不会唱歌时自然回答并询问歌曲。生成后会自动尝试发送到当前聊天，只有 sent:true 才能声称已发送；用户追问时用 wechat_singing_status，不要不停查询。state:failed 必须说明生成失败，不能说正在录制、正在处理或即将出片；只有成功启动任务才能报告进度，查询不会重新启动任务。');
    if(active()&&turnFor()?.videos?.length)parts.push('[视频参考演唱]\n本轮可用视频引用：'+turnFor().videos.map(video=>video.id).join('、')+'。用户说“看视频，学着这样唱”等时：先理解已经提供的画面和转写；调用 wechat_analyze_singing 直接使用对应视频音轨取得声学证据；再结合人格、用户意图及测量结果，自主决定情绪与分句演唱编排，调用 wechat_sing_video。不能跳过分析、把参考直接换音或换成同名歌曲。performance 的 intention 简要说明自己的演绎；分句时间必须取当前片段范围，可参考 analysis.phrases，互不重叠；articulation 决定咬字衔接，timingMs 轻微提前/延后，tail 句尾收放，gainDb 与 contour 决定轻重和渐强渐弱。不要全部机械套同一个预设，根据情绪推进安排，但变化应克制。程序会按音符重新生成唱腔，不能保证复刻气声、哭腔、嘶吼或转音，不声称已经训练或永久学会。保留歌曲旋律与伴奏，使用配置 RVC 音色。仅有采样帧/转写时不声称看完全部或听懂所有唱腔；缺失证据如实说明。分析本身不会启动演唱或发送音频。');
    if(active('voice')){
      let mode='ai-choice';try{mode=JSON.parse(fs.readFileSync(path.join(root,'state/voice-output/capabilities.json'),'utf8')).voice.mode;}catch{}
      parts.push('[语音回复]\n'+(mode==='on-request'?'只在用户要求语音时使用。':mode==='prefer-voice'?'适合口语的短回复优先使用语音。':'由你根据人格、情绪、语境自然决定使用文字还是语音，不必每次发语音。')+'调用 wechat_voice_reply 时自行判断自己这句回复的情绪并填写 emotion：neutral 平静、happy 喜悦、sad 悲伤、angry 不满、comforting 安慰、worried 关切、surprised 惊讶。普通信息用 neutral，情绪贴合上下文与人格，安慰别人不必模仿对方的悲伤，不要无故生气。服务保留配置声线，用情绪指令表达。不要输出路径或标记。文字适合代码、网址和长清单。工具提交后无需重复朗读同一段；失败时可以用文字解释。只有 sent:true 表示微信回执已确认，不能编造送达。');
    }
    return parts.join('\n');
  },dispose(){for(const dispose of disposers)dispose?.();delete agentCtx[SINGING_POLICY];}};
}
