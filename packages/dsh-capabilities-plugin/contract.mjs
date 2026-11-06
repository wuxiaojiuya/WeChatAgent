export const CAPABILITY_EXECUTION_VERSION='dsh-generation-v1';
export const CAPABILITY_OPERATIONS=Object.freeze({
  'drawing.check':15000,'drawing.generate':250000,
  'voice.check':15000,'voice.generate':300000,
  'audio.probe':120000,'singing.reference':720000,'singing.render':3000000,'singing.preview':180000,
  'music.search':30000,'music.resolve':30000,'music.download':180000,'music.login-check':30000,
});
export const CAPABILITY_PLUGIN_FILES=Object.freeze(['package.json','cordis.patch.yml','index.mjs','runtime.mjs','contract.mjs','configuration.mjs','drawing.mjs','voice.mjs','speech-rvc.mjs','singing.mjs']);
export const capabilityFault=(code,message,status=503)=>Object.assign(new Error(message),{code,status});
export function publicCapabilityError(error){
  const safe=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599&&typeof error.message==='string'&&error.message.length<=500&&!/[\r\n\0]|https?:\/\/|[A-Z]:[\\/]|Bearer\s|[A-Za-z0-9_-]{48,}/i.test(error.message);
  return {code:/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.code??'')?error.code:'CAPABILITY_EXECUTION_FAILED',message:safe?error.message:'DSH 能力插件未完成生成，请检查推理环境和任务状态。',status:safe?error.status:503};
}
