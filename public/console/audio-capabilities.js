import {musicMarkup,bindMusic} from './music-source.js';
import {voiceUploadMarkup,bindVoiceUpload} from './voice-profiles.js';

export function createAudioCapabilityUI({api,modal,closeModal,escapeHtml:esc,state,renderPage,toast}) {
  async function dialog(item) {
    let saved=await api('/api/audio-capabilities');
    const voice=item.audioKind==='voice',kind=item.audioKind,settings=saved.settings[kind];
    let voices=(await api('/api/audio-capabilities/voice/models')).voices;
    const selectedVoice=voices.find(value=>value.id===saved.settings.voice.voiceId);
    const keys=['private','groups'].flatMap(type=>(state.config.wechat.whitelist[type]??[]).map(id=>'wechat:'+(type==='groups'?'group':'private')+':'+id));
    let closed=false,busy=false,audioUrl,music;
    const controller=new AbortController();
    const input=(label,id,value,attrs='',help='')=>`<div class="field"><label for="${id}">${label}</label><input id="${id}" value="${esc(value)}" ${attrs}>${help?`<small>${help}</small>`:''}</div>`;
    const select=(label,id,value,options)=>`<div class="field"><label for="${id}">${label}</label><select id="${id}">${options.map(([key,name])=>`<option value="${esc(key)}" ${key===value?'selected':''}>${esc(name)}</option>`).join('')}</select></div>`;
    const fields=voice?`${select('音色','audio-voice',settings.voiceId,voices.map(value=>[value.id,value.name+(value.rvcModelId?'':'（待上传 RVC 模型）')]))}
      <p id="audio-voice-readiness" role="status" class="subtle"></p><button type="button" class="button" id="audio-complete-voice" hidden>补充此音色的 RVC 模型</button>
      <p class="subtle">先合成语音，再换成所选音色。说话和翻唱共用同一 RVC 模型。</p>
      ${select('回复方式','audio-mode',settings.mode,[['ai-choice','由 AI 自然选择'],['on-request','用户要求时使用语音'],['prefer-voice','优先使用语音回复']])}
      ${select('情绪表达','audio-emotion-mode',settings.emotionMode??'auto',[['auto','AI 根据对话与人格自行判断'],['neutral','始终平静自然']])}
      ${select('情绪强度','audio-emotion-strength',settings.emotionStrength??'natural',[['gentle','轻微含蓄'],['natural','自然适度'],['strong','明显表达']])}
      <p class="subtle">AI 会区分开心、难过、不满、安慰、担忧和惊讶，用同一声线表达。效果以实际试听为准。</p>`:
      `<p class="subtle">当前音色：${esc(selectedVoice?.name??'未选择')}。${selectedVoice?.rvcModelId?'自动沿用语音回复的音色。':'请在语音回复中补充此音色的 RVC 模型后启用翻唱。'}</p>
      ${input('变调（半音）','audio-pitch',settings.pitch,'type="number" min="-12" max="12" step="1"','0 保留原调，正数升调，负数降调。')}
      ${input('试听时长（秒）','audio-clip',settings.clipSeconds,'type="number" min="10" max="30" step="1"')}
      <label class="extension-option audio-mix"><input id="audio-accompaniment" type="checkbox" ${settings.accompaniment?'checked':''}>保留原曲伴奏并混音</label>
      ${input('抖音访问 Cookie（可选）','audio-douyin-cookie','','type="password" autocomplete="new-password" maxlength="32768"',(settings.hasDouyinCookie?'已保存，留空保留。':'')+'链接提示需要访问凭据时，可在本机填写抖音网站 Cookie。仅保存在本机，只用于抖音解析；直接发微信视频无需填写。不要通过聊天发送 Cookie。')}
      <label class="extension-option"><input id="audio-clear-douyin-cookie" type="checkbox" ${settings.hasDouyinCookie?'':'disabled'}>清除已保存的抖音 Cookie</label>`;
    modal(item.name,`<form id="audio-capability-form" class="audio-capability-form"><div class="audio-scroll">
      <div class="audio-intro"><span class="audio-feature-icon" aria-hidden="true">♪</span><div><strong>${voice?'本机语音回复':'用自己的音色演唱'}</strong><p>${voice?'语音合成 → 所选 RVC 音色换声，语音与翻唱共用音色。':'原曲人声 → AI 分析编排 → 所选 .pth 换声 → 混入伴奏'}</p></div></div>
      <div class="audio-status-note">${voice?'语音合成并换声后通过微信原生语音条发送；试听需要本机 TTS 与 RVC 环境就绪，无需上传说话录音。':'支持对话点歌、微信视频和抖音分享链接。直接点歌或视频点唱都会先分离原唱与伴奏，结合画面、可用转写和音轨测量编排升降调、分句轻重及伴奏比例，再用语音回复中选择的 .pth 换声混音。旋律、节奏、咬字沿用原唱，不重新生成演唱。最长30秒，速度取决于本机性能。抖音无法访问时可直接发视频。聊天中完成后发送微信原生语音；页面普通点歌试听只在本机播放。'}<br>${esc(saved.nativeTransport?.message??'请启动并登录连接设置中匹配的微信，连接原生语音发送通道。')}</div>
      <p class="subtle">WeChatAgent 管理设置、音色与任务；DSH 中的 AI 决定何时使用并调用能力插件生成。检查和试听也需要 DSH 已运行并加载能力插件。</p>
      <label class="switch-row audio-enable"><div><strong>启用${item.name}</strong><p>聊天接入后按所选范围使用；页面试听通过 DSH 插件生成。</p></div><span class="switch-control"><input id="audio-enabled" type="checkbox" role="switch" aria-label="启用${item.name}" ${settings.enabled?'checked':''}><span class="switch-track"></span></span></label>
      <section class="audio-section"><h3>${voice?'音色与表达':'翻唱设置'}</h3><div class="form-grid">${fields}</div>${voice?'<button type="button" class="button" id="audio-check-button">保存并检测音色</button><p id="audio-check-status" role="status" class="subtle"></p>':''}</section>
      ${voice?voiceUploadMarkup({voices,esc}):''}
      ${voice?`<section class="audio-section audio-preview-section"><h3>语音试听</h3>${select('试听情绪','audio-preview-emotion','neutral',[['neutral','平静'],['happy','开心'],['sad','难过'],['angry','不满'],['comforting','安慰'],['worried','担忧'],['surprised','惊讶']])}<label class="sr-only" for="audio-preview-text">试听文字</label><textarea id="audio-preview-text" rows="2" maxlength="500">你好，很高兴认识你。</textarea><div class="audio-preview-actions"><button type="button" class="button" id="audio-preview-button">保存并生成试听</button></div><p id="audio-preview-status" role="status" class="subtle"></p><audio id="audio-preview-player" controls hidden></audio></section>`:musicMarkup({settings,esc})}
      <fieldset class="extension-fieldset audio-scope"><legend>聊天范围</legend><p class="subtle">聊天接入后只在选中的聊天中使用。</p>${keys.length?keys.map(key=>`<label class="extension-option"><input type="checkbox" name="audio-chat" value="${esc(key)}" ${settings.chats.includes(key)?'checked':''}>${esc(state.names.get(key)??key)}</label>`).join(''):'<div class="audio-empty-scope">连接微信并添加聊天后，可选择好友或群聊。</div>'}</fieldset>
      </div><div class="audio-footer"><p id="audio-config-error" class="extension-error" role="alert" hidden></p><div class="modal-actions"><button type="button" class="button" data-close>关闭</button><button type="submit" class="button primary">保存配置</button></div></div></form>`,
      {className:'audio-modal',onClose(){closed=true;controller.abort();music?.close();document.querySelector('#audio-preview-player')?.pause();if(audioUrl)URL.revokeObjectURL(audioUrl);}});
    const form=document.querySelector('#audio-capability-form'),field=id=>form.querySelector('#'+id);
    const environmentLink=document.createElement('a');environmentLink.className='text-link';environmentLink.href='#settings/audio';environmentLink.textContent='安装或修复语音与翻唱环境';environmentLink.addEventListener('click',()=>closeModal());form.querySelector('.audio-status-note').append(document.createElement('br'),environmentLink);
    function collect() {
      const common={enabled:field('audio-enabled').checked,chats:[...form.querySelectorAll('[name="audio-chat"]:checked')].map(input=>input.value)};
      return voice?{...common,provider:'feiyu',endpoint:'http://127.0.0.1:9880',style:settings.style??'cute',voiceId:field('audio-voice').value,mode:field('audio-mode').value,emotionMode:field('audio-emotion-mode').value,emotionStrength:field('audio-emotion-strength').value,apiKey:''}:
        {...common,provider:'feiyu-rvc',modelId:saved.settings.singing.modelId,pitch:Number(field('audio-pitch').value),clipSeconds:Number(field('audio-clip').value),
          accompaniment:field('audio-accompaniment').checked,musicSource:field('music-source').value,douyinCookie:field('audio-douyin-cookie').value,neteaseCookie:field('music-netease-cookie').value};
    }
    function error(value){if(closed)return;field('audio-config-error').textContent=value.message;field('audio-config-error').hidden=false;}
    function showVoiceReadiness(){
      if(!voice)return;
      const selected=voices.find(value=>value.id===field('audio-voice').value),missing=selected&&!selected.rvcModelId;
      field('audio-voice-readiness').textContent=missing?'此音色缺少 RVC 模型，请上传 .pth 和可选 .index 后使用。':selected?'此音色可用于说话换声和翻唱，无需参考录音。生成试听可验证效果。':'请选择音色。';
      field('audio-complete-voice').hidden=!missing;
    }
    if(voice){
      field('audio-voice').addEventListener('change',showVoiceReadiness);
      field('audio-complete-voice').addEventListener('click',()=>{
        field('voice-upload-target').value=field('audio-voice').value;
        field('voice-upload-target').dispatchEvent(new Event('change'));
        field('voice-upload-target').closest('details').open=true;
        field('voice-model').focus();
      });
      showVoiceReadiness();
    }
    async function save() {
      saved=await api('/api/audio-capabilities/'+kind,{revision:saved.revision,settings:collect(),...(voice?{clearApiKey:true}:{clearDouyinCookie:field('audio-clear-douyin-cookie').checked,clearNeteaseCookie:field('music-clear-netease-cookie').checked})},true,{signal:controller.signal});
      if(!closed&&!voice){field('audio-douyin-cookie').value='';field('audio-clear-douyin-cookie').checked=false;field('audio-clear-douyin-cookie').disabled=!saved.settings.singing.hasDouyinCookie;music?.saved(saved.settings.singing);}
      return saved;
    }
    if(voice)bindVoiceUpload({form,api,state,signal:controller.signal,getVoices:()=>voices,setVoices(values){const current=field('audio-voice').value;voices=values;field('audio-voice').innerHTML=voices.map(value=>`<option value="${esc(value.id)}">${esc(value.name)}${value.rvcModelId?'':'（待上传 RVC 模型）'}</option>`).join('');field('audio-voice').value=current;field('voice-upload-target').innerHTML='<option value="">新建音色</option>'+voices.filter(value=>!value.builtin).map(value=>`<option value="${esc(value.id)}">更新：${esc(value.name)}</option>`).join('');},save:async()=>{const result=await save();showVoiceReadiness();return result;},showError:error,setBusy:value=>{busy=value;},isBusy:()=>busy});
    if(!voice)music=bindMusic({form,api,save,esc,state,signal:controller.signal,showError:error});
    form.addEventListener('submit',async event=>{event.preventDefault();if(busy)return;busy=true;field('audio-config-error').hidden=true;
      try{await save();if(closed)return;closeModal();await renderPage();toast(item.name+'配置已保存。');}catch(value){error(value);}finally{busy=false;}});
    field('audio-preview-button')?.addEventListener('click',async()=>{
      if(busy||!form.reportValidity())return;busy=true;field('audio-preview-button').disabled=true;field('audio-config-error').hidden=true;
      field('audio-preview-status').textContent='正在合成语音并换成所选音色，首次生成需要加载模型…';
      try{await save();const selected=voices.find(value=>value.id===field('audio-voice').value);
        if(selected&&!selected.rvcModelId)throw Error('设置已保存，请补充此音色的 RVC 模型后生成试听。');
        const result=await api('/api/audio-capabilities/voice/preview',{revision:saved.revision,text:field('audio-preview-text').value,emotion:field('audio-preview-emotion').value},true,{signal:controller.signal});
        if(closed)return;const player=field('audio-preview-player');player.pause();if(audioUrl)URL.revokeObjectURL(audioUrl);
        audioUrl=URL.createObjectURL(new Blob([Uint8Array.from(atob(result.audio),char=>char.charCodeAt(0))],{type:result.mime}));player.src=audioUrl;player.hidden=false;field('audio-preview-status').textContent='试听已生成，点击播放器收听。';
      }catch(value){error(value);if(!closed)field('audio-preview-status').textContent=value.message||'试听生成失败，请重试。';}finally{busy=false;if(!closed)field('audio-preview-button').disabled=false;}
    });
    field('audio-check-button')?.addEventListener('click',async()=>{
      if(busy||!form.reportValidity())return;busy=true;field('audio-check-button').disabled=true;field('audio-config-error').hidden=true;
      field('audio-check-status').textContent='正在检测 TTS 服务、所选 RVC 音色与换声环境…';
      try{await save();const result=await api('/api/audio-capabilities/voice/check',{revision:saved.revision},true,{signal:controller.signal});
        if(!closed)field('audio-check-status').textContent=result.message;
      }catch(value){error(value);if(!closed)field('audio-check-status').textContent=value.message||'音色检测失败，请重试。';}
      finally{busy=false;if(!closed)field('audio-check-button').disabled=false;}
    });
  }
  return {dialog};
}
