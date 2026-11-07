// The idle dispatcher may use only the capability it actually selected.
// Reflection itself has no tools; no caller-supplied HTTP flag enables this path.
export const IDLE_ACTION_POLICY=Symbol.for('wechatagent.idle-action.v1');
export function idleActionTools(kind){
  return new Set(({singing:['wechat_sing_song','wechat_singing_status'],drawing:['wechat_draw_image','wechat_drawing_status'],moment:['wechat_post_moment','wechat_management_status'],reflect:[]})[kind]??[]);
}
export function mindActionResult(plan,output){
  if(output?.error)return {state:output.admitted?'unknown':'failed',reason:output.admitted?'执行结果未确认，保留记录，不自动重复行动。':'本次行动未能开始。'};
  const outcome=output?.autonomousOutcome;
  if(!outcome)return {state:'postponed',reason:'这次没有实际调用行动工具，想法继续保留。'};
  if(['failed','rejected','none','cancelled','interrupted'].includes(outcome.state))return {state:'failed',reason:'本次行动未完成，具体原因见能力任务记录。'};
  if(['unconfirmed','unknown'].includes(outcome.state))return {state:'unknown',reason:'工具结果未确认，保留记录，不自动重复提交。'};
  if(['queued','running','api-acknowledged'].includes(outcome.state))return {state:'submitted',reason:plan.kind==='moment'?'朋友圈接口已接受请求；这不是最终完成回执。':plan.delivery==='chat'?'已提交分享生成任务，作品及发送结果见任务记录。':'已提交本地练习任务，作品完成情况见任务记录，不发送微信。',...(outcome.id?{jobId:outcome.id}:{})};
  if(outcome.state==='success'||outcome.confirmed===true)return {state:'completed',reason:plan.delivery==='chat'&&outcome.sent!==true?'作品已生成，发送状态见任务记录。':'本次行动已完成。',...(outcome.id?{jobId:outcome.id}:{})};
  return {state:'unknown',reason:'未取得明确工具结果，不自动重复行动。'};
}
export function mindJobResult(plan,job){
  if(!job||job.id!==plan.jobId)return {state:'unknown',reason:'能力任务记录与本计划不匹配，不自动重复生成。'};
  if(['queued','running'].includes(job.state))return null;
  if(['failed','interrupted','cancelled'].includes(job.state))return {state:'failed',reason:'能力任务未能生成作品，具体原因见任务记录。'};
  if(job.state!=='success')return {state:'unknown',reason:'没有取得明确的作品结果，不自动重试。'};
  if(plan.delivery!=='chat')return {state:'completed',reason:'本地练习作品已生成，没有向微信发送。',jobId:job.id};
  if(job.sent===true)return {state:'completed',reason:'作品已生成，发送接口已确认发送；这不是对方已读回执。',jobId:job.id};
  if(['waiting','queued','preparing','sending'].includes(job.delivery?.state))return null;
  if(['failed','not-sent'].includes(job.delivery?.state))return {state:'failed',reason:'作品已生成，但没有完成微信发送，具体原因见任务记录。',jobId:job.id};
  return {state:'unknown',reason:'作品已生成，微信发送结果未确认，不自动重复提交。',jobId:job.id};
}
export function idleActionMessage(plan){
  return '[本机空闲行动，不是微信新消息]\n'+
    '你之前自己留下了以下计划，刚刚的后台回顾选择现在尝试。仍可调整或放弃；不是必须执行。只根据实际工具结果记录进展，不编造完成。此轮最终文字留在本机，不会自动发到微信，也不需要问候或向群聊解释你在思考。\n'+
    (plan.kind==='moment'?'本轮仅提供发布一条文字朋友圈及查询回执；内容由你决定。不泄露不同私聊的内容、私人称呼或约定。':
    plan.delivery==='chat'?'你已选择把本次作品分享给计划来源的当前聊天。只有本轮能力工具会向该聊天发送，任务排队并非已送达。':
    '这是自己的本地练习。唱歌或绘画工具只保存作品，不向微信发送；这不会改变用户聊天里的正常发送方式。')+
    '\n计划资料：'+JSON.stringify({title:plan.title,kind:plan.kind,detail:plan.detail,delivery:plan.delivery??'local'}).replaceAll('<','\\u003c')+
    '\n完成工具操作或决定暂不行动后，最终输出 SILENT。';
}
