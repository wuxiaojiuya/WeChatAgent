const {withoutSocialTools,canonicalSocialTools,withoutDshIdentity}=await import(new URL('./social-tool-policy.mjs'+new URL(import.meta.url).search,import.meta.url));
import { WEB_READER_POLICY } from './web-reader-policy.mjs';
import {MODEL_SEARCH_POLICY} from './model-search.mjs';
import {FILE_TRANSFER_POLICY} from './file-transfers.mjs';
import {ASSISTANT_ACCESS} from './assistant-policy.mjs';
import {DSH_ACCESS_POLICY} from './dsh-access.mjs';
import {MEME_LIBRARY_POLICY} from './meme-library-policy.mjs';
import {MEMBER_MEMORY_POLICY} from './member-memory-policy.mjs';
import {HISTORY_POLICY} from './history-policy.mjs';
import {SINGING_POLICY} from './singing-tools.mjs';
import {PERSONA_PROPOSAL_POLICY} from './persona-proposal-tools.mjs';
export const name = 'social-tool-restrict';
export const inject = ['tools'];
const policies = (ctx,agent) => [Symbol.for('wechatagent.extension-tools.v1'),WEB_READER_POLICY,MODEL_SEARCH_POLICY,DSH_ACCESS_POLICY,FILE_TRANSFER_POLICY,MEME_LIBRARY_POLICY,MEMBER_MEMORY_POLICY,HISTORY_POLICY,SINGING_POLICY,PERSONA_PROPOSAL_POLICY]
  .map(symbol => agent?.ctx?.[symbol] ?? ctx[symbol]).filter(Boolean);
const assistantAllowed=agent=>{try{return agent?.ctx?.[ASSISTANT_ACCESS]?.()!==false;}catch{return false;}};
const namesFor=(ctx,agent)=>new Set(assistantAllowed(agent)?policies(ctx,agent).flatMap(policy=>[...policy.names()]):[]);

// New DSH versions keep tool declarations outside the text-assembly waterfall.
// Filter the scoped executor's declarations before DSH snapshots the request.
export function bindNativeToolPresentation(agentCtx,agent){
  const tools=agentCtx.tools,marker=Symbol.for('wechatagent.native-tool-presentation.v1');
  if(typeof tools?.setExecutor!=='function'||typeof tools?.selectExecutor!=='function'||Object.hasOwn(agentCtx,marker))return;
  const original=tools.selectExecutor(agent);
  tools.setExecutor({...original,
    describe(definitions){
      const names=namesFor(agentCtx,agent);
      return original.describe(canonicalSocialTools(definitions.filter(tool=>names.has(tool.name)).map(({deferLoading,...tool})=>tool)));
    },
    execute:input=>original.execute(input),
  });
  Object.defineProperty(agentCtx,marker,{value:true,configurable:true});
}
export function apply(ctx) {
  const marker=Symbol.for('wechatagent.scoped-tool-guard.v1');if(Object.hasOwn(ctx,marker))return;Object.defineProperty(ctx,marker,{value:true,configurable:true});
  ctx.tools.presentAs?.('native'); // Visibility and execution use the same live per-chat authorization below.
  ctx.tools.guard(exec => assistantAllowed(exec?.agent)&&policies(ctx,exec?.agent).some(policy => policy.check(exec?.name)) ? undefined : '微信群友会话不允许调用未授权工具');
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const original = withoutDshIdentity(await next()), assembly=original.sections?.some(section=>section.name==='dsh-expression:companion')?{...original,sections:original.sections.filter(section=>section.name!=='dsh-expression:companion')}:original, names = namesFor(ctx,context?.scope);
    if(!Array.isArray(assembly.tools))return assembly;
    return names.size ? { ...assembly, tools: canonicalSocialTools(assembly.tools.filter(tool => names.has(tool.name)).map(({deferLoading,...tool})=>tool)) } : withoutSocialTools(assembly);
  }, { prepend: true });
}
