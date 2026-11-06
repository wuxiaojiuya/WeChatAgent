export function createDrawingCapabilityUI({api,modal,closeModal,escapeHtml:esc,state,renderPage,toast}){
  // Keep the operation identity across dialog closes. An interrupted progress
  // request must never turn the next click into another billed generation.
  let previewTask;
  async function dialog(){
    let saved=await api('/api/drawing-capability'),closed=false,busy=false,imageUrl,pollTimer;
    const settings=saved.settings,controller=new AbortController();
    const keys=['private','groups'].flatMap(kind=>(state.config?.wechat?.whitelist?.[kind]??[]).map(id=>'wechat:'+(kind==='groups'?'group':'private')+':'+id));
    const input=(label,id,value,attrs='',help='')=>`<div class="field"><label for="${id}">${label}</label><input id="${id}" value="${esc(value)}" ${attrs}>${help?`<small>${help}</small>`:''}</div>`;
    const select=(label,id,value,options)=>`<div class="field"><label for="${id}">${label}</label><select id="${id}">${options.map(([id,name])=>`<option value="${id}" ${id===value?'selected':''}>${name}</option>`).join('')}</select></div>`;
    modal('GPT 绘画',`<form id="drawing-form" class="audio-capability-form"><div class="audio-scroll">
      <div class="audio-intro"><span class="audio-feature-icon" aria-hidden="true">✦</span><div><strong>把想象画出来</strong><p>在聊天里说“帮我画一张雨夜的猫咪”，DSH 中的 AI 会调用绘画插件生成图片，并由 WeChatAgent 发到当前聊天。</p></div></div>
      <p class="subtle">在这里管理设置与密钥。接口检查和试画需要 DSH 能力插件已加载。</p>
      <label class="switch-row audio-enable"><div><strong>启用 GPT 绘画</strong><p>只在下方勾选的聊天中使用。保存即生效。</p></div><span class="switch-control"><input id="drawing-enabled" type="checkbox" role="switch" aria-label="启用 GPT 绘画" ${settings.enabled?'checked':''}><span class="switch-track"></span></span></label>
      <section class="audio-section"><h3>绘画服务</h3><div class="form-grid">
      ${input('API 基础地址','drawing-endpoint',settings.endpoint,'type="url" required maxlength="2048"','OpenAI 官方地址为 https://api.openai.com/v1，也可使用兼容 GPT Image 的服务。')}
      ${input('API Key','drawing-key','','type="password" autocomplete="new-password" maxlength="4096"',settings.apiKeyConfigured?'已保存，留空保留。更换接口地址时需重新填写。':'填写绘画服务的 API Key，仅保存在本机。')}
      ${input('绘画模型','drawing-model',settings.model,'required maxlength="100" list="drawing-models"','模型需由服务商提供访问权限。')}
      <datalist id="drawing-models"><option value="gpt-image-2"><option value="gpt-image-1.5"><option value="gpt-image-2.5-sunburst"><option value="gpt-image-2.5-flare"></datalist>
      ${select('图片尺寸','drawing-size',settings.size,[['1024x1024','正方形 · 1024 × 1024'],['1536x1024','横图 · 1536 × 1024'],['1024x1536','竖图 · 1024 × 1536'],['auto','由绘画模型选择']])}
      ${select('画质','drawing-quality',settings.quality,[['auto','自动'],['low','快速'],['medium','标准'],['high','精细']])}
      <label class="extension-option"><input id="drawing-clear-key" type="checkbox" ${settings.apiKeyConfigured?'':'disabled'}>清除已保存的 API Key</label></div>
      <button id="drawing-check" class="button" type="button">保存并检查连接</button><p id="drawing-check-status" role="status" class="subtle"></p></section>
      <section class="audio-section audio-preview-section"><h3>本地试画</h3><label for="drawing-prompt">画面描述</label><textarea id="drawing-prompt" rows="3" maxlength="4000">${esc(previewTask?.prompt??'一只坐在窗边看雨的橘猫，温暖的水彩插画，柔和光线。')}</textarea><p class="subtle">试画会调用绘画 API，仅在本机预览，不发送微信。关闭此窗口不会取消后台生成，重新打开后可继续查询。</p><div class="drawing-preview-actions"><button id="drawing-preview" class="button" type="button">保存并生成试画</button><button id="drawing-resume" class="button" type="button" hidden>继续查询上次试画</button></div><p id="drawing-progress" role="status" aria-live="polite" class="subtle"></p><img id="drawing-image" class="drawing-preview-image" alt="GPT 生成的试画" hidden><a id="drawing-download" class="music-download" download="gpt-drawing.png" hidden>保存图片</a></section>
      <fieldset class="extension-fieldset audio-scope"><legend>聊天范围</legend>${keys.length?keys.map(key=>`<label class="extension-option"><input name="drawing-chat" type="checkbox" value="${esc(key)}" ${settings.chats.includes(key)?'checked':''}>${esc(state.names.get(key)??key)}</label>`).join(''):'<p class="subtle">添加好友或群聊后，可选择允许绘画的聊天。</p>'}</fieldset>
      </div><div class="audio-footer"><p id="drawing-error" class="extension-error" role="alert" hidden></p><div class="modal-actions"><button class="button" type="button" data-close>关闭</button><button class="button primary" type="submit">保存配置</button></div></div></form>`,{className:'audio-modal',onClose(){closed=true;controller.abort();clearTimeout(pollTimer);if(imageUrl)URL.revokeObjectURL(imageUrl);}});
    const form=document.querySelector('#drawing-form'),field=id=>form.querySelector('#'+id);
    const error=value=>{if(closed)return;field('drawing-error').textContent=value.message??'绘画操作未完成。';field('drawing-error').hidden=false;};
    const pending=()=>previewTask&&(!['success','failed','interrupted','cancelled'].includes(previewTask.job?.state)||previewTask.job?.state==='success'&&!previewTask.previewReady);
    function setBusy(value){busy=value;for(const control of form.querySelectorAll('input,select,textarea,button:not([data-close])'))control.disabled=value;
      field('drawing-clear-key').disabled=value||!saved.settings.apiKeyConfigured;field('drawing-preview').disabled=value||!!pending();field('drawing-prompt').readOnly=!!pending();field('drawing-resume').hidden=!previewTask;field('drawing-resume').disabled=value;
    }
    async function save(){saved=await api('/api/drawing-capability/save',{revision:saved.revision,settings:{enabled:field('drawing-enabled').checked,endpoint:field('drawing-endpoint').value.trim(),apiKey:field('drawing-key').value.trim(),model:field('drawing-model').value.trim(),quality:field('drawing-quality').value,size:field('drawing-size').value,chats:[...form.querySelectorAll('[name="drawing-chat"]:checked')].map(input=>input.value)},clearApiKey:field('drawing-clear-key').checked},true,{signal:controller.signal});
      if(!closed){field('drawing-key').value='';field('drawing-clear-key').checked=false;field('drawing-clear-key').disabled=!saved.settings.apiKeyConfigured;}return saved;
    }
    form.addEventListener('submit',async event=>{event.preventDefault();if(busy||!form.reportValidity())return;setBusy(true);field('drawing-error').hidden=true;
      try{await save();if(closed)return;closeModal();await renderPage();toast('GPT 绘画设置已保存。');}catch(value){error(value);}finally{if(!closed)setBusy(false);}});
    field('drawing-check').addEventListener('click',async()=>{if(busy||!form.reportValidity())return;setBusy(true);field('drawing-error').hidden=true;field('drawing-check-status').textContent='正在检测 API 凭据和绘画模型…';
      try{await save();const result=await api('/api/drawing-capability/check',{revision:saved.revision},true,{signal:controller.signal});if(!closed)field('drawing-check-status').textContent=result.message;}catch(value){error(value);if(!closed)field('drawing-check-status').textContent='连接检查未通过。';}finally{if(!closed)setBusy(false);}});
    async function previewImage(job){
      const expected='/api/drawing-capability/jobs/'+job.id+'/image';
      if(job.previewOnly!==true||job.previewUrl!==expected)throw Error('试画预览地址无效，未读取外部图片。');
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]);
      let response=await fetch(expected,{headers:{'X-Console-Token':state.token},redirect:'error',signal});
      if(response.status===401){await api('/api/drawing-capability',undefined,true,{signal});response=await fetch(expected,{headers:{'X-Console-Token':state.token},redirect:'error',signal});}
      if(!response.ok)throw Error('图片已生成，但预览读取失败。点击“继续查询上次试画”重新读取，不会重新生成。');
      if(!response.headers.get('content-type')?.toLowerCase().startsWith('image/png'))throw Error('试画未返回 PNG 图片。');
      const blob=await response.blob();if(blob.size<=0||blob.size>16*1024*1024)throw Error('试画图片大小无效。');return blob;
    }
    async function show(job){
      if(!job||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(job.id??'')||job.previewOnly!==true||previewTask?.job?.id&&previewTask.job.id!==job.id)throw Error('试画任务身份不匹配，请重新检查。');
      previewTask.job=job;if(closed)return;field('drawing-progress').textContent=job.error??job.stage;
      if(['failed','interrupted','cancelled'].includes(job.state)){setBusy(false);return;}
      if(job.state==='success'){
        const blob=await previewImage(job);if(closed)return;if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=URL.createObjectURL(blob);
        previewTask.previewReady=true;field('drawing-image').src=imageUrl;field('drawing-image').hidden=false;field('drawing-download').href=imageUrl;field('drawing-download').hidden=false;field('drawing-progress').textContent='试画已生成，仅在本机预览。';setBusy(false);return;
      }
      if(!['queued','running'].includes(job.state))throw Error('试画任务状态无效，请继续查询上次任务。');
      setBusy(true);
      pollTimer=setTimeout(()=>resume(),1400);
    }
    async function resume(){
      if(closed||!previewTask)return;clearTimeout(pollTimer);setBusy(true);field('drawing-error').hidden=true;
      try{
        let result;
        if(previewTask.job?.id)result=await api('/api/drawing-capability/jobs/'+previewTask.job.id,undefined,true,{signal:controller.signal});
        else{
          // The first response may be lost after the server recorded the job.
          // Reuse its exact operation identity; never resave settings here.
          const current=await api('/api/drawing-capability',undefined,true,{signal:controller.signal});
          result=await api('/api/drawing-capability/generate',{prompt:previewTask.prompt,requestId:previewTask.requestId,previewOnly:true,revision:current.revision},false,{signal:controller.signal});
        }
        await show(result.job);
      }catch(value){error(value);if(!closed){field('drawing-progress').textContent='暂时无法读取上次试画结果，请点击“继续查询上次试画”。不会提交新的画面。';setBusy(false);}}
    }
    field('drawing-preview').addEventListener('click',async()=>{if(busy||!form.reportValidity())return;const prompt=field('drawing-prompt').value.trim();if(!prompt){error(Error('请描述想画的内容。'));return;}
      if(pending()){error(Error('上次试画结果还没确认，请先继续查询。'));return;}
      setBusy(true);field('drawing-error').hidden=true;field('drawing-progress').textContent='正在提交绘画，生成需要一些时间…';
      let submitted=false;
      try{await save();if(closed)return;previewTask={requestId:crypto.randomUUID(),prompt};submitted=true;
        field('drawing-image').hidden=true;field('drawing-download').hidden=true;
        const result=await api('/api/drawing-capability/generate',{requestId:previewTask.requestId,prompt,previewOnly:true,revision:saved.revision},false,{signal:controller.signal});await show(result.job);}
      catch(value){error(value);if(submitted&&[400,403,409,422,429].includes(value.status))previewTask=undefined;
        if(!closed){field('drawing-progress').textContent=submitted&&previewTask?'本次结果未确认，请继续查询上次试画；不要另外生成一张。':'试画尚未启动，请修正设置后重试。';setBusy(false);}}
    });
    field('drawing-resume').addEventListener('click',()=>{if(!busy)void resume();});
    setBusy(false);if(previewTask)void resume();
  }
  return {dialog};
}
