import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';
import {EventEmitter} from 'node:events';import {createRequire} from 'node:module';import {setImmediate as nextTurn} from 'node:timers/promises';
const source=path.resolve(import.meta.dirname,'../apps/console-desktop'),load=createRequire(path.join(source,'main.cjs'));
async function until(predicate){for(let i=0;i<60&&!predicate();i++)await nextTurn();assert(predicate(),'desktop lifecycle did not settle');}
async function fixture(t,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-desktop-exit-'));
  t.after(()=>{assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  const state={root,windows:[],messages:[],errors:[],prompts:[],migrations:[],deployments:[],legacyStops:0,dirty:false,answer:0,stops:0,closed:0,exited:false,stop:async()=>{}};
  const location={dataHome:path.join(root,'data'),migrationSource:path.join(root,'old')},plan={...location,needed:true,source:location.migrationSource,migrateDsh:true,managedDsh:true,oldDshHome:path.join(root,'old DSH')};
  if(options.packaged){fs.mkdirSync(path.join(root,'project'),{recursive:true});fs.writeFileSync(path.join(root,'project/deployment.json'),'{}');}
  const app=new EventEmitter(),ipcMain=new EventEmitter();
  app.isPackaged=!!options.packaged;app.setName=()=>{};app.setAppUserModelId=()=>{};app.setPath=()=>{};app.getPath=()=>root;app.requestSingleInstanceLock=()=>true;app.whenReady=()=>Promise.resolve();
  app.quit=()=>{
    const event={prevented:false,preventDefault(){this.prevented=true;}};app.emit('before-quit',event);if(event.prevented)return;
    for(const window of state.windows){if(window.destroyed)continue;window.close();if(!window.destroyed)return;}
    app.emit('will-quit');state.exited=true;
  };
  class Window extends EventEmitter{
    constructor(){super();this.destroyed=false;this.hidden=false;this.webContents=new EventEmitter();state.windows.push(this);
      Object.assign(this.webContents,{isDestroyed:()=>this.destroyed,setWindowOpenHandler(){},session:{setPermissionRequestHandler(){},setPermissionCheckHandler(){}},send:(name,value)=>{
        state.messages.push([name,value]);if(name==='desktop:check-unsaved')setImmediate(()=>ipcMain.emit('desktop:unsaved-answer',{sender:this.webContents,senderFrame:{url:'http://127.0.0.1:12341/'}},value,state.dirty));
      }});
    }
    setMenu(){}setTitleBarOverlay(){}setTitle(){}show(){this.hidden=false;}hide(){this.hidden=true;}focus(){}isMinimized(){return false;}restore(){}isMaximized(){return false;}getBounds(){return{x:0,y:0,width:900,height:620};}isDestroyed(){return this.destroyed;}
    async loadURL(){this.loaded=true;this.emit('ready-to-show');}
    async loadFile(){this.loading=true;}
    destroy(){this.destroyed=true;}
    close(){const event={prevented:false,preventDefault(){this.prevented=true;}};this.emit('close',event);if(event.prevented)return;
      if(state.dirty){const unload={allowed:false,preventDefault(){this.allowed=true;}};this.webContents.emit('will-prevent-unload',unload);if(!unload.allowed)return;}
      this.destroyed=true;
    }
  }
  class Tray extends EventEmitter{setToolTip(){}setContextMenu(menu){state.trayMenu=menu;}isDestroyed(){return false;}destroy(){state.trayDestroyed=true;}}
  const dialog={showMessageBoxSync:(_window,prompt)=>{state.prompts.push(prompt);return prompt.title==='迁移旧版数据'?options.migrationAnswer??0:prompt.title==='保留旧 DSH 数据'?options.fallbackAnswer??0:state.answer;},showMessageBox:async()=>({response:0}),showErrorBox:(title,message)=>state.errors.push([title,message])};
  ipcMain.handle=()=>{};
  const electron={app,BrowserWindow:Window,Menu:{setApplicationMenu(){},buildFromTemplate:items=>items},Tray,nativeImage:{createFromPath:()=>({resize(){return this;}})},dialog,ipcMain,screen:{getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1280,height:720}})},shell:{}};
  const consoleApp={start:async()=>({port:12341}),isBusy:()=>false,shutdown:async()=>{state.stops++;await state.stop();},close:()=>{state.closed++;}};
  let code=fs.readFileSync(path.join(source,'main.cjs'),'utf8');
  const importExpression="await import(pathToFileURL(path.join(root, 'scripts/console-server.mjs')).href)";
  assert(code.includes(importExpression));code=code.replace(importExpression,'({createConsole:()=>fixtureConsole})');
  code=code.replace("await import(pathToFileURL(path.join(root, 'scripts/project-config.mjs')).href)",'({prepare(){}})');
  const storage=load('./storage-location.cjs'),fakeStorage={...storage,resolveStorageLocation:()=>location,migrationPlan:()=>plan,stopLegacyServices:async()=>{state.legacyStops++;},prepareDataHome:async current=>{
    state.migrations.push({...current});if(options.migrationError&&state.migrations.length===1)throw options.migrationError;
    return {migrated:true,report:{version:1,source:current.source,managedDsh:current.managedDsh,oldDshHome:current.oldDshHome,dshCopied:current.migrateDsh,...(current.dshRetained?{dshRetained:true}:{})}};
  }};
  const context={fixtureConsole:consoleApp,process:{pid:process.pid,resourcesPath:root,env:{WECHATAGENT_NODE_EXECUTABLE:process.execPath}},__dirname:source,setTimeout,clearTimeout,console,
    require:id=>id==='electron'?electron:id==='./desktop-policy.cjs'?{projectDirectory:()=>root,safeNavigation:()=>true,externalWebUrl:()=>null,windowPlacement:()=>({width:900,height:620})}:id==='./appearance.cjs'?{createAppearanceStore:()=>({read:()=>({})}),strengthOf:x=>x}:options.packaged&&id==='./storage-location.cjs'?fakeStorage:options.packaged&&id==='./deployment.cjs'?{bootstrapDeployment:async(_resources,dataHome,_progress,settings)=>{state.deployments.push({...settings});return {node:process.execPath,root:path.join(dataHome,'workspace')};}}:load(id)};
  vm.runInNewContext(code,context,{filename:path.join(source,'main.cjs')});await until(()=>state.windows.some(window=>window.loaded)||state.exited);
  return {...state,get stops(){return state.stops;},get exited(){return state.exited;},get closed(){return state.closed;},state,app,plan,window:state.windows.find(window=>window.loaded)||state.windows[0]};
}
test('actual desktop wiring keeps X in tray and waits for its services before quitting',async t=>{
  const f=await fixture(t);f.window.close();assert.equal(f.window.hidden,true);assert.equal(f.window.destroyed,false);assert.equal(f.stops,0);
  let release;f.state.stop=()=>new Promise(resolve=>{release=resolve;});f.state.trayMenu.find(item=>item.label==='退出应用').click();
  await until(()=>f.stops===1);assert.equal(f.exited,false);assert.equal(f.closed,0);release();await until(()=>f.exited);
  assert.equal(f.closed,1);assert.equal(fs.existsSync(path.join(f.root,'state/desktop/runtime.json')),false);
});
test('actual desktop wiring respects unsaved changes and confirms before stopping services',async t=>{
  const f=await fixture(t);f.state.dirty=true;f.state.answer=0;f.app.quit();await until(()=>f.state.messages.some(([,value])=>value==='idle'));
  assert.equal(f.stops,0);assert.equal(f.window.destroyed,false);
  f.state.answer=1;f.app.quit();await until(()=>f.exited);assert.equal(f.stops,1);assert.equal(f.state.errors.length,0);
});
test('actual desktop wiring retains the window on a failed stop and allows retry',async t=>{
  const f=await fixture(t);f.state.stop=async()=>{throw Error('fixture stop failed');};f.app.quit();await until(()=>f.state.errors.length===1);
  assert.equal(f.exited,false);assert.equal(f.window.destroyed,false);assert.equal(f.closed,0);
  f.state.stop=async()=>{};f.app.quit();await until(()=>f.exited);assert.equal(f.stops,2);
});
test('installed startup offers DSH retention, continues deployment and cancels without stopping legacy services',async t=>{
 for(const answer of [0,1,2]){
  const f=await fixture(t,{packaged:true,migrationAnswer:answer}),prompt=f.state.prompts[0];
  assert.deepEqual(Array.from(prompt.buttons),['停止旧服务并迁移','保留旧 DSH','暂不启动']);assert.equal(prompt.cancelId,2);assert.equal(prompt.defaultId,1);
  if(answer===2){assert(f.exited);assert.equal(f.state.legacyStops,0);assert.equal(f.state.migrations.length,0);assert.equal(f.state.deployments.length,0);continue;}
  assert(!f.exited);assert.equal(f.state.errors.length,0);assert.equal(f.state.legacyStops,1);assert.equal(f.state.migrations.length,1);assert.equal(f.state.migrations[0].migrateDsh,answer===0);
  assert.equal(f.state.deployments[0].dshHome,answer===1?f.plan.oldDshHome:path.join(f.plan.dataHome,'dsh'));
  if(answer===1){assert.equal(f.state.migrations[0].dshRetained,true);assert.equal(f.state.deployments[0].externalDshHome,f.plan.oldDshHome);}
 }
});
test('a DSH external-link failure offers retention, while other failures never silently skip data',async t=>{
 for(const mode of ['retain','cancel','unrelated']){
  const error=Object.assign(Error('fixture migration failed'),{code:mode==='unrelated'?'UNSUPPORTED_WORKSPACE_LINK':'DSH_EXTERNAL_LINK'});
  const f=await fixture(t,{packaged:true,migrationAnswer:0,fallbackAnswer:mode==='cancel'?1:0,migrationError:error});
  assert.equal(f.state.legacyStops,1);
  if(mode==='retain'){assert(!f.exited);assert.equal(f.state.migrations.length,2);assert.equal(f.state.migrations[1].dshRetained,true);assert.equal(f.state.deployments[0].dshHome,f.plan.oldDshHome);assert.equal(f.state.errors.length,0);}
  else {assert(f.exited);assert.equal(f.state.migrations.length,1);assert.equal(f.state.deployments.length,0);assert.equal(f.state.errors.length,mode==='unrelated'?1:0);}
  assert.equal(f.state.prompts.length,mode==='unrelated'?1:2);
 }
});
