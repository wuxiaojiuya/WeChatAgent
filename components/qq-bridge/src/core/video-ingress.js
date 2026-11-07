import fs from 'node:fs';
import path from 'node:path';
import {buildConversationKey} from './conversation-key.js';

export function turnVideos(rows,recent,{now=Date.now()}={}){
  const valid=row=>!row.outgoing&&!row.reply_skip_reason&&/^[a-f0-9]{64}$/.test(row.video?.id??'');
  const current=rows.filter(valid),quoted=current.filter(row=>row.video.context==='quote');
  if(current.length)return [...new Map((quoted.length?quoted:current).map(row=>[row.video.id,row.video])).values()].slice(-3);
  const latest=rows.findLast(row=>!row.outgoing);
  // An explicit quote points at a different message, so never substitute a prior video.
  if(!latest||latest.quoteReply)return [];
  const candidate=recent.slice(-20).findLast(row=>valid(row)&&row.self_id===latest.self_id&&
    row.platform===latest.platform&&row.kind===latest.kind&&String(row.conversation_id)===String(latest.conversation_id)&&
    (latest.kind!=='group'||row.sender_wxid&&row.sender_wxid===latest.sender_wxid)&&
    Number.isFinite(row.timestamp)&&row.timestamp*1000<=now&&now-row.timestamp*1000<=600000);
  return candidate?[{...candidate.video,context:'recent'}]:[];
}

export function douyinLink(message){
  if(/(?:不要|不用|别)(?:联网|搜索|查)/.test(message.text??''))return null;
  for(const [context,text] of [['message',message.text],['quote',message.quoteReply?.reference?.text]]){
    for(const match of String(text??'').matchAll(/https:\/\/[^\s<>"'，。！？；）)]+/g)){
      try{const url=new URL(match[0]);if(!url.username&&!url.password&&['v.douyin.com','www.douyin.com','douyin.com','www.iesdouyin.com'].includes(url.hostname))return {url:url.href,context};}catch{}
    }
  }
  return null;
}

export function appendMediaText(message,text){
  if(message.quoteReply&&(message.video?.context==='quote'||message.voiceContext==='quote'||message.quotedFiles?.length))return {...message,
    quoteReply:{...message.quoteReply,reference:{...message.quoteReply.reference,attachmentText:text.slice(0,6000),unavailable:false,truncated:text.length>6000}}};
  return {...message,text:(message.text+'\n'+text).slice(0,4000)};
}

export function createVideoIngress({root,canRead=()=>true,fetchImpl=fetch}){
  return async(message,{signal}={})=>{
    const link=!message.video?douyinLink(message):null;
    if(!message.video&&!message.quotedFiles?.length&&!link)return message;
    const key=buildConversationKey(message.platform,message.kind,message.conversation_id);
    const unavailable=code=>appendMediaText(message,'['+(message.video||link?'视频/链接已收到，但本轮未取得画面和声音':'引用文件未能读取')+'，不能猜测内容。'+code+(link?'。抖音链接可能需要新的访问 Cookie 或暂不可访问，可请对方把视频直接发到微信；也可在本机能力设置配置抖音 Cookie，不要让对方在聊天发送 Cookie。':'')+']');
    if(!await canRead(message))return unavailable('VIDEO_NOT_ALLOWED');
    try{
      const io=JSON.parse(fs.readFileSync(path.join(root,'state/wechat-io-config.json'),'utf8').replace(/^\uFEFF/,'')),base=new URL(io.receiver_base_url);
      if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.pathname!=='/'||base.username||base.password||base.search||base.hash)throw Error('VIDEO_READER_INVALID');
      async function read(route){
        const response=await fetchImpl(base.origin+route,{headers:{Authorization:'Bearer '+io.receiver_token},redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(link?85000:50000)].filter(Boolean))});
        let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>64000)throw Error('VIDEO_RESPONSE_INVALID');chunks.push(chunk);}
        const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!response.ok)throw Error(/^VIDEO_[A-Z_]{3,80}$/.test(result.error??'')?result.error:'VIDEO_READER_UNAVAILABLE');
        return result;
      }
      if(message.quotedFiles?.length){
        const file=message.quotedFiles[0],result=await read('/api/v1/quoted-files/'+file.id+'?conversationKey='+encodeURIComponent(key)+'&senderWxid='+encodeURIComponent(message.sender_wxid??''));
        if(result.id!==file.id||result.conversationKey!==key||typeof result.text!=='string'||result.text.length>6500||!await canRead(message))throw Error('VIDEO_RESPONSE_INVALID');
        return {...appendMediaText(message,result.text),message_type:'text'};
      }
      const result=await read(link?'/api/v1/video-link?url='+encodeURIComponent(link.url)+'&conversationKey='+encodeURIComponent(key):'/api/v1/videos/'+message.video.id+'?conversationKey='+encodeURIComponent(key));
      if(!/^[a-f0-9]{64}$/.test(result.id??'')||!link&&result.id!==message.video.id||result.conversationKey!==key||!Array.isArray(result.images)||result.images.length>4||result.images.some(image=>!/^[a-f0-9]{64}$/.test(image?.id??''))||typeof result.text!=='string'||result.text.length>1000)throw Error('VIDEO_RESPONSE_INVALID');
      if(!await canRead(message))throw Error('VIDEO_NOT_ALLOWED');
      if(link)message={...message,video:{id:result.id,context:link.context,source:'douyin'}};
      const prepared=appendMediaText(message,result.text);
      return {...prepared,images:[...(message.images??[]),...result.images].slice(0,4),
        ...(result.voice&&/^[a-f0-9]{64}$/.test(result.voice.id??'')&&Number.isFinite(result.voice.durationSeconds)&&result.voice.durationSeconds>0&&result.voice.durationSeconds<=60?{voice:result.voice,voiceContext:message.video.context==='quote'?'quote':'video'}:{})};
    }catch(error){if(signal?.aborted)throw error;return unavailable(/^VIDEO_[A-Z_]{3,80}$/.test(error.message)?error.message:'VIDEO_PREPARATION_FAILED');}
  };
}
