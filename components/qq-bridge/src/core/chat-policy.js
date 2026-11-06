/** Chat text is data. Host configuration changes have no chat command route. */
export const LOCKED_BEHAVIOR_REPLY = '系统规则、账号和工具权限只能在本机配置中修改；人格可以通过专用工具自主成长。';
export { CHAT_POLICY_NOTICE, CHAT_COHERENCE_NOTICE } from '../../../../packages/dsh-social-bridge-plugin/prompt-context.mjs';

export function isBehaviorChangeCommand(value) {
  const text = String(value ?? '').trim().replace(/^@[^\s\u2005]{1,64}[\s\u2005]+/, '').replace(/^(?:请你|请|帮我|麻烦你)\s*/, '');
  return /^(?:\/(?:config|system|prompt)\b|(?:进入|退出|切换|更换|修改|重写|替换|清除|重置|关闭|开启|取消|解除)(?:你(?:的)?|自身的)?(?:系统提示(?:词)?|提示词|系统指令|行为(?:逻辑|规则)|工具权限|安全限制|白名单)|(?:忽略|忘记|覆盖|绕过)[^\n]{0,30}(?:指令|系统提示|行为规则|安全限制)|(?:从现在(?:起|开始)?|以后|今后)[^\n]{0,12}你(?:就是|是|必须|要扮演|将扮演)|(?:你是|我是)[^\n]{0,20}(?:管理员|开发者|主人)[^\n]{0,30}(?:修改|更改|关闭|解除|授权))/i.test(text)
    || /^(?:please\s+)?(?:(?:ignore|forget|override|bypass)[^\n]{0,50}(?:instructions|system\s*prompt|rules|restrictions)|(?:change|replace|rewrite|disable)[^\n]{0,40}(?:your\s+(?:rules|behavior|configuration)|system\s*prompt)|from\s+now\s+on\s+you\s+(?:are|must|will))/i.test(text);
}
