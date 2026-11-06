const actions={install:'一键安装语音 / 翻唱环境',repair:'一键修复语音 / 翻唱环境',check:'检查环境'};
export function audioRuntimeMarkup(data,esc,selected='all'){
  const job=data.job,disabled=data.busy||!data.supported;
  const percent=job?.total>0?Math.min(100,Math.floor(job.downloaded/job.total*100)):null;
  return `<section class="card" id="audio-runtime-panel"><h2>语音与翻唱环境</h2><p class="card-description">语音回复：TTS 合成 → 所选 RVC 音色。视频演唱：理解画面与音轨 → AI 编排 → SoulX 按谱演唱 → 同一 .pth 音色 → 伴奏混音。编排使用现有环境，无需新增模型。首次安装需要联网，建议内存 16 GB 以上，至少预留 35 GB 可用空间；CPU 翻唱需数分钟。</p>
  ${!data.supported?'<p role="alert">当前一键安装支持 Windows x64，使用 CPU 推理。</p>':''}
  <div class="form-grid">${data.environments.map(env=>`<div class="field"><strong>${esc(env.name)}</strong><p>${esc(env.label)}</p>${env.verifiedAt?`<small>上次安装验证：${esc(new Date(env.verifiedAt*1000).toLocaleString())}</small>`:''}</div>`).join('')}</div>
  <div class="field"><label for="audio-runtime-kind">安装 / 修复范围</label><select id="audio-runtime-kind" ${data.busy?'disabled':''}>${[['all','全部（TTS + RVC + SoulX）'],['voice','语音回复（TTS + RVC）'],['singing','歌曲 / 视频翻唱（SoulX + RVC）'],['soulx','仅补充 SoulX 演唱环境'],['rvc','仅修复共享 RVC 换声']].map(([value,name])=>`<option value="${value}" ${selected===value?'selected':''}>${name}</option>`).join('')}</select></div>
  <div class="button-row">${Object.entries(actions).map(([action,title])=>`<button class="button ${action==='install'?'primary':''}" data-audio-runtime="${action}" ${disabled?'disabled':''}>${title}</button>`).join('')}</div>
  <p class="subtle">安装或修复前，请先在概览停止助手服务，并关闭单独运行的音频服务。操作期间保持本窗口打开。</p>
  ${job?`<div role="status" aria-live="polite"><p><strong>${esc({running:'正在处理',success:'已完成',failed:'未完成',interrupted:'已中断'}[job.state]??'状态')}</strong> · ${esc(job.message)}</p>${data.busy?`<progress max="100" ${percent===null?'':`value="${percent}"`} aria-label="安装进度"></progress>${percent===null?'<span> 正在处理，请稍候…</span>':`<span> ${percent}% · ${(job.downloaded/1024**2).toFixed(1)} / ${(job.total/1024**2).toFixed(1)} MB</span>`}`:''}
  ${job.code?`<p class="subtle">错误编号：${esc(job.code)}。诊断日志：state/audio-install</p>`:''}
  <ol>${(job.events??[]).slice(-6).map(e=>`<li>${esc(e.message)}</li>`).join('')}</ol></div>`:''}
  <p class="subtle">预部署依赖包从项目下载服务器获取并校验；SoulX、TTS 及 RVC 基础模型从官方来源下载。支持中文歌曲，伴奏从原歌曲或视频中分离。音色仍在“语音回复”上传一次，翻唱共用。修复保留自有音色、密钥和配置；新环境验证失败时恢复旧环境。</p>
  <a class="text-link" href="#extensions/catalog">安装完成后前往能力菜单配置语音与唱歌</a></section>`;
}

export function createAudioRuntimeUI({api,escapeHtml,toast}){
  let timer=null,controller=null,selected='all',active=false;
  const paint=data=>{const panel=document.querySelector('#audio-runtime-panel');if(panel)panel.outerHTML=audioRuntimeMarkup(data,escapeHtml,selected);};
  function unmount(){active=false;clearTimeout(timer);controller?.abort();controller=null;}
  function mount(){
    unmount();active=true;controller=new AbortController();
    const signal=controller.signal;
    async function poll(){
      if(!active||signal.aborted||!document.querySelector('#audio-runtime-panel'))return;
      try{paint(await api('/api/audio-runtime/status',undefined,true,{signal}));}catch(error){if(!signal.aborted)toast(error.message);}
      if(!signal.aborted)timer=setTimeout(poll,2000);
    }
    document.addEventListener('change',event=>{if(event.target.id==='audio-runtime-kind')selected=event.target.value;},{signal});
    document.addEventListener('click',async event=>{
      const button=event.target.closest('[data-audio-runtime]');if(!button||button.disabled)return;
      clearTimeout(timer);document.querySelectorAll('[data-audio-runtime]').forEach(b=>b.disabled=true);
      try{paint(await api('/api/audio-runtime/start',{kind:selected,action:button.dataset.audioRuntime},true,{signal}));}catch(error){if(!signal.aborted)toast(error.message);}
      if(!signal.aborted)void poll();
    },{signal});
    timer=setTimeout(poll,2000);
  }
  return {page:async()=>audioRuntimeMarkup(await api('/api/audio-runtime/status'),escapeHtml,selected),mount,unmount};
}
