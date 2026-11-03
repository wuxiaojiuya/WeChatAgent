import {parsePersonaDecision} from '../../../../scripts/persona-approvals.mjs';
import {consoleClient} from '../../../../packages/dsh-social-bridge-plugin/console-client.mjs';
import {assistantSenderAllowed,verifiedAssistantSender} from '../../../../packages/dsh-social-bridge-plugin/assistant-policy.mjs';
import crypto from 'node:crypto';

export function createPersonaApprovalDelivery({root,adapter,settingsFor,isReady,accountScope,request=consoleClient(root),log=()=>{}}) {
  let running=false,stopped=false;
  const ready=()=>!stopped&&isReady()&&adapter.stats.connected&&!!adapter.selfId;
  async function tick(){
    if(running||!ready())return;running=true;
    try{
      const data=await request('/api/persona-proposals/notifications');
      for(const notice of data.notifications??[]){
        if(!ready())break;
        if(!assistantSenderAllowed(settingsFor(),'wechat:private:'+notice.target,notice.wxid))continue;
        const receipt=await adapter.sendText({kind:'private',target:notice.target,text:notice.text,deliveryId:notice.id});
        const confirmed=receipt?.confirmed===true||receipt?.accepted===true&&receipt?.delivered==='database-confirmed'&&receipt?.response?.data?.receipt==='wechat-server-id';
        if(!confirmed)break;
        if(!ready())break;
        await request('/api/persona-proposals/ack',{id:notice.id});
      }
    }catch{log('[Persona] approval_notice_deferred');}finally{running=false;}
  }
  async function receive(message){
    if(!parsePersonaDecision(message.text))return false;
    // Exact commands are consumed here; quoted, group and unauthorized input
    // never becomes a model-directed approval or a reply to a stranger.
    if(!ready()||message.kind!=='private'||!assistantSenderAllowed(settingsFor(),'wechat:private:'+message.conversation_id,verifiedAssistantSender(message)))return true;
    let text;
    try{const result=await request('/api/persona-proposals/decide',{message,accountScope});text=result.message;}
    catch(error){text=error.status?error.message:'人格审批服务暂不可用，请稍后重发原指令。';}
    if(ready())await adapter.sendText({kind:'private',target:message.conversation_id,text,deliveryId:crypto.createHash('sha256').update(JSON.stringify(['persona-result',accountScope,message.conversation_id,message.message_id,text])).digest('hex')});
    return true;
  }
  return {tick,receive,stop(){stopped=true;}};
}
