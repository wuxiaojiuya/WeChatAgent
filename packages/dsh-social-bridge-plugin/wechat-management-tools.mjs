import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {allowedConversation} from './conversation-policy.mjs';

export const WECHAT_MANAGEMENT_POLICY=Symbol.for('wechatagent.wechat-management.v1');
const HEX=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const id=value=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value)&&BigInt(value)<=18446744073709551615n;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const string=(maximum,{empty=false}={})=>({type:'string',maxLength:maximum,...(empty?{}:{minLength:1})});
const imageProperties={imageIds:{type:'array',items:{type:'string',pattern:HEX.source},minItems:1,maxItems:1},drawingJobIds:{type:'array',items:{type:'string',pattern:UUID.source},minItems:1,maxItems:1}};
const momentId={type:'string',pattern:'^[1-9][0-9]{0,19}$',description:'朋友圈工具实际返回的完整 momentId，保持字符串，不能四舍五入。'};
const textValid=(value,maximum,empty=false)=>typeof value==='string'&&!value.includes('\0')&&(empty||!!value.trim())&&Buffer.byteLength(value,'utf8')<=maximum;
const canonical=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
const pack=(value,isError=false)=>({content:JSON.stringify(value),isError});
const definitions=[
  {name:'wechat_post_moment',route:'/PostMoment',description:'自主发布一条文字朋友圈，内容由你结合人格、心情与语境决定。此 Hook 的接口文档提示文字朋友圈可能导致微信断线；返回未确认时查询状态，不重复发布。',properties:{text:string(16000)},required:['text']},
  {name:'wechat_post_image_moment',route:'/PostImageMoment',description:'自主发布一张图片及可选文案到朋友圈。图片只能使用本轮已收到的 imageIds，或当前会话已完成绘画的 drawingJobIds；目前接口一次只支持一张图，不接受路径。',properties:{text:string(16000,{empty:true}),...imageProperties}},
  {name:'wechat_reply_moment',route:'/ReplyMoment',description:'回复朋友圈或其中一条评论。先通过朋友圈列表/详情取得真实 momentId 和 commentId；回复该朋友圈本身时 commentId 为 0。内容和是否互动由你决定。',properties:{momentId,commentId:{type:'integer',minimum:0,maximum:4294967295},content:string(16000)},required:['momentId','commentId','content']},
  {name:'wechat_set_nickname',route:'/SetSelfNickname',description:'自主修改当前微信账号自己的昵称。只操作当前连接账号，不修改好友备注。',properties:{nickname:string(512)},required:['nickname']},
  {name:'wechat_set_avatar',route:'/SetSelfAvatar',description:'自主将一张本轮收到的图片或当前会话已完成的绘画设为自己的微信头像。提供 imageId 或 drawingJobId 二选一，不接受文件路径。',properties:{imageId:{type:'string',pattern:HEX.source},drawingJobId:{type:'string',pattern:UUID.source}}},
  {name:'wechat_set_signature',route:'/SetSelfSignature',description:'自主修改当前微信账号的个性签名；空字符串表示清空签名。',properties:{signature:string(4096,{empty:true})},required:['signature']},
  {name:'wechat_set_group_name',route:'/SetGroupName',groupOnly:true,description:'自主修改当前正在对话的微信群名称。目标由当前会话绑定，不能指定其他群；微信账号本身需要有改名权限。',properties:{name:string(1024)},required:['name']},
  {name:'wechat_list_moments',route:'/GetMoments',read:true,description:'读取当前账号可见的朋友圈列表，供你理解内容、选择互动对象和取得完整 momentId。不修改朋友圈。',properties:{}},
  {name:'wechat_moment_detail',route:'/GetMomentDetail',read:true,description:'读取一条朋友圈及评论，取得原文和准确 commentId 后可自主回复。momentId 必须保持完整字符串。',properties:{momentId},required:['momentId']},
  {name:'wechat_management_status',route:'/ManagementOperationStatus',read:true,status:true,description:'查询当前会话先前账号或朋友圈操作的实际状态。使用工具返回的 operationId；未确认时先查，不重复提交同一操作。',properties:{operationId:{type:'string',pattern:HEX.source}},required:['operationId']},
];

/** Bind existing allowed conversations to the owner's autonomous Hook tools.
 * Model input never controls the recipient, gateway, token or file paths.
 */
export function bindWechatManagementTools(agentCtx,root,key,turnFor,{isAllowed=()=>true,fetchImpl=fetch,scope=''}={}){
  const group=/^wechat:group:/.test(key);
  let disposed=false;
  const connection=()=>{
    const config=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,''));
    if(!allowedConversation(config.wechat,key)||config.hook?.backend!=='supplier-http')throw Error('HOOK_MANAGEMENT_NOT_ALLOWED');
    const url=new URL(config.hook.baseUrl);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.port)throw Error('HOOK_LOOPBACK_REQUIRED');
    const token=fs.readFileSync(path.join(root,'state/hook/native-token.txt'),'utf8').trim();
    if(!HEX.test(token))throw Error('HOOK_TOKEN_MISSING');
    return {origin:url.origin,token};
  };
  const active=()=>{try{const turn=turnFor();if(disposed||!turn||turn.controller.signal.aborted||isAllowed()!==true)return false;connection();return true;}catch{return false;}};
  const available=def=>active()&&(!def.groupOnly||group);
  const validate=(def,args,turn)=>{
    if(!plain(args)||Object.keys(args).some(name=>!Object.hasOwn(def.properties,name))||(def.required??[]).some(name=>!Object.hasOwn(args,name)))throw Error('微信工具参数无效。');
    for(const [name,value] of Object.entries(args)){
      const schema=def.properties[name];
      if(schema.type==='string'){
        if(!textValid(value,schema.maxLength??128,schema.minLength===undefined))throw Error('微信工具文字或编号无效。');
        if(schema.pattern&&!new RegExp(schema.pattern).test(value))throw Error('微信工具编号无效。');
      }else if(schema.type==='integer'){
        if(!Number.isSafeInteger(value)||value<schema.minimum||value>schema.maximum)throw Error('朋友圈评论编号无效。');
      }else if(!Array.isArray(value)||value.length!==1||typeof value[0]!=='string'||!new RegExp(schema.items.pattern).test(value[0]))throw Error('请提供一个有效的图片引用。');
    }
    if(args.momentId!==undefined&&!id(args.momentId))throw Error('朋友圈编号无效。');
    if(def.name==='wechat_post_image_moment'&&(Number(args.imageIds!==undefined)+Number(args.drawingJobIds!==undefined)!==1))throw Error('请选择一张接收图片或一项已完成绘画。');
    if(def.name==='wechat_set_avatar'&&(Number(args.imageId!==undefined)+Number(args.drawingJobId!==undefined)!==1))throw Error('请选择一张接收图片或一项已完成绘画。');
    const received=[...(args.imageIds??[]),...(args.imageId?[args.imageId]:[])];
    const allowed=new Set((turn.images??[]).map(image=>typeof image==='string'?image:image?.id));
    if(received.some(imageId=>!allowed.has(imageId)))throw Error('这张图片不在当前会话本轮已接收的图片中。');
  };
  const tools=definitions.map(def=>({name:def.name,description:def.description,
    parameters:{type:'object',properties:def.properties,...(def.required?{required:def.required}:{}),additionalProperties:false},
    output:{schema:{type:'object',properties:{content:{type:'string'},isError:{type:'boolean'}},required:['content','isError'],additionalProperties:false},render:(_args,value)=>[{type:'text',text:value.content}]},
    async execute(args,exec){
      const turn=turnFor();if(!available(def))throw Error('当前微信会话的账号操作工具不可用。');
      validate(def,args,turn);
      turn.managementRequests??=new Map();turn.managementTurnId??=crypto.randomUUID();
      const fingerprint=crypto.createHash('sha256').update(def.name+'\0'+canonical(args)).digest('hex');
      if(!def.read&&turn.managementRequests.has(fingerprint))return turn.managementRequests.get(fingerprint);
      const operationId=def.status?args.operationId:crypto.createHash('sha256').update(JSON.stringify([scope,key,turn.batchId??turn.managementTurnId,def.name,canonical(args)])).digest('hex');
      const promise=(async()=>{
        let submitted=false;
        try{
          const {origin,token}=connection();
          const signal=AbortSignal.any([turn.controller.signal,AbortSignal.timeout(30000),...(exec?.signal?[exec.signal]:[])]);
          const body={...args,conversationKey:key,...(!def.read?{operationId}:{})};
          if(!available(def)||turnFor()!==turn)throw Error('HOOK_MANAGEMENT_SCOPE_CHANGED');
          submitted=!def.read;
          const response=await fetchImpl(origin+def.route,{method:'POST',redirect:'error',signal,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
          const raw=await response.text();
          if(Buffer.byteLength(raw)>512*1024)throw Error('HOOK_MANAGEMENT_RESPONSE_INVALID');
          const value=JSON.parse(raw);
          if(!response.ok)throw Object.assign(Error('HOOK_MANAGEMENT_REJECTED'),{status:response.status,code:typeof value.error==='string'&&/^HOOK_[A-Z0-9_]{1,80}$/.test(value.error)?value.error:undefined});
          if(!available(def)||turnFor()!==turn)throw Error('HOOK_MANAGEMENT_SCOPE_CHANGED');
          if(def.name==='wechat_list_moments'){
            if(!Array.isArray(value.moments))throw Error('HOOK_MANAGEMENT_RESPONSE_INVALID');
            return pack({moments:value.moments,...(value.truncated===true?{truncated:true}:{})});
          }
          if(def.name==='wechat_moment_detail'){
            if(!plain(value.moment))throw Error('HOOK_MANAGEMENT_RESPONSE_INVALID');
            return pack({moment:value.moment});
          }
          if(value.operationId!==operationId||!['api-acknowledged','unconfirmed','rejected'].includes(value.state))throw Error('HOOK_MANAGEMENT_RESPONSE_INVALID');
          const receipt={operationId,state:value.state,apiAcknowledged:value.apiAcknowledged===true,confirmed:value.confirmed===true,
            ...Object.fromEntries(['imageId','imageIds','drawingJobId','drawingJobIds'].filter(field=>args[field]!==undefined).map(field=>[field,args[field]])),
            notice:value.confirmed===true?'操作已确认。':value.state==='api-acknowledged'?'接口已接受操作；尚无最终完成回执。':'操作结果未确认时查询状态，不能声称已经完成，也不重复提交。'};
          return pack(receipt,value.state==='rejected');
        }catch(error){
          const state=(submitted||def.status)&&(!error.status||error.status>=500)?'unconfirmed':'rejected';
          return pack({operationId,state,apiAcknowledged:false,confirmed:false,...(error.code?{code:error.code}:{}),
            message:state==='unconfirmed'?'这次操作的结果未确认，请查询 operationId；同一请求不会重复提交。':'本次微信操作未完成，后续对话可以继续。'},true);
        }
      })();
      if(!def.read)turn.managementRequests.set(fingerprint,promise);
      return promise;
    },when:()=>available(def)}));
  const currentTools=()=>tools.filter((_,index)=>available(definitions[index]));
  Object.defineProperty(agentCtx,WECHAT_MANAGEMENT_POLICY,{configurable:true,value:{names:()=>new Set(currentTools().map(tool=>tool.name)),definitions:currentTools,check:name=>currentTools().some(tool=>tool.name===name)}});
  const disposers=tools.map(tool=>{const {when,...definition}=tool;return agentCtx.tools.register(definition,{when});});
  return {instructions:()=>active()?'[微信自主操作]\n本机所有者已授权你在已允许的微信会话自主使用朋友圈和个人资料工具，无需逐次审批。你可以结合自身人格、想法、情绪与对话选择是否发布、互动或修改昵称、头像、签名；不要把这些操作写成固定的性格或情绪脚本。群名工具只对应当前群。图片使用本轮实际提供的 imageId，或绘画工具实际返回的当前会话 drawingJobId，不使用文件路径。朋友圈回复先读取真实内容和评论编号。操作结果以工具回执为准；api-acknowledged 仅表示接口接受，未确认时可查询 operationId，不重复提交同一操作。'+((turnFor()?.images??[]).length?'\n本轮接收图片引用：'+turnFor().images.map(image=>typeof image==='string'?image:image.id).join('、'):''):'',dispose(){disposed=true;for(const dispose of disposers)dispose?.();delete agentCtx[WECHAT_MANAGEMENT_POLICY];}};
}
