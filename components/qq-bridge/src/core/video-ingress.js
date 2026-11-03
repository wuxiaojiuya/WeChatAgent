import fs from 'node:fs';
import path from 'node:path';
import {buildConversationKey} from './conversation-key.js';

export function appendMediaText(message,text){
  if(message.quoteReply&&(message.video?.context==='quote'||message.voiceContext==='quote'||message.quotedFiles?.length))return {...message,
    quoteReply:{...message.quoteReply,reference:{...message.quoteReply.reference,attachmentText:text.slice(0,6000),unavailable:false,truncated:text.length>6000}}};
  return {...message,text:(message.text+'\n'+text).slice(0,4000)};
}

export function createVideoIngress({root,canRead=()=>true,fetchImpl=fetch}){
  return async(message,{signal}={})=>{
    if(!message.video&&!message.quotedFiles?.length)return message;
    const key=buildConversationKey(message.platform,message.kind,message.conversation_id);
    const unavailable=code=>appendMediaText(message,'['+(message.video?'视频已收到，但本轮未取得画面和声音':'引用文件未能读取')+'，不能猜测内容。'+code+']');
    if(!await canRead(message))return unavailable('VIDEO_NOT_ALLOWED');
    try{
      const io=JSON.parse(fs.readFileSync(path.join(root,'state/wechat-io-config.json'),'utf8').replace(/^\uFEFF/,'')),base=new URL(io.reader_base_url);
      if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.pathname!=='/'||base.username||base.password||base.search||base.hash)throw Error('VIDEO_READER_INVALID');
      async function read(route){
        const response=await fetchImpl(base.origin+route,{headers:{Authorization:'Bearer '+io.reader_token},redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(50000)].filter(Boolean))});
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
      const result=await read('/api/v1/videos/'+message.video.id+'?conversationKey='+encodeURIComponent(key));
      if(result.id!==message.video.id||result.conversationKey!==key||!Array.isArray(result.images)||result.images.length>4||result.images.some(image=>!/^[a-f0-9]{64}$/.test(image?.id??''))||typeof result.text!=='string'||result.text.length>1000)throw Error('VIDEO_RESPONSE_INVALID');
      if(!await canRead(message))throw Error('VIDEO_NOT_ALLOWED');
      const prepared=appendMediaText(message,result.text);
      return {...prepared,images:[...(message.images??[]),...result.images].slice(0,4),
        ...(result.voice&&/^[a-f0-9]{64}$/.test(result.voice.id??'')&&Number.isFinite(result.voice.durationSeconds)&&result.voice.durationSeconds>0&&result.voice.durationSeconds<=60?{voice:result.voice,voiceContext:message.video.context==='quote'?'quote':'video'}:{})};
    }catch(error){if(signal?.aborted)throw error;return unavailable(/^VIDEO_[A-Z_]{3,80}$/.test(error.message)?error.message:'VIDEO_PREPARATION_FAILED');}
  };
}
