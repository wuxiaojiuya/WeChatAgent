const imageId = /^[a-f0-9]{64}$/;
const followup = /(?:描述|形容|分析|辨认|识别|讲讲|说说|看看|看清|看见|看到).{0,12}(?:图|画|照片|头像)|(?:这|那|刚才|上面|之前|上一张).{0,8}(?:图|画|照片|头像)|(?:图|画面|照片|头像).{0,12}(?:里|中|上|什么|谁|怎样|怎么样)|^(?:(?:再|具体|详细|仔细|重新|帮我|给我|你|请)\s*)*(?:描述|形容|分析|辨认|识别|看清楚)(?:一下|下|点|一点|了|了吗)?[呢吧啊嘛吗？?。.!！\s]*$|^(?:什么|啥)(?:颜色|发色|表情)|^(?:她|他|它).{0,8}(?:头发|衣服|发色|表情)|\b(?:describe|what(?:'s| is) in|look at).{0,20}(?:image|picture|photo)\b/i;

function sameChat(a, b) {
  return !!a.self_id && a.self_id === b.self_id && a.platform === b.platform && a.kind === b.kind &&
    String(a.conversation_id) === String(b.conversation_id) && (a.work_mode ?? 'social') === (b.work_mode ?? 'social');
}

function sameSender(a, b) {
  if (a.kind === 'group' || a.sender_wxid || b.sender_wxid) return !!a.sender_wxid && a.sender_wxid === b.sender_wxid;
  return !!a.sender_id && String(a.sender_id) === String(b.sender_id);
}

function explicitTarget(row) {
  return row.images?.length || row.video || row.files?.length || row.quoteReply || row.forwardedRecord ||
    /https?:\/\/|\[(?:图片|视频|文件|表情)\]/i.test(row.text ?? '');
}

/** Re-read a recent picture for an image follow-up, without retaining image
 * bytes in every model turn or substituting a different message's media. */
export function turnImages(rows, recent, {now = Date.now()} = {}) {
  const current = rows.flatMap(row => row.images ?? []).filter(image => imageId.test(image?.id ?? ''));
  if (current.length) return current.slice(0, 4);
  const latest = rows.findLast(row => !row.outgoing && !row.reply_skip_reason);
  if (!latest || rows.some(explicitTarget) || !followup.test(latest.text ?? '')) return [];

  // Never select a newer message that arrived while this batch was queued.
  const index = recent.findIndex(row => row.id && row.id === latest.id);
  const before = index >= 0 ? recent.slice(0, index) : recent.filter(row => row.timestamp <= latest.timestamp);
  const candidate = before.slice(-20).findLast(row => !row.outgoing && sameChat(latest, row) && explicitTarget(row));
  if (!candidate || candidate.reply_skip_reason || !sameSender(latest, candidate) || candidate.video || candidate.files?.length ||
      candidate.quoteReply || candidate.forwardedRecord || !Number.isFinite(candidate.timestamp) ||
      candidate.timestamp * 1000 > now || now - candidate.timestamp * 1000 > 600000) return [];
  const images = candidate.images ?? [];
  if (!images.length || images.some(image => !imageId.test(image?.id ?? '') || image.kind && image.kind !== 'image' || image.context === 'quote')) return [];
  return images.slice(0, 4).map(image => ({...image, context:'recent'}));
}
