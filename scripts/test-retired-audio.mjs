import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import retired from '../apps/console-desktop/retired-audio.cjs';

const fixture=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'retired-audio-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const write=(root,relative,value='fixture')=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
test('upgrade removes only obsolete managed singing environments and retains voices, speech, covers and credentials',t=>{
  const root=fixture(t),keep=['state/rvc-models/custom/model.pth','state/voice-profiles/custom/profile.json','state/music-output/song.mp3',
    'state/maintenance/audio-capabilities/feiyu-tts/venv/speech.bin','state/maintenance/audio-capabilities/feiyu-cover/models/rvc.pth','config/wechatagent.json'];
  for(const file of keep)write(root,file);
  for(const file of retired.RETIRED_FILES)write(root,file);
  for(const folder of retired.RETIRED_RUNTIME.slice(0,2))write(root,folder+'/source/pretrained_models/model.pt');
  write(root,retired.RETIRED_RUNTIME[2]);
  const result=retired.retireSoulx(root);assert.equal(result.retained.length,0);
  for(const file of [...retired.RETIRED_FILES,...retired.RETIRED_RUNTIME])assert(!fs.existsSync(path.join(root,file)));
  for(const file of keep)assert.equal(fs.readFileSync(path.join(root,file),'utf8'),'fixture');
  assert.deepEqual(retired.retireSoulx(root),{version:1,removed:[],retained:[]});
});
test('cleanup skips an environment reached through a junction and never removes its external content',t=>{
  const root=fixture(t),outside=fixture(t),target=path.join(root,retired.RETIRED_RUNTIME[0]);
  write(outside,'model.pt');fs.mkdirSync(path.dirname(target),{recursive:true});fs.symlinkSync(outside,target,process.platform==='win32'?'junction':'dir');
  assert.equal(retired.retireSoulx(root).retained.length,1);assert.equal(fs.readFileSync(path.join(outside,'model.pt'),'utf8'),'fixture');
  fs.unlinkSync(target);
});
test('an active environment installer defers runtime removal until a subsequent safe launch',t=>{
  const root=fixture(t);write(root,retired.RETIRED_RUNTIME[0]+'/runtime.cpu.json');
  write(root,'state/audio-install/operation.lock',JSON.stringify({workerPid:process.pid}));
  const result=retired.retireSoulx(root);assert.equal(result.retained[0].reason,'installer-running');assert(fs.existsSync(path.join(root,retired.RETIRED_RUNTIME[0])));
  fs.unlinkSync(path.join(root,'state/audio-install/operation.lock'));assert.equal(retired.retireSoulx(root).retained.length,0);
});

test('a junction in the state path cannot redirect deletion or the migration report outside the workspace',t=>{
  const root=fixture(t),outside=fixture(t),link=path.join(root,'state');
  write(outside,'maintenance/audio-capabilities/soulx-singer/model.pt');
  fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
  retired.retireSoulx(root);assert(fs.existsSync(path.join(outside,'maintenance/audio-capabilities/soulx-singer/model.pt')));
  assert(!fs.existsSync(path.join(outside,'maintenance/retired-audio.json')));fs.unlinkSync(link);
});
