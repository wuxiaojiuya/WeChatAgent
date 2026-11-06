import path from 'node:path';
const {createCapabilityRuntime}=await import(new URL('./runtime.mjs'+new URL(import.meta.url).search,import.meta.url));
export const name='wechat-capabilities-plugin';
export function apply(ctx,config={}){
  const root=path.resolve(config.projectRoot??path.resolve(import.meta.dirname,'..','..'));
  const runtime=createCapabilityRuntime({root});
  ctx.reflect.provide('wechatCapabilities',runtime);
  ctx.effect(()=>()=>runtime.close());
}
