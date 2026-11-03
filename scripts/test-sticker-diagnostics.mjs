import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('sticker CDN opt-in failures retain safe diagnostic reasons without network requests',()=>{
  const root=path.resolve(import.meta.dirname,'..'),embedded=path.join(root,'state/installer-stage/runtime/python/python.exe');
  const python=process.env.WECHATAGENT_TEST_PYTHON||(fs.existsSync(embedded)?embedded:'python');
  const result=spawnSync(python,['-B',path.join(root,'scripts/test-sticker-diagnostics.py')],{cwd:root,encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,PYTHONUTF8:'1'}});
  assert.equal(result.status,0,result.stderr||result.stdout||result.error?.message);
});
