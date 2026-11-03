import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyHookBuild } from './hook-build-policy.mjs';

test('release refuses stale native builds and metadata/DLL mismatches', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechatagent-hook-build-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('native-build-fixture');
  const build = {
    targetVersion: '4.1.10.27', initialization: 'deferred-module-v3',
    mutexCompatibility: 'legacy-runtime-constructor-v1',
    exceptionDiagnostics: 'seh-cpp-stage-v1', logWriter: 'win32-srw-v1',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  const write = value => fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify(value));
  fs.writeFileSync(path.join(dir, 'version.dll'), bytes);
  write({ ...build, initialization: 'deferred-module-v2' });
  assert.throws(() => verifyHookBuild(dir), /outdated/);
  write({ ...build, mutexCompatibility: undefined });
  assert.throws(() => verifyHookBuild(dir), /outdated/);
  write(build);
  assert.deepEqual(verifyHookBuild(dir), build);
  fs.appendFileSync(path.join(dir, 'version.dll'), 'modified');
  assert.throws(() => verifyHookBuild(dir), /does not match/);
});
