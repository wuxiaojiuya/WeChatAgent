const states=new Set(['ok','error','warning','pending']);
export const speechProtocolLabels=Object.freeze({auto:'自动识别地址格式', 'openai-transcriptions':'语音转写 API（文件上传）','openai-chat':'Chat 音频（Base64）','chat-audio-data-url':'Chat 音频（Data URL）','anthropic-messages':'Anthropic Messages（仅模型发现）',custom:'自定义请求（保留手动模板）'});
export function speechProtocolField({attr,field,schema,value,esc}){
  return `<div class="field"><label for="${esc(field)}">API 协议</label><select ${attr}>${schema.enum.map((option,index)=>`<option value="${index}" ${option===value?'selected':''}>${esc(speechProtocolLabels[option]??option)}</option>`).join('')}</select><small>像 DSH 一样按协议连接服务；标准语音协议自动处理路径、鉴权和响应。Anthropic 标准消息接口不能直接转写音频。</small></div>`;
}
export function speechModelField({attr,field,label,value,esc}){
  return `<div class="field speech-model-field"><label for="${field}">${label}</label><div class="speech-model-row"><select id="speech-api-models" aria-label="API 返回的模型"><option value="">读取后选择模型</option></select><input ${attr} type="text" value="${esc(value)}" placeholder="也可手动填写模型 ID" autocomplete="off"></div><small id="speech-model-hint">读取模型不会发送语音；列表可见不代表已验证语音识别。</small></div>`;
}
export function speechDiagnosticsMarkup(status={},esc){
  return `<section class="speech-service-panel" aria-label="语音接口配置状态"><div class="speech-service-heading"><strong>语音接口状态</strong><span id="speech-service-state" class="status-tag ${states.has(status.state)?status.state:'pending'}">${esc(status.label??'配置待检测')}</span></div><p id="speech-service-note" role="status" aria-live="polite">${esc(status.message??'读取模型后可检测识别接口和音频转换组件。')}</p><ul id="speech-service-checks" class="speech-service-checks"></ul><div class="speech-service-actions"><button type="button" class="button" id="speech-read-models">读取模型</button><button type="button" class="button" id="speech-check-api">检测配置</button></div><small>“检测配置”会调用一次识别 API，发送插件自带的测试短句音频，不使用聊天语音。</small></section>`;
}

export function bindSpeechSettings({form,api,item,revision,readValues,esc}){
  const modelInput=form.querySelector('[data-plugin-setting="model"]'),select=form.querySelector('#speech-api-models');
  const badge=form.querySelector('#speech-service-state'),note=form.querySelector('#speech-service-note'),checks=form.querySelector('#speech-service-checks'),hint=form.querySelector('#speech-model-hint');
  const readButton=form.querySelector('#speech-read-models'),checkButton=form.querySelector('#speech-check-api');
  let sequence=0,controller,timer,closed=false,models=[];
  const setState=(label,message,state='pending')=>{badge.textContent=label;badge.className='status-tag '+(states.has(state)?state:'pending');note.textContent=message;};
  const validEndpoint=()=>{try{const value=readValues().endpoint;return !!value&&['http:','https:'].includes(new URL(value).protocol);}catch{return false;}};
  const auto=()=>form.querySelector('[data-plugin-setting="autoReadModels"]')?.checked??true;
  function cancel(){clearTimeout(timer);sequence++;controller?.abort();readButton.disabled=false;checkButton.disabled=false;}
  function paint(report){
    setState(report.summary.label,report.summary.message,report.summary.state);
    checks.innerHTML=(report.configuration?.checks??[]).map(check=>`<li class="speech-check ${states.has(check.state)?check.state:'pending'}"><span>${check.state==='ok'?'通过':check.state==='error'?'需处理':check.state==='warning'?'注意':'待确认'}</span>${esc(check.message)}</li>`).join('');
    if(report.probe)checks.innerHTML+=`<li class="speech-check ${report.probe.verified?'ok':'warning'}"><span>接口测试</span>${esc(report.probe.message)}${report.probe.testedAt?`<small>语音测试时间：${esc(new Date(report.probe.testedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))}</small>`:''}${report.probe.text?`<q>${esc(report.probe.text)}</q>`:''}</li>`;
    if(report.lastAttempt)checks.innerHTML+=`<li class="speech-check ${report.lastAttempt.ok?'ok':'error'}"><span>最近微信语音</span>${report.lastAttempt.ok?'已收到并完成转写':'已收到，转写失败：'+esc(report.lastAttempt.code)}<small>${esc(new Date(report.lastAttempt.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))}</small></li>`;
    if(report.models){
      models=report.models.models??[];
      const oldValue=modelInput.value;
      select.innerHTML='<option value="">选择 API 返回的模型</option>'+models.map(model=>`<option value="${esc(model.id)}">${esc(model.id)}${model.transportHint==='websocket'?' · 实时协议，需适配':model.audioCandidate?' · 语音候选':''}</option>`).join('');
      select.value=models.some(model=>model.id===oldValue)?oldValue:'';
      if(report.models.ok){
        hint.textContent=`已读取 ${models.length} 个模型，其中 ${report.models.audioCandidates} 个语音候选。候选仍需测试确认。`;
        if(!oldValue)hint.textContent+=' 请选择实际需要的模型，再检测配置；不会自动替换模型。';
      }else hint.textContent=report.models.message??'模型列表不可用，可手动输入模型 ID 并测试识别。';
    }
  }
  async function run(kind,refreshModels=false){
    if(closed)return;cancel();const own=sequence;controller=new AbortController();readButton.disabled=true;checkButton.disabled=true;
    const test=kind==='check';setState(test?'检测中…':'正在读取模型…',test?'正在检查请求配置、转换组件及内置测试音频。':'正在读取当前接口返回的模型列表。');
    try{const report=await api('/api/plugins/speech-recognition/'+kind,{revision,settings:readValues(),refreshModels,...(test?{testAudio:true}:{})},{signal:controller.signal});if(closed||own!==sequence)return;paint(report);}
    catch(error){if(closed||own!==sequence||error.name==='AbortError')return;setState('检测未完成',error.message,'error');}
    finally{if(!closed&&own===sequence){readButton.disabled=false;checkButton.disabled=false;}}
  }
  const changed=event=>{
    if(!event.target.dataset?.pluginSetting)return;cancel();setState('设置已变化','请重新检测后保存，旧的检测结果不适用于当前设置。');checks.innerHTML='';
    if(/^https?:\/\//i.test(modelInput.value))setState('模型名填写有误','模型一栏需要模型 ID，不能填写网址。','error');
    if(['apiProtocol','requestMode','endpoint','apiKey','authHeader','authPrefix','headersJson','modelsEndpoint','modelsResponsePath','autoReadModels'].includes(event.target.dataset.pluginSetting)&&auto()&&validEndpoint())timer=setTimeout(()=>void run('models'),900);
  };
  form.addEventListener('input',changed);form.addEventListener('change',changed);
  select.addEventListener('change',()=>{if(!select.value)return;modelInput.value=select.value;changed({target:modelInput});});
  readButton.addEventListener('click',()=>void run('models',true));checkButton.addEventListener('click',()=>void run('check',true));
  if(auto()&&validEndpoint())timer=setTimeout(()=>void run('models'),150);
  return {cancel,dispose(){closed=true;cancel();form.removeEventListener('input',changed);form.removeEventListener('change',changed);}};
}
