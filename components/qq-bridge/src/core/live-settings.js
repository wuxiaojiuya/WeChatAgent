export function applyLiveChatSettings(config,engines,groups,privateChats){
  const wechat=config.wechat;
  groups.clear();for(const id of wechat.whitelist.groups)groups.add(String(id));
  privateChats.clear();for(const id of wechat.whitelist.private)privateChats.add(String(id));
  for(const engine of engines)Object.assign(engine,{
    wakeWords:wechat.wake_words??[],mode:wechat.wake_mode??'hybrid',
    batchMs:config.social?.batch_ms??3000,minIntervalMs:config.social?.min_interval_ms??15000,
    privateMinIntervalMs:config.social?.private_min_interval_ms??1000,
    maxPerMinute:config.social?.max_per_minute??3,maxPerTenMinutes:config.social?.max_per_ten_minutes??10,
  });
}
