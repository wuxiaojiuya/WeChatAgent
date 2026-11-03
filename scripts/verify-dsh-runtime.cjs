// Run with the selected DSH executable and ELECTRON_RUN_AS_NODE=1.
// Uses the real DSH runtime with an offline model adapter and isolated data.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

(async () => {
  const project = path.resolve(process.env.WECHATAGENT_VERIFY_PROJECT || path.join(__dirname, '..'));
  const source = path.resolve(process.argv[2] || 'E:/DSH');
  const fixture = fs.mkdtempSync(path.join(project, 'state', 'dsh-020-compat-'));
  const home = path.join(fixture, 'home');
  process.env.DSH_HOME = home;
  process.env.DSH_TELEMETRY_DISABLED = '1';
  fs.mkdirSync(path.join(fixture, 'state'), { recursive: true });
  const base = path.join(source, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
  const mod = name => import(pathToFileURL(path.join(base, name, 'lib/index.js')).href);
  const boot = await mod('dsh-app-boot');
  const sdk = await mod('dsh-llm');
  const toolSdk = await mod('dsh-tools');
  const actualVersion = JSON.parse(fs.readFileSync(path.join(source, 'resources/app.asar/package.json'))).version;
  assert.match(actualVersion, /^0\.2\.\d+(?:-.*)?$/, 'verification requires the supported DSH 0.2 runtime');
  const plugin = path.join(project, 'packages/dsh-social-bridge-plugin');
  assert.equal(boot.evaluatePluginCompatibility(JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'))), {}, actualVersion), undefined);
  const persona = '你是用于兼容验收的测试助手，只回复 SILENT。';
  fs.writeFileSync(path.join(fixture, 'state/bridge-config.json'), JSON.stringify({role:persona, persona_name:'测试人格', roles:{}}));
  const token = crypto.randomBytes(24).toString('hex');
  const tokenFile = path.join(fixture, 'token.txt'); fs.writeFileSync(tokenFile, token);
  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  const rows = ['dsh-llm','dsh-session','dsh-session-projection','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop','dsh-session-title'].map((name, i) => ({id:'core-'+i, name:'@deepseek-ai/'+name, config:{}}));
  rows[3].config={personaPrefix:''};
  rows[7].config={fallbackMaxWords:5,fallbackMaxBytes:40,maxTitleBytes:80};
  rows.push({id:'tokens',name:'@deepseek-ai/dsh-token-meter'});
  rows.push({id:'image-offload',name:'@deepseek-ai/dsh-compaction-image-offload'});
  rows.push({id:'persist',name:'@deepseek-ai/dsh-session-persistence-jsonl',config:{root:path.join(home,'sessions')}});
  rows.push({id:'storage',name:'@deepseek-ai/dsh-storage'});
  rows.push({id:'storage-json',name:'@deepseek-ai/dsh-storage-json',config:{root:path.join(home,'storage')}});
  rows.push({id:'storage-domain',name:'@deepseek-ai/dsh-storage-domain',config:{backend:'json'}});
  rows.push({id:'workspaces',name:'@deepseek-ai/dsh-workspace'});
  rows.push({id:'attachments',name:'@deepseek-ai/dsh-attachment-local',config:{dshHome:home}});
  rows.push({id:'presets',name:'@deepseek-ai/dsh-agent-preset-registry',config:{default:'wechat-social'}});
  rows.push({id:'social-preset',name:'@deepseek-ai/dsh-agent-preset',config:{id:'wechat-social',name:'微信测试',plugins:[
    {id:'persona',name:pathToFileURL(path.join(base,'dsh-persona/lib/index.js')).href,config:{prefix:persona,suffix:'',includeRuntimeContext:false}},
    {id:'compaction',name:'cordis:group',group:true,isolate:{compaction:true},config:[{id:'basic',name:pathToFileURL(path.join(base,'dsh-compaction-basic/lib/index.js')).href,config:{auto:false}}]},
    {id:'restrict',name:pathToFileURL(path.join(plugin,'social-tool-restrict.mjs')).href}
  ]}});
  rows.push({id:'social',name:pathToFileURL(path.join(plugin,'index.js')).href,config:{projectRoot:fixture,tokenFile,statePath:path.join(fixture,'mappings.json'),provider:'offline-test',model:'test-image',port}});
  const configFile = path.join(fixture,'cordis.yml'); fs.writeFileSync(configFile, JSON.stringify(rows));
  let ctx, reader;
  const calls = [];
  try {
    ctx = await boot.boot('WeChatAgent compatibility',configFile,[],undefined,pathToFileURL(path.join(source,'resources/app.asar/dsh/package.json')).href);
    let failVision=false;
    class Adapter extends sdk.LlmAdapter {
      async resolveModel(provider,id) { return {provider,id,name:id,inputModalities:['text','image'],contextWindow:65536,maxOutputTokens:4096,toolUpdate:'in-history'}; }
      async *stream(options) {
        calls.push(options);
        let output='SILENT';
        if(options.messages.at(-1)?.source?.kind==='wechat-history-summary'){
          const text=options.messages.at(-1).content[0].text,packet=JSON.parse(text.slice(text.lastIndexOf('\n')+1));output=packet.records.map(r=>r.speaker+'：'+r.text.slice(0,60)+' [#'+r.id+']').join('\n').slice(0,3000);
        }
        if(failVision&&options.messages.some(message=>message.content?.some(block=>block.type==='image')))throw new sdk.LlmError('Offline fixture rejects this image','INVALID_REQUEST');
        if(options.tools?.length && options.tools.every(tool=>tool.deferLoading===true))throw new sdk.LlmError('tools: at least one tool must have defer_loading=false. All tools cannot be deferred.','INVALID_REQUEST');
        const wantsHistory=options.messages.some(m=>m.role==='user'&&m.content?.some(b=>b.type==='text'&&b.text.includes('WINDOW_HISTORY_LOOKUP')));
        const wantsBatch=options.messages.some(m=>m.role==='user'&&m.content?.some(b=>b.type==='text'&&b.text.includes('WINDOW_BATCHED_HISTORY')));
        if(wantsBatch){
          const evidence=options.messages.filter(m=>m.role==='tool');
          if(evidence.length<2){
            const previous=evidence.length?JSON.parse(evidence[0].content[0].text.split('\n')[0]):null;
            if(previous){assert.equal(previous.budget.remaining,1);assert(previous.matches.length);assert(evidence[0].content[0].text.includes('最终输出 RESPOND:'));}
            const block={type:'tool-call',id:'batch-history-'+evidence.length,name:'wechat_history_search',arguments:JSON.stringify(previous?{mode:'message',messageId:previous.matches[0].id,context:1}:{queries:['DISPLAY_ONLY_SECRET','兰亭书店']})};
            yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:100,cacheReadTokens:50,outputTokens:10}};yield {type:'finish',reason:{kind:'stop'}};return;
          }
          const expanded=JSON.parse(evidence[1].content[0].text.split('\n')[0]);assert.equal(expanded.budget.remaining,0);assert(!expanded.error);output='RESPOND: 旧事已核对。';
        }
        if(wantsHistory&&!options.messages.some(m=>m.role==='tool')){
          const block={type:'tool-call',id:'window-history-call',name:'wechat_history_search',arguments:JSON.stringify({query:'DISPLAY_ONLY_SECRET'})};
          yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block};yield {type:'usage',usage:{inputTokens:100,cacheReadTokens:50,outputTokens:10}};yield {type:'finish',reason:{kind:'stop'}};return;
        }
        yield {type:'block-start',index:0,blockType:'text'};
        yield {type:'text-delta',index:0,text:output};
        yield {type:'block-end',index:0,block:{type:'text',text:output}};
        yield {type:'usage',usage:{inputTokens:100,cacheReadTokens:50,outputTokens:10}};
        yield {type:'finish',reason:{kind:'stop'}};
      }
    }
    ctx.llm.registerAdapter(['offline-test'],new Adapter());
    const sharp = require(path.join(source,'resources/app.asar/dsh/node_modules/sharp'));
    const image = await sharp({create:{width:2,height:2,channels:3,background:{r:0,g:150,b:150}}}).png().toBuffer();
    const imageId = crypto.createHash('sha256').update(image).digest('hex');
    const key = 'wechat:private:offline-dsh-020';
    let readerConversationKey=key;
    reader = http.createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({imageId,conversationKey:readerConversationKey,b64:image.toString('base64'),mime:'image/png',sha256:imageId}));});
    await new Promise(resolve=>reader.listen(0,'127.0.0.1',resolve));
    fs.writeFileSync(path.join(fixture,'state/wechat-io-config.json'),JSON.stringify({reader_base_url:'http://127.0.0.1:'+reader.address().port,reader_token:token}));
    const identity = {conversationKey:key,conversationName:'离线兼容验收',personaName:'测试人格',persona};
    async function rpc(route, body, allowFailure=false) {
      const response=await fetch('http://127.0.0.1:'+port+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
      const value=await response.json(); if(!allowFailure)assert(response.ok,JSON.stringify(value));return value;
    }
    const configured=await rpc('/configure',identity);
    await rpc('/followup',{...identity,message:'第一条测试消息'});
    await rpc('/followup',{...identity,message:'第二条测试消息'});
    let session=(await rpc('/sessions')).sessions[0]; assert.equal(session.initializations,1);
    assert(calls.every(call=>!call.tools?.length),'Social tools must remain empty');
    const socialAgent=ctx.agents.get(configured.sessionId);
    const lateTools=['schedule_create','schedule_delete','schedule_list','schedule_update'].map(name=>toolSdk.defineTool({
      name,description:'Late scoped fixture tool',parameters:{},
      output:{schema:{type:'object',properties:{},additionalProperties:false},render:()=>[{type:'text',text:'{}'}]},
      async execute(){throw new Error('Social fixture tools must never execute');},
    }));
    for(const tool of lateTools)socialAgent.ctx.tools.register(tool);
    // Reproduce the pre-fix presentation in this isolated offline fixture.
    const legacySchemas=lateTools.map(({name,description,parameters})=>({name,description,parameters}));
    const removeLegacyOverride=socialAgent.ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>({...await next(),tools:legacySchemas}),{prepend:true});
    const legacyFailure=await rpc('/followup',{...identity,message:'旧版定时工具污染复现'},true);
    assert.equal(legacyFailure.code,'INVALID_REQUEST','The fixture must reproduce the deferred-only failure');
    assert(calls.at(-1).tools.every(tool=>tool.deferLoading===true));
    removeLegacyOverride();
    const recovered=await rpc('/followup',{...identity,message:'修复后的历史工具隔离测试'});
    assert.equal(recovered.text,'SILENT');assert.equal(calls.at(-1).tools?.length ?? 0,0);
    assert(socialAgent.session.snapshotEvents().some(event=>event.type==='user/message'&&event.data.source?.socialToolMetadataRetired));
    assert(socialAgent.session.snapshotEvents().some(event=>event.type==='developer/message'&&event.data.message?.content.some(block=>block.type==='tool-addition')),'Original tool-change history must be retained for audit');
    const coding=await ctx.agents.create({sessionId:'coding-tool-isolation-fixture',meta:{cwd:fixture},agentOptions:{provider:'offline-test',model:'test-image'}});
    coding.agent.ctx.tools.register(lateTools[0]);
    const codingAssembly=await ctx.systemPrompt.assemble({scope:coding.agent});
    assert(codingAssembly.tools.some(tool=>tool.name==='schedule_create'),'Ordinary Agent tools must not be hidden');
    await coding.dispose();
    await rpc('/followup',{...identity,message:'测试原生图片',images:[{id:imageId}]});
    assert(calls.some(call=>call.messages.some(message=>message.content?.some(block=>block.type==='image'))),'Image must reach the real runtime adapter');
    await new Promise(resolve=>setTimeout(resolve,100));
    const agent=ctx.agents.get(configured.sessionId);
    assert(agent.session.snapshotEvents().some(event=>event.type==='image/offload'),'Completed images must be offloaded');
    failVision=true;
    const badVision=await rpc('/followup',{...identity,message:'离线验证失败的图片',images:[{id:imageId}]},true);
    assert.equal(badVision.code,'INVALID_REQUEST');failVision=false;
    const textAfterVision=await rpc('/followup',{...identity,message:'异常图片之后继续文字'});
    assert.equal(textAfterVision.sessionId,configured.sessionId);assert.equal(textAfterVision.text,'SILENT');
    assert((await rpc('/compact',{conversationKey:key})).compacted);
    await rpc('/followup',{...identity,message:'压缩后测试消息'});
    session=(await rpc('/sessions')).sessions[0]; assert.equal(session.initializations,2);assert.equal(session.sessionId,configured.sessionId);
    // A real first turn with enabled extension instructions used to append a
    // user slot before DSH's protected system head. The mock previously hid it.
    fs.mkdirSync(path.join(fixture,'config'),{recursive:true});
    fs.writeFileSync(path.join(fixture,'config/wechatagent.json'),JSON.stringify({wechat:{whitelist:{private:['123'],groups:[]},search:{enabled:true}}}));
    const searchIdentity={...identity,conversationKey:'wechat:private:123',conversationName:'空会话系统消息头验收'};
    const searchConfigured=await rpc('/configure',searchIdentity);
    assert.equal(ctx.agents.get(searchConfigured.sessionId).session.surface.nodes.length,0);
    await rpc('/followup',{...searchIdentity,message:'离线验证扩展首次写入，不实际联网，只输出 SILENT。'});
    const firstSurface=ctx.agents.get(searchConfigured.sessionId).session;
    assert.equal(firstSurface.eventAt(firstSurface.surface.nodes[0]).type,'system/message');
    assert.equal(firstSurface.surface.nodes.map(seq=>firstSurface.eventAt(seq)).filter(e=>e.data.source?.socialInstructionSlot==='extensions').length,1);
    const damagedIdentity={...identity,conversationKey:'wechat:private:456',conversationName:'旧错误历史的隔离恢复验收'};
    const damagedConfigured=await rpc('/configure',damagedIdentity);
    // Recreate the OLD early slot write in isolated offline data only.
    ctx.agents.get(damagedConfigured.sessionId).session.append('user/message',sdk.createUserMessage({content:[{type:'text',text:'旧版在 system head 之前写入的扩展说明'}],source:{kind:'wechat-social-bridge',socialInstructionSlot:'extensions'}}),{surfaceOp:'append'});
    await rpc('/followup',{...damagedIdentity,message:'生成旧顺序的离线历史，只输出 SILENT。'},true);
    await ctx.fiber.dispose();ctx=undefined;
    const files=[];const visit=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())visit(file);else files.push(file);}};visit(home);
    const damagedLog=files.find(file=>file.includes(damagedConfigured.sessionId+path.sep)&&file.endsWith('session.v4.jsonl.zstd'));
    assert(damagedLog,'damaged fixture must have a real compressed history');
    const damagedHash=crypto.createHash('sha256').update(fs.readFileSync(damagedLog)).digest('hex');
    ctx=await boot.boot('WeChatAgent compatibility resume',configFile,[],undefined,pathToFileURL(path.join(source,'resources/app.asar/dsh/package.json')).href);
    ctx.llm.registerAdapter(['offline-test'],new Adapter());
    await rpc('/followup',{...identity,message:'重载运行时后的续聊测试'});
    session=(await rpc('/sessions')).sessions[0];assert.equal(session.sessionId,configured.sessionId);assert.equal(session.initializations,2);
    await rpc('/followup',{...searchIdentity,message:'重载真实压缩日志后继续，只输出 SILENT。'});
    assert.equal((await rpc('/sessions')).sessions.find(item=>item.conversationKey===searchIdentity.conversationKey).sessionId,searchConfigured.sessionId);
    const recoveredSession=await rpc('/configure',damagedIdentity);
    assert.notEqual(recoveredSession.sessionId,damagedConfigured.sessionId);
    assert.equal(recoveredSession.recovery.reason,'SYSTEM_HEAD_MISSING');assert.equal(recoveredSession.recovery.historyRestored,false);
    assert(fs.existsSync(path.join(fixture,recoveredSession.recovery.backup)));
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(damagedLog)).digest('hex'),damagedHash);
    await rpc('/followup',{...damagedIdentity,message:'替代会话正常续聊，只输出 SILENT。'});
    await ctx.fiber.dispose();ctx=undefined;
    ctx=await boot.boot('WeChatAgent recovered history resume',configFile,[],undefined,pathToFileURL(path.join(source,'resources/app.asar/dsh/package.json')).href);
    ctx.llm.registerAdapter(['offline-test'],new Adapter());
    const continued=await rpc('/followup',{...damagedIdentity,message:'替代会话再次重启后继续，只输出 SILENT。'});
    assert.equal(continued.sessionId,recoveredSession.sessionId);
    fs.mkdirSync(path.join(fixture,'config'),{recursive:true});
    fs.writeFileSync(path.join(fixture,'config/wechatagent.json'),JSON.stringify({wechat:{whitelist:{private:['321'],groups:[]}}}));
    const workspaceIdentity={...identity,conversationKey:'wechat:private:321',conversationName:'工作区移动验收'};
    readerConversationKey=workspaceIdentity.conversationKey;
    const workspaceSource=await rpc('/followup',{...workspaceIdentity,message:'需要保留的聊天事实：标识为 workspace-42。',images:[{id:imageId}]});
    const sourceAgent=ctx.agents.get(workspaceSource.sessionId),sourceEvents=sourceAgent.session.snapshotEvents();
    assert(sourceEvents.some(event=>event.type==='image/offload'));
    const workspaceList=await rpc('/session-groups');assert.equal(workspaceList.available,true);
    const workspacePath=path.join(fixture,'目标 工作区');fs.mkdirSync(workspacePath);
    const workspaceCreated=await rpc('/session-groups/create',{title:'聊天分组',path:workspacePath,revision:workspaceList.revision});
    const targetGroup=workspaceCreated.groups.find(item=>item.path===workspacePath);assert(targetGroup);
    const callsBeforeMove=calls.length;
    const workspaceMoved=await rpc('/session-groups/move',{conversationKey:workspaceIdentity.conversationKey,expectedSessionId:workspaceSource.sessionId,groupId:targetGroup.id,confirmed:true});
    assert(workspaceMoved.historyCopied);assert.notEqual(workspaceMoved.sessionId,workspaceSource.sessionId);assert.equal(calls.length,callsBeforeMove);
    const movedSession=ctx.agents.get(workspaceMoved.sessionId).session;
    assert.equal(movedSession.header.cwd,workspacePath);assert.equal(movedSession.header.parentSession,workspaceSource.sessionId);
    assert.deepEqual(movedSession.snapshotEvents().slice(0,sourceEvents.length),sourceEvents);
    assert.equal(movedSession.eventAt(movedSession.surface.nodes[0]).type,'system/message');
    assert(ctx.workspaceRegistry.get(targetGroup.id).sessionIds.includes(workspaceMoved.sessionId));assert(ctx.workspaceRegistry.archivedSessionIds.includes(workspaceSource.sessionId));
    await rpc('/followup',{...workspaceIdentity,message:'请承接刚才保存的聊天事实，只回复 SILENT。'});
    assert(JSON.stringify(calls.at(-1).messages).includes('workspace-42'));
    await ctx.fiber.dispose();ctx=undefined;
    ctx=await boot.boot('WeChatAgent workspace resume',configFile,[],undefined,pathToFileURL(path.join(source,'resources/app.asar/dsh/package.json')).href);
    ctx.llm.registerAdapter(['offline-test'],new Adapter());
    const workspaceResumed=await rpc('/followup',{...workspaceIdentity,message:'移动后的会话重启恢复验收，只回复 SILENT。'});
    assert.equal(workspaceResumed.sessionId,workspaceMoved.sessionId);
    assert.equal((await rpc('/sessions')).sessions.find(item=>item.conversationKey===workspaceIdentity.conversationKey).groupId,targetGroup.id);
    assert(JSON.stringify(calls.at(-1).messages).includes('workspace-42'));
    // Exercise bounded generations in the real 0.2 runtime, including a paid-call-free social summary fixture.
    const historyKey='wechat:private:987',historyIdentity={...identity,conversationKey:historyKey,conversationName:'有界记忆验收'};
    fs.writeFileSync(path.join(fixture,'config/wechatagent.json'),JSON.stringify({wechat:{whitelist:{private:['987'],groups:[]},history:{enabled:true,maxSessionTurns:4,recentMessages:4}}}));
    const historyRows=Array.from({length:12},(_,i)=>({id:'history-'+i,platform:'wechat',kind:'private',conversation_id:'987',message_id:String(i),sender_id:'987',sender_name:'测试好友',text:i===0?'去年苏州桂花面的约定':'近期原文 '+i,timestamp:Date.now()/1000-600+i,processed:true}));
    fs.writeFileSync(path.join(fixture,'state/social-messages.json'),JSON.stringify({version:1,chats:{[historyKey]:historyRows},pendingReplies:{}}));
    const historyFirst=await rpc('/followup',{...historyIdentity,message:'有界记忆第一轮，只输出 SILENT。'});
    for(let i=1;i<4;i++)await rpc('/followup',{...historyIdentity,message:'有界记忆继续 '+i+'，只输出 SILENT。'});
    const oldHistoryAgent=ctx.agents.get(historyFirst.sessionId),oldHistoryEvents=structuredClone(oldHistoryAgent.session.snapshotEvents()),oldHistoryPath=fs.readdirSync(path.join(home,'sessions'),{recursive:true}).map(name=>path.join(home,'sessions',name)).find(file=>file.includes(oldHistoryAgent.session.id+path.sep)&&file.endsWith('session.v4.jsonl.zstd')),oldHistoryHash=crypto.createHash('sha256').update(fs.readFileSync(oldHistoryPath)).digest('hex');
    const historyNext=await rpc('/followup',{...historyIdentity,message:'跨代续聊，只输出 SILENT。',batchId:'f'.repeat(64)});
    assert.notEqual(historyNext.sessionId,historyFirst.sessionId);assert(!ctx.agents.get(historyFirst.sessionId));
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(oldHistoryPath)).digest('hex'),oldHistoryHash);
    assert(JSON.stringify(calls.at(-1).messages).includes('近期原文 11'));assert(JSON.stringify(calls.at(-1).messages).includes('去年苏州桂花面的约定'));
    const historyAgent=ctx.agents.get(historyNext.sessionId),historyBeforeCache=calls.length;
    assert.equal((await rpc('/followup',{...historyIdentity,message:'跨代续聊，只输出 SILENT。',batchId:'f'.repeat(64)})).cached,true);assert.equal(calls.length,historyBeforeCache);
    assert.equal(historyAgent.session.snapshotEvents().filter(e=>e.data.source?.socialMemorySeed).length,1);
    const {HistoryStore}=await import(pathToFileURL(path.join(plugin,'history-store.mjs')).href);const historyStore=new HistoryStore(fixture);
    assert(historyStore.search(historyKey,'桂花面').length);assert(historyStore.checkpoint(historyKey));assert.equal(historyStore.db.prepare('SELECT count(*) n FROM native_events WHERE session=?').get(historyFirst.sessionId).n,oldHistoryEvents.length);historyStore.close();
    await ctx.fiber.dispose();ctx=undefined;ctx=await boot.boot('Bounded history restart',configFile,[],undefined,pathToFileURL(path.join(source,'resources/app.asar/dsh/package.json')).href);ctx.llm.registerAdapter(['offline-test'],new Adapter());
    assert.equal((await rpc('/followup',{...historyIdentity,message:'跨代重启恢复，只输出 SILENT。'})).sessionId,historyNext.sessionId);
    // A stable visible Session with a freshly bounded request on every turn.
    const windowConfig={wechat:{whitelist:{private:['987'],groups:[]},history:{enabled:true,mode:'window',recentMessages:4,recentChars:2000,maxSessionTurns:4,maxSessionEvents:100,maxContextTokens:8000}}};
    fs.writeFileSync(path.join(fixture,'config/wechatagent.json'),JSON.stringify(windowConfig));
    const archive=new HistoryStore(fixture);archive.append(historyKey,{id:'ancient-display',message_id:'ancient-display',sender_id:'987',sender_name:'测试好友',text:'DISPLAY_ONLY_SECRET: 周五去过兰亭书店',timestamp:Date.now()/1000-10000});archive.close();
    const visibleId=historyNext.sessionId,visibleAgent=ctx.agents.get(visibleId),beforeWindow=structuredClone(visibleAgent.session.snapshotEvents());
    const firstWindow=await rpc('/followup',{...historyIdentity,message:'WINDOW_NEW_MESSAGE 只输出 SILENT。'});assert.equal(firstWindow.sessionId,visibleId);
    assert(!JSON.stringify(calls.at(-1).messages).includes('DISPLAY_ONLY_SECRET'));assert(!JSON.stringify(calls.at(-1).messages).includes('去年苏州桂花面的约定'));assert(JSON.stringify(calls.at(-1).messages).includes('近期原文 11'));
    assert(!calls.at(-1).messages.some(m=>m.source?.socialMemorySeed||m.source?.socialDisplayOnly));
    const visibleEvents=visibleAgent.session.snapshotEvents();assert.deepEqual(visibleEvents.slice(0,beforeWindow.length),beforeWindow);
    assert(visibleEvents.some(e=>e.surfaceOp==='append'&&e.data.source?.socialDisplayOnly&&JSON.stringify(e.data).includes('DISPLAY_ONLY_SECRET')));
    const cacheTools=['z_cache_probe','a_cache_probe'].map(name=>({name,description:'offline cache-order fixture',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[]},execute:async()=>({})}));
    Object.defineProperty(visibleAgent.ctx,Symbol.for('wechatagent.extension-tools.v1'),{configurable:true,value:{names:()=>new Set(cacheTools.map(t=>t.name)),check:name=>cacheTools.some(t=>t.name===name)}});
    let cacheDisposers=[],fixedPrefix,stableToolSchema;
    for(let i=0;i<12;i++){
      cacheDisposers.forEach(dispose=>dispose());cacheDisposers=(i%2?[...cacheTools].reverse():cacheTools).map(tool=>visibleAgent.ctx.tools.register(tool));
      assert.equal((await rpc('/followup',{...historyIdentity,message:'WINDOW_ROUND_'+i+' 只输出 SILENT。'})).sessionId,visibleId);
      const call=calls.at(-1),tools=call.tools.map(tool=>tool.name);assert.deepEqual(tools,[...tools].sort());assert(tools.includes('a_cache_probe')&&tools.includes('z_cache_probe'));
      const schema=JSON.stringify(call.tools);if(stableToolSchema)assert.equal(schema,stableToolSchema);stableToolSchema=schema;
      const input=call.messages.find(message=>message.source?.socialInputWindow),source=input.source.socialInputWindow;
      assert.equal(source.prefixPlacement,'native-system');
      const prefix=call.messages[0].content.map(block=>block.text??'').join('');assert.equal(call.messages[0].role,'system');assert(prefix.includes('WeChatAgent 当前人格与规则：'));assert(!input.content[0].text.includes('WeChatAgent 当前人格与规则：'));
      if(fixedPrefix)assert.equal(prefix,fixedPrefix);fixedPrefix=prefix;
      const lastUser=call.messages.findLast(message=>message.role==='user');assert(JSON.stringify(lastUser).includes('本机发送要求：最终输出 RESPOND: 正文 或 SILENT'));
    }
    cacheDisposers.forEach(dispose=>dispose());delete visibleAgent.ctx[Symbol.for('wechatagent.extension-tools.v1')];
    const echoText='CONFIRMED_DEDUP_SENTINEL 这是已经确认发送的回复。';
    const echoArchive=new HistoryStore(fixture);echoArchive.append(historyKey,{id:'confirmed-echo',message_id:'confirmed-echo',sender_id:'987',sender_name:'AI',outgoing:true,delivery_status:'confirmed',text:echoText,timestamp:Date.now()/1000});echoArchive.close();
    const {buildPrivatePrompt}=await import(pathToFileURL(path.join(project,'components/qq-bridge/src/core/social-engine.js')).href);
    const echoPrompt=buildPrivatePrompt({key:historyKey,rows:[{sender_id:'987',text:'WINDOW_DEDUP_CURRENT_MESSAGE',timestamp:Date.now()/1000}],previousReply:{text:echoText,delivery_status:'confirmed'}});
    await rpc('/followup',{...historyIdentity,message:echoPrompt,batchId:'c'.repeat(64)});
    const echoCall=calls.at(-1),echoInput=echoCall.messages.findLast(message=>message.source?.socialWindowReplyDedup);
    assert(echoInput);assert(echoInput.source.socialWindowReplyDedup>0);assert(!echoInput.content[0].text.includes('<previous_reply>'));assert(JSON.stringify(echoCall.messages).includes('WINDOW_DEDUP_CURRENT_MESSAGE'));assert.equal(JSON.stringify(echoCall.messages).split(echoText).length-1,1);
    const echoStatus=(await rpc('/sessions')).sessions.find(s=>s.sessionId===visibleId);assert(echoStatus.history.request.duplicateReplyCharsRemoved>0);
    console.log(JSON.stringify({confirmedWindowReplyDedup:true,canonicalReplyStillInWindow:true,currentInputPreserved:true}));
    console.log(JSON.stringify({stableToolSchemaAcrossRegistrationOrder:true,fixedPersonaPrefixAcrossTurns:true,hostOutputContractOutsideChat:true}));
    assert(!JSON.stringify(calls.at(-1).messages).includes('WINDOW_ROUND_0'));assert(!ctx.workspaceRegistry.archivedSessionIds.includes(visibleId));
    const toolStart=calls.length;await rpc('/followup',{...historyIdentity,message:'WINDOW_HISTORY_LOOKUP 查询旧事，只输出 SILENT。'});
    const toolCalls=calls.slice(toolStart);assert.equal(toolCalls.length,2);assert(toolCalls[0].tools.some(t=>t.name==='wechat_history_search'));
    assert(!toolCalls[0].messages.some(m=>m.role==='tool'));assert(toolCalls[1].messages.some(m=>m.role==='tool'&&JSON.stringify(m).includes('DISPLAY_ONLY_SECRET')));
    const batchStart=calls.length;const batchReply=await rpc('/followup',{...historyIdentity,message:'WINDOW_BATCHED_HISTORY 查询并展开旧事。'});
    assert.equal(batchReply.text,'RESPOND: 旧事已核对。');assert.equal(calls.length-batchStart,3);
    const batchRequests=calls.slice(batchStart);assert(batchRequests.every(call=>JSON.stringify(call.tools)===JSON.stringify(batchRequests[0].tools)),'Budget notes must not change the tool schema between continuation steps');
    const metered=(await rpc('/sessions')).sessions.find(s=>s.sessionId===visibleId).usage;assert(metered.recent.calls>0);assert(metered.cumulative.P>=metered.recent.P);assert.equal(metered.latest.calls,1);
    console.log(JSON.stringify({batchedHistoryLookup:true,historyExpansionBudgetPreserved:true,historyToolReplyContract:true,usageRecentAndCumulative:true}));
    await rpc('/followup',{...historyIdentity,message:'WINDOW_AFTER_LOOKUP 只输出 SILENT。'});assert(!JSON.stringify(calls.at(-1).messages).includes('DISPLAY_ONLY_SECRET'));
    const displayPages=visibleAgent.session.snapshotEvents().filter(e=>e.data.source?.socialDisplayOnly).length;
    const cachedWindow='a'.repeat(64);await rpc('/followup',{...historyIdentity,message:'WINDOW_CACHED 只输出 SILENT。',batchId:cachedWindow});const beforeWindowCache=calls.length;
    assert.equal((await rpc('/followup',{...historyIdentity,message:'WINDOW_CACHED 只输出 SILENT。',batchId:cachedWindow})).cached,true);assert.equal(calls.length,beforeWindowCache);
    await ctx.fiber.dispose();ctx=undefined;ctx=await boot.boot('Window history restart',configFile,[],undefined,pathToFileURL(path.join(source,'resources/app.asar/dsh/package.json')).href);ctx.llm.registerAdapter(['offline-test'],new Adapter());
    assert.equal((await rpc('/followup',{...historyIdentity,message:'WINDOW_RESTART 只输出 SILENT。'})).sessionId,visibleId);
    const restartedWindow=ctx.agents.get(visibleId).session;assert.equal(restartedWindow.snapshotEvents().filter(e=>e.data.source?.socialDisplayOnly).length,displayPages);assert(!JSON.stringify(calls.at(-1).messages).includes('DISPLAY_ONLY_SECRET'));
    assert(restartedWindow.snapshotEvents().some(e=>e.surfaceOp==='append'&&JSON.stringify(e.data).includes('WINDOW_ROUND_0')));
    const interactionId='b'.repeat(64);await rpc('/followup',{...historyIdentity,message:'WINDOW_REPAIR_ORIGINAL_CONTEXT 只输出 SILENT。',batchId:interactionId});
    await rpc('/followup',{...historyIdentity,message:'本机发送格式校正：上一轮为空，仅修正发送格式。',batchId:crypto.createHash('sha256').update(interactionId+'\0format-repair-v4').digest('hex')});
    assert(JSON.stringify(calls.at(-1).messages).includes('WINDOW_REPAIR_ORIGINAL_CONTEXT'));
    await rpc('/followup',{...historyIdentity,message:'WINDOW_AFTER_REPAIR 只输出 SILENT。'});assert(!JSON.stringify(calls.at(-1).messages).includes('WINDOW_REPAIR_ORIGINAL_CONTEXT'));
    // Append only canonical evidence; keep drafts and old tool chains out.
    windowConfig.wechat.history.windowStrategy='append';fs.writeFileSync(path.join(fixture,'config/wechatagent.json'),JSON.stringify(windowConfig));
    let appendReuses=0,appendRotations=0;
    for(let i=0;i<14;i++){
      const appendArchive=new HistoryStore(fixture);appendArchive.append(historyKey,{id:'append-'+i,message_id:'append-'+i,sender_id:'987',sender_name:'测试好友',text:'CANONICAL_APPEND_'+i,timestamp:Date.now()/1000+i});appendArchive.close();
      await rpc('/followup',{...historyIdentity,message:'APPEND_CURRENT_'+i+' 只输出 SILENT。'});
      const call=calls.at(-1),input=call.messages.find(m=>m.source?.socialInputWindow),meta=input.source.socialInputWindow;
      assert.equal(meta.strategy,'bounded-append-v1');assert(meta.recentRecords<=8);assert.equal(meta.maxRecords,8);
      assert(input.content[0].text.includes('CANONICAL_APPEND_'+i));assert(!JSON.stringify(call.messages).includes('WINDOW_REPAIR_ORIGINAL_CONTEXT'));assert(!call.messages.some(m=>m.role==='tool'));
      if(meta.reused)appendReuses++;if(meta.resetReason==='count')appendRotations++;
    }
    assert(appendReuses>0);assert(appendRotations>0);
    const lastAppend=calls.at(-1).messages.find(m=>m.source?.socialInputWindow).content[0].text;
    await ctx.fiber.dispose();ctx=undefined;ctx=await boot.boot('Append window restart',configFile,[],undefined,pathToFileURL(path.join(source,'resources/app.asar/dsh/package.json')).href);ctx.llm.registerAdapter(['offline-test'],new Adapter());
    await rpc('/followup',{...historyIdentity,message:'APPEND_RESTART 只输出 SILENT。'});
    const resumedAppend=calls.at(-1).messages.find(m=>m.source?.socialInputWindow);assert.equal(resumedAppend.content[0].text,lastAppend);assert(resumedAppend.source.socialInputWindow.reused);
    const appendStatus=(await rpc('/sessions')).sessions.find(s=>s.sessionId===visibleId).history.request;assert.equal(appendStatus.strategy,'bounded-append-v1');assert(appendStatus.reused);
    console.log(JSON.stringify({boundedAppend:true,appendReuses,appendRotations,appendPersistedResume:true,appendNoDraftsOrToolHistory:true}));
    const stableWindowBefore=calls.at(-1).messages.find(m=>m.source?.socialInputWindow).content[0].text;
    const tailStart=calls.length,tailBatch='d'.repeat(64);
    await rpc('/followup',{...historyIdentity,message:'看看 https://example.com/fixture 只输出 SILENT。',batchId:tailBatch});
    const withTail=calls.at(-1),tail=withTail.messages.find(m=>m.source?.socialWindowTail),head=withTail.messages.find(m=>m.source?.socialInputWindow);
    assert(tail&&tail.content[0].text.includes('内置技能'));assert.equal(head.content[0].text,stableWindowBefore);assert(withTail.messages.indexOf(tail)>withTail.messages.indexOf(head));
    assert.equal(head.source.socialInputWindow.layout,'stable-window-tail-v2');
    assert(withTail.messages.at(-1).source.socialBatchId===tailBatch);assert(withTail.messages.at(-1).content[0].text.includes('最终输出 RESPOND:'));
    await rpc('/followup',{...historyIdentity,message:'本机发送格式校正：保持刚才的原意。',batchId:crypto.createHash('sha256').update(tailBatch+'\0format-repair-v4').digest('hex')});
    assert(calls.at(-1).messages.some(m=>m.source?.socialFormatRepair));assert(JSON.stringify(calls.at(-1).messages).includes('https://example.com/fixture'));
    await rpc('/followup',{...historyIdentity,message:'接着聊刚才那件事，只输出 SILENT。'});
    assert(!calls.at(-1).messages.some(m=>m.source?.socialWindowTail),'Expired webpage instructions must leave the next interaction');
    assert(!JSON.stringify(calls.at(-1).messages).includes('https://example.com/fixture'));
    assert.equal(calls.length-tailStart,3,'Context maintenance must not introduce model calls');
    const cacheStatus=(await rpc('/sessions')).sessions.find(s=>s.sessionId===visibleId).history;
    assert(cacheStatus.requests.length<=20);assert(cacheStatus.requests.some(r=>r.tailChars>0));assert(cacheStatus.requests.every(r=>r.usage?.U===100&&r.usage?.R===50));assert(cacheStatus.requests.at(-1).changedParts.includes('tail'));
    assert(!JSON.stringify(cacheStatus.requests).includes('example.com'),'Diagnostics must not expose raw input');
    console.log(JSON.stringify({separateDynamicTail:true,stableWindowUnchangedByWebpage:true,expiredTailRemoved:true,requestUsageLinked:true,noMaintenanceModelCalls:true}));
    const manualWindowCount=calls.length;assert.equal((await rpc('/compact',{conversationKey:historyKey})).sessionId,visibleId);assert.equal(ctx.agents.get(visibleId).session.id,visibleId);
    // Each owner persona is registered in that agent's system scope, including
    // literal template-looking text. Other social and coding scopes stay separate.
    const alternateKey='wechat:private:986',alternatePersona='这是其他聊天的独立人格 {{literal_fixture}}，只回复 SILENT。';
    windowConfig.wechat.whitelist.private.push('986');fs.writeFileSync(path.join(fixture,'config/wechatagent.json'),JSON.stringify(windowConfig));
    const roleFile=path.join(fixture,'state/bridge-config.json'),roleConfig=JSON.parse(fs.readFileSync(roleFile,'utf8'));
    roleConfig.roles[alternateKey]={name:'独立前缀',persona:alternatePersona};fs.writeFileSync(roleFile,JSON.stringify(roleConfig));
    await rpc('/followup',{conversationKey:alternateKey,personaName:'独立前缀',persona:alternatePersona,message:'独立系统前缀验收'});
    const alternateSystem=calls.at(-1).messages[0].content.map(b=>b.text??'').join('');assert(alternateSystem.includes(alternatePersona));assert(!alternateSystem.includes('WeChatAgent 当前人格与规则：\n'+historyIdentity.persona));
    await rpc('/followup',{...historyIdentity,message:'原聊天的系统前缀继续'});assert(!JSON.stringify(calls.at(-1).messages).includes(alternatePersona));
    console.log(JSON.stringify({nativeSystemPrefix:true,personaAbsentFromDynamicWindow:true,nativePrefixScopeIsolation:true,literalPersonaPreserved:true}));
    {
    const searchKey='wechat:private:985',searchIdentity={...historyIdentity,conversationKey:searchKey,conversationName:'首次搜索顺序验收'};
    const {SEARCH_DEFAULTS}=await import(pathToFileURL(path.join(plugin,'search-policy.mjs')).href);
    const {WebSearch}=await import(pathToFileURL(path.join(project,'components/qq-bridge/src/core/web-search.js')).href);
    windowConfig.wechat.whitelist.private.push('985');windowConfig.wechat.search={...SEARCH_DEFAULTS,enabled:true};fs.writeFileSync(path.join(fixture,'config/wechatagent.json'),JSON.stringify(windowConfig));
    const searchService=new WebSearch({configFile:path.join(fixture,'config/wechatagent.json'),stateFile:path.join(fixture,'state/search/state.json'),fetchImpl:async()=>new Response('<rss><channel><item><title>书店营业时间</title><link>https://docs.example.org/</link><description>OFFLINE_PREFETCH_SOURCE 书店营业时间来源摘要</description></item></channel></rss>')});
    const prefetched=await searchService.prepare(searchKey,[{text:'帮我搜索书店营业时间'}],'fresh-search-order');assert.equal(prefetched.status,'ready');
    readerConversationKey=searchKey;const countBeforePrefetch=calls.length;
    await rpc('/followup',{...searchIdentity,message:'看看 https://example.com/fixture 只输出 SILENT。',searchTicket:prefetched.id,searchContext:prefetched.context,batchId:'e'.repeat(64),images:[{id:imageId}]});
    const prefetchedCall=calls.at(-1),windowIndex=prefetchedCall.messages.findIndex(m=>m.source?.socialInputWindow),tailIndex=prefetchedCall.messages.findIndex(m=>m.source?.socialWindowTail),searchIndex=prefetchedCall.messages.findIndex(m=>m.source?.socialSearch),currentIndex=prefetchedCall.messages.findIndex(m=>m.source?.socialBatchId==='e'.repeat(64));
    assert(windowIndex>0);assert(tailIndex>windowIndex);assert(searchIndex>tailIndex);assert(currentIndex>searchIndex);assert(prefetchedCall.messages[currentIndex].content.some(b=>b.type==='image'));assert.deepEqual(prefetchedCall.messages[currentIndex].source.socialImageIds,[imageId]);assert.equal(calls.length,countBeforePrefetch+1);
    await rpc('/followup',{...searchIdentity,message:'普通的后续消息，只输出 SILENT。'});assert(!JSON.stringify(calls.at(-1).messages).includes('OFFLINE_PREFETCH_SOURCE'));
    console.log(JSON.stringify({freshPrefetchAfterStableWindow:true,prefetchBeforeCurrentMessage:true,prefetchImagePreserved:true,prefetchRetiredOnNextInteraction:true,noExtraModelCalls:true}));
    }
    {
      const {wakeContextHint}=await import(pathToFileURL(path.join(plugin,'request-window.mjs')).href);
      const {buildSocialPrompt}=await import(pathToFileURL(path.join(project,'components/qq-bridge/src/core/social-engine.js')).href);
      windowConfig.wechat.whitelist.groups.push('984','983');windowConfig.wechat.history.coldWakeMinutes=30;fs.writeFileSync(path.join(fixture,'config/wechatagent.json'),JSON.stringify(windowConfig));
      const at=Math.floor(Date.now()/1000),coldKey='wechat:group:984',memoryKey='wechat:group:983';
      const roles=JSON.parse(fs.readFileSync(roleFile,'utf8'));for(const key of [coldKey,memoryKey])roles.roles[key]={name:historyIdentity.personaName,persona:historyIdentity.persona};fs.writeFileSync(roleFile,JSON.stringify(roles));
      const old=Array.from({length:12},(_,i)=>({id:'cold-original-'+i,platform:'wechat',kind:'group',conversation_id:'984',sender_id:'42',sender_name:'群友',timestamp:at-4000+i,text:'COLD_ARCHIVE_OLD_'+i+' DISPLAY_ONLY_SECRET 兰亭书店周六约定'}));
      const current={...old[0],id:'cold-current',timestamp:at,text:'帮我介绍一下 Python 的用途'},memory={...current,id:'cold-memory',conversation_id:'983',text:'上次我们约在哪里？ WINDOW_HISTORY_LOOKUP'};
      const archive=new HistoryStore(fixture);for(const key of [coldKey,memoryKey])for(const row of old)archive.append(key,row);archive.append(coldKey,current);archive.append(memoryKey,memory);archive.close();
      const identity={...historyIdentity,conversationKey:coldKey},prompt=buildSocialPrompt({key:coldKey,rows:[current],direct:true,previousReply:{text:'COLD_OLD_ECHO',delivery_status:'confirmed'}}),before=calls.length;
      readerConversationKey=coldKey;
      const first=await rpc('/followup',{...identity,message:prompt,wakeContext:{...wakeContextHint([current]),direct:true},historyExcludeIds:[current.id],images:[{id:imageId}],batchId:'6'.repeat(64)});
      assert.equal(calls.length,before+1);const coldInput=calls.at(-1),coldText=JSON.stringify(coldInput.messages);assert(!coldText.includes('COLD_ARCHIVE_OLD_'));assert(!coldText.includes('COLD_OLD_ECHO'));assert(coldText.includes('Python'));assert(coldInput.messages.some(m=>m.content?.some(b=>b.type==='image')));
      const status=(await rpc('/sessions')).sessions.find(s=>s.sessionId===first.sessionId);assert.equal(status.history.request.contextSelection.mode,'independent');assert.equal(status.history.request.recentRecords,0);assert(status.history.request.usage);
      const next={...current,id:'cold-next',timestamp:at+1,text:'那你接着介绍其他用途'};const newer=new HistoryStore(fixture);newer.append(coldKey,next);newer.close();
      assert.equal((await rpc('/followup',{...identity,message:buildSocialPrompt({key:coldKey,rows:[next],direct:true}),wakeContext:{...wakeContextHint([next]),direct:true},historyExcludeIds:[next.id]})).sessionId,first.sessionId);
      const active=calls.at(-1).messages.find(m=>m.source?.socialInputWindow).source.socialInputWindow;assert.equal(active.selection,undefined);assert.equal(active.recentRecords,windowConfig.wechat.history.recentMessages);
      const lookupStart=calls.length;await rpc('/followup',{...historyIdentity,conversationKey:memoryKey,message:buildSocialPrompt({key:memoryKey,rows:[memory],direct:true}),wakeContext:{...wakeContextHint([memory]),direct:true},historyExcludeIds:[memory.id]});
      assert.equal(calls.length,lookupStart+2);assert.equal(calls[lookupStart].messages.find(m=>m.source?.socialInputWindow).source.socialInputWindow.recentRecords,0);assert(!JSON.stringify(calls[lookupStart].messages).includes('COLD_ARCHIVE_OLD_'));assert(calls.at(-1).messages.some(m=>m.role==='tool'&&JSON.stringify(m.content).includes('兰亭书店')));
      assert(ctx.agents.get(first.sessionId).session.snapshotEvents().some(e=>e.data.source?.socialDisplayOnly&&JSON.stringify(e.data).includes('COLD_ARCHIVE_OLD_')));
      console.log(JSON.stringify({coldWakeIndependentNoHistory:true,coldWakeImagePreserved:true,coldWakeNoClassifierCalls:true,coldWakeActiveWindowRestored:true,coldWakeHistoryToolLoop:true,coldWakeVisibleArchivePreserved:true}));
    }
    const result={dshVersion:actualVersion,realRuntime:true,coldWakeIndependentNoHistory:true,coldWakeHistoryToolLoop:true,coldWakeActiveWindowRestored:true,freshPrefetchAfterStableWindow:true,prefetchImagePreserved:true,continuousTranscript:true,perTurnRecentWindow:true,displayOnlyExcludedFromInput:true,oldSummaryNotInInput:true,historyLookupActualToolLoop:true,toolResultsTurnScoped:true,formatRepairRetainsCurrentInteraction:true,windowStableBeyondThreshold:true,windowPersistedResume:true,boundedSessionRotation:true,boundedSummaryCheckpoint:true,boundedRecentRaw:true,boundedRestartResume:true,boundedOriginalPreserved:true,boundedCacheNoExtraCall:true,model:'offline fixture adapter',workspaceCreation:true,workspaceHistoryMove:true,workspaceMoveNoModelCall:true,workspaceMovePersistedResume:true,workspaceOriginalArchived:true,sessionCreation:true,followup:true,persistedResume:true,emptySessionExtensionAdmission:true,extensionSessionPersistedResume:true,missingHeadAutoRecovery:true,damagedHistoryPreserved:true,imageAttachment:true,imageOffload:true,nativeCompaction:true,emptyTools:true,lateScopedToolIsolation:true,deferredOnlyFailureReproduced:true,legacyToolHistoryRecovered:true,codingToolsUnaffected:true,peerCompatibility:true,wechatMessagesSent:0};
    fs.writeFileSync(path.join(project,'state/dsh-020-runtime-verification.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
  } finally {
    if(ctx)await ctx.fiber.dispose();
    if(reader)await new Promise(resolve=>reader.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
