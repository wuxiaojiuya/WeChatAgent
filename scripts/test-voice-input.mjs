import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('voice reader validates synthetic message, media and account boundaries',()=>{
  const root=path.resolve(import.meta.dirname,'..');
  const file=path.join(root,'config/wechatagent.json'),config=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')):{};
  const python=process.env.WECHATAGENT_TEST_PYTHON??config.runtime?.python??'python';
  const result=spawnSync(python,['-B',path.join(root,'scripts/test-voice-input.py')],{cwd:root,encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout||result.error?.message);
});
