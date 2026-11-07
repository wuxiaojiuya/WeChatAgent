import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {releaseIdentity} from './release-version.mjs';

test('a plus release has an exact public label, valid package alias and numeric Windows build version',()=>{
  assert.deepEqual(releaseIdentity({version:'0.4.1+plus',releaseVersion:'0.4.1+'}),{version:'0.4.1+',packageVersion:'0.4.1+plus',buildVersion:'0.4.1.2',tag:'v0.4.1+'});
});
test('normal and existing fix releases retain their release names',()=>{
  assert.equal(releaseIdentity({version:'0.4.1'}).version,'0.4.1');
  assert.equal(releaseIdentity({version:'0.4.1-fix'}).buildVersion,'0.4.1.1');
});
test('invalid or mismatched labels are rejected before packaging',()=>{
  for(const pkg of [{version:'0.4.1+'},{version:'0.4.1',releaseVersion:'0.4.1+'},{version:'0.4.2+plus',releaseVersion:'0.4.1+'},{version:'0.4.1+plus'},{version:'../0.4.1'},{version:'0.4.1',releaseVersion:'0.4.2'}])assert.throws(()=>releaseIdentity(pkg),/RELEASE_VERSION/);
});

test('supplier installer metadata retains both public release and package versions for release verification',()=>{
  const source=fs.readFileSync(new URL('build-supplier-installer.mjs',import.meta.url),'utf8');
  const identity=source.slice(source.indexOf('const pkg='),source.indexOf('const stage='));
  const line=prefix=>{const found=source.split(/\r?\n/).find(value=>value.startsWith(prefix));assert(found,'Missing production metadata statement: '+prefix);return found;};
  const metadata=[line("fs.writeFileSync(path.join(app,'package.json')"),line('const deployment='),line("fs.writeFileSync(path.join(project,'deployment.json')"),line("fs.writeFileSync(path.join(output,'VERIFICATION.json')")].join('\n');
  for(const pkg of [{version:'0.2.15',releaseVersion:'0.2.15'},{version:'0.4.1+plus',releaseVersion:'0.4.1+'},{version:'0.4.1-fix'}]){
    const writes=new Map(),context={releaseIdentity,path,root:'/fixture',app:'/fixture/app',project:'/fixture/project',output:'/fixture/output',buildId:'a'.repeat(16),builtAt:'fixture',runtimeRevision:'runtime',sourceHashes:{'package.json':'hash'},process:{version:'fixture-node'},fs:{readFileSync:()=>JSON.stringify(pkg),writeFileSync:(file,value)=>writes.set(file,JSON.parse(value))}};
    vm.runInNewContext(identity+'\n'+metadata,context);
    const expected=releaseIdentity(pkg),desktop=writes.get(path.join(context.app,'package.json')),deployment=writes.get(path.join(context.project,'deployment.json')),verification=writes.get(path.join(context.output,'VERIFICATION.json'));
    assert.equal(desktop.version,expected.packageVersion);assert.equal(desktop.releaseVersion,expected.version);
    for(const item of [deployment,verification]){assert.equal(item.version,expected.version);assert.equal(item.packageVersion,expected.packageVersion);}
  }
});
