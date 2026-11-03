const base='/api/audio-capabilities/music';
export function musicMarkup({settings}) {
  return `<section class="audio-section music-section"><h3>对话点歌</h3>
    <div class="music-conversation-note"><strong>想听什么，直接和 AI 说</strong><p>AI 理解歌名和你指定的版本，自动查找歌曲、选择可用音源并翻唱。不需要你查看歌手或挑选搜索结果。</p>
    <div class="music-example">你会唱歌吗？<span>会呀，想听哪首？</span></div><div class="music-example">你会唱朋友的酒 DJ 版吗？<span>按 DJ 版找歌，用已选音色翻唱。</span></div></div>
    <div class="field"><label for="music-source">歌曲来源</label><select id="music-source">${[['kugou','酷狗音乐'],['netease','网易云音乐'],['qq','QQ 音乐'],['local','仅本地曲库']].map(([id,name])=>`<option value="${id}" ${settings.musicSource===id?'selected':''}>${name}</option>`).join('')}</select><small>优先复用匹配的本地歌曲。找不到可用音源时会说明，不会用其他版本替代你指定的版本。</small></div>
    <p class="music-retention">下载缓存保存 7 天，到期自动删除。手动导入的歌曲和上传的模型会保留。</p><span id="music-cache-info" class="subtle"></span></section>
    <section class="audio-section music-section audio-preview-section"><details class="music-import" id="music-test"><summary>本机点歌测试与歌曲导入（可选）</summary>
      <p class="subtle">这里可以用一句话测试自动找歌和翻唱；聊天中由 AI 结合上下文理解你的话。</p>
      <div class="field"><label for="music-request">想听什么</label><input id="music-request" maxlength="180" placeholder="你会唱朋友的酒 DJ 版吗"></div>
      <div class="audio-preview-actions"><button type="button" class="button primary" id="music-generate">保存并试着点歌</button></div>
      <p id="music-job-status" class="subtle" role="status" aria-live="polite"></p><audio id="music-player" aria-label="翻唱试听播放器" controls hidden></audio><a id="music-download" class="music-download" hidden>下载试听音频</a>
      <details class="music-import"><summary>导入本机歌曲</summary><div class="form-grid">
        <div class="field"><label for="music-import-path">音频完整路径</label><input id="music-import-path" placeholder="D:\\音乐\\歌曲.mp3"><small>支持普通 MP3、FLAC、WAV、M4A，最大 64 MB。</small></div>
        <div class="field"><label for="music-import-title">歌曲名称（可选）</label><input id="music-import-title" maxlength="240" placeholder="留空使用文件名，如：朋友的酒（DJ版）"></div>
      </div><button type="button" class="button" id="music-import-button">加入本地曲库</button><p id="music-import-status" class="subtle" role="status"></p></details>
    </details></section>`;
}
export function bindMusic({form,api,save,state,signal,showError}) {
  const field=id=>form.querySelector('#'+id);
  let busy=false,closed=false,audioUrl;
  const request=(route,body)=>api(base+route,body,true,{signal});
  const setBusy=value=>{busy=value;for(const button of form.querySelectorAll('.music-section button'))button.disabled=value;};
  async function refresh(restore=false) {
    const info=await request('/status');if(closed)return;
    field('music-cache-info').textContent=`本地曲库 ${info.cachedSongs} 首 · ${(info.cacheBytes/1048576).toFixed(1)} MB`;
    if(!info.localCoverAvailable)field('music-job-status').textContent='本地 RVC 运行环境尚未准备。';
    if(restore&&info.latestJob&&['running','success'].includes(info.latestJob.state)){
      setBusy(true);field('music-test').open=true;await poll(info.latestJob.id);
    }
  }
  async function action(task) {
    if(busy)return;setBusy(true);
    try{await task();}catch(error){if(!closed){showError(error);field('music-job-status').textContent='这次操作没有完成，可稍后重试。';}}finally{if(!closed)setBusy(false);}
  }
  field('music-request').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();field('music-generate').click();}});
  field('music-import-button').addEventListener('click',()=>action(async()=>{
    await request('/import',{path:field('music-import-path').value.trim().replace(/^"|"$/g,''),title:field('music-import-title').value,artist:''});
    if(closed)return;field('music-import-status').textContent='已加入本地曲库，点歌时会自动匹配使用。';await refresh();
  }));
  async function poll(id) {
    while(!closed){
      const job=await request('/jobs/'+id);if(closed)return;
      field('music-job-status').textContent=job.stage;
      if(job.state==='failed')throw new Error(job.error);
      if(job.state==='success'){
        const result=await request('/preview',{jobId:id});if(closed)return;
        const player=field('music-player');player.pause();if(audioUrl)URL.revokeObjectURL(audioUrl);
        audioUrl=URL.createObjectURL(new Blob([Uint8Array.from(atob(result.audio),char=>char.charCodeAt(0))],{type:result.mime}));
        player.src=audioUrl;player.hidden=false;field('music-download').href=audioUrl;field('music-download').download=result.title+'-翻唱试听.mp3';field('music-download').hidden=false;
        field('music-job-status').textContent=`${job.title} · ${job.seconds.toFixed(1)} 秒，试听已生成。${job.previewOnly?'音源为平台提供的试听片段。':''}`;
        await refresh();return;
      }
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }
  field('music-generate').addEventListener('click',()=>action(async()=>{
    const message=field('music-request').value.trim();if(!message)throw new Error('告诉我想听哪首歌就好。');
    field('music-job-status').textContent='正在理解点歌并自动寻找可用音源…';
    await save();const result=await request('/request',{message});if(closed)return;
    if(!result.id){field('music-job-status').textContent=result.message;return;}
    await poll(result.id);
  }));
  setBusy(true);refresh(true).catch(error=>{if(!closed)showError(error);}).finally(()=>{if(!closed)setBusy(false);});
  return {close(){closed=true;field('music-player')?.pause();if(audioUrl)URL.revokeObjectURL(audioUrl);}};
}
