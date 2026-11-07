const fs=require('node:fs');
const path=require('node:path');

const retiredDirectories=Object.freeze(['components/weflow-cli','scripts/native-hook']);
const retiredFiles=Object.freeze([
  'scripts/reader-api.py','scripts/resolve-wechat-image.py','scripts/reader_setup.py',
  'scripts/reader-setup.mjs','scripts/reader-account-state.mjs','scripts/reader-requirements.txt',
  'scripts/sync-weflow.cjs','scripts/build-hook.ps1','scripts/build-hook-current.ps1',
  'scripts/load-hook-current.ps1','scripts/hook-build-policy.mjs','scripts/hook-profiles.mjs',
  'scripts/configure-hook.mjs','scripts/pin-hook-client.ps1','scripts/wechat-account-check.mjs',
  'scripts/hook-client-health.ps1',
]);
function retiredHookProgram(relative){
  const file=relative.replaceAll('\\','/');
  return retiredFiles.includes(file)||retiredDirectories.some(dir=>file===dir||file.startsWith(dir+'/'));
}
function assertHookOnlyFiles(files){
  const retired=files.filter(retiredHookProgram);
  if(retired.length)throw Error('Retired WeChat connection files in package: '+retired.join(', '));
}
function assertHookRuntime(runtime){
  const python=path.join(runtime,'python'),site=path.join(python,'Lib','site-packages');
  const dependencies=JSON.parse(fs.readFileSync(path.join(python,'DEPENDENCIES.json'),'utf8'));
  if(dependencies.some(item=>/sqlcipher/i.test(item.name))||(fs.existsSync(site)&&fs.readdirSync(site).some(name=>/sqlcipher/i.test(name))))throw Error('Retired database dependency in Hook runtime; rebuild the bundled runtime.');
}
function retireLegacyHook(workspace){
  const base=path.resolve(workspace),retired=[];
  if(!fs.existsSync(base))return {retired};
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const backup=path.join(base,'state','maintenance','retired-hook-'+stamp);
  for(const relative of [...retiredDirectories,...retiredFiles]){
    const target=path.resolve(base,relative);
    if(!target.startsWith(base+path.sep))throw Error('Retired program path escaped project');
    if(!fs.existsSync(target))continue;
    for(let current=target;;current=path.dirname(current)){
      if(fs.lstatSync(current).isSymbolicLink())throw Error('Cannot retire a linked project program: '+relative);
      if(current===base)break;
    }
    const saved=path.resolve(backup,relative);
    if(!saved.startsWith(backup+path.sep))throw Error('Retired program backup escaped project');
    for(let current=path.dirname(saved);;current=path.dirname(current)){
      if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('Cannot archive programs through a linked project directory');
      if(current===base)break;
    }
    fs.mkdirSync(path.dirname(saved),{recursive:true});
    fs.renameSync(target,saved);
    retired.push(relative);
  }
  if(retired.length)fs.writeFileSync(path.join(backup,'retirement.json'),JSON.stringify({retired,scope:'project-program-files-only',wechatClientModified:false},null,2)+'\n');
  return {retired,...(retired.length?{backup}:{})};
}
module.exports={retiredDirectories,retiredFiles,retiredHookProgram,assertHookOnlyFiles,assertHookRuntime,retireLegacyHook};
