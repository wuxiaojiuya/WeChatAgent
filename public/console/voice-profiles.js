const base='/api/audio-capabilities/voice/models';
export function voiceUploadMarkup({voices,esc}){
  return `<section class="audio-section music-section"><details class="music-import"><summary>上传音色</summary>
    <p class="subtle">语音直接使用参考录音合成，不经过换声。翻唱自动使用同一音色档案的 RVC 模型；请提供同一个人的录音与模型。</p>
    <div class="form-grid">
      <div class="field"><label for="voice-upload-target">音色档案</label><select id="voice-upload-target"><option value="">新建音色</option>${voices.filter(voice=>!voice.builtin).map(voice=>`<option value="${esc(voice.id)}">更新：${esc(voice.name)}</option>`).join('')}</select><small>已有音色可补充参考录音或配套翻唱模型。</small></div>
      <div class="field"><label for="voice-name">音色名称</label><input id="voice-name" maxlength="80" placeholder="例如：我的音色"></div>
      <div class="field"><label for="voice-reference">参考录音</label><input id="voice-reference" type="file" accept=".wav,.mp3,.flac,.m4a,.ogg"><small>3～30 秒清晰说话录音，无伴奏，最大 20 MB。</small></div>
      <div class="field"><label for="voice-reference-text">录音对应文字</label><textarea id="voice-reference-text" rows="2" maxlength="500" placeholder="准确填写参考录音中说的内容"></textarea></div>
      <div class="field"><label for="voice-model">配套翻唱模型（可选）</label><input id="voice-model" type="file" accept=".pth"><small>同一音色的 RVC 推理模型，最大 512 MB。仅有录音可直接说话，补齐模型后才能翻唱。</small></div>
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
      const reference=field('voice-reference').files[0],model=field('voice-model').files[0],index=field('voice-index').files[0];
      const name=field('voice-name').value.trim(),referenceText=field('voice-reference-text').value.trim();
      const existingVoiceId=field('voice-upload-target').value||undefined,selected=getVoices().find(voice=>voice.id===existingVoiceId);
      if(!name||(!reference&&!selected?.ttsReady)||(reference&&!referenceText))throw Error('请填写音色名称，上传参考录音并填写录音对应文字；已有录音可保留。');
      if(index&&!model)throw Error('请同时选择索引配套的 RVC 模型。');
      field('voice-upload-status').textContent='正在上传并检查音色文件…';
      const referenceUploadId=reference?await upload(reference,'reference'):undefined;
      const modelUploadId=model?await upload(model,'pth'):undefined,indexUploadId=index?await upload(index,'index'):undefined;
      const added=await api(base,{name,referenceText,referenceUploadId,modelUploadId,indexUploadId,existingVoiceId},true,{signal});
      if(signal.aborted)return;
      setVoices([...getVoices().filter(voice=>voice.id!==added.id),added]);
      field('audio-voice').value=added.id;await save();
      field('voice-upload-status').textContent=added.rvcModelId?'音色已保存，语音直接合成，翻唱自动沿用配套模型。':'音色已保存，可直接合成语音。翻唱还需在此音色下补充配套 RVC 模型。';
      for(const id of ['voice-reference','voice-model','voice-index'])field(id).value='';
    }catch(error){if(!signal.aborted){showError(error);field('voice-upload-status').textContent='音色尚未应用，请修正后重试。';}}
    finally{setBusy(false);if(!signal.aborted)field('voice-upload').disabled=false;}
  });
  field('voice-upload-target').addEventListener('change',()=>{
    const selected=getVoices().find(voice=>voice.id===field('voice-upload-target').value);
    field('voice-name').value=selected?.name??'';
    field('voice-reference-text').value='';
    field('voice-reference-text').placeholder=selected?.ttsReady?'不换参考录音时留空保留原文字':'准确填写参考录音中说的内容';
  });
}
