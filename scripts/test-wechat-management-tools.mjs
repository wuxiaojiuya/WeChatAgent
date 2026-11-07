import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {bindWechatManagementTools,WECHAT_MANAGEMENT_POLICY} from '../packages/dsh-social-bridge-plugin/wechat-management-tools.mjs';
import {apply as restrictTools} from '../packages/dsh-social-bridge-plugin/social-tool-restrict.mjs';

const PRIVATE='wechat:private:123',GROUP='wechat:group:456',IMAGE='a'.repeat(64),DRAWING='11111111-1111-4111-8111-111111111111',MOMENT='18446744073709550001';
const parsed=async(tool,args={})=>JSON.parse((await tool.execute(args)).content);
function fixture(t,{key=PRIVATE,fetchImpl,scope='fixture-account'}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-management-')),tools=new Map(),registrations=new Map(),calls=[];
  const file=path.join(root,'config/wechatagent.json');
  const config={wechat:{whitelist:{private:['123'],groups:['456']},assistant:{administrators:[]}},hook:{backend:'supplier-http',baseUrl:'http://127.0.0.1:31010'}};
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(config));
  fs.mkdirSync(path.join(root,'state/hook'),{recursive:true});fs.writeFileSync(path.join(root,'state/hook/native-token.txt'),'b'.repeat(64));
  let turn={controller:new AbortController(),batchId:'c'.repeat(64),images:[{id:IMAGE}]},allowed=true,state='api-acknowledged';
  const ctx={tools:{register(tool,options){tools.set(tool.name,tool);registrations.set(tool.name,options);return()=>{tools.delete(tool.name);registrations.delete(tool.name);};}}};
  const binding=bindWechatManagementTools(ctx,root,key,()=>turn,{scope,isAllowed:()=>allowed,fetchImpl:async(url,request)=>{
    const body=JSON.parse(request.body);calls.push({url,request,body});
    if(fetchImpl)return fetchImpl(url,request,body);
    if(url.endsWith('/GetMoments'))return Response.json({moments:[{momentId:MOMENT,text:'今天的记录'}]});
    if(url.endsWith('/GetMomentDetail'))return Response.json({moment:{momentId:body.momentId,text:'今天的记录',comments:[{commentId:7,content:'评论正文'}]}});
    return Response.json({operationId:body.operationId,state,apiAcknowledged:state==='api-acknowledged',confirmed:false,rawPath:'C:/private.png',token:'private-secret'});
  }});
  t.after(()=>{binding.dispose();fs.rmSync(root,{recursive:true,force:true});});
  return {root,key,file,config,ctx,tools,registrations,binding,calls,turn:()=>turn,setTurn:value=>turn={controller:new AbortController(),batchId:'c'.repeat(64),images:[{id:IMAGE}],...value},setAllowed:value=>allowed=value,setState:value=>state=value,save:()=>fs.writeFileSync(file,JSON.stringify(config))};
}

test('owner-authorized tools are available in allowed conversations without requiring admin membership',async t=>{
  const f=fixture(t),policy=f.ctx[WECHAT_MANAGEMENT_POLICY];
  assert.equal(policy.names().size,9);assert(!policy.names().has('wechat_set_group_name'));
  assert(f.binding.instructions().includes('无需逐次审批'));assert(f.binding.instructions().includes(IMAGE));
  assert.match(f.tools.get('wechat_post_moment').description,/可能导致微信断线/);
  for(const name of policy.names())assert.equal(await f.registrations.get(name).when(),true);
  await parsed(f.tools.get('wechat_set_nickname'),{nickname:'今天的新名字'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.nickname,'今天的新名字');
  const group=fixture(t,{key:GROUP});assert.equal(group.ctx[WECHAT_MANAGEMENT_POLICY].names().size,10);
  await parsed(group.tools.get('wechat_set_group_name'),{name:'共同的新群名'});
  assert.deepEqual(Object.keys(group.calls[0].body).sort(),['conversationKey','name','operationId']);
  assert.equal(group.calls[0].body.conversationKey,GROUP);
  await assert.rejects(f.tools.get('wechat_set_group_name').execute({name:'不能改群'}));
});

test('all seven mutations map to the fixed authenticated gateway with no actor or account gates',async t=>{
  const f=fixture(t,{key:GROUP});
  const operations=[['wechat_post_moment',{text:'今天想记下这句话。'},'/PostMoment'],
    ['wechat_post_image_moment',{text:'一张画',imageIds:[IMAGE]},'/PostImageMoment'],
    ['wechat_reply_moment',{momentId:MOMENT,commentId:7,content:'很喜欢这个想法。'},'/ReplyMoment'],
    ['wechat_set_nickname',{nickname:'小鱼'},'/SetSelfNickname'],
    ['wechat_set_avatar',{drawingJobId:DRAWING},'/SetSelfAvatar'],
    ['wechat_set_signature',{signature:''},'/SetSelfSignature'],
    ['wechat_set_group_name',{name:'聊天小窝'},'/SetGroupName']];
  for(const [name,args,route] of operations){
    const result=await parsed(f.tools.get(name),args),call=f.calls.at(-1);
    assert.equal(call.url,'http://127.0.0.1:31010'+route);assert.equal(call.request.redirect,'error');
    assert.equal(call.request.headers.Authorization,'Bearer '+'b'.repeat(64));
    assert.equal(call.body.conversationKey,GROUP);assert.match(call.body.operationId,/^[a-f0-9]{64}$/);
    for(const [field,value]of Object.entries(args))assert.deepEqual(call.body[field],value);
    assert(!Object.hasOwn(call.body,'actorWxid'));assert(!Object.hasOwn(call.body,'accountScope'));
    assert.equal(result.state,'api-acknowledged');assert.equal(result.apiAcknowledged,true);assert.equal(result.confirmed,false);
    assert(!JSON.stringify(result).includes('private-secret'));assert(!JSON.stringify(result).includes('private.png'));
  }
  assert.equal(f.calls.length,7);
});

test('model arguments cannot redirect operations or supply paths, credentials, recipients or operation IDs',async t=>{
  const f=fixture(t),tool=f.tools.get('wechat_set_nickname');
  for(const extra of [{path:'C:/secret.txt'},{url:'https://other.invalid'},{token:'stolen'},{conversationKey:GROUP},{operationId:'d'.repeat(64)},{wxidorgid:'wxid_other'},{actorWxid:'wxid_admin'}])await assert.rejects(tool.execute({nickname:'名称',...extra}));
  for(const args of [null,[],{}, {nickname:''},{nickname:'a\0b'},{nickname:'中'.repeat(171)}])await assert.rejects(tool.execute(args));
  assert.equal(f.calls.length,0);
});

test('image actions use only current received image IDs or scoped drawing job references',async t=>{
  const f=fixture(t),avatar=f.tools.get('wechat_set_avatar'),post=f.tools.get('wechat_post_image_moment');
  for(const args of [{},{imageId:'d'.repeat(64)},{imageId:IMAGE,drawingJobId:DRAWING},{path:'C:/avatar.png'},{drawingJobId:'not-a-job'}])await assert.rejects(avatar.execute(args));
  for(const args of [{imageIds:[]},{imageIds:[IMAGE,IMAGE]},{imageIds:['d'.repeat(64)]},{imageIds:[IMAGE],drawingJobIds:[DRAWING]},{drawingJobIds:['not-a-job']}])await assert.rejects(post.execute(args));
  assert.equal(f.calls.length,0);
  assert.deepEqual((await parsed(avatar,{imageId:IMAGE})).imageId,IMAGE);
  assert.deepEqual((await parsed(post,{drawingJobIds:[DRAWING]})).drawingJobIds,[DRAWING]);
  assert.equal(f.calls.length,2);
  f.setTurn({images:[]});await assert.rejects(avatar.execute({imageId:IMAGE}));
  assert.equal(f.calls.length,2);
});

test('identical writes share one promise and stable batch operation ID while separate batches remain distinct',async t=>{
  const f=fixture(t),tool=f.tools.get('wechat_post_moment');
  const [first,second]=await Promise.all([parsed(tool,{text:'同一条记录'}),parsed(tool,{text:'同一条记录'})]);
  assert.deepEqual(first,second);assert.equal(f.calls.length,1);
  f.setTurn();const retry=await parsed(tool,{text:'同一条记录'});assert.equal(retry.operationId,first.operationId);
  f.setTurn({batchId:'e'.repeat(64)});const next=await parsed(tool,{text:'同一条记录'});assert.notEqual(next.operationId,first.operationId);
  const other=fixture(t,{scope:'another-cache-namespace'});assert.notEqual((await parsed(other.tools.get('wechat_post_moment'),{text:'同一条记录'})).operationId,first.operationId);
});

test('lost write responses remain unconfirmed and never cause an implicit retry',async t=>{
  const f=fixture(t,{fetchImpl:async()=>{throw Error('private token and endpoint details');}}),tool=f.tools.get('wechat_set_signature');
  const first=await parsed(tool,{signature:'安静地听风'}),second=await parsed(tool,{signature:'安静地听风'});
  assert.equal(first.state,'unconfirmed');assert.equal(first.apiAcknowledged,false);assert.equal(first.confirmed,false);assert.deepEqual(first,second);assert.equal(f.calls.length,1);
  assert(!JSON.stringify(first).includes('private token'));assert.match(first.operationId,/^[a-f0-9]{64}$/);
  const unavailable=fixture(t,{fetchImpl:async()=>Response.json({error:'HOOK_MANAGEMENT_STORE_UNAVAILABLE'},{status:503})});
  const unknown=await parsed(unavailable.tools.get('wechat_post_moment'),{text:'不能从服务器错误推断发布失败。'});
  assert.equal(unknown.state,'unconfirmed');assert.equal(unknown.confirmed,false);
});

test('read tools preserve full moment IDs and status queries can observe updated receipts without resubmitting',async t=>{
  const f=fixture(t),list=await parsed(f.tools.get('wechat_list_moments'));
  assert.equal(list.moments[0].momentId,MOMENT);
  const clipped=fixture(t,{fetchImpl:async()=>Response.json({moments:[{id:MOMENT,text:'预览',textTruncated:true}],truncated:true})});
  const preview=await parsed(clipped.tools.get('wechat_list_moments'));assert.equal(preview.truncated,true);assert.equal(preview.moments[0].id,MOMENT);assert.equal(preview.moments[0].textTruncated,true);
  const detail=await parsed(f.tools.get('wechat_moment_detail'),{momentId:MOMENT});assert.equal(detail.moment.comments[0].commentId,7);
  const reply=await parsed(f.tools.get('wechat_reply_moment'),{momentId:MOMENT,commentId:0,content:'有感而发。'});
  const status=f.tools.get('wechat_management_status');f.setState('unconfirmed');assert.equal((await parsed(status,{operationId:reply.operationId})).state,'unconfirmed');
  f.setState('api-acknowledged');assert.equal((await parsed(status,{operationId:reply.operationId})).state,'api-acknowledged');
  assert.equal(f.calls.filter(call=>call.url.endsWith('/ReplyMoment')).length,1);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/ManagementOperationStatus')).length,2);
  assert.equal(f.calls.find(call=>call.url.endsWith('/GetMomentDetail')).body.momentId,MOMENT);
  for(const args of [{momentId:18446744073709550001},{momentId:'18446744073709551616'},{momentId:'01'}])await assert.rejects(f.tools.get('wechat_moment_detail').execute(args));
  for(const commentId of [-1,4294967296,1.2,true])await assert.rejects(f.tools.get('wechat_reply_moment').execute({momentId:MOMENT,commentId,content:'text'}));
});

test('revoked conversation, cancelled turn, changed runtime and disposed binding deny execution',async t=>{
  const f=fixture(t),tool=f.tools.get('wechat_set_nickname'),policy=f.ctx[WECHAT_MANAGEMENT_POLICY];
  f.setAllowed(false);assert.equal(policy.names().size,0);await assert.rejects(tool.execute({nickname:'名称'}));
  f.setAllowed(true);f.turn().controller.abort();assert.equal(policy.names().size,0);await assert.rejects(tool.execute({nickname:'名称'}));
  f.setTurn();f.config.wechat.whitelist.private=[];f.save();assert.equal(policy.names().size,0);await assert.rejects(tool.execute({nickname:'名称'}));
  f.config.wechat.whitelist.private=['123'];f.save();f.binding.dispose();assert.equal(f.ctx[WECHAT_MANAGEMENT_POLICY],undefined);await assert.rejects(tool.execute({nickname:'名称'}));assert.equal(f.calls.length,0);
});

test('gateway configuration cannot point requests outside authenticated IPv4 loopback',async t=>{
  const f=fixture(t),policy=f.ctx[WECHAT_MANAGEMENT_POLICY];
  for(const baseUrl of ['https://127.0.0.1:31010','http://example.com:31010','http://127.0.0.1:31010/private','http:'+'//user:password@127.0.0.1:31010','http://127.0.0.1:31010?token=secret']){
    f.config.hook.baseUrl=baseUrl;f.save();assert.equal(policy.names().size,0);await assert.rejects(f.tools.get('wechat_post_moment').execute({text:'记录'}));
  }
  assert.equal(f.calls.length,0);
});

test('parameter rejection and cancellation do not become claims of completed mutations',async t=>{
  const denied=fixture(t,{fetchImpl:async()=>Response.json({error:'HOOK_IMAGE_REFERENCE_NOT_ALLOWED',details:'private-path-and-key'},{status:403})});
  const rejected=await parsed(denied.tools.get('wechat_set_avatar'),{drawingJobId:DRAWING});assert.equal(rejected.state,'rejected');assert.equal(rejected.confirmed,false);assert.equal(rejected.code,'HOOK_IMAGE_REFERENCE_NOT_ALLOWED');assert(!JSON.stringify(rejected).includes('private-path'));
  let release;const gate=new Promise(resolve=>release=resolve),f=fixture(t,{fetchImpl:async(_url,_request,body)=>{await gate;return Response.json({operationId:body.operationId,state:'api-acknowledged',apiAcknowledged:true,confirmed:false});}});
  const pending=parsed(f.tools.get('wechat_set_signature'),{signature:'今天'});f.turn().controller.abort();release();const cancelled=await pending;assert.equal(cancelled.state,'unconfirmed');assert.equal(cancelled.confirmed,false);
});

test('tool guard and native presentation expose only the live management policy',async t=>{
  const f=fixture(t),guards=[],handlers=[];f.ctx.tools.guard=guard=>guards.push(guard);f.ctx.on=(name,handler)=>handlers.push({name,handler});restrictTools(f.ctx);
  const agent={ctx:f.ctx};assert.equal(guards[0]({agent,name:'wechat_post_moment'}),undefined);assert.equal(typeof guards[0]({agent,name:'pwsh'}),'string');
  const shown=await handlers[0].handler(null,{scope:agent},async()=>({sections:[],tools:[{name:'pwsh'},{name:'wechat_set_group_name'},{name:'wechat_post_moment'}]}));
  assert.deepEqual(shown.tools.map(tool=>tool.name),['wechat_post_moment']);
  f.setAllowed(false);assert.equal(typeof guards[0]({agent,name:'wechat_post_moment'}),'string');
});

test('native lifecycle binds fresh received images and scheduled turns and disposes management tools',()=>{
  const source=fs.readFileSync(new URL('../packages/dsh-social-bridge-plugin/native-context.mjs',import.meta.url),'utf8');
  assert.match(source,/bindWechatManagementTools\(agent\.ctx,root,key,\(\)=>pending\.get\(sid\)\?\.managementTurn/);
  assert.match(source,/item\.managementTurn=\{controller:webReaderTurn\.controller,batchId,images:Array\.isArray\(body\.images\)/);
  assert.match(source,/item\.managementTurn=\{controller:webReaderTurn\.controller,batchId,images:\[\]\}/);
  assert.match(source,/managementBindings\.get\(sid\)\?\.dispose\(\);managementBindings\.delete\(sid\)/);
  assert.match(source,/for\(const binding of managementBindings\.values\(\)\)binding\.dispose\(\)/);
});
