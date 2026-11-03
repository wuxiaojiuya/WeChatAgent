import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createConsole} from './console-server.mjs';import {createWorkspaceLayout} from '../public/console/workspace-layout.js';

test('the sending page exposes an integer candidate control without changing a draft when it is opened',async()=>{
 const draft={wechat:{stickers:{enabled:true}},persona:{default:'fixture'}},before=JSON.stringify(draft),fields=[];
 const ui=createWorkspaceLayout({state:{draft,stickerSection:'sending'},escapeHtml:value=>String(value),icon:()=>'',header:(title,description)=>'<h2>'+title+'</h2><p>'+description+'</p>',toggle:()=>'',field:(label,key,options)=>{fields.push({label,key,options});return '<label>'+label+'</label>';},getCards:()=>({})});
 const html=await ui.stickersPage();assert.equal(fields.length,1);assert.equal(fields[0].key,'wechat.stickers.candidateLimit');assert.equal(fields[0].options.type,'number');assert.equal(fields[0].options.min,1);assert.equal(fields[0].options.max,20);assert.equal(fields[0].options.step,1);assert.equal(fields[0].options.required,true);assert(html.includes('每轮候选数量'));assert(fields[0].options.help.includes('默认 8'));assert.equal(JSON.stringify(draft),before);
});

test('candidate-only API saves persist live settings without pending restarts and reject invalid or conflicting updates',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'candidate-settings-'));for(const dir of ['config','roles','state'])fs.mkdirSync(path.join(root,dir),{recursive:true});
 const config=JSON.parse(fs.readFileSync('config/wechatagent.example.json','utf8')),file=path.join(root,'config/wechatagent.json');fs.writeFileSync(file,JSON.stringify(config));fs.writeFileSync(path.join(root,'roles',config.persona.default+'.md'),'Fixture persona');
 const app=createConsole({root,port:0,fetchImpl:async()=>new Response('{}'),runner:async()=>0,processProbe:async()=>[]}),address=await app.start();t.after(async()=>{app.server.closeAllConnections();if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+address.port,info=await fetch(base+'/api/info').then(r=>r.json()),headers={'X-Console-Token':info.token,'Content-Type':'application/json'};
 const read=()=>fetch(base+'/api/config',{headers}).then(r=>r.json()),original=await read(),draft=structuredClone(original.config);draft.wechat.stickers.candidateLimit=20;
 const saved=await fetch(base+'/api/config',{method:'POST',headers,body:JSON.stringify({revision:original.revision,config:draft})});assert.equal(saved.status,200);const result=await saved.json();assert.equal(result.config.wechat.stickers.candidateLimit,20);assert(!result.pendingApply);assert(!result.dshRestartRequired);assert.deepEqual(result.config.persona,original.config.persona);assert.deepEqual(result.config.wechat.whitelist,original.config.wechat.whitelist);
 const bytes=fs.readFileSync(file);for(const value of [0,21,-1,1.5,'8',null,true]){const invalid=structuredClone(result.config);invalid.wechat.stickers.candidateLimit=value;const response=await fetch(base+'/api/config',{method:'POST',headers,body:JSON.stringify({revision:result.revision,config:invalid})});assert.equal(response.status,400);assert.deepEqual(fs.readFileSync(file),bytes);}
 draft.wechat.stickers.candidateLimit=3;assert.equal((await fetch(base+'/api/config',{method:'POST',headers,body:JSON.stringify({revision:original.revision,config:draft})})).status,409);assert.equal((await read()).config.wechat.stickers.candidateLimit,20);
});
