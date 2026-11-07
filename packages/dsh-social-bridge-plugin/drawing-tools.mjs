import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {allowedConversation} from './conversation-policy.mjs';
const {consoleClient}=await import(new URL('./console-client.mjs'+new URL(import.meta.url).search,import.meta.url));

export const DRAWING_POLICY=Symbol.for('wechatagent.drawing.v1');
const jobId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const safeMessage=value=>typeof value==='string'&&value.length<=400&&!/[\r\n\0]|https?:\/\/|[A-Z]:[\\/]|[A-Za-z0-9_-]{48,}/i.test(value)?value:undefined;
const apiAcknowledged=d=>d?.state==='api-acknowledged'&&d.sent===true&&d.confirmed===false&&d.apiAcknowledged===true&&d.receipt==='supplier-api'&&d.delivered==='api-acknowledged';
const delivered=job=>job?.delivery?.state==='confirmed'||apiAcknowledged(job?.delivery);
function publicJob(value,key){
  if(!value||!jobId(value.id)||!['queued','running','success','failed','interrupted','cancelled'].includes(value.state)||value.conversationKey!==undefined&&value.conversationKey!==key)throw Error('DRAWING_JOB_INVALID');
  return {id:value.id,state:value.state,...(value.previewOnly===true?{previewOnly:true}:{}),stage:safeMessage(value.stage),error:safeMessage(value.error),sent:delivered(value),
    ...(value.delivery?{delivery:{state:safeMessage(value.delivery.state),sent:delivered(value),confirmed:value.delivery.state==='confirmed',...(apiAcknowledged(value.delivery)?{apiAcknowledged:true,receipt:'supplier-api',delivered:'api-acknowledged'}:{}),...(value.delivery.state==='confirmed'&&['wechat-image-server-id','wechat-message-response'].includes(value.delivery.receipt)?{receipt:value.delivery.receipt}:{})}}:{})};
}
export function drawingReplyOutcome(text,turn){
  const outcome=turn?.drawingOutcome;if(!outcome||outcome.sent===true)return text;
  const body=typeof text==='string'?text.replace(/^\s*RESPOND:\s*/,''):'';
  const claims=body.replace(/(?:还没|没有|没|尚未|无法|不能|未)(?:确认|确定)?(?:成功)?(?:发出|发送|送达|生成|画好|完成)(?:了)?/g,'');
  const successClaim=/(?:已经|刚刚|已)(?:发|发送|发出|送达)|(?:图|图片|画|照片|自拍|形象照)(?:发给你了|发你了|已发|发出)|(?:发送|送达)(?:成功|完成)|(?:发给你|发你|发过去|发出)(?:了|啦|咯)|你(?:看|收下)(?:这张|这幅)/.test(claims);
  const generatedClaim=/(?:已经|刚刚|已)(?:画好|生成|完成)|(?:图|图片|画|照片|自拍|形象照)(?:做好了|画好了)|画好了/.test(claims);
  const progressClaim=/(?:正在|还在|已经开始)(?:画|绘|生成)|(?:绘画|画图|图片|照片|自拍|形象照).{0,8}(?:处理中|生成中|绘制中)/.test(claims);
  // A status read can concern an older image during otherwise normal chat.
  // Correct unsupported claims; do not replace every answer with task status.
  if(outcome.state==='failed'||['interrupted','cancelled'].includes(outcome.state)){
    if(!successClaim&&!generatedClaim&&!progressClaim)return text;
    return 'RESPOND: 这次图片没能生成或发送，'+(outcome.error??'绘画服务处理失败了，请稍后再试。');
  }
  if(outcome.state==='unconfirmed')return !successClaim&&!generatedClaim&&!progressClaim?text:'RESPOND: 这次绘画请求的结果还没确认，我先不重复生成。';
  if(outcome.state==='none')return successClaim||generatedClaim||progressClaim?'RESPOND: 当前聊天没有已启动的绘画任务，还没有生成图片。':text;
  if(outcome.state==='success'){
    if(outcome.delivery?.state==='failed')return !successClaim?text:'RESPOND: 图片已经生成，但微信发送失败了，还没有送达。';
    return !successClaim?text:'RESPOND: 图片已经生成，微信发送结果还没确认。';
  }
  return successClaim||generatedClaim?'RESPOND: 绘画任务已经启动，图片还在处理中，尚未确认发送。':text;
}

export function bindDrawingTools(agentCtx,root,key,turnFor,{isAllowed=()=>true,fetchImpl=fetch,port}={}){
  const request=consoleClient(root,{fetchImpl,port});let latest;
  const scopeAllowed=()=>{try{return isAllowed()===true&&allowedConversation(JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,'' )).wechat,key);}catch{return false;}};
  const active=()=>{const turn=turnFor();return !!turn&&!turn.controller.signal.aborted&&scopeAllowed()&&turn.drawingCapability?.enabled===true;};
  async function refresh({force=false}={}){
    const turn=turnFor();if(!turn||turn.controller.signal.aborted||!scopeAllowed())return false;
    if(!force&&turn.drawingCapabilityPromise)return turn.drawingCapabilityPromise;
    turn.drawingCapabilityPromise=(async()=>{
      try{
        const value=await request('/api/drawing-capability',undefined,{signal:AbortSignal.any([turn.controller.signal,AbortSignal.timeout(3000)])}),settings=value.settings;
        if(turnFor()!==turn||turn.controller.signal.aborted||!scopeAllowed())return false;
        turn.drawingRevision=value.revision;
        turn.drawingCapability={enabled:settings?.enabled===true&&settings?.apiKeyConfigured===true&&Array.isArray(settings.chats)&&settings.chats.includes(key)};
        return turn.drawingCapability.enabled;
      }catch{turn.drawingCapability={enabled:false};return false;}
    })();return turn.drawingCapabilityPromise;
  }
  const definitions=[
    {name:'wechat_draw_image',description:'用户明确要求画图、生成图片，或说“发张你的照片”“给我一张自拍”“让我看看你的样子”时使用。自拍、形象照应结合当前人格与已知外貌生成虚拟角色图片，不声称真实拍照；未指定外貌可合理设计，不必要求用户改说画图。根据当前对话整理完整绘画要求；看图、理解图片、描述内容不等于要求画图，其他需求不清楚先问清。仅生成新图片，不读取本地路径或替用户更改设置。每轮最多提交一次生成，后台异步完成后向当前微信聊天发送图片；必须实际调用工具，不能仅口头承诺已经发图。任务启动或生成成功均不等于送达。超时结果未知时不重复提交，用 wechat_drawing_status 查询。',parameters:{type:'object',properties:{prompt:{type:'string',minLength:1,maxLength:4000,description:'用户请求的完整画面、构图与风格；自拍或形象照结合当前人格和本会话已知外貌，不虚构现实拍摄。不是路径、接口参数或接收者。'}},required:['prompt'],additionalProperties:false}},
    {name:'wechat_drawing_status',description:'用户追问绘画进度或发送问题时，按需查询当前微信聊天的绘画任务及发送状态。可省略 jobId 查询最近任务。只查询，不启动生成；不要连续轮询，只有 sent:true 才表示接口已确认发送。用户说“收到啦”“确认”或发表情时通常是在自然接话，不必再次查询，也不要反复播报未确认。',parameters:{type:'object',properties:{jobId:{type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'}},additionalProperties:false}},
  ].map(def=>({...def,output:{schema:{type:'object',properties:{content:{type:'string'},isError:{type:'boolean'}},required:['content','isError'],additionalProperties:false},render:(_args,value)=>[{type:'text',text:value.content}]},
    async execute(args,exec){
      const turn=turnFor();
      if(!turn||turn.controller.signal.aborted||!scopeAllowed())throw Error('当前聊天未授权使用绘画。');
      const reject=message=>{turn.drawingOutcome??={state:'failed',sent:false,error:message};throw Error(message);};
      if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(name=>!Object.hasOwn(def.parameters.properties,name)))reject('绘画参数无效。');
      if((turn.drawingCalls=(turn.drawingCalls??0)+1)>4)reject('本轮绘画操作次数已用完，请勿重复轮询。');
      if(def.name==='wechat_draw_image'&&(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>4000||args.prompt.includes('\0')))reject('请提供 1～4000 字的绘画要求。');
      if(args.jobId!==undefined&&!jobId(args.jobId))reject('绘画任务编号无效。');
      if(!await refresh({force:true})||turnFor()!==turn||!active()){
        turn.drawingOutcome={state:'failed',sent:false,error:'当前聊天的绘画能力未开启或尚未配置完成。'};
        throw Error('当前聊天的绘画能力未开启或尚未配置完成。');
      }
      const signal=AbortSignal.any([turn.controller.signal,AbortSignal.timeout(12000),...(exec?.signal?[exec.signal]:[])]);
      let submitting=false;
      try{
        let response;
        if(def.name==='wechat_draw_image'){
          if(turn.networkOptOut)throw Object.assign(Error('本轮不允许联网绘画，请允许联网后再试。'),{public:true});
          if(turn.drawingStarted){
            if(turn.drawingPrompt!==args.prompt.trim())return {content:JSON.stringify({job:turn.drawingOutcome??{state:'unconfirmed',sent:false},message:'本轮已经提交过绘画任务，请先等待这张图片的结果，不会生成第二张。'}),isError:true};
          }else{
            turn.drawingPrompt=args.prompt.trim();turn.drawingRequestId??=crypto.randomUUID();submitting=true;
            turn.drawingStarted=request('/api/drawing-capability/generate',{prompt:turn.drawingPrompt,...(turn.previewOnly?{revision:turn.drawingRevision}:{conversationKey:key}),requestId:turn.drawingRequestId,previewOnly:turn.previewOnly===true},{signal});
          }
          submitting=true;response=await turn.drawingStarted;
        }else{
          const id=args.jobId??(turn.previewOnly?turn.drawingLatest:latest);
          if(turn.previewOnly&&!id)response={job:null};
          else response=await request(id?'/api/drawing-capability/jobs/'+id+(turn.previewOnly?'':'?conversationKey='+encodeURIComponent(key)):'/api/drawing-capability/latest?conversationKey='+encodeURIComponent(key),undefined,{signal});
        }
        if(!active()||turnFor()!==turn)throw Error('DRAWING_SCOPE_CHANGED');
        const job=response.job===null?{state:'none',sent:false}:publicJob(response.job,key);
        if(turn.previewOnly&&job.id&&job.previewOnly!==true)throw Error('DRAWING_PREVIEW_SCOPE_INVALID');
        if(job.id){if(turn.previewOnly)turn.drawingLatest=job.id;else latest=job.id;}turn.drawingOutcome=job;
        return {content:JSON.stringify({job,notice:job.sent?(job.delivery.apiAcknowledged?'图片发送接口已返回成功，无需再等待微信消息号或重复发送；这不是对方已读回执。':'图片发送已取得微信服务器回执。'):'仅 sent:true 才能声称接口已确认发送。queued/running 表示处理中；success 只表示图片已生成。若查询的是旧任务，本轮正常接话即可，不必复述状态；用户表示已经收到时可自然回应，不将用户反馈伪造成接口确认，也不重复生成或发送。失败按当前人格自然解释，不编造进度、图片内容或送达。用户只让看图时不要生成新图。'}),isError:['failed','interrupted','cancelled'].includes(job.state)};
      }catch(error){
        const state=(submitting&&!error.status&&!error.public)||def.name==='wechat_drawing_status'?'unconfirmed':'failed';
        const message=(error.public||error.status)&&safeMessage(error.message);
        const result={state,sent:false,error:message||(state==='unconfirmed'?'绘画请求的结果未确认，请查询当前任务，不要重复生成。':'绘画操作未完成，请检查本机控制台和绘画配置。')};
        turn.drawingOutcome=result;
        return {content:JSON.stringify({job:result,notice:'如实说明当前环节；未确认不能声称图片已经发送，不重复提交生成。'}),isError:true};
      }
    }}));
  Object.defineProperty(agentCtx,DRAWING_POLICY,{configurable:true,value:{names:()=>new Set(active()?definitions.map(tool=>tool.name):[]),definitions:()=>active()?definitions:[],check:name=>active()&&definitions.some(tool=>tool.name===name)}});
  // DSH resolves tools and snapshots their schemas before agent/pre-step.
  // Await this turn's eligibility here so describe sees the same capability
  // as the later instructions; both tools share refresh's per-turn promise.
  const disposers=definitions.map(tool=>agentCtx.tools.register(tool,{when:()=>refresh()}));
  return {refresh,instructions:()=>active()?'[GPT 绘画]\n用户明确要求画图或生成图片时，调用 wechat_draw_image。“发张你的照片给我看看”“给我一张自拍”“看看你的样子”也属于图片生成请求，结合当前人格与本会话已知外貌生成虚拟角色自拍或形象照；未指定外貌可合理设计，不必追问用户是否要画图，不冒称真实拍照。必须实际调用工具，不能仅口头承诺发图或在没有任务时说正在画。只看图、辨认、描述图片时不能擅自画图；其他需求模糊先问清。结合用户要求整理 prompt，不让用户提供内部接口、文件路径或接收者。每轮最多生成一次，后台异步生成并向当前聊天发送图片，先回复真实的已启动状态；只有用户追问进度或发送问题时才按需使用 wechat_drawing_status，不连续轮询、不因响应超时再生成。用户说“收到啦”“确认”、谢谢或发表情时，结合上下文自然接话，不因旧任务尚无接口回执而反复查询和播报。只有 sent:true 才能声称接口已确认图片、照片或自拍发送，success 仅表示图片已生成；可自然接受用户已收到的反馈，但不篡改接口状态。失败或发送未确认按本轮需要自然说明，不编造成功、进度或图片细节。':'',dispose(){for(const dispose of disposers)dispose?.();delete agentCtx[DRAWING_POLICY];}};
}
