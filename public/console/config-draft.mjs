const MISSING=Symbol('missing');
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>record(value)&&Object.hasOwn(value,key);
const clone=value=>value===MISSING?MISSING:structuredClone(value);
const equal=(a,b)=>{
  if(a===b)return true;
  if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((value,index)=>equal(value,b[index]));
  if(!record(a)||!record(b))return false;
  const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>own(b,key)&&equal(a[key],b[key]));
};
const scope=value=>value??null;
const setPaths=new Set(['wechat.whitelist.private','wechat.whitelist.groups','wechat.assistant.administrators']);
const setValue=value=>value===MISSING?[]:Array.isArray(value)&&value.every(item=>typeof item==='string')?value:null;

// Only this small list of unordered membership fields is merged as a set.
// In particular, an unchanged stale list cannot restore a server-side removal.
function mergeSet(before,local,current){
  const b=setValue(before),l=setValue(local),r=setValue(current);if(!b||!l||!r)return null;
  const baseline=new Set(b),pending=new Set(l),remote=new Set(r);
  return [...new Set([...r,...l])].filter(value=>baseline.has(value)?pending.has(value)&&remote.has(value):pending.has(value)||remote.has(value));
}

export function mergeConfigDraft(base,local,current,{preferLocal=false}={}){
  const conflicts=[];
  const merge=(before,pending,remote,path)=>{
    if(equal(before,pending))return clone(remote);
    if(equal(before,remote)||equal(pending,remote))return clone(pending);
    if(setPaths.has(path)){
      const merged=mergeSet(before,pending,remote);if(merged)return merged;
    }
    if(record(pending)&&record(remote)&&(record(before)||before===MISSING)){
      const result={};
      for(const name of new Set([...Object.keys(before===MISSING?{}:before),...Object.keys(pending),...Object.keys(remote)])){
        const value=merge(own(before,name)?before[name]:MISSING,own(pending,name)?pending[name]:MISSING,own(remote,name)?remote[name]:MISSING,path?path+'.'+name:name);
        if(value!==MISSING)Object.defineProperty(result,name,{value,enumerable:true,writable:true,configurable:true});
      }
      return result;
    }
    conflicts.push(path||'配置');return clone(preferLocal?pending:remote);
  };
  return {config:merge(base,local,current,''),conflicts};
}

// These edits happened after submission and have never reached the server.
// Keep them in the draft, while adopting saved values at untouched paths.
export function rebasePendingConfig(submitted,pending,saved){
  return mergeConfigDraft(submitted,pending,saved,{preferLocal:true}).config;
}

const changedScope=()=>Object.assign(new Error('微信连接已切换，草稿已保留。请核对当前账号后重新载入设置，不能把旧账号的聊天设置合并到新账号。'),{status:409,code:'CONFIG_SCOPE_CHANGED'});
export function assertConfigScope(expected,actual){if(scope(expected)!==scope(actual))throw changedScope();}

// The server remains the compare-and-swap authority. Rebase once, and never
// turn a genuine same-field conflict into a silent last-writer-wins update.
export async function saveConfigDraft({base,draft,revision,accountScope,read,save}){
  const capturedBase=clone(base),capturedDraft=clone(draft),capturedScope=scope(accountScope);
  const submit=async(config,expectedRevision)=>{
    const result=await save({config,revision:expectedRevision,accountScope:capturedScope});
    assertConfigScope(capturedScope,result.accountScope);return result;
  };
  try{return await submit(clone(capturedDraft),revision);}
  catch(error){
    if(error.status!==409||error.code==='CONFIG_SCOPE_CHANGED')throw error;
    const latest=await read();assertConfigScope(capturedScope,latest.accountScope);
    const merged=mergeConfigDraft(capturedBase,capturedDraft,latest.config);
    if(merged.conflicts.length)throw Object.assign(new Error('这些设置也被后台或其他窗口修改，草稿已保留：'+merged.conflicts.slice(0,8).join('、')+'。请核对后再保存。'),{status:409,code:'CONFIG_DRAFT_CONFLICT',paths:merged.conflicts});
    try{return await submit(merged.config,latest.revision);}
    catch(retryError){
      if(retryError.status!==409||retryError.code==='CONFIG_SCOPE_CHANGED')throw retryError;
      throw Object.assign(new Error('配置或微信连接仍在更新，本次没有继续覆盖。草稿已保留，请稍后再保存。'),{status:409,code:'CONFIG_CHANGED_AGAIN'});
    }
  }
}
