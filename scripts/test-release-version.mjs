import test from 'node:test';
import assert from 'node:assert/strict';
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
