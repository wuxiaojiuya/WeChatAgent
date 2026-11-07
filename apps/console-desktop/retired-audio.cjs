// Only fixed, application-owned obsolete files are eligible for removal.
const fs = require('node:fs');
const path = require('node:path');
const RETIRED_FILES = ['scripts/music-soulx-worker.py', 'scripts/soulx-runtime.py',
  'scripts/soulx-assets.json', 'scripts/test-music-soulx.py', 'docs/SOULX_SINGING.md'];
const RETIRED_RUNTIME = ['state/maintenance/audio-capabilities/soulx-singer',
  'state/maintenance/soulx-singer', 'state/audio-install/downloads/soulx-singer-windows-cpu-20261106.zip',
  'state/audio-install/downloads/soulx-singer-windows-cpu-20261106.zip.partial'];

function retireSoulx(workspace) {
  const root = fs.realpathSync(workspace), removed = [], retained = [];
  const within = file => {
    const relative = path.relative(root, file);
    return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
  };
  const assertOwned = file => {
    if (!within(file)) throw Error('RETIRED_AUDIO_PATH_INVALID');
    let current = file;
    while (current !== root) {
      if (fs.lstatSync(current, {throwIfNoEntry: false})?.isSymbolicLink()) throw Error('linked-path');
      current = path.dirname(current);
    }
  };
  let installing = false;
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'state/audio-install/operation.lock'), 'utf8'));
    for (const pid of [lock.pid, lock.workerPid]) if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); installing = true; } catch (error) { if (error.code !== 'ESRCH') installing = true; }
    }
  } catch {}
  for (const relative of [...RETIRED_FILES, ...RETIRED_RUNTIME]) {
    const target = path.resolve(root, relative);
    if (!within(target)) throw Error('RETIRED_AUDIO_PATH_INVALID');
    if (!fs.existsSync(target)) continue;
    if (installing && RETIRED_RUNTIME.includes(relative)) { retained.push({path: relative, reason: 'installer-running'}); continue; }
    try {
      assertOwned(target);
      if (!within(fs.realpathSync(target))) throw Error('linked-path');
      if (RETIRED_FILES.includes(relative) && !fs.lstatSync(target).isFile()) throw Error('unexpected-directory');
      fs.rmSync(target, {recursive: RETIRED_RUNTIME.includes(relative), force: true, maxRetries: 3, retryDelay: 100});
      removed.push(relative);
    } catch { retained.push({path: relative, reason: 'linked-or-in-use'}); }
  }
  const result = {version: 1, removed, retained};
  if (removed.length || retained.length) {
    const report = path.join(root, 'state/maintenance/retired-audio.json');
    try {
      assertOwned(report);
      fs.mkdirSync(path.dirname(report), {recursive: true});
      fs.writeFileSync(report, JSON.stringify(result, null, 2));
    } catch {}
  }
  return result;
}
module.exports = {retireSoulx, RETIRED_FILES, RETIRED_RUNTIME};
