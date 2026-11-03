const base='/api/audio-capabilities/voice/models';
export function voiceUploadMarkup({voices,esc}){
  return `<section class="audio-section music-section"><details class="music-import"><summary>上传音色</summary>
    <p class="subtle">上传 RVC 音色模型，说话先合成语音再换成此音色，翻唱共用此模型。无需参考录音或录音文字。</p>
    <div class="form-grid">
      <div class="field"><label for="voice-upload-target">音色档案</label><select id="voice-upload-target"><option value="">新建音色</option>${voices.filter(voice=>!voice.builtin).map(voice=>`<option value="${esc(voice.id)}">更新：${esc(voice.name)}</option>`).join('')}</select><small>已有音色可更新模型，说话和翻唱同时生效。</small></div>
      <div class="field"><label for="voice-name">音色名称</label><input id="voice-name" maxlength="80" placeholder="例如：我的音色"></div>
      <div class="field"><label for="voice-model">RVC 音色模型</label><input id="voice-model" type="file" accept=".pth"><small>RVC 推理模型，最大 512 MB。更新已有音色时可保留原模型。</small></div>
      <div class="field"><label for="voice-index">配套索引（可选）</label><input id="voice-index" type="file" accept=".index"><small>与 RVC 模型配套，最大 256 MB。</small></div>
    </div><button type="button" class="button" id="voice-upload">上传并使用音色</button><p id="voice-upload-status" class="subtle" role="status"></p>
  </details></section>`;
}
export function bindVoiceUpload({form,api,state,signal,getVoices,setVoices,save,showError,setBusy,isBusy}){
  const field=id=>form.querySelector('#'+id);
  async function upload(file,kind){
    const response=await fetch(base+'/upload?'+new URLSearchParams({kind,name:file.name}),{method:'POST',headers:{'X-Console-Token':state.token,'Content-Type':'application/octet-stream'},body:file,signal:AbortSignal.any([signal,AbortSignal.timeout(180000)])});
    const value=await response.json();if(!response.ok)throw Error(value.error??'音色上传失败。');return value.uploadId;
  }
  field('voice-upload').addEventListener('click',async()=>{
    if(isBusy())return;setBusy(true);field('voice-upload').disabled=true;
    try{
      const model=field('voice-model').files[0],index=field('voice-index').files[0];
      const name=field('voice-name').value.trim();
      const existingVoiceId=field('voice-upload-target').value||undefined,selected=getVoices().find(voice=>voice.id===existingVoiceId);
      if(!name||(!model&&!selected?.rvcModelId))throw Error('请填写音色名称并上传 RVC 模型；已有模型可保留。');
      if(index&&!model)throw Error('请同时选择索引配套的 RVC 模型。');
      field('voice-upload-status').textContent='正在上传并检查音色文件…';
      const modelUploadId=model?await upload(model,'pth'):undefined,indexUploadId=index?await upload(index,'index'):undefined;
      const added=await api(base,{name,modelUploadId,indexUploadId,existingVoiceId},true,{signal});
      if(signal.aborted)return;
      setVoices([...getVoices().filter(voice=>voice.id!==added.id),added]);
      field('audio-voice').value=added.id;await save();
      field('voice-upload-status').textContent='音色已保存，说话将先合成再换声，翻唱共用此音色。';
      for(const id of ['voice-model','voice-index'])field(id).value='';
    }catch(error){if(!signal.aborted){showError(error);field('voice-upload-status').textContent='音色尚未应用，请修正后重试。';}}
    finally{setBusy(false);if(!signal.aborted)field('voice-upload').disabled=false;}
  });
  field('voice-upload-target').addEventListener('change',()=>{
    const selected=getVoices().find(voice=>voice.id===field('voice-upload-target').value);
    field('voice-name').value=selected?.name??'';
  });
}
