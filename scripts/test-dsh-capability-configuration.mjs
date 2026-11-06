import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {capabilityPluginRevision,upsertCapabilitiesPatch} from '../packages/dsh-capabilities-plugin/configuration.mjs';
import {CAPABILITY_PLUGIN_FILES} from '../packages/dsh-capabilities-plugin/contract.mjs';
import {sourceHostFiles,assertSourceHostCoverage} from './source-release-policy.mjs';

test('capability plugin configuration is idempotent and preserves the bridge bundle',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-capability-patch-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'packages/dsh-capabilities-plugin');fs.mkdirSync(directory,{recursive:true});
  for(const file of CAPABILITY_PLUGIN_FILES)fs.copyFileSync(path.resolve('packages/dsh-capabilities-plugin',file),path.join(directory,file));
  const original=fs.readFileSync('packages/dsh-social-bridge-plugin/cordis.patch.yml','utf8');
  const first=upsertCapabilitiesPatch(original,root),second=upsertCapabilitiesPatch(first,root);
  assert.equal(first,second);assert(first.startsWith(original));
  const lines=first.split(/\r?\n/).filter(line=>line.includes('"id":"wechat-capabilities-plugin"'));
  assert.equal(lines.length,1);const entry=JSON.parse(lines[0].trim().slice(2));
  assert.equal(entry.config.projectRoot,path.resolve(root));
  assert.equal(fileURLToPath(new URL(entry.name)),path.join(directory,'index.mjs'));
  assert.equal(new URL(entry.name).searchParams.get('wechatagent'),capabilityPluginRevision(root));
  const revision=capabilityPluginRevision(root);fs.appendFileSync(path.join(directory,'voice.mjs'),'\n// revision fixture\n');
  assert.notEqual(capabilityPluginRevision(root),revision);
  const updated=upsertCapabilitiesPatch(first,root);assert(!updated.includes('?wechatagent='+revision));
  assert.equal(updated.split('"id":"wechat-capabilities-plugin"').length,2);
});

test('source and installer host coverage require every DSH capability executor and the RPC client',()=>{
  const root=path.resolve('.'),files=sourceHostFiles(root);
  for(const relative of ['scripts/dsh-capability-client.mjs',...CAPABILITY_PLUGIN_FILES.map(file=>'packages/dsh-capabilities-plugin/'+file)]){
    assert(files.includes(relative));assert(fs.existsSync(relative));
    assert.throws(()=>assertSourceHostCoverage(root,files.filter(file=>file!==relative)),/SOURCE_PLUGIN_HOST_FILES_OMITTED/);
  }
});
