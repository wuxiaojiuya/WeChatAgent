import {musicMarkup,bindMusic} from './music-source.js';

export function createAudioCapabilityUI({api,modal,closeModal,escapeHtml:esc,state,renderPage,toast}) {
  async function dialog(item) {
    let saved=await api('/api/audio-capabilities');
    const voice=item.audioKind==='voice',kind=item.audioKind,settings=saved.settings[kind];
    const models=voice?[]:(await api('/api/audio-capabilities/music/models')).models;
    const keys=['private','groups'].flatMap(type=>(state.config.wechat.whitelist[type]??[]).map(id=>'wechat:'+(type==='groups'?'group':'private')+':'+id));
    let closed=false,busy=false,audioUrl,music;
    const controller=new AbortController();
    const input=(label,id,value,attrs='',help='')=>`<div class="field"><label for="${id}">${label}</label><input id="${id}" value="${esc(value)}" ${attrs}>${help?`<small>${help}</small>`:''}</div>`;
    const select=(label,id,value,options)=>`<div class="field"><label for="${id}">${label}</label><select id="${id}">${options.map(([key,name])=>`<option value="${esc(key)}" ${key===value?'selected':''}>${esc(name)}</option>`).join('')}</select></div>`;
    const fields=voice?`${input('肥鱼语音服务地址','audio-endpoint',settings.endpoint,'type="url" maxlength="2048"','启动 astrbot_plugin_feiyu_voice 的本地 HTTP 服务后填写地址。')}
      ${select('默认声线','audio-style',settings.style,[['cute','可爱'],['gentle','温柔']])}
      ${select('回复方式','audio-mode',settings.mode,[['ai-choice','由 AI 自然选择'],['on-request','用户要求时使用语音'],['prefer-voice','优先使用语音回复']])}
      ${select('情绪表达','audio-emotion-mode',settings.emotionMode??'auto',[['auto','AI 根据对话与人格自行判断'],['neutral','始终平静自然']])}
      ${select('情绪强度','audio-emotion-strength',settings.emotionStrength??'natural',[['gentle','轻微含蓄'],['natural','自然适度'],['strong','明显表达']])}
      <p class="subtle">AI 会区分开心、难过、不满、安慰、担忧和惊讶，用同一声线表达。需要支持情绪指令的本地肥鱼服务；效果以试听为准。</p>
      ${input('肥鱼服务 API Key','audio-api-key','','type="password" autocomplete="new-password" maxlength="4096"',(settings.hasApiKey?'已保存，留空保留。':'')+'这是肥鱼服务的本地访问令牌，不是火山引擎密钥，也不是 RVC 模型密钥。首次启动服务后，在服务目录的 .runtime/voice-service/api_key.txt 获取；自定义 data_dir 时到该目录查找。仅本机翻唱不需要此 Key。')}
      <label class="extension-option"><input id="audio-clear-key" type="checkbox" ${settings.hasApiKey?'':'disabled'}>清除已保存的密钥</label>`:
      `${select('唱歌音色 / RVC 模型','audio-model',settings.modelId,models.map(model=>[model.id,model.name]))}
      ${input('变调（半音）','audio-pitch',settings.pitch,'type="number" min="-12" max="12" step="1"','0 保留原调，正数升调，负数降调。')}
      ${input('试听时长（秒）','audio-clip',settings.clipSeconds,'type="number" min="10" max="30" step="1"')}
      <label class="extension-option audio-mix"><input id="audio-accompaniment" type="checkbox" ${settings.accompaniment?'checked':''}>保留原曲伴奏并混音</label>
      ${input('抖音访问 Cookie（可选）','audio-douyin-cookie','','type="password" autocomplete="new-password" maxlength="32768"',(settings.hasDouyinCookie?'已保存，留空保留。':'')+'链接提示需要访问凭据时，可在本机填写抖音网站 Cookie。仅保存在本机，只用于抖音解析；直接发微信视频无需填写。不要通过聊天发送 Cookie。')}
      <label class="extension-option"><input id="audio-clear-douyin-cookie" type="checkbox" ${settings.hasDouyinCookie?'':'disabled'}>清除已保存的抖音 Cookie</label>`;
    modal(item.name,`<form id="audio-capability-form" class="audio-capability-form"><div class="audio-scroll">
      <div class="audio-intro"><span class="audio-feature-icon" aria-hidden="true">♪</span><div><strong>${voice?'肥鱼本地语音回复':'用自己的音色翻唱'}</strong><p>${voice?'由本地肥鱼语音服务生成，可爱与温柔两种声线。':'人声分离 → RVC 换声 → 伴奏混音'}</p></div></div>
      <div class="audio-status-note">${voice?'语音合成后通过微信原生语音条发送；试听需要肥鱼 TTS 服务运行。':'支持对话点歌，也可直接发微信视频或抖音分享链接，说“这段唱给我听”。AI 使用视频原音轨分离、RVC 换声并混音，最长30秒。抖音链接无法公开访问时可改发视频。完成后发送微信原生语音；页面试听只在本机播放。'}<br>${esc(saved.nativeTransport?.message??'请启动并登录连接设置中匹配的微信，连接原生语音发送通道。')}</div>
      <label class="switch-row audio-enable"><div><strong>启用${item.name}</strong><p>聊天接入后按所选范围使用；本地试听可独立操作。</p></div><span class="switch-control"><input id="audio-enabled" type="checkbox" role="switch" aria-label="启用${item.name}" ${settings.enabled?'checked':''}><span class="switch-track"></span></span></label>
      <section class="audio-section"><h3>${voice?'服务与声线':'唱歌音色'}</h3><div class="form-grid">${fields}</div>${voice?'<button type="button" class="button" id="audio-check-button">保存并检测服务</button><p id="audio-check-status" role="status" class="subtle"></p>':''}</section>
      ${voice?`<section class="audio-section audio-preview-section"><h3>语音试听</h3>${select('试听情绪','audio-preview-emotion','neutral',[['neutral','平静'],['happy','开心'],['sad','难过'],['angry','不满'],['comforting','安慰'],['worried','担忧'],['surprised','惊讶']])}<label class="sr-only" for="audio-preview-text">试听文字</label><textarea id="audio-preview-text" rows="2" maxlength="500">你好，很高兴认识你。</textarea><div class="audio-preview-actions"><button type="button" class="button" id="audio-preview-button">保存并生成试听</button></div><p id="audio-preview-status" role="status" class="subtle"></p><audio id="audio-preview-player" controls hidden></audio></section>`:musicMarkup({settings,esc})}
      <fieldset class="extension-fieldset audio-scope"><legend>聊天范围</legend><p class="subtle">聊天接入后只在选中的聊天中使用。</p>${keys.length?keys.map(key=>`<label class="extension-option"><input type="checkbox" name="audio-chat" value="${esc(key)}" ${settings.chats.includes(key)?'checked':''}>${esc(state.names.get(key)??key)}</label>`).join(''):'<div class="audio-empty-scope">连接微信并添加聊天后，可选择好友或群聊。</div>'}</fieldset>
      </div><div class="audio-footer"><p id="audio-config-error" class="extension-error" role="alert" hidden></p><div class="modal-actions"><button type="button" class="button" data-close>关闭</button><button type="submit" class="button primary">保存配置</button></div></div></form>`,
      {className:'audio-modal',onClose(){closed=true;controller.abort();music?.close();document.querySelector('#audio-preview-player')?.pause();if(audioUrl)URL.revokeObjectURL(audioUrl);}});
    const form=document.querySelector('#audio-capability-form'),field=id=>form.querySelector('#'+id);
    function collect() {
      const common={enabled:field('audio-enabled').checked,chats:[...form.querySelectorAll('[name="audio-chat"]:checked')].map(input=>input.value)};
      return voice?{...common,provider:'feiyu',endpoint:field('audio-endpoint').value.trim(),style:field('audio-style').value,mode:field('audio-mode').value,emotionMode:field('audio-emotion-mode').value,emotionStrength:field('audio-emotion-strength').value,apiKey:field('audio-api-key').value}:
        {...common,provider:'feiyu-rvc',modelId:field('audio-model').value,pitch:Number(field('audio-pitch').value),clipSeconds:Number(field('audio-clip').value),
          accompaniment:field('audio-accompaniment').checked,musicSource:field('music-source').value,douyinCookie:field('audio-douyin-cookie').value};
    }
    function error(value){if(closed)return;field('audio-config-error').textContent=value.message;field('audio-config-error').hidden=false;}
    async function save() {
      saved=await api('/api/audio-capabilities/'+kind,{revision:saved.revision,settings:collect(),...(voice?{clearApiKey:field('audio-clear-key').checked}:{clearDouyinCookie:field('audio-clear-douyin-cookie').checked})},true,{signal:controller.signal});
      if(!closed&&voice){field('audio-api-key').value='';field('audio-clear-key').checked=false;field('audio-clear-key').disabled=!saved.settings.voice.hasApiKey;}
      if(!closed&&!voice){field('audio-douyin-cookie').value='';field('audio-clear-douyin-cookie').checked=false;field('audio-clear-douyin-cookie').disabled=!saved.settings.singing.hasDouyinCookie;}
      return saved;
    }
    if(!voice)music=bindMusic({form,api,save,esc,state,signal:controller.signal,showError:error});
    form.addEventListener('submit',async event=>{event.preventDefault();if(busy)return;busy=true;field('audio-config-error').hidden=true;
      try{await save();if(closed)return;closeModal();await renderPage();toast(item.name+'配置已保存。');}catch(value){error(value);}finally{busy=false;}});
    field('audio-preview-button')?.addEventListener('click',async()=>{
      if(busy||!form.reportValidity())return;busy=true;field('audio-preview-button').disabled=true;field('audio-config-error').hidden=true;
      field('audio-preview-status').textContent='正在调用肥鱼本地语音服务…';
      try{await save();const result=await api('/api/audio-capabilities/voice/preview',{revision:saved.revision,text:field('audio-preview-text').value,emotion:field('audio-preview-emotion').value},true,{signal:controller.signal});
        if(closed)return;const player=field('audio-preview-player');player.pause();if(audioUrl)URL.revokeObjectURL(audioUrl);
        audioUrl=URL.createObjectURL(new Blob([Uint8Array.from(atob(result.audio),char=>char.charCodeAt(0))],{type:result.mime}));player.src=audioUrl;player.hidden=false;field('audio-preview-status').textContent='试听已生成，点击播放器收听。';
      }catch(value){error(value);if(!closed)field('audio-preview-status').textContent='未生成试听。';}finally{busy=false;if(!closed)field('audio-preview-button').disabled=false;}
    });
    field('audio-check-button')?.addEventListener('click',async()=>{
      if(busy||!form.reportValidity())return;busy=true;field('audio-check-button').disabled=true;field('audio-config-error').hidden=true;
      field('audio-check-status').textContent='正在检测肥鱼服务、密钥和 TTS 配置…';
      try{await save();const result=await api('/api/audio-capabilities/voice/check',{revision:saved.revision},true,{signal:controller.signal});
        if(!closed)field('audio-check-status').textContent=result.message;
      }catch(value){error(value);if(!closed)field('audio-check-status').textContent='检测未完成。';}
      finally{busy=false;if(!closed)field('audio-check-button').disabled=false;}
    });
  }
  return {dialog};
}
