// Health checks use only the packaged component contract, never client storage.
export function hookComponentProblem(health,expectedVersion='4.1.8.27') {
  if(!health||typeof health!=='object')return 'HOOK_HEALTH_INVALID_RESPONSE';
  if(health.integration!=='WeChatAgent-supplier-v1'||health.provider!=='supplier-http'||health.backend!=='wechat-hook')return 'REVIEWED_HOOK_BUILD_REQUIRED';
  if(expectedVersion!=='4.1.8.27'||health.version!==expectedVersion)return 'HOOK_VERSION_MISMATCH';
  if(health.startupState!==undefined&&health.startupState!=='ready')return 'HOOK_INITIALIZATION_PENDING';
  return '';
}
