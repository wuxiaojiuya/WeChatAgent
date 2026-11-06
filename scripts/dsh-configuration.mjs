import fs from 'node:fs';
import path from 'node:path';
import {CAPABILITY_EXECUTION_VERSION} from '../packages/dsh-capabilities-plugin/contract.mjs';

export function sameProjectPath(left,right){
  if(typeof left!=='string'||!left||typeof right!=='string'||!right)return false;
  try{return fs.realpathSync.native(path.resolve(left))===fs.realpathSync.native(path.resolve(right));}catch{return false;}
}

export function dshPluginMatches(root, health) {
  const patch = path.join(root, 'packages/dsh-social-bridge-plugin/cordis.patch.yml');
  const revision = fs.existsSync(patch) ? /wechatagent=([a-f0-9]{16})/.exec(fs.readFileSync(patch, 'utf8'))?.[1] : '';
  return !!revision && health?.pluginRevision === revision && health.capabilityExecution === CAPABILITY_EXECUTION_VERSION;
}

export function dshConfigurationMatches(root, config, health) {
  if (!health?.ok || health.project !== 'WeChatAgent' || !sameProjectPath(health.projectRoot,root)) return false;
  if (health.provider !== config.dsh.provider || health.model !== config.dsh.model || !dshPluginMatches(root,health)) return false;
  const accountFile = path.join(root, 'state/weflow/active-account.json');
  if (fs.existsSync(accountFile)) {
    const account = JSON.parse(fs.readFileSync(accountFile, 'utf8').replace(/^\uFEFF/, ''));
    if (account.id && health.accountScope !== account.id) return false;
  }
  return true;
}
