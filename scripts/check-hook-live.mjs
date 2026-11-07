// Explicit diagnostic send through a real OneBot WebSocket. No DSH generation.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { HookOneBot, root } from './hook-onebot.mjs';
import { ReverseOneBotServer } from '../components/qq-bridge/src/onebot/reverse-ws-server.js';

const target = process.argv[2], text = process.argv.slice(3).join(' ');
if (!/^\d+$/.test(target ?? '') || !text.trim()) throw new Error('Usage: node scripts/check-hook-live.mjs PRIVATE_ONEBOT_ID TEST_TEXT');
const adapter = new HookOneBot(), peer = new ReverseOneBotServer({ port: 0, timeoutMs: 45000 });
let connected;
const connection = new Promise(resolve => { connected = resolve; });
peer.on('open', connected); peer.on('error', () => {});
try {
  await peer.start();
  adapter.api.onebot_ws_url = `ws://127.0.0.1:${peer.server.address().port}/ws`;
  adapter.project.ports.adapter = 0;
  await adapter.start();
  await Promise.race([connection, sleep(10000).then(() => { throw new Error('Diagnostic OneBot connection timeout'); })]);
  const response = await peer.action('send_private_msg', {
    user_id: Number(target), message: [{ type: 'text', data: { text } }],
  });
  const apiAcknowledged=response.data?.receipt==='supplier-api'&&response.data?.delivered==='api-acknowledged'&&/^api-text:[a-f0-9]{64}$/.test(response.data?.message_id??'');
  if (response.data?.receipt !== 'wechat-server-id'&&!apiAcknowledged) throw new Error('Diagnostic has no verified receipt');
  const file = path.join(root, 'state', 'hook', 'deployment.json');
  const result = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  Object.assign(result, { outcome: apiAcknowledged?'native-private-send-api-acknowledged':'native-private-send-verified', hookAccountVerified: adapter.status.hook_account_verified, hookAccountVerification:adapter.status.hook_account_verification,
    realSendVerified: !apiAcknowledged, onebotWebSocketVerified: true, diagnosticSends: 1, textReceipt:response.data.receipt,apiAcknowledged });
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  console.log(apiAcknowledged?'Live native private send acknowledged by supplier API through OneBot; recipient delivery was not verified.':'Live native private send passed: real OneBot WebSocket response, new selected-conversation server receipt.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await adapter.stop(); await peer.stop(); }
