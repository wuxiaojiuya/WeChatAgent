import {sessionUsage} from './session-usage.js';
import {consoleRoute,routeKey,SETTINGS_SECTIONS} from './layout-model.mjs';
import {createWorkspaceLayout} from './workspace-layout.js';
import {createAudioRuntimeUI} from './audio-runtime.js';
import {createMemoryUI} from './memory-view.js';
import {createFishNotebookUI} from './fish-notebook.js';
import {createAssistantFeedbackUI} from './assistant-feedback.js';
'use strict';
import { personaError, decodePersonaFile, MAX_PERSONA_BYTES } from './persona-files.mjs';
import {createPersonaDeletion} from './persona-delete.js';
import {createPersonaCategoryUI} from './persona-categories.js';
import {dshInstallCard} from './dsh-install.mjs';
import {createSessionGroupUI} from './session-groups.js';
import { initAppearance } from './appearance.js';
import { installExternalLinks } from './external-links.js';
import { startUpdateUI } from './updates.js';
import { createExtensionUI } from './extensions.js';
import {createStickerManagerUI} from './sticker-manager.js';
import {mergeConversationSave} from './conversation-settings.mjs';
import {openProcessRecovery,needsWeChatRepair} from './process-recovery.js';
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<svg aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
const state = { token: '', config: null, draft: null, revision: '', page: 'overview', roles: [], roleDrafts: new Map(), selectedRole: '', chatKind: 'all', names: new Map(), status: null, job: null, logs: null, loading: false, connection: null };
const roleSaves = new Map();
const fishNotebookUI=createFishNotebookUI({api,state,escapeHtml,icon,renderPage,toast,onSave:result=>syncExtensionProject(result,'fishNotebook')});
const memoryUI=createMemoryUI({api,state,escapeHtml,icon,renderPage,toast,notebookPage:()=>fishNotebookUI.page()});
const assistantFeedbackUI=createAssistantFeedbackUI({api,modal,closeModal,escapeHtml,icon,toast});
const personaCategoryUI=createPersonaCategoryUI({state,api,modal,closeModal,escapeHtml,renderPage,toast});
const sessionGroupUI=createSessionGroupUI({api,modal,closeModal,escapeHtml,icon,renderPage,toast});
const deletePersona=createPersonaDeletion({state,roleSaves,api,modal,closeModal,escapeHtml,renderPage,updateDraftUI,toast});
installExternalLinks({report:message=>toast(message)});
const extensionUI = createExtensionUI({api,modal,closeModal,confirmAction,escapeHtml,icon,state,renderPage,toast,onDshSave:(result,key)=>{state.draft=mergeConversationSave(state.config,state.draft,result.config,key,result.administratorIdentity);state.config=result.config;state.revision=result.revision;updateDraftUI();refreshStatus();},onProjectSave:syncExtensionProject});
const stickerManagerUI=createStickerManagerUI({api,modal,closeModal,escapeHtml,icon,state,renderPage,toast});
const audioRuntimeUI=createAudioRuntimeUI({api,escapeHtml,toast});
const workspaceLayout=createWorkspaceLayout({api,state,escapeHtml,icon,header,field,toggle,empty,sessionGroupUI,sessionUsage:typeof sessionUsage==='function'?sessionUsage:()=>'',getCards:settingsCards,contextSettingsCard,feedbackCard:()=>assistantFeedbackUI.card(),connectionsPage,audioRuntimePage:()=>audioRuntimeUI.page(),logsPage,toolsPage,dshPage:()=>extensionUI.dshPage(),stickerPage:()=>stickerManagerUI.page()});
const pageScroll=new Map();let currentRoute={page:'overview'};
function selectRoute(hash){currentRoute=consoleRoute(hash);state.page=currentRoute.page;if(currentRoute.page==="memory")state.memorySection=currentRoute.section;state.settingsSection=currentRoute.page==='settings'?currentRoute.section:state.settingsSection;state.stickerSection=currentRoute.page==='stickers'?currentRoute.section:state.stickerSection;state.capabilitySection=currentRoute.page==='extensions'?currentRoute.section:state.capabilitySection;if(currentRoute.detail)state.chatDetailTab=currentRoute.detail;}
const pages = {
  settings: ['设置', '默认行为、连接与诊断按用途分类。'],
  setup: ['首次配置', '按下面的步骤连接自己的微信与模型，无需命令行。'],
  overview: ['概览', '微信助手的运行情况，一眼看清。'],
  chats: ['聊天', '选择好友或群聊，集中管理模式、能力、工作区与任务。'],
  roles: ['人格卡', '设置助手的性格、语气与聊天习惯。'],
  sessions: ['会话', '分别整理聊天记录，允许且开启历史的会话共享 DSH 记忆。'],
  behavior: ['回复设置', '决定何时回复，以及回复的频率。'],
  connections: ['连接设置', '连接本机微信、消息接收服务与 DSH。'],
  logs: ['运行日志', '查看最近的运行记录，定位连接与收发问题。'],
  tools: ['工具', '安装、检查与维护，通过按钮完成。'],
  extensions: ['能力', '查看内置能力与 DSH 来源，在聊天中独立分配权限。'],
  stickers: ['表情包', '查看、添加与整理当前账号的共享表情包。'],
  memory: ['记忆', '群聊与私聊共享 DSH 的经历，按来源查看群友观察与会话摘要。'],
};
const actions = {
  start: ['启动助手', '正在自动准备微信收发连接并启动助手，通常需要几十秒。请先在微信中完成登录。'],
  stop: ['停止服务', '停止本项目管理的服务，控制台会继续保持打开。'],
  restart: ['重启并应用', '正在重新读取设置、自动准备微信收发连接并重启本项目服务。'],
  'apply-settings': ['应用设置', '正在自动应用设置，等待当前模型任务完成后重载必要组件。'],
  prepare: ['准备配置', '生成连接配置与插件设置。'],
  setup: ['安装依赖', '按现有锁文件安装依赖，需要联网，可能耗时几分钟。'],
  'wechat-open': ['打开匹配微信', '正在打开匹配微信并自动加载内置 Hook。打开后请登录，再到概览启动助手。'],
  'dsh-open': ['打开 DSH', '打开模型程序，在 DSH 中登录并启用本项目插件。'],
  'hook-check': ['检查发送连接', '检查发送组件、微信版本和就绪状态。'],
  'hook-build': ['准备发送组件', '按当前 Hook 配置准备组件。新 Hook 使用你提供的 DLL 与启动器。'],
  'sessions-configure': ['同步会话名称', '按聊天名称和当前人格更新 DSH 会话名称。'],
  'sessions-compact': ['压缩上下文', '在同一 DSH 会话内生成摘要，这会调用模型。'],
};
const searchDefaults={enabled:false,cache:true,maxResults:3,maxSnippetChars:1200,maxSearchesPerTurn:1,timeoutMs:20000,cacheTtlSeconds:900};
const proactiveDefaults={enabled:false,mode:'mixed',intervalMinutes:240,idleMinutes:120,startTime:'09:00',endTime:'22:00',useSearch:true,jitterMinutes:15};
const contextDefaults={enabled:false,maxTokens:100000,idleSeconds:60};
const getPath = (object, path) => {const value=path.split('.').reduce((value,key)=>value?.[key],object);if(value!==undefined)return value;if(path==='wechat.stickers.collectEnabled')return object.wechat?.stickers?.collectGroups??true;if(path==='wechat.stickers.shareEnabled')return object.wechat?.stickers?.shareGroups??true;if(['wechat.stickers.enabled','wechat.stickers.labelCache','wechat.stickers.collectGroups','wechat.stickers.shareGroups'].includes(path))return true;if(path==='wechat.replyLayout.maxMessages')return 2;if(path==='wechat.stickers.candidateLimit')return 8;if(path==='wechat.webReader.enabled')return true;if(path.startsWith('wechat.search.'))return searchDefaults[path.split('.').at(-1)];if(path.startsWith('wechat.proactive.'))return proactiveDefaults[path.split('.').at(-1)];if(path.startsWith('wechat.context.'))return contextDefaults[path.split('.').at(-1)];return value;};
function syncExtensionProject(result,feature) {
  const previous=state.config, draft=state.draft;
  state.config=result.config;state.revision=result.revision;
  state.draft=structuredClone(result.config);
  // Retain unrelated pending form edits when an extension saves one feature.
  function retain(old,savedDraft,target) {
    for(const key of Object.keys(savedDraft ?? {})) {
      if(key==='wechat')continue;
      if(JSON.stringify(savedDraft[key])!==JSON.stringify(old?.[key]))target[key]=structuredClone(savedDraft[key]);
    }
  }
  retain(previous,draft,state.draft);
  for(const key of Object.keys(draft?.wechat ?? {}))if(key!==feature && JSON.stringify(draft.wechat[key])!==JSON.stringify(previous?.wechat?.[key]))state.draft.wechat[key]=structuredClone(draft.wechat[key]);
}
function setPath(object, path, value) { const keys = path.split('.'); const last = keys.pop(); let target = object; for (const key of keys) target = target[key] ??= {}; target[last] = value; }
const configDirty = () => state.config && JSON.stringify(state.config) !== JSON.stringify(state.draft);
const hasDraft = () => configDirty() || state.roleDrafts.size > 0;
window.desktop?.onQuitCheck?.(()=>Boolean(hasDraft()||document.querySelector('#chat-settings-form [type=submit]:not(:disabled)')));
window.desktop?.onShutdownState?.(phase=>{
  state.shuttingDown=['checking','stopping'].includes(phase);document.body.inert=state.shuttingDown;
  if(state.shuttingDown){$('#connection-label').innerHTML='<i class="dot"></i><span>正在停止后台服务…</span>';}
  else if(['idle','failed'].includes(phase)){state.closed=false;void refreshStatus();}
});
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 4200); }
function showError(message) { $('#connection-error').textContent = message; $('#connection-error').hidden = false; }
function updateDraftUI() {
  $('#save-bar').hidden = !hasDraft(); document.body.classList.toggle('has-draft', hasDraft());
  $('#nav-chat-count').textContent = state.draft ? state.draft.wechat.whitelist.private.length + state.draft.wechat.whitelist.groups.length : '—';
  $('#save-button').disabled = state.savingAll || roleSaves.size > 0 || !!state.job && state.job.state === 'running';
  $('#discard-button').disabled = state.savingAll || roleSaves.size > 0;
  const savingRole = roleSaves.has(state.selectedRole);
  if ($('#save-role')) {
    $('#save-role').disabled = state.savingAll || savingRole || !state.roleDrafts.has(state.selectedRole) || state.job?.state === 'running';
    $('#save-role').textContent = savingRole ? '正在保存…' : '保存人格';
    $('#role-edit-status').textContent = savingRole ? '正在保存' : state.roleDrafts.has(state.selectedRole) ? '有未保存的修改' : '已保存';
  }
  if($('#delete-role'))$('#delete-role').disabled=state.savingAll||roleSaves.size>0||!!state.deletingRole||state.job?.state==='running';
}
async function api(route, body, retry = true, options = {}) {
  const timeout=AbortSignal.timeout(route === '/api/browse' ? 180000 : route === '/api/contacts'||route.startsWith('/api/contacts?') ? 130000 : route === '/api/audio-capabilities/music/request' ? 90000 : route === '/api/audio-capabilities/voice/preview' ? 300000 : route === '/api/audio-capabilities/music/cache' ? 60000 : route === '/api/fish-notebook/write'||route === '/api/persona/default/generate' ? 45000 : route === '/api/plugins/speech-recognition/check' ? 40000 : 20000);
  const response = await fetch(route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Console-Token': state.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: options.signal?AbortSignal.any([timeout,options.signal]):timeout, ...(options.cache?{cache:options.cache}:{}) });
  const result = await response.json();
  if (response.status === 401 && retry) {
    const info = await fetch('/api/info').then(r => r.json());
    if (info.root !== state.root) throw new Error('控制台连接到其他项目，请重新打开当前项目入口。');
    state.token = info.token; return api(route, body, false, options);
  }
  if (!response.ok) throw Object.assign(new Error(result.error ?? '操作失败，请重试。'),{status:response.status});
  return result;
}
let modalLifecycle = {};
function modal(title, content, options = {}) {
  modalLifecycle.onClose?.(); modalLifecycle = options;
  $('#modal').className = options.className ?? '';
  $('#modal-title').textContent = title; $('#modal-content').innerHTML = content;
  if (!$('#modal').open) $('#modal').showModal();
}
function closeModal(options = {}) {
  if (options.force !== true && modalLifecycle.beforeClose?.() === false) return;
  const cleanup = modalLifecycle.onClose; modalLifecycle = {}; cleanup?.();
  $('#modal').close(); $('#modal').className = '';
}
function confirmAction(title, description, label, callback) {
  modal(title, `<p class="modal-description">${escapeHtml(description)}</p><div class="modal-actions"><button class="button" data-close>取消</button><button class="button primary" id="confirm-action">${escapeHtml(label)}</button></div>`);
  $('#confirm-action').addEventListener('click', () => { closeModal(); callback(); }, { once: true });
}
function field(label, path, { type = 'text', help = '', placeholder = '', transform = '', min, max, step, full = false, browse = '', required = false } = {}) {
  let value = getPath(state.draft, path);
  if (transform === 'lines') value = (value ?? []).join('\n');
  if (transform === 'seconds') value /= 1000;
  const id = 'field-' + path.replaceAll('.', '-');
  const attrs = `id="${id}" data-path="${path}" data-transform="${transform}" ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''} ${step ? `step="${step}"` : ''} ${required ? 'required' : ''}`;
  const input = transform === 'lines' ? `<textarea ${attrs} placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>` : `<input ${attrs} type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">`;
  return `<div class="field ${full ? 'full' : ''}"><label for="${id}">${label}</label>${browse ? `<div class="input-with-button">${input}<button class="button" data-browse="${browse}" data-target="${id}">${icon('folder')}选择</button></div>` : input}${help ? `<small>${help}</small>` : ''}</div>`;
}
function toggle(label, path, help) {
  const id = 'switch-' + path.replaceAll('.', '-');
  return `<div class="switch-row"><div><label for="${id}">${label}</label><p>${help}</p></div><label class="switch-control"><input type="checkbox" role="switch" id="${id}" data-path="${path}" ${getPath(state.draft, path) ? 'checked' : ''} aria-label="${label}"><span class="switch-track"></span></label></div>`;
}
function header(title, description = '', right = '', name = '') { return `<div class="card-header"><div class="${name ? 'section-label' : ''}">${name ? `<span class="section-icon">${icon(name)}</span>` : ''}<div><h2>${title}</h2>${description ? `<p class="card-description">${description}</p>` : ''}</div></div>${right}</div>`; }
function empty(title, description, button = '', name = 'chat') { return `<div class="empty-state">${icon(name)}<h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p>${button}</div>`; }
function modeSelector() {
  return `<div class="mode-selector"><button class="mode-option ${state.draft.wechat.wake_mode === 'hybrid' ? 'selected' : ''}" data-mode="hybrid" aria-pressed="${state.draft.wechat.wake_mode === 'hybrid'}"><strong>自然参与</strong><span>看场合接话，其他时间旁听</span></button><button class="mode-option ${state.draft.wechat.wake_mode === 'mention' ? 'selected' : ''}" data-mode="mention" aria-pressed="${state.draft.wechat.wake_mode === 'mention'}"><strong>唤醒后回复</strong><span>识别昵称提示与唤醒词</span></button></div>`;
}
function overviewPage() {
  const c = state.draft;
  return `<div class="dashboard-grid">
    <section class="card power-card"><div class="power-top"><div class="power-copy"><span class="eyebrow">微信助手</span><h2 id="power-title">正在检查连接</h2><p id="power-description">等待本机服务响应。</p></div><button class="power-control" id="power-button" data-action="start" aria-label="启动助手">${icon('power')}</button></div><div class="power-bottom"><span id="power-tag" class="status-tag">检查中</span><div class="button-row"><button class="button small" data-action="wechat-open">${icon('chat')}打开微信</button><button class="button small" data-action="restart">${icon('refresh')}重启</button></div></div></section>
    <section class="card">${header('聊天默认值','各聊天可独立覆盖。','','chat')}<p class="card-description">群聊默认：${c.wechat.wake_mode==='mention'?'唤醒后回复':'自然参与'} · 默认人格：${escapeHtml(c.persona.default)}</p><div class="button-row space-top"><a class="button" href="#chats">管理聊天</a><a class="button" href="#settings/chat">编辑默认值</a></div></section>
    <section class="card wide">${header('连接检查', '', '<a class="text-link" href="#connections">连接设置' + icon('arrow') + '</a>')}<div class="service-track" id="service-track"><div class="loading-state">检查本机连接中…</div></div></section>
    <div class="metrics wide"><section class="card"><div class="metric-label">${icon('chat')}缓存消息</div><div class="metric-value" id="metric-messages">—<span>条</span></div><p class="metric-note" id="metric-note">本机保留的消息记录</p></section><section class="card"><div class="metric-label">${icon('person')}允许的好友</div><div class="metric-value">${c.wechat.whitelist.private.length}<span>位</span></div><a class="text-link metric-note" href="#chats">管理允许的聊天 ${icon('arrow')}</a></section><section class="card"><div class="metric-label">${icon('users')}允许的群聊</div><div class="metric-value">${c.wechat.whitelist.groups.length}<span>个</span></div><p class="metric-note">独立人格与会话上下文</p></section></div>
    <section class="card">${header('最近记录', '', '<a class="text-link" href="#sessions">查看会话' + icon('arrow') + '</a>')}<div id="recent-list"><div class="loading-state">读取记录中…</div></div></section>
    <section class="card">${header('连接与维护','在设置中检查、修复微信或 DSH。')}<p class="card-description">连接异常会在上方显示，详细日志和端口检查集中在诊断中。</p><a class="button" href="#settings/diagnostics">连接诊断</a></section>
  </div>`;
}
function paintStatus() {
  if(state.shuttingDown)return;
  const s = state.status; if (!s) return;
  const busy = state.job?.state === 'running';
  const statusText = busy ? '正在操作' : s.ready ? '机器人运行中' : s.running ? '连接待完成' : '服务未启动';
  $('#connection-label').innerHTML = '<i class="dot '+(s.ready&&!busy?'online':'warning')+'"></i><span>'+statusText+'</span>';
  $('#connection-label').title = '控制台已连接。'+statusText+'，点击查看连接详情。';
  $('#connection-label').setAttribute('aria-label',statusText+'，查看连接详情');
  $('#updated-label').textContent = '更新于 ' + new Date(s.updatedAt).toLocaleTimeString('zh-CN', { hour12: false });
  $('#pending-banner').hidden = !s.pendingApply && !s.dshReloadRequired;
  $('#pending-message').textContent = s.activeJob?.action==='apply-settings' ? '正在自动应用设置，请稍候…' : s.dshReloadRequired ? 'DSH 尚未加载当前插件和能力服务。请从托盘完整退出并重开 DSH，然后重新应用。' : '设置尚未完成应用，请点击“重新应用”查看处理结果。';
  $('#pending-banner button').disabled=!!s.activeJob;
  if (state.page !== 'overview') return;
  const runningJob = state.job?.state === 'running';
  $('#power-title').textContent = runningJob ? '正在' + (actions[state.job.action]?.[0] ?? '操作') : s.ready ? '运行中' : s.running ? '连接待完成' : '服务未启动';
  $('#power-description').textContent = runningJob ? '操作完成后会自动更新运行状态。' : s.ready ? '收发连接已就绪，按当前设置自动回复。' : s.running ? '部分连接尚未就绪，查看下方连接检查。' : '在设置中打开微信并登录，再点击右侧按钮启动助手，程序会自动准备连接。';
  const power = $('#power-button'); power.dataset.action = s.running ? 'stop' : 'start'; power.setAttribute('aria-label', s.running ? '停止服务' : '启动助手'); power.classList.toggle('active', s.ready); power.disabled = runningJob;
  $('#power-tag').className = 'status-tag ' + (s.ready ? 'ok' : s.running ? 'warn' : '');
  $('#power-tag').innerHTML = `<i class="dot ${s.ready ? 'online' : s.running ? 'warning' : ''}"></i>${s.ready ? '全部连接正常' : s.running ? '需要检查连接' : '等待启动'}`;
  $('#service-track').innerHTML = s.services.map(service => `<div class="service-node"><div class="service-node-top"><i class="dot ${service.ready ? 'online' : 'warning'}"></i><strong>${escapeHtml(service.label)}</strong><span class="port">:${service.port}</span></div><p>${escapeHtml(service.detail)}</p><span class="status-tag ${service.ready ? 'ok' : 'warn'}">${service.ready ? '已就绪' : '待连接'}</span></div>`).join('');
  $('#metric-messages').innerHTML = `${s.stats.received + s.stats.sent}<span>条</span>`;
  $('#metric-note').textContent = `接收 ${s.stats.received} · 发出 ${s.stats.sent} · 待处理 ${s.stats.pending}`;
  $('#recent-list').innerHTML = s.recent.length ? s.recent.map(row => `<div class="recent-row"><span class="avatar">${escapeHtml((row.name || '聊').slice(0, 1))}</span><div class="recent-copy"><strong>${escapeHtml(row.name || row.key)}</strong><p>${escapeHtml(row.text || '附件消息')}</p></div><div class="recent-meta">${new Date(row.timestamp * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}<div class="direction">${row.outgoing ? '发出' : '接收'}</div></div></div>`).join('') : empty('还没有消息记录', '服务启动后，允许的好友和群聊消息会出现在这里。', '', 'history');
}
function roleOptions(value, includeDefault = false) {
  return (includeDefault ? '<option value="">跟随默认人格</option>' : '') + state.roles.map(r => `<option value="${escapeHtml(r.name)}" ${r.name === value ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
}
function conversationSummary(key) {
  const c=state.draft, a=c.wechat.dshAccess?.chats?.[key]??{}, role=c.persona.chats?.[key]??c.persona.default;
  const workMode=c.wechat.workModes?.[key]??'social',mode=c.wechat.chatModes?.[key]??(workMode==='assistant'?'mention':c.wechat.wake_mode);
  return '<p class="conversation-summary">'+(workMode==='assistant'?'助手模式'+(key.includes(':group:')?' · 群友聊天 / 管理员执行':' · 仅管理员'):'聊天模式')+' · 人格：'+escapeHtml(role)+(key.includes(':group:')?' · '+(mode==='mention'?'唤醒后回复':'自然参与'):'')+'</p><p class="conversation-summary">'+(workMode==='assistant'&&a.mode==='native'?'使用 DSH 可用能力 · '+escapeHtml(a.preset??'微信助手'):(a.skills?.length??0)+' 个技能 · '+(a.tools?.length??0)+' 个插件工具')+'</p>';
}
async function chatsPage() { return workspaceLayout.chatsPage(); }
function addChats(kind = state.chatKind==='groups'?'groups':'private') {
 const picked = new Map(),adminPicked=new Map();
  let closed=false,requesting=false;
  const controller=new AbortController();
  modal(kind === 'groups' ? '添加群聊' : '添加好友', `<p class="modal-description">每次打开和搜索都会通过微信 Hook 接口获取最新${kind === 'groups' ? '群聊' : '好友'}列表，勾选需要允许的聊天。</p><form id="contact-search-form" class="contact-search"><input id="contact-keyword" aria-label="聊天名称" placeholder="输入名称搜索"><button class="button" id="contact-search" type="submit">${icon('search')}搜索</button><button class="button" id="contact-sync" type="button">${icon('refresh')}刷新${kind==='groups'?'群聊':'好友'}列表</button></form><p id="contact-sync-status" class="subtle" role="status" aria-live="polite" hidden></p><div class="contact-results" id="contact-results"></div><details class="advanced"><summary>使用已有的数字 ID 添加</summary><div class="field"><label for="manual-ids">聊天 ID</label><textarea id="manual-ids" placeholder="每行一个数字 ID"></textarea><small>填写已有 OneBot 数字 ID；群名与微信账号标识不能代替数字 ID。</small></div></details><div id="contact-error" class="inline-error" role="alert"></div><div class="modal-actions"><button class="button" data-close>取消</button><button class="button primary" id="contact-add">添加到允许的聊天</button></div>`,{onClose(){closed=true;controller.abort();}});
  const form=$('#contact-search-form'),searchButton=$('#contact-search'),syncButton=$('#contact-sync'),results=$('#contact-results'),syncStatus=$('#contact-sync-status'),errorBox=$('#contact-error');
  const active=()=>!closed&&form.isConnected;
  const search=async()=>{
    if(!active()||requesting)return;
    requesting=true;searchButton.disabled=true;syncButton.disabled=true;errorBox.textContent='';
    results.innerHTML='';syncStatus.hidden=false;syncStatus.textContent='正在通过微信 Hook 接口查询最新列表…';
    try {
      const data = await api(`/api/contacts?kind=${kind}&includeIdentity=1&keyword=${encodeURIComponent($('#contact-keyword').value)}`,undefined,true,{signal:controller.signal,cache:'no-store'});
      if(!active())return;
      results.innerHTML = data.contacts.length ? data.contacts.map(c => {
        const disabled=c.ambiguous||state.draft.wechat.whitelist[kind].map(String).includes(c.id);
        return `<div class="contact-result contact-row"><label class="contact-choice"><input type="checkbox" value="${escapeHtml(c.id)}" data-contact data-name="${escapeHtml(c.name)}" ${disabled?'disabled':''} ${picked.has(c.id)?'checked':''}><span><strong>${escapeHtml(c.name)}</strong><small>ID ${escapeHtml(c.id)}${c.ambiguous?' · 无法唯一识别':disabled?' · 已添加':''}</small></span></label>${kind==='private'&&c.administratorEligible?`<label class="subtle contact-admin"><input type="checkbox" data-contact-admin="${escapeHtml(c.id)}" value="${escapeHtml(c.wechatId)}" ${disabled||!picked.has(c.id)?'disabled':''} ${adminPicked.has(c.id)?'checked':''}> 设为管理员</label>`:''}</div>`;
      }).join('') : empty('没有找到匹配的聊天', '检查名称或备注，确认电脑微信已同步联系人。', '', 'search');
      syncStatus.textContent='已通过微信 Hook 接口获取最新列表。';
    } catch (error) {
      if(!active())return;
      results.innerHTML=empty('最新列表查询失败', '请确认微信和消息接收服务正常后重试。', '', 'search');
      syncStatus.textContent='未取得最新列表，请重试。';
      errorBox.textContent=error.message;
    }
    finally {requesting=false;if(active()){searchButton.disabled=false;syncButton.disabled=false;}}
  };
  form.addEventListener('submit',event=>{event.preventDefault();void search();});
  syncButton.addEventListener('click',()=>{void search();});
  $('#contact-results').addEventListener('change', event => {const input=event.target;
    if(input.matches('[data-contact]')){input.checked?picked.set(input.value,input.dataset.name):picked.delete(input.value);const admin=input.closest('.contact-result').querySelector('[data-contact-admin]');if(admin){admin.disabled=!input.checked;if(!input.checked){admin.checked=false;adminPicked.delete(input.value);}}}
    if(input.matches('[data-contact-admin]'))input.checked?adminPicked.set(input.dataset.contactAdmin,input.value):adminPicked.delete(input.dataset.contactAdmin);
  });
  $('#contact-add').addEventListener('click', () => {
    const manual = $('#manual-ids').value.trim().split(/[\s,，]+/).filter(Boolean);
    if (manual.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) { $('#contact-error').textContent = 'ID 应为正整数，请检查输入。'; return; }
    if (!manual.length && !picked.size) { $('#contact-error').textContent = '请勾选聊天或填写数字 ID。'; return; }
    const admins=new Set([...(state.draft.wechat.assistant?.administrators??[]),...adminPicked.values()]);
    if(admins.size>50){$('#contact-error').textContent='管理员最多 50 位。';return;}
    if(adminPicked.size){state.draft.wechat.assistant??={};state.draft.wechat.assistant.administrators=[...admins];}
    state.draft.wechat.whitelist[kind] = [...new Set([...state.draft.wechat.whitelist[kind].map(String), ...picked.keys(), ...manual])];
    for (const [id, name] of picked) state.names.set(`wechat:${kind === 'groups' ? 'group' : 'private'}:${id}`, name);
    closeModal(); renderPage(); updateDraftUI(); toast('已加入草稿，保存设置后自动生效。');
  });
  void search();
}
function reconnectGroup(id) {
  if(hasDraft())return toast('请先保存或放弃未保存的设置，再重新关联群聊。');
  modal('重新关联原群聊', `<p class="modal-description">选择微信中原来的同一个群。保留当前人格、技能设置和 DSH 会话，不合并两个不同群的历史。</p><form id="group-reconnect-form"><div class="contact-search"><input id="group-reconnect-keyword" aria-label="原群聊名称" placeholder="输入原群名称或现在的群名称"><button class="button" type="button" id="group-reconnect-search">搜索</button></div><div id="group-reconnect-results" class="contact-results"></div><div id="group-reconnect-error" class="inline-error" role="alert"></div><div class="modal-actions"><button class="button" type="button" data-close>取消</button><button class="button primary" type="submit">确认关联</button></div></form>`);
  const search=async()=>{
    const button=$('#group-reconnect-search');button.disabled=true;$('#group-reconnect-error').textContent='';
    try{
      const data=await api('/api/contacts?kind=groups&keyword='+encodeURIComponent($('#group-reconnect-keyword').value));
      if(!$('#group-reconnect-form'))return;
      if(data.contacts.length&&!data.contacts.some(c=>c.groupRef))throw Error('消息接收服务尚未加载群关联更新，请重启应用与服务后再试。');
      $('#group-reconnect-results').innerHTML=data.contacts.filter(c=>c.groupRef).map(c=>`<label class="contact-result"><input type="radio" name="reconnect-group" value="${escapeHtml(c.groupRef)}"><span><strong>${escapeHtml(c.name)}</strong><small>群标识末尾 ${escapeHtml(c.groupRef.replace('@chatroom','').slice(-6))} · ID ${escapeHtml(c.id)}</small></span></label>`).join('')||empty('没有找到匹配的群聊','请在匹配微信中打开该群并等待同步，再搜索。','','search');
    }catch(error){if($('#group-reconnect-error'))$('#group-reconnect-error').textContent=error.message;}
    finally{if($('#group-reconnect-search'))$('#group-reconnect-search').disabled=false;}
  };
  $('#group-reconnect-search').addEventListener('click',search);
  $('#group-reconnect-keyword').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();search();}});
  $('#group-reconnect-form').addEventListener('submit',async event=>{
    event.preventDefault();const selected=$('#group-reconnect-form input[name=reconnect-group]:checked');
    if(!selected){$('#group-reconnect-error').textContent='请先搜索并选择原来的群聊。';return;}
    const button=event.submitter;button.disabled=true;
    try{const result=await api('/api/group-bindings',{id:String(id),groupRef:selected.value,revision:state.revision});state.names.set('wechat:group:'+id,result.name);closeModal();await renderPage();await refreshStatus();toast('群聊已重新关联，原会话和设置保留。');}
    catch(error){if($('#group-reconnect-error'))$('#group-reconnect-error').textContent=error.message;button.disabled=false;}
  });
}
function rolesPage() {
  const visibleRoles=personaCategoryUI.visible();
  const selected = visibleRoles.find(r => r.name === state.selectedRole) ?? visibleRoles[0];
  const toolbar = `<div class="page-toolbar"><span class="subtle">${state.roles.length} 个人格 · 可为每个聊天单独指定</span><div class="button-row"><button class="button" id="persona-regenerate-default" ${state.personaGenerating?'disabled':''} title="重新生成当前已保存的默认人格：${escapeHtml(state.config.persona.default)}">${state.personaGenerating?'AI 正在生成…':'AI 重新生成默认人格'}</button><button class="button" id="persona-proposals">AI 人格成长</button><button class="button" id="import-role">${icon('folder')}导入人格</button><button class="button" id="new-role">${icon('plus')}新建人格</button></div></div>` + personaCategoryUI.toolbar();
  if (!selected && state.roles.length) return toolbar + `<section class="card">${empty('此分类还没有人格', '选择“全部”后打开已有的人格卡，再点击“移动分类”。', '', 'folder')}</section>`;
  if (!selected) return toolbar + `<section class="card">${empty('创建或导入第一个人格', '新建一个人格，或导入已有的 Markdown 人格文件。', '', 'person')}</section>`;
  state.selectedRole = selected.name;
  const content = state.roleDrafts.get(selected.name)?.content ?? selected.content;
  return toolbar + `<div class="role-layout"><div class="role-list">${visibleRoles.map(r => `<button class="role-item ${r.name === selected.name ? 'selected' : ''}" data-role="${escapeHtml(r.name)}" aria-pressed="${r.name === selected.name}"><strong>${escapeHtml(r.name)}</strong><small>${state.draft.persona.default === r.name ? '用于跟随默认的聊天' : '可指定给好友或群聊'}</small>${state.draft.persona.default === r.name ? '<span class="status-tag ok">默认人格</span>' : ''}</button>`).join('')}</div><section class="card">${header(escapeHtml(selected.name), 'AI 可自行生成和调整人格，无需审批；会话自主更新仅影响本会话，保留原卡与备份。手动编辑保存后下一轮生效。')}${personaCategoryUI.control(selected.name)}<p class="persona-usage">用于 ${[...state.draft.wechat.whitelist.private.map(id=>'wechat:private:'+id),...state.draft.wechat.whitelist.groups.map(id=>'wechat:group:'+id)].filter(key=>(state.draft.persona.chats?.[key]??state.draft.persona.default)===selected.name).map(key=>escapeHtml(state.names.get(key)??key)).join('、')||'暂无聊天'} · <a href="#chats">管理聊天绑定</a></p><label class="field-label" for="role-content">人格内容</label><textarea class="role-editor" id="role-content" aria-describedby="role-save-help">${escapeHtml(content)}</textarea><div class="role-editor-toolbar"><div class="role-editor-meta"><span class="subtle" id="role-char-count">${content.length} 字</span><span class="subtle" id="role-edit-status" role="status">已保存</span></div><div class="button-row"><button class="button" id="set-default-role" ${state.draft.persona.default === selected.name ? 'disabled' : ''}>${icon('check')}${state.draft.persona.default === selected.name ? '已是默认人格' : '设为默认人格'}</button><button class="button danger" id="delete-role">删除人设卡</button><button class="button primary" id="save-role" disabled>保存人格</button></div></div><div id="role-save-error" class="inline-error" role="alert"></div><p class="subtle" id="role-save-help">保存仅提交当前人格，其他页面的草稿会保留。修改前的内容会自动备份。</p></section></div>`;
}
async function persistRole(name) {
  if (roleSaves.has(name)) return roleSaves.get(name);
  const draft = state.roleDrafts.get(name); if (!draft) return;
  const error = personaError(name, draft.content); if (error) throw new Error(error);
  const save = (async () => {
    const result = await api('/api/roles', draft);
    const role = state.roles.find(r => r.name === name);
    role.content = draft.content; role.revision = result.revision;
    // Preserve edits typed while the request was saving, with the new revision.
    const current = state.roleDrafts.get(name);
    if (!current || current.content === draft.content) state.roleDrafts.delete(name);
    else state.roleDrafts.set(name, { ...current, revision: result.revision });
  })();
  roleSaves.set(name, save); updateDraftUI();
  try { await save; } finally { roleSaves.delete(name); updateDraftUI(); }
}
async function saveRole() {
  const name = state.selectedRole;
  $('#role-save-error').textContent = '';
  try { await persistRole(name); await refreshStatus(); toast('人格已保存，下一轮对话生效，无需重启。'); }
  catch (error) { if ($('#role-save-error')) $('#role-save-error').textContent = error.message; else showError(error.message); }
}
async function regenerateDefaultPersona(){
  if(state.personaGenerating)return;
  if(state.roleDrafts.size||configDirty()||roleSaves.size){toast('请先保存已有的人格或设置草稿，再让 AI 重新生成默认人格。');return;}
  state.personaGenerating=true;
  const button=$('#persona-regenerate-default');if(button){button.disabled=true;button.textContent='AI 正在生成…';}
  try{
    const generated=await api('/api/persona/default/generate',{});
    if(state.roleDrafts.size||configDirty()||roleSaves.size)throw Error('生成期间有新的未保存修改，本次未覆盖。请保存后重新生成。');
    const result=await api('/api/persona/default/apply',generated);
    const roles=await api('/api/roles');state.roles=roles.roles;personaCategoryUI.setData(roles.categories);state.selectedRole=generated.expectedBase.name;personaCategoryUI.reveal(state.selectedRole);
    await renderPage();await refreshStatus();toast(result.message??'默认人格已重新生成，原卡已备份，下一轮生效。');
  }catch(error){toast(error.message);}
  finally{state.personaGenerating=false;if($('#persona-regenerate-default')){$('#persona-regenerate-default').disabled=false;$('#persona-regenerate-default').textContent='AI 重新生成默认人格';}}
}
function importRole() {
  modal('导入人格', `<p class="modal-description">选择 Markdown 人格文件，检查名称和内容后导入。导入后可继续编辑，再为聊天指定人格。</p><div class="field"><label for="role-import-file">人格文件</label><input id="role-import-file" type="file" accept=".md,.markdown" aria-describedby="role-import-help"><small id="role-import-help">支持 UTF-8 或 UTF-16 编码的 .md / .markdown 文件，最多 60 KB。</small></div><div class="field space-top"><label for="role-import-name">人格名称</label><input id="role-import-name" maxlength="61" placeholder="选择文件后自动填写，也可修改"><small>不需要填写扩展名。可换一个名称保留现有人格。</small></div><div class="field space-top"><label for="role-import-content">内容预览 / 编辑</label><textarea id="role-import-content" rows="7" placeholder="选择文件后显示人格内容。"></textarea></div><div id="role-import-collision" class="role-import-collision" hidden><p id="role-import-notice"></p><label class="role-import-replace"><input type="checkbox" id="role-import-replace">确认替换同名人格的内容</label></div><div id="role-import-error" class="inline-error" role="alert"></div><div class="modal-actions"><button class="button" data-close>取消</button><button class="button primary" id="role-import-submit" disabled>导入人格</button></div>`);
  const fileInput = $('#role-import-file'), nameInput = $('#role-import-name'), contentInput = $('#role-import-content');
  const submit = $('#role-import-submit'), errorBox = $('#role-import-error'), collision = $('#role-import-collision'), replace = $('#role-import-replace'), notice = $('#role-import-notice');
  let selectedFile = false, reading = false, saving = false, sequence = 0, previousTarget = '';
  const targetRole = () => state.roles.find(r => r.name.toLocaleLowerCase() === nameInput.value.trim().toLocaleLowerCase());
  const update = () => {
    const target = targetRole();
    if (previousTarget !== (target?.name ?? '')) { replace.checked = false; previousTarget = target?.name ?? ''; }
    collision.hidden = !target;
    notice.textContent = target ? `已存在“${target.name}”，替换前会自动备份原文件。${state.roleDrafts.has(target.name) ? '该人格还有未保存的修改，确认替换也会覆盖这些草稿。' : ''}` : '';
    submit.textContent = saving ? '正在导入…' : reading ? '正在读取…' : target ? '替换并导入' : '导入人格';
    submit.disabled = saving || reading || !selectedFile || !!personaError(nameInput.value.trim(), contentInput.value) || !!target && !replace.checked;
  };
  fileInput.addEventListener('change', async () => {
    const version = ++sequence; const file = fileInput.files[0]; selectedFile = false; errorBox.textContent = ''; replace.checked = false;
    nameInput.value = ''; contentInput.value = ''; reading = !!file; update();
    if (!file) return;
    try {
      if (file.size > MAX_PERSONA_BYTES) throw new Error('人格文件最多 60 KB，请缩短后再导入。');
      const result = decodePersonaFile(file.name, await file.arrayBuffer());
      if (version !== sequence) return;
      nameInput.value = result.name; contentInput.value = result.content; selectedFile = true;
    } catch (error) { if (version === sequence) errorBox.textContent = error.message; }
    finally { if (version === sequence) { reading = false; update(); } }
  });
  for (const input of [nameInput, contentInput, replace]) input.addEventListener('input', () => { errorBox.textContent = ''; update(); });
  for (const input of [nameInput, contentInput]) input.addEventListener('blur', () => { if (selectedFile) errorBox.textContent = personaError(nameInput.value.trim(), contentInput.value); });
  submit.addEventListener('click', async () => {
    const existing = targetRole(), name = existing?.name ?? nameInput.value.trim(), content = contentInput.value;
    const error = personaError(name, content);
    if (error || !selectedFile || reading || saving || existing && !replace.checked) { errorBox.textContent = error || '请先选择文件并确认同名替换。'; return; }
    if (roleSaves.size || state.savingAll) { errorBox.textContent = '人格正在保存，请等保存完成后再导入。'; return; }
    saving = true; errorBox.textContent = ''; update();
    for (const input of [fileInput, nameInput, contentInput, replace]) input.disabled = true;
    try {
      const result = await api('/api/roles', { name, content, ...(existing ? { revision: existing.revision } : {}) });
      if (existing) { existing.content = content; existing.revision = result.revision; state.roleDrafts.delete(existing.name); }
      else state.roles.push({ name, content, revision: result.revision });
      state.selectedRole = name; personaCategoryUI.setData(result.categories); personaCategoryUI.reveal(name); closeModal(); await renderPage(); await refreshStatus(); toast('人格已导入，可继续修改或指定给聊天。');
    } catch (error) { errorBox.textContent = error.message; }
    finally { saving = false; for (const input of [fileInput, nameInput, contentInput, replace]) input.disabled = false; update(); }
  });
}
function newRole() {
  modal('新建人格', `<div class="field"><label for="new-role-name">人格名称</label><input id="new-role-name" maxlength="61" placeholder="例如：温和助手"><small>名称也是本机文件名；不需要填写扩展名。</small></div><div class="field space-top"><label for="new-role-content">性格与语气</label><textarea id="new-role-content" rows="7" placeholder="描述助手的性格、说话习惯与边界。"></textarea></div><div id="role-create-error" class="inline-error" role="alert"></div><div class="modal-actions"><button class="button" data-close>取消</button><button class="button primary" id="create-role">创建人格</button></div>`);
  $('#create-role').addEventListener('click', async () => {
    const button = $('#create-role'); button.disabled = true;
    try { const name = $('#new-role-name').value.trim(); const content = $('#new-role-content').value; const result = await api('/api/roles', { name, content }); state.roles.push({ name, content, revision: result.revision }); state.selectedRole = name; personaCategoryUI.setData(result.categories); personaCategoryUI.reveal(name); closeModal(); renderPage(); await refreshStatus(); toast('人格已创建，可设为默认或指定给聊天。'); }
    catch (error) { $('#role-create-error').textContent = error.message; } finally { button.disabled = false; }
  });
}
function contextSettingsCard() {
  return `<section class="card context-settings">${header('上下文上限与自动压缩', '每个聊天独立统计，达到阈值后等待空闲再压缩。', '', 'history')}${toggle('启用空闲时自动压缩', 'wechat.context.enabled', '只作用于允许的聊天中的好友和群聊；沿用同一个会话，保留原始记录。')}<div class="form-grid space-top">${field('默认上下文阈值 / token', 'wechat.context.maxTokens', {type:'number',min:4000,max:2000000,step:1,help:'默认 100,000。按 DSH 当前有效上下文统计；是压缩触发阈值，正在回复时可能暂时超过。'})}${field('聊天至少空闲 / 秒', 'wechat.context.idleSeconds', {type:'number',min:15,max:3600,step:1,help:'默认 60 秒。没有待回复消息、模型运行或发送任务时才压缩。'})}</div><p class="subtle space-top">可在允许的聊天为单个聊天修改阈值，留空继承全局，填 0 关闭。每 30 秒检查，保存后生效。压缩会调用一次摘要模型；失败后等待重试，同一段未变化的上下文最多尝试 3 次。</p></section>`;
}
function settingsCards() { return {
  participation:`<section class="card">${header('群聊参与', '默认方式，可在允许的聊天为每个群单独选择。', '', 'chat')}<div id="behavior-mode">${modeSelector()}</div><div class="form-grid space-top">${field('唤醒词', 'wechat.wake_words', { transform: 'lines', help: '每行一个。群里识别这些文字后进入回复判断。', placeholder: '小助手' })}${field('账号昵称提示', 'account.nicknames', { transform: 'lines', help: '每行一个。填写账号在聊天中使用的昵称。' })}</div><div class="notice plain">${icon('info')}<span>“自然参与”先判断对话对象：被叫到或明确接话时回应，其他成员互聊和随手分享时默认旁听，合适时偶尔加入。选择沉默仍可能调用模型；过时或超出频率的普通群消息只作上下文，不排队补答。</span></div></section>`,
  admins:`<section class="card">${header('聊天管理员', '名单属于当前微信账号，用于助手任务权限；人格可由 AI 自主成长。', '', 'person')}${field('管理员真实微信 ID', 'wechat.assistant.administrators', {transform:'lines',help:'每行一位，最多 50 位。建议从微信好友中选择；昵称及“我是管理员”等聊天文字不能授予权限。保存后生效，名单为空时群友仍可聊天，但无人能执行任务；私聊助手仍仅允许管理员。',placeholder:'wxid_xxxxxxxxxxxxxx'})}<div class="button-row"><button class="button" id="choose-assistant-admin">${icon('plus')}从微信好友选择</button></div><p class="subtle space-top">群聊助手向所有群友开放聊天，工具、技能、文件、联网与任务控制仅允许指定管理员。普通聊天与管理员任务使用独立上下文；原生权限和审批仍然生效。</p></section>`,
  rhythm:`<section class="card">${header('回复节奏', '控制消息合并、发送间隔与群聊频率。', '', 'sliders')}<div class="form-grid">${field('消息合并等待 / 秒', 'social.batch_ms', { type: 'number', transform: 'seconds', min: 0, max: 60, step: .1, help: '把短时间内收到的消息合并到同一轮判断。' })}${field('私聊回复最小间隔 / 秒', 'social.private_min_interval_ms', { type: 'number', transform: 'seconds', min: 0, max: 3600, step: .1 })}${field('群聊回复最小间隔 / 秒', 'social.min_interval_ms', { type: 'number', transform: 'seconds', min: 0, max: 3600, step: 1 })}${field('每分钟群回复上限 / 条', 'social.max_per_minute', { type: 'number', min: 1, max: 1000, step: 1 })}${field('每十分钟群回复上限 / 条', 'social.max_per_ten_minutes', { type: 'number', min: 1, max: 10000, step: 1 })}</div></section>`,
  proactive:`<section class="card">${header('按人设主动聊天', '让当前人格自然找话题或问候，不强迫每次开口。', '', 'chat')}${toggle('启用定时主动聊天', 'wechat.proactive.enabled', '总开关。还需在允许的聊天中逐个开启好友或群聊，默认不向任何聊天主动发送。')}${toggle('允许使用热点与新梗资料', 'wechat.proactive.useSearch', '仅在联网搜索对该聊天也开启时生效。资料不适合人设或无法取得时，改为问候或沉默。')}<div class="form-grid space-top"><div class="field full"><label for="field-proactive-mode">主动内容方向</label><select id="field-proactive-mode" data-path="wechat.proactive.mode">${[['mixed','问候、热点、新梗轮换'],['greeting','问候与生活关心'],['news','人设适合的实时热点'],['meme','人设适合的新梗 / meme']].map(([value,label])=>`<option value="${value}" ${getPath(state.draft,'wechat.proactive.mode')===value?'selected':''}>${label}</option>`).join('')}</select></div>${field('主动机会间隔 / 分钟','wechat.proactive.intervalMinutes',{type:'number',min:30,max:1440,step:1,help:'默认 240 分钟。启用后等待一个间隔，再开始考虑；模型可选择沉默。'})}${field('聊天至少安静 / 分钟','wechat.proactive.idleMinutes',{type:'number',min:5,max:1440,step:1,help:'默认 120 分钟。有新消息、待回复或正在发言时让路。'})}${field('允许开始时间 / 北京时间','wechat.proactive.startTime',{type:'time'})}${field('允许结束时间 / 北京时间','wechat.proactive.endTime',{type:'time'})}${field('随机延迟上限 / 分钟','wechat.proactive.jitterMinutes',{type:'number',min:0,max:60,step:1,help:'在间隔上增加少量随机延迟，使问候不总卡在同一时刻。'})}</div><p class="subtle">保存后一分钟内应用。沿用每个聊天当前的人设、关系和上下文；热点与梗不合适就不讲。避免重复话题和催促回复，好友明确要求不被主动打扰时暂停，直到其再次主动聊天。重启不会补发过期草稿。每个符合条件的主动机会可能调用一次模型，选择沉默也会产生模型消耗。</p></section>`,
  reader:`<section class="card">${header('网页阅读', '模型默认具备网页阅读能力，无需导入或配置密钥。', '', 'search')}${toggle('网页阅读', 'wechat.webReader.enabled', '默认开启。发来公开链接并要求阅读、总结或分析时，模型会读取实际正文；独立于联网搜索开关，保存后生效。')}<p class="subtle">例如：总结这个网页：https://example.com 。每轮最多三页，每页最多 12,000 字符；需要登录、验证码或执行 JavaScript 的页面可能无法读取。网页资料会提交给当前模型，工具调用与后续总结会产生模型消耗。</p></section>`,
  search:`<section class="card">${header('联网搜索', '按需搜索，以每轮回复的次数上限控制；不设每日额度。', '', 'search')}${toggle('允许联网搜索', 'wechat.search.enabled', '模型结合当前问题和前文按需搜索，无需提供网址；普通闲聊不搜索。可在允许的聊天中为好友或群聊单独覆盖，保存后生效。')}${toggle('复用短期搜索缓存', 'wechat.search.cache', '相同问题复用摘要，天气与实时信息缓存最多两分钟。缓存命中不发起新的联网请求。')}<details class="technical-details"><summary>搜索次数、缓存与超时</summary><div class="form-grid space-top">${field('每轮回复最多搜索 / 次', 'wechat.search.maxSearchesPerTurn', {type:'number',min:1,max:3,step:1,help:'默认 1 次，限制模型调用本拓展的次数。直接调用 DSH 网页搜索；服务内部检索由 DSH 自身设置控制。新一轮回复重新计数。'})}${field('每轮搜索摘要最大长度 / 字符', 'wechat.search.maxSnippetChars', {type:'number',min:256,max:3000,step:1,help:'只提供截断后的摘要与来源，不把整篇网页反复放入上下文。'})}${field('搜索结果上限 / 条', 'wechat.search.maxResults', {type:'number',min:1,max:3,step:1})}${field('普通摘要缓存 / 秒', 'wechat.search.cacheTtlSeconds', {type:'number',min:60,max:3600,step:1})}${field('搜索超时 / 秒', 'wechat.search.timeoutMs', {type:'number',transform:'seconds',min:1,max:60,step:1,help:'默认 20 秒。DSH 原生搜索需要等待服务端返回；本次 DSH 搜索使用完整超时。已有较短设置可调整为 20–30 秒。'})}</div></details><p class="subtle">沿用当前模型与推理设置，不强制修改输出 token 参数。次数上限约束每轮搜索次数，单次模型消耗仍取决于模型和已有上下文。完整搜索摘要会在该轮完成后退出后续上下文。天气和热点也通过 DSH 网页搜索核实，缺少城市时会询问；直接调用 DSH 网页搜索，沿用当前账号及 DSH 搜索配置。服务不可用时明确返回原因。无需另外填写搜索密钥，DSH 登录和搜索服务需正常可用。网页正文读取失败不代表搜索失败。天气公共接口限个人及非商业使用。</p></section>`,
  media:`<section class="card">${header('图片与表情包', '普通图片继续从本机读取；以下选项仅影响表情包。', '', 'folder')}${toggle('允许从腾讯下载缺失的表情包', 'wechat.media.allowStickerCdn', '本机缓存缺失时，用白名单原消息提供的地址下载，并核验原消息摘要。')}${toggle('允许兼容旧版表情包地址', 'wechat.media.allowStickerCdnAlias', '将旧腾讯域名映射至兼容域名，仍使用 HTTPS 并核验摘要。')}</section>`
}; }

async function chooseAssistantAdmin(){
  const picked=new Set(state.draft.wechat.assistant?.administrators??[]);let searchVersion=0;
  modal('选择聊天管理员','<p class="modal-description">按真实微信 ID 识别管理员，修改在保存设置后生效。</p><div class="field"><label for="assistant-admin-keyword">搜索微信好友</label><input id="assistant-admin-keyword" type="search" placeholder="昵称或备注"></div><div class="button-row"><button class="button" id="assistant-admin-search">搜索</button></div><div id="assistant-admin-results" class="space-top" role="status"></div><p id="assistant-admin-count" class="subtle"></p><div class="button-row space-top"><button class="button" data-close>取消</button><button class="button primary" id="assistant-admin-use">使用所选名单</button></div>');
  const count=()=>{$('#assistant-admin-count').textContent='已选 '+picked.size+' 位（包含未出现在当前搜索结果中的已选管理员）';};count();
  const search=async()=>{const version=++searchVersion,results=$('#assistant-admin-results');results.textContent='正在读取微信好友…';try{const data=await api('/api/contacts?kind=private&includeIdentity=1&keyword='+encodeURIComponent($('#assistant-admin-keyword').value));if(version!==searchVersion||!results.isConnected)return;results.innerHTML=data.contacts.filter(c=>c.administratorEligible&&!c.ambiguous&&typeof c.wechatId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(c.wechatId)).map(c=>'<label class="contact-result"><input type="checkbox" value="'+escapeHtml(c.wechatId)+'" '+(picked.has(c.wechatId)?'checked':'')+'><span><strong>'+escapeHtml(c.name)+'</strong><small>'+escapeHtml(c.wechatId)+'</small></span></label>').join('')||'<p class="subtle">没有找到好友。确认消息接收服务已启动，微信已同步联系人。</p>';}catch(error){if(results.isConnected)results.textContent=error.message;}};
  $('#assistant-admin-search').addEventListener('click',search);$('#assistant-admin-keyword').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void search();}});
  $('#assistant-admin-results').addEventListener('change',event=>{const input=event.target;if(input.type!=='checkbox')return;if(input.checked&&picked.size>=50){input.checked=false;toast('最多选择 50 位管理员。');return;}if(input.checked)picked.add(input.value);else picked.delete(input.value);count();});
  $('#assistant-admin-use').addEventListener('click',()=>{state.draft.wechat.assistant??={};state.draft.wechat.assistant.administrators=[...picked];closeModal();renderPage();updateDraftUI();toast('管理员名单已放入草稿，请保存设置。');});await search();
}
function hookConnectionCard() {
  return `<section class="card hook-connection-setup">${header('连接自己的微信','打开微信时自动加载项目内置 Hook，匹配微信 4.1.8.27。','<span class="status-tag">启动时自动连接</span>','plug')}<div class="connection-steps"><span>1. 打开微信并加载组件</span><span>2. 登录微信</span><span>3. 概览启动助手</span></div><p class="modal-description">在本页打开微信并登录，再到概览点击“启动助手”。程序会自动准备消息接收与发送连接，消息通过 Hook 推送。</p><p class="subtle">切换微信账号前请先停止助手，登录后重新启动助手即可。</p><div class="button-row"><button class="button" data-action="wechat-open">打开微信 4.1.8.27</button><a class="button primary" href="#overview">前往概览启动助手</a></div><p class="field-error space-top" id="hook-connection-error" role="alert"></p><p class="subtle" id="hook-connection-progress" role="status"></p></section>`;
}

function paintConnectionSetup() {
  const running=state.job?.state==='running';
  document.querySelectorAll('.hook-connection-setup button').forEach(button=>{button.disabled=running;});
  if($('#hook-connection-progress'))$('#hook-connection-progress').textContent=running?state.job.action==='wechat-open'?'正在打开微信并加载内置 Hook，完成后请登录。':['start','restart'].includes(state.job.action)?'正在自动准备微信连接并启动助手…':'正在处理，请等待当前操作完成。':state.connection?.prepared?'微信连接配置已准备，登录微信后可在概览启动助手。':'登录微信后，到概览点击“启动助手”，程序会自动连接。';
}
function pluginPathField() {
  return `<div class="field full space-top"><label for="plugin-path">DSH 插件目录</label><div class="input-with-button"><input id="plugin-path" value="${escapeHtml(state.deployment?.pluginPath ?? '')}" readonly aria-describedby="plugin-path-help" placeholder="暂时无法获取目录，请刷新后重试"><button class="button" id="copy-plugin-path">复制插件路径</button></div><small id="plugin-path-help">如果在 DSH 中误移除了本项目插件，可在插件页面重新添加此目录，启用后从托盘完整退出并重新打开 DSH。</small></div>`;
}
async function copyPluginPath(button) {
  button.disabled = true;
  try {
    if (window.desktop?.copyPluginPath) await window.desktop.copyPluginPath();
    else {
      const value = $('#plugin-path')?.value;
      if (!value) throw new Error('插件目录尚未加载');
      await navigator.clipboard.writeText(value);
    }
    toast('插件路径已复制。');
  } catch {
    const input = $('#plugin-path');
    if (input?.value) { input.focus(); input.select(); toast('自动复制失败，已选中插件路径，请按 Ctrl+C 手动复制。'); }
    else toast('插件目录尚未加载，请刷新页面后重试。');
  } finally { button.disabled = false; }
}
function connectionsPage() {
  return `<div class="section-stack"><section class="card">${header('模型连接', '使用你已在 DSH 中配置的模型。', '', 'plug')}<div class="form-grid">${field('DSH 程序位置', 'runtime.dshDesktop', { full: true, browse: 'exe', placeholder: '选择 DeepSeek Harness.exe', help: '启动时若 DSH 尚未打开，会尝试打开这个程序。' })}${field('模型提供方标识', 'dsh.provider', { help: '与 DSH 中的 provider 标识一致。' })}${field('模型标识', 'dsh.model', { help: '图片理解需要当前模型支持图片输入。' })}</div>${pluginPathField()}<div class="notice plain">${icon('info')}<span>修改模型并保存后自动应用；若提示插件版本过旧，再按提示重新加载 DSH 插件。</span></div></section>
    <section class="card">${header('微信与运行环境', 'Hook 组件已内置，连接地址由项目自动管理。', '', 'chat')}<div class="form-grid">${field('匹配微信程序位置', 'hook.wechatExecutable', { full: true, browse: 'exe', help: '当前 Hook 匹配 '+(state.config?.hook?.expectedVersion??'4.1.8.27')+'。选择程序后先保存设置，再点击打开微信，内置 Hook 会自动加载。' })}${field('Python 程序位置', 'runtime.python', { full: true, browse: 'exe', help: '选择已有环境的 python.exe，也可填写可用的 Python 命令。' })}</div></section>
    ${hookConnectionCard()}
    <section class="card">${header('高级连接选项', '通常无需修改。端口需要互不重复。', '', 'sliders')}<details><summary>展开端口与发送超时设置</summary><div class="form-grid">${field('消息接收服务端口', 'ports.receiver', { type: 'number', min: 1024, max: 65535 })}${field('消息桥接端口', 'ports.onebot', { type: 'number', min: 1024, max: 65535 })}${field('适配器状态端口', 'ports.adapter', { type: 'number', min: 1024, max: 65535 })}${field('DSH 插件端口', 'ports.dshPlugin', { type: 'number', min: 1024, max: 65535 })}${field('发送请求超时 / 秒', 'hook.requestTimeoutMs', { type: 'number', transform: 'seconds', min: 1, max: 5, step: .1 })}${field('回执等待超时 / 秒', 'hook.receiptTimeoutMs', { type: 'number', transform: 'seconds', min: 1, max: 18, step: .1 })}${field('并发发送上限', 'hook.maxConcurrentSends', { type: 'number', min: 1, max: 4, step: 1 })}</div></details></section></div>`;
}
function toolsPage() {
  const row = (title, help, action, label = '执行') => `<div class="tool-row"><div><h3>${title}</h3><p>${help}</p></div><button class="button" data-action="${action}">${label}</button></div>`;
  const sender=row('检查内置微信组件','检查项目内置组件，自动准备运行配置。','hook-build','检查');
  return `<div class="tool-grid"><section class="card">${header('发送组件', '', '', 'tool')}${sender}</section><section class="card">${header('依赖维护','通常只供开发环境使用。','','tool')}${row('安装项目依赖','使用原安装脚本检查或安装依赖。','setup','安装')}</section></div>`;
}
function setupPage() {
  return `<div class="section-stack"><div class="notice plain">${icon('shield')}<span>此安装包使用独立的本机数据目录。请设置微信程序与 DSH 模型，初始允许的聊天为空。</span></div><p class="subtle"><a class="text-link" href="https://github.com/wuxiaojiuya/WeChatAgent" target="_blank" rel="noopener noreferrer">觉得好用去GitHub上点个star吧 ${icon('arrow')}</a></p><div class="tool-grid setup-grid">
    <section class="card">${header('检查运行环境', 'Node.js、Python 和运行依赖均已内置。', '', 'check')}<p class="modal-description">不需要安装开发工具或系统 Python。可先检查安装文件是否完整。</p><button class="button" data-action="setup">验证内置环境</button></section>
    <section class="card">${header('登录匹配微信', '选择已安装的匹配微信程序，保存后打开。', '', 'chat')}<p class="modal-description">打开微信时会自动加载内置 Hook；请在微信窗口登录，完成后到概览启动助手。当前配置的微信版本为 ${escapeHtml(state.config?.hook?.expectedVersion??'4.1.8.27')}；如果微信要求升级，请保留提示并检查兼容性。</p><div class="form-grid">${field('微信程序位置', 'hook.wechatExecutable', {full:true,browse:'exe',help:'选择已安装的 Weixin.exe；路径更改后先点击“保存设置”，再打开微信。Hook 组件和接口地址由项目自动管理。'})}</div><div class="button-row space-top"><button class="button" data-layout-control="save-button">保存设置</button><button class="button" data-action="wechat-open">打开微信</button><button class="button" data-repair-wechat>修复微信连接…</button></div></section>
    ${dshInstallCard({header,field,pluginPathField})}
    </div>${hookConnectionCard()}<section class="card">${header('启动并选择允许的聊天', '完成模型连接并登录微信后，到概览启动助手，程序会自动准备微信连接。', '', 'power')}<p class="modal-description">启动后，在“允许的聊天”搜索自己的好友或群聊。添加并保存后生效，助手只会处理允许的聊天。</p><div class="button-row"><a class="button primary" href="#overview">前往概览启动助手</a><a class="button" href="#chats">选择允许的聊天</a><a class="button" href="#overview">查看连接状态</a></div></section></div>`;
}
async function logsPage() {
  state.logs = await api('/api/logs' + (state.logs?.file ? '?file=' + encodeURIComponent(state.logs.file) : ''));
  return `<section class="card">${header('本机运行日志', '显示所选文件最近 120 KB 的内容。')}<div class="log-toolbar"><select id="log-file" aria-label="日志文件">${state.logs.files.map(file => `<option ${file === state.logs.file ? 'selected' : ''}>${escapeHtml(file)}</option>`).join('')}</select><input id="log-filter" aria-label="过滤日志" placeholder="筛选关键词"><button class="button" id="export-log">${icon('download')}导出当前日志</button></div><pre class="log-view" id="log-view" tabindex="0">${escapeHtml(state.logs.content || '当前没有日志记录。')}</pre><div class="log-caption"><span>连接令牌与受保护凭据已隐藏</span><button class="link-button" id="reload-log">刷新日志</button></div></section>`;
}
let renderSequence = 0;
async function renderPage() {
  audioRuntimeUI.unmount();
  if (!state.config) return;
  const sequence = ++renderSequence; const page = state.page;
  const title=page==='settings'?'设置 · '+SETTINGS_SECTIONS[state.settingsSection??'chat']:pages[page][0];
  $('#page-title').textContent = title; $('#breadcrumb-page').textContent = title; $('#page-description').textContent = pages[page][1];
  document.title = pages[page][0] + ' · WeChatAgent';
  document.querySelectorAll('[data-page]').forEach(a => page === a.dataset.page ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  let markup;
  try {
    if (['chats','settings','extensions','stickers','memory'].includes(page)) $('#page-body').innerHTML = '<div class="loading-state">正在读取…</div>';
    if (page === 'overview') markup = overviewPage();
    if (page === 'chats') markup = await chatsPage();
    if (page === 'roles') markup = rolesPage();
    if (page === 'settings') { if(state.settingsSection==='connections'&&!state.connection)state.connection=await api('/api/hook/connection'); markup=await workspaceLayout.settingsPage(); }
    if (page === 'extensions') markup = state.capabilitySection==='catalog'?await extensionUI.page():await workspaceLayout.capabilityPage();
    if (page === 'stickers') markup = await workspaceLayout.stickersPage();
    if (page === 'memory') markup = await memoryUI.page();
    if (page === 'setup') { if (!state.connection) state.connection = await api('/api/hook/connection'); markup = setupPage(); }

  } catch (error) {
    markup = `<section class="card">${empty('暂时无法读取', error.message, '<button class="button" id="retry-page">重试</button><a class="button" href="#overview">前往概览</a>', 'plug')}</section>`;
  }
  if (sequence !== renderSequence || state.page !== page) return;
  if(page==='setup')markup+=`<section class="card process-recovery-card">${header('端口与进程排查','遇到端口占用、其他微信实例或连接失败时，先检查正在运行的进程。','','tool')}<p class="card-description">检查不会停止程序。只有选中具体进程并再次确认后才会停止；随后可重新打开微信或 DSH，再重试配置。</p><button class="button" data-process-recovery>${icon('search')}检查端口与进程</button></section>`;
  $('#page-body').innerHTML = markup; updateDraftUI(); paintStatus(); paintConnectionSetup();
  if(page==='settings'&&state.settingsSection==='audio')audioRuntimeUI.mount();
  if(page==='memory'){if(state.memorySection==='notebook')fishNotebookUI.mount();else memoryUI.mount();}
  if(page==='stickers'&&state.stickerSection==='library')stickerManagerUI.mount();
  if(page==='stickers'&&state.stickerSection==='collection')api('/api/sticker-pool').then(pool=>{if(sequence!==renderSequence||!$('#sticker-pool-status'))return;const labels={selected:'DS 已完成评选',waiting_retry:'等待 DS 重试'};$('#sticker-pool-status').textContent='已入池 '+pool.count+'/50 · 待评选 '+(pool.waiting+pool.legacyWaiting)+' · '+(pool.review==='reviewing'?'DS 正在评选':labels[pool.lastReview?.status]??(pool.waiting?'等待 DS 评选':'未满池或没有新候选'));}).catch(()=>{});
  $('#role-content')?.addEventListener('input', event => {
    const role = state.roles.find(r => r.name === state.selectedRole); const content = event.target.value;
    if (content === role.content && !roleSaves.has(role.name)) state.roleDrafts.delete(role.name); else state.roleDrafts.set(role.name, { name: role.name, content, revision: role.revision });
    $('#role-char-count').textContent = content.length + ' 字'; updateDraftUI();
  });
  $('#log-file')?.addEventListener('change', async event => { state.logs.file = event.target.value; await renderPage(); });
  $('#log-filter')?.addEventListener('input', event => { const value = event.target.value.toLowerCase(); $('#log-view').textContent = state.logs.content.split('\n').filter(line => line.toLowerCase().includes(value)).join('\n') || '没有匹配的日志。'; });
}
async function refreshStatus() {
  if (state.closed||state.shuttingDown) return;
  try {
    state.status = await api('/api/status'); $('#connection-error').hidden = true; paintStatus();
    if (state.status.activeJob) {
      if (!state.job || state.job.id !== state.status.activeJob.id) $('#job-panel').hidden = false;
      state.job = state.status.activeJob; paintJob(); pollJob();
    } else if (state.status.latestJob && (!state.job || state.job.id === state.status.latestJob.id)) {
      state.job = state.status.latestJob; paintJob();
    }
  } catch (error) {
    $('#connection-label').innerHTML = '<i class="dot failed"></i><span>控制台未连接</span>';
    $('#connection-label').title = '无法连接本机控制台，点击查看详情。';
    $('#connection-label').setAttribute('aria-label','控制台未连接，查看详情');
    showError(error.message + ' 若后台控制台已关闭，请重新双击控制台入口。');
    if (state.page === 'overview' && $('#power-button')) { $('#power-title').textContent = '状态暂不可用'; $('#power-button').disabled = true; }
  }
}
async function saveAll() {
  if (state.savingAll || roleSaves.size) return;
  const invalid = [...document.querySelectorAll('[data-path], [data-context-key]')].find(input => !input.checkValidity());
  if (invalid) { invalid.reportValidity(); return; }
  state.savingAll = true; updateDraftUI();
  try {
    for (const name of [...state.roleDrafts.keys()]) await persistRole(name);
    if (configDirty()) {
      const result = await api('/api/config', { config: state.draft, revision: state.revision });
      state.config = result.config; state.draft = structuredClone(result.config); state.revision = result.revision;
    }
    updateDraftUI(); await refreshStatus(); toast(state.status?.pendingApply ? '设置已保存，正在自动应用。' : '设置已保存，后续消息使用新设置。');
  } catch (error) { showError(error.message); }
  finally { state.savingAll = false; updateDraftUI(); }
}
function paintJob() {
  const job = state.job; if (!job) return;
  const name = actions[job.action]?.[0] ?? '操作'; const running = job.state === 'running';
  $('#job-title').textContent = name + (running ? '中' : job.state === 'succeeded' ? '完成' : '失败');
  $('#job-dot').className = 'dot ' + (running ? 'warning' : job.state === 'succeeded' ? 'online' : 'failed');
  $('#job-description').textContent = job.state === 'failed' ? job.message || '检查下方详细信息，修正配置或完成准备后重试。' : actions[job.action]?.[1] ?? '';
  const output = $('#job-output'); const wasAtBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 50;
  output.textContent = job.output || '操作已开始，等待结果…'; if (wasAtBottom) output.scrollTop = output.scrollHeight;
  $('#job-state').textContent = running ? '正在执行 · 可收起此窗口' : job.state === 'succeeded' ? '操作成功' : `操作未完成 · 退出码 ${job.exitCode}`;
  $('#job-retry').hidden = job.state !== 'failed';
  $('#job-recovery').hidden = job.state !== 'failed';
  $('#job-recovery').textContent = needsWeChatRepair(job.output) ? '修复微信连接' : '检查占用进程';
  $('#job-recovery').dataset.hookRepair = String($('#job-recovery').textContent === '修复微信连接');
  $('#activity-button').hidden = false;
  document.querySelectorAll('[data-action]').forEach(button => { button.disabled = running; }); updateDraftUI(); paintStatus(); paintConnectionSetup();
}
let jobPolling = false;
async function pollJob() {
  if (jobPolling) return; jobPolling = true;
  try {
    while (state.job?.state === 'running') {
      await new Promise(resolve => setTimeout(resolve, 1200));
      state.job = await api('/api/job?id=' + encodeURIComponent(state.job.id)); paintJob();
    }
    if(['start','restart'].includes(state.job?.action)&&state.job?.state==='succeeded'){
      const [connection,deployment]=await Promise.all([api('/api/hook/connection'),api('/api/deployment')]);
      state.connection=connection;state.deployment=deployment;
      if(state.job.accountSwitched){
        const updated=await api('/api/config');state.config=updated.config;state.draft=structuredClone(updated.config);state.revision=updated.revision;state.names.clear();
        toast('微信连接已更新，请为当前账号选择允许的聊天。');
      }
      $('#setup-banner').hidden=deployment.configured;$('#setup-nav').hidden=deployment.configured;
      if(state.page==='setup'||state.page==='settings'&&state.settingsSection==='connections')await renderPage();
    }
    await refreshStatus();
    if ($('#job-panel').hidden && state.job && !state.job.accountSwitched) toast((actions[state.job.action]?.[0] ?? '操作') + (state.job.state === 'succeeded' ? '已完成。' : '未完成，点击右上角操作记录查看原因。'));
    if (state.job?.state === 'succeeded' && state.page === 'chats') await renderPage();
  } catch (error) { showError('操作状态暂时无法获取：' + error.message + '。正在通过运行状态重新检查，请勿重复执行。'); }
  finally { jobPolling = false; paintConnectionSetup(); }
}
async function runAction(action, conversationKey) {
  if (hasDraft() && action !== 'hook-check') {
    toast('请先保存或放弃草稿，再执行操作。'); return;
  }
  const run = async () => {
    try {
      const body = { action, ...(conversationKey ? { conversationKey } : {}) };
      state.job = await api('/api/jobs', body); state.jobBody = body; $('#job-panel').hidden = false; paintJob(); pollJob();
    } catch (error) { showError(error.message); }
  };
  if (action === 'sessions-compact') return confirmAction('压缩这个聊天的上下文', '会调用当前模型生成摘要，可能消耗额度；会话仍保留，完成后继续在同一会话中聊天。', '开始压缩', run);
  if (['setup', 'hook-build'].includes(action)) return confirmAction(actions[action][0], actions[action][1], actions[action][0], run);
  await run();
}
async function browse(button) {
  button.disabled = true;
  try { const result = await api('/api/browse', { kind: button.dataset.browse }); if (result.path) { const input = document.getElementById(button.dataset.target); input.value = result.path; input.dispatchEvent(new Event('input', { bubbles: true })); } }
  catch (error) { toast(error.message); } finally { button.disabled = false; }
}
async function load() {
  const info = await fetch('/api/info').then(response => response.json()); state.token = info.token; state.root = info.root;
  const [config, roles, chats, deployment] = await Promise.all([api('/api/config'), api('/api/roles'), api('/api/chats'), api('/api/deployment').catch(() => ({installed:false}))]);
  state.deployment = deployment;
  state.config = config.config; state.draft = structuredClone(config.config); state.revision = config.revision; state.roles = roles.roles; personaCategoryUI.setData(roles.categories);
  state.names.clear();
  for (const chat of chats.chats) if(chat.name)state.names.set(chat.key, chat.name);
  selectRoute(location.hash);
  if (deployment.installed) {
    $('#setup-nav').hidden = deployment.configured; $('#setup-banner').hidden = deployment.configured;
    if (!location.hash && !deployment.configured) {state.page='setup';currentRoute={page:'setup'};}
    actions.setup = ['检查内置依赖', '验证安装包内置的运行环境，无需安装系统 Python。'];
    $('.version').textContent = deployment.version + ' · 关闭窗口收起到托盘';
  }
  await renderPage(); await refreshStatus();
  if(!state.updateUIStarted){state.updateUIStarted=true;startUpdateUI({api,toast});}
}
document.addEventListener('submit',event=>{if(event.target.id==='chat-filter-form'){event.preventDefault();state.chatQuery=$('#chat-search-query').value;state.chatModeFilter=$('#chat-mode-filter').value;renderPage();}});
document.addEventListener('change',event=>{if(event.target.id==='chat-mode-filter'){state.chatModeFilter=event.target.value;state.chatQuery=$('#chat-search-query').value;renderPage();}});
document.addEventListener('input', event => {
  const input = event.target;
  if (input.dataset.contextKey) {
    state.draft.wechat.context ??= {}; state.draft.wechat.context.chats ??= {};
    if (input.value === '') delete state.draft.wechat.context.chats[input.dataset.contextKey];
    else state.draft.wechat.context.chats[input.dataset.contextKey] = Number(input.value);
    input.setCustomValidity(input.value !== '' && Number(input.value) !== 0 && (!Number.isSafeInteger(Number(input.value)) || Number(input.value) < 4000) ? '启用值至少 4000 token；填 0 关闭，留空继承全局。' : '');
    updateDraftUI(); return;
  }
  if (!input.dataset.path || !state.draft) return;
  let value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  if (input.dataset.transform === 'lines') value = input.value.split('\n').map(v => v.trim()).filter(Boolean);
  if (input.dataset.transform === 'seconds') value = Math.round(Number(input.value) * 1000);
  setPath(state.draft, input.dataset.path, value); updateDraftUI();
});
document.addEventListener('change', event => {
  if(event.target.dataset.wakeKey){const key=event.target.dataset.wakeKey;state.draft.wechat.chatModes??={};if(event.target.value==='inherit')delete state.draft.wechat.chatModes[key];else state.draft.wechat.chatModes[key]=event.target.value;updateDraftUI();return;}
  if(event.target.dataset.stickerKey){const key=event.target.dataset.stickerKey;state.draft.wechat.stickers??={};state.draft.wechat.stickers.chats??={};if(event.target.value==='inherit')delete state.draft.wechat.stickers.chats[key];else state.draft.wechat.stickers.chats[key]=event.target.value==='on';updateDraftUI();return;}
  if(event.target.dataset.searchKey){const key=event.target.dataset.searchKey;state.draft.wechat.search??={};state.draft.wechat.search.chats??={};if(event.target.value==='inherit')delete state.draft.wechat.search.chats[key];else state.draft.wechat.search.chats[key]=event.target.value==='on';updateDraftUI();return;}
  if(event.target.dataset.proactiveKey){const key=event.target.dataset.proactiveKey;state.draft.wechat.proactive??={};state.draft.wechat.proactive.chats??={};state.draft.wechat.proactive.chats[key]=event.target.value==='on';updateDraftUI();return;}
  if (event.target.dataset.personaKey) {
    const key = event.target.dataset.personaKey;
    state.draft.persona.chats ??= {};
    if (event.target.value) state.draft.persona.chats[key] = event.target.value; else delete state.draft.persona.chats[key];
    updateDraftUI();
  }
});
document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if(button.hasAttribute('data-repair-wechat')||button.id==='job-recovery'&&button.dataset.hookRepair==='true'){
    if(hasDraft())return toast('请先保存或放弃草稿，再修复微信连接。');
    return openProcessRecovery({api,modal,refreshStatus,toast,repairWeChat:true,onRecovered:async()=>{closeModal();await runAction('wechat-open');}});
  }
  if(sessionGroupUI.click(button))return;
  if(fishNotebookUI.click(button))return;
  if(memoryUI.click(button))return;
  if(personaCategoryUI.click(button))return;
  if(button.matches('[data-process-recovery]')||button.id==='job-recovery')return openProcessRecovery({api,modal,refreshStatus,toast});
  if (button.hasAttribute('data-close')) return closeModal();
  if (button.dataset.action) return runAction(button.dataset.action, button.dataset.key);
  if (button.dataset.browse) return browse(button);
  if (button.dataset.mode) { state.draft.wechat.wake_mode = button.dataset.mode; const selector = state.page === 'overview' ? '#overview-mode' : '#behavior-mode'; $(selector).innerHTML = modeSelector(); updateDraftUI(); return; }
  if(button.dataset.layoutControl){document.getElementById(button.dataset.layoutControl)?.click();return;}
  if(button.dataset.addChatKind)return addChats(button.dataset.addChatKind);
  if(button.dataset.chatSelect){state.selectedChat=button.dataset.chatSelect;renderPage();return;}
  if(button.dataset.chatDetailTab){state.chatDetailTab=button.dataset.chatDetailTab;renderPage();return;}
  if (button.dataset.kind) { state.chatKind = button.dataset.kind; renderPage(); return; }
  if (button.dataset.rebindGroup) return reconnectGroup(button.dataset.rebindGroup);
  if (button.dataset.role) { state.selectedRole = button.dataset.role; renderPage(); return; }
  if (button.dataset.removeId) { const kind=button.dataset.chatKind??(state.chatKind==='groups'?'groups':'private'); state.draft.wechat.whitelist[kind] = state.draft.wechat.whitelist[kind].filter(id => String(id) !== button.dataset.removeId); const key = `wechat:${kind === 'groups' ? 'group' : 'private'}:${button.dataset.removeId}`; delete state.draft.persona.chats?.[key]; renderPage(); updateDraftUI(); return; }
  if (['add-chat', 'empty-add-chat'].includes(button.id)) return addChats();
  if (button.id === 'choose-assistant-admin') return chooseAssistantAdmin();
  if (button.id === 'new-role') return newRole();
  if (button.id === 'import-role') return importRole();
  if (button.id === 'save-role') return saveRole();
  if (button.id === 'persona-regenerate-default') return regenerateDefaultPersona();
  if (button.id === 'delete-role') return deletePersona();
  if (button.id === 'set-default-role') { state.draft.persona.default = state.selectedRole; renderPage(); updateDraftUI(); return; }
  if (button.id === 'copy-plugin-path') return copyPluginPath(button);
  if (button.id === 'open-plugin-folder') { window.desktop?.openPluginFolder().catch(() => toast('无法打开插件目录。')); return; }
  if (['retry-page', 'reload-log'].includes(button.id)) return renderPage();
  if (button.id === 'export-log') {
    if (window.desktop) { window.desktop.exportLog($('#log-view').textContent, state.logs?.file || 'wechatagent.log').then(result => { if (result.saved) toast('日志已保存。'); }).catch(() => toast('无法保存日志，请重试。')); return; }
    const blob = new Blob([$('#log-view').textContent], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = state.logs?.file || 'wechatagent.log'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
  }
});
$('#save-button').addEventListener('click', saveAll);
$('#discard-button').addEventListener('click', () => confirmAction('放弃未保存的更改', '已保存的设置和人格不会受影响。', '放弃更改', () => { state.draft = structuredClone(state.config); state.roleDrafts.clear(); renderPage(); updateDraftUI(); }));
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('cancel', event => {event.preventDefault();closeModal();});
$('#modal').addEventListener('click', event => { if (event.target === $('#modal')) { const bounds = $('#modal').getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeModal(); } });
$('#job-close').addEventListener('click', () => { $('#job-panel').hidden = true; if (state.job?.state === 'running') toast('操作继续在后台执行，完成后可刷新查看结果。'); });
$('#activity-button').addEventListener('click', () => { if (state.job) { $('#job-panel').hidden = false; paintJob(); } });
$('#job-retry').addEventListener('click', () => { if (state.jobBody) runAction(state.jobBody.action, state.jobBody.conversationKey); else toast('请回到对应页面重新执行。'); });
const mobileNavigation=matchMedia('(max-width:640px)');
function paintNavigation() {
  const open=mobileNavigation.matches&&document.body.classList.contains('nav-open');
  $('#sidebar').inert=mobileNavigation.matches&&!open;
  $('#sidebar').setAttribute('aria-hidden',String(mobileNavigation.matches&&!open));
  $('#menu-button').setAttribute('aria-expanded',String(open));
  $('#menu-button').setAttribute('aria-label',open?'关闭导航':'打开导航');
}
$('#menu-button').addEventListener('click',()=>{document.body.classList.toggle('nav-open');paintNavigation();});
mobileNavigation.addEventListener('change',()=>{document.body.classList.remove('nav-open');paintNavigation();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('#modal').open&&document.body.classList.contains('nav-open')){document.body.classList.remove('nav-open');paintNavigation();$('#menu-button').focus();}});
paintNavigation();
$('#quit-console').addEventListener('click', () => {
  if (hasDraft()) return toast('请先保存或放弃草稿，再退出控制台。');
  const automatic=window.desktop?.shutdownOnExit===true;
  confirmAction(automatic ? '退出并停止后台服务' : window.desktop?'退出应用':'退出控制台', automatic ? '退出前会停止本实例的消息读取、自动回复、主动聊天和发送队列。微信和外部 DSH 会继续运行。下次打开应用后可重新启动服务。' : '当前只关闭管理界面，聊天服务继续运行；需要停止时请先手动停止服务。', automatic ? '停止并退出' : window.desktop?'退出应用':'退出控制台', async () => {
    try { await api('/api/quit', {}); state.closed = true;if(window.desktop){$('#connection-label').innerHTML='<i class="dot"></i><span>'+(automatic?'正在退出并停止后台服务…':'正在退出应用…')+'</span>';return;} $('#connection-label').innerHTML = '<i class="dot"></i>控制台已关闭'; $('#page-body').innerHTML = empty('控制台已关闭', '聊天服务继续运行。需要管理时，重新双击 WeChatAgent-Console.vbs。', '', 'power'); }
    catch (error) { showError(error.message); }
  });
});
if (window.desktop) {
  document.body.classList.add('desktop-mode');
  $('.brand span').textContent = '桌面应用';
  $('.breadcrumb > span:first-of-type').textContent = 'WeChatAgent';
  $('.version').textContent = '0.4.0 · 关闭窗口收起到托盘';
  $('#quit-console').textContent = '退出应用';
}
document.addEventListener('click', event => { if (document.body.classList.contains('nav-open') && !event.target.closest('.sidebar') && !event.target.closest('#menu-button')) {document.body.classList.remove('nav-open');paintNavigation();} });
window.addEventListener('hashchange', async () => {pageScroll.set(routeKey(currentRoute),window.scrollY);selectRoute(location.hash);const selectedRoute=routeKey(currentRoute);document.body.classList.remove('nav-open');paintNavigation();await renderPage();if(routeKey(currentRoute)===selectedRoute)window.scrollTo(0,pageScroll.get(selectedRoute)??0);});
document.addEventListener('click',event=>{for(const menu of document.querySelectorAll('.action-menu[open]'))if(!menu.contains(event.target))menu.open=false;});
window.addEventListener('beforeunload', event => { if (hasDraft() || document.querySelector('#chat-settings-form [type=submit]:not(:disabled)')) { event.preventDefault(); event.returnValue = ''; } });
function applyTheme(theme) { document.documentElement.dataset.theme = theme; $('#theme-button').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon')+'<span>切换主题</span>'; $('#theme-button').setAttribute('aria-label', theme === 'dark' ? '切换浅色主题' : '切换深色主题'); window.desktop?.setTheme(theme).catch(() => {}); }
let savedTheme; try { savedTheme = localStorage.getItem('wechatagent-console-theme'); } catch {}
applyTheme(window.desktop?.initialTheme ?? (savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('#theme-button').addEventListener('click', () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(theme); try { localStorage.setItem('wechatagent-console-theme', theme); } catch {} });
initAppearance({modal,closeModal,toast,escapeHtml,icon});
$('#refresh-button').addEventListener('click', async () => {
  if (state.refreshing) return;
  const button=$('#refresh-button'); state.refreshing=true;button.disabled=true;button.classList.add('is-refreshing');button.setAttribute('aria-label','正在刷新');
  try {
    if (!state.config) { await load(); return; }
    if (hasDraft()) { await refreshStatus(); toast('状态已刷新，未保存的草稿已保留。'); return; }
    const [config,roles]=await Promise.all([api('/api/config'),api('/api/roles')]);
    // A user can begin editing while the refresh request is in flight.
    if (hasDraft()) {await refreshStatus();toast('状态已刷新，新输入的草稿已保留。');return;}
    state.config=config.config;state.draft=structuredClone(config.config);state.revision=config.revision;state.roles=roles.roles;personaCategoryUI.setData(roles.categories);state.connection=null;
    await renderPage();await refreshStatus();
  } catch(error) {showError(error.message);}
  finally {state.refreshing=false;button.disabled=false;button.classList.remove('is-refreshing');button.setAttribute('aria-label','刷新当前页面');}
});
load().catch(error => { $('#connection-label').innerHTML='<i class="dot failed"></i><span>控制台未连接</span>'; $('#connection-label').setAttribute('aria-label','控制台未连接，查看详情'); showError(error.message || '控制台未连接，请重新双击控制台入口。'); $('#page-body').innerHTML = empty('暂时无法打开控制台', '检查本机配置后点击右上角刷新，或重新双击控制台入口。', '', 'plug'); });
setInterval(() => { if (!document.hidden && state.token) refreshStatus(); }, 5000);

document.addEventListener('click',async event=>{const target=event.target.closest('[data-assistant-status],[data-assistant-cancel]');if(!target)return;target.disabled=true;try{const action=target.dataset.assistantCancel?'cancel':'status',result=await api('/api/assistant-task/'+action,{key:target.dataset.assistantCancel??target.dataset.assistantStatus,...(target.dataset.assistantTaskId?{taskId:target.dataset.assistantTaskId}:{})});if(action==='cancel')toast('已请求取消任务。');else modal('助手任务状态','<pre class="log-output">'+escapeHtml(result.text??(result.running?'任务正在执行，请在 DSH 查看进度或审批。':'当前没有正在执行的任务。'))+'</pre>');await renderPage();}catch(error){toast(error.message);}finally{target.disabled=false;}});

// Context repair is local configuration maintenance, separate from paid compaction.
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-context-repair]');if(!button||button.disabled)return;
  if(hasDraft()){toast('请先保存或放弃草稿，再修复上下文。');return;}
  confirmAction('修复这个聊天的上下文','重新绑定当前人格前缀并刷新模型可见窗口。会话 ID、原始历史与能力权限保留；不调用模型，不补发此前失败的消息。','修复上下文',async()=>{
    button.disabled=true;button.setAttribute('aria-busy','true');
    try{await api('/api/sessions/repair-context',{key:button.dataset.contextRepair,expectedSessionId:button.dataset.contextSession,confirmed:true});await renderPage();toast('已重新绑定上下文，下一条新消息将验证修复结果。');}
    catch(error){showError(error.message);}
    finally{button.disabled=false;button.removeAttribute('aria-busy');}
  });
});

// Dashboard review is read-only; approval requires a verified administrator DM.
document.addEventListener('click',async event=>{
  if(!event.target.closest('#persona-proposals'))return;
  modal('AI 人格成长','<p class="subtle" id="persona-proposals-loading">正在读取成长记录…</p>');
  try{
    const {proposals,evolution}=await api('/api/persona-proposals');
    if(!document.querySelector('#persona-proposals-loading'))return;
    const labels={applied:'已自主更新',superseded:'旧审批已停止',pending:'历史待处理',approved:'历史已批准',rejected:'历史已拒绝',expired:'已过期',conflict:'原设置已变化',applying:'正在应用',failed:'应用失败'};
    const reviewLabels={waiting:'累计互动中',reviewing:'正在回顾',unchanged:'本次保持原人格',applied:'已自主更新',proposed:'历史提案',pending:'历史待处理',failed:'等待重试'};
    const progress='<section class="card"><strong>自动人格回顾</strong><p class="subtle">每个会话累计 20 次有效互动后回顾，每 24 小时最多一次。失败、静默、定时任务及重复消息不计入。回顾会额外调用一次当前模型，未发现值得修改的地方也会记录原因。</p>'+(evolution?.chats?.length?evolution.chats.map(row=>'<p><strong>'+escapeHtml(state.names.get(row.conversationKey)??row.conversationKey)+'</strong> · '+escapeHtml(reviewLabels[row.state]??row.state)+' · '+Number(row.interactions||0)+'/20 次'+(row.nextReviewAt>Date.now()?' · 最早下次回顾：'+escapeHtml(new Date(row.nextReviewAt).toLocaleString()):'')+(row.retryAt>Date.now()?' · 重试时间：'+escapeHtml(new Date(row.retryAt).toLocaleString()):'')+'</p>'+(row.reason?'<p class="subtle">'+escapeHtml(row.reason)+'</p>':'')).join(''):'<p class="subtle">尚无新互动记录。在允许的会话中正常聊天后开始累计。</p>')+'</section>';
    modal('AI 人格成长',progress+'<p class="modal-description">AI 可自行生成和调整人格，无需审批。回顾有明确收获时直接更新当前会话，保留原卡与备份；共享卡会另存为本会话专属卡，不影响其他聊天。AI 可自行决定是否在对话里提到改动，不强制发送管理员私聊。手工编辑仍然保留。</p>'+ (proposals.length?proposals.slice(0,50).map(p=>'<section class="card"><strong>'+escapeHtml(labels[p.state]??p.state)+'</strong><p>'+escapeHtml(p.conversationKey?(state.names.get(p.conversationKey)??p.conversationKey):'默认人格')+' · '+escapeHtml(p.id)+'</p><p>'+escapeHtml(p.reason)+'</p><details><summary>查看人格全文</summary><pre style="white-space:pre-wrap">'+escapeHtml(p.content)+'</pre></details></section>').join(''):'<p class="empty-state">暂无自主更新记录。达到回顾条件且 AI 确实想调整时会更新；你也可以直接让 AI 为自己生成或调整人格。</p>'));
  }catch(error){toast(error.message);}
});
