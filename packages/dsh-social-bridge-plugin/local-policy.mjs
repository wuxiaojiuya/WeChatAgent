import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {personaError} from '../../public/console/persona-files.mjs';
import {selectRoleText} from '../../components/qq-bridge/src/role-card.js';

export const BEHAVIOR_POLICY = 'local-config-only-v1';
export const MAX_PERSONA_BYTES = 60000;
export const MAX_RPC_BYTES = 256 * 1024;

/** Read current owner files so an approved card takes effect on the next turn.
 * Legacy installations can still use the generated snapshot. RPC metadata is
 * never an authority for persona content or binding. */
export function localPersona(root, key) {
  const ownerFile=path.join(root,'config/wechatagent.json');
  if(fs.existsSync(ownerFile)) {
    const owner=JSON.parse(fs.readFileSync(ownerFile,'utf8').replace(/^\uFEFF/,''));
    if(owner.persona?.default){
      const name=owner.persona.chats?.[key]??owner.persona.default;
      if(personaError(name,'校验'))throw Error('LOCAL_PERSONA_CONFIG_REQUIRED');
      const content=fs.readFileSync(path.join(root,'roles',name+'.md'),'utf8'),error=personaError(name,content);
      const persona=selectRoleText(content,'v2');
      if(error||!persona.trim())throw Error('LOCAL_PERSONA_CONFIG_REQUIRED');
      return {persona,personaName:name};
    }
  }
  const config = JSON.parse(fs.readFileSync(path.join(root, 'state/bridge-config.json'), 'utf8').replace(/^\uFEFF/, ''));
  const selected = config.roles?.[key];
  const persona = selected && typeof selected === 'object' && typeof selected.persona === 'string' ? selected.persona : config.role;
  const personaName = selected && typeof selected === 'object' && typeof selected.name === 'string' ? selected.name : config.persona_name;
  if (typeof persona !== 'string' || !persona.trim() || persona.includes('\0') || Buffer.byteLength(persona,'utf8') > MAX_PERSONA_BYTES || typeof personaName !== 'string' || !personaName.trim()) throw new Error('LOCAL_PERSONA_CONFIG_REQUIRED');
  return { persona, personaName };
}

export function assertLocalPersona(body, locked) {
  if ((body.persona !== undefined && body.persona !== locked.persona) || (body.personaName !== undefined && body.personaName !== locked.personaName) || (body.personaDigest !== undefined && body.personaDigest !== crypto.createHash('sha256').update(locked.persona).digest('hex'))) throw new Error('BEHAVIOR_CHANGE_NOT_ALLOWED');
}
