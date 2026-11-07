import { spawn } from 'node:child_process';
import path from 'node:path';

export function windowsPowerShellEnvironment(env = process.env) {
  const result = { ...env };
  for (const key of Object.keys(result)) if (key.toLowerCase() === 'psmodulepath') delete result[key];
  const systemRoot = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows';
  const modules = [path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')];
  if (env.ProgramFiles) modules.push(path.win32.join(env.ProgramFiles, 'WindowsPowerShell', 'Modules'));
  result.PSModulePath = modules.join(';');
  return result;
}

export function windowsPowerShellExecutable(env = process.env) {
  return path.win32.join(env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// A persistent service started by PowerShell can inherit a pipe handle even
// after the launcher exits. Its pipes must not define the task's lifetime.
export function runConsoleCommand(spec, onOutput, { cwd, env = process.env, timeoutMs = 180000, drainMs = 150 } = {}) {
  return new Promise(resolve => {
    const processEnv = /(?:^|[\\/])powershell\.exe$/i.test(spec.exe) ? windowsPowerShellEnvironment(env) : env;
    const child = spawn(spec.exe, spec.args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...processEnv, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' } });
    let done = false, drainTimer;
    const finish = code => {
      if (done) return;
      done = true; clearTimeout(deadline); clearTimeout(drainTimer);
      child.stdout?.destroy(); child.stderr?.destroy(); resolve(code);
    };
    const deadline = setTimeout(() => {
      onOutput('\n操作等待超时，请查看连接检查与运行日志后重试。\n');
      child.kill(); finish(124);
    }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', onOutput); child.stderr.on('data', onOutput);
    child.once('error', error => { onOutput(error.message); finish(1); });
    child.once('exit', code => {
      clearTimeout(deadline);
      // Let queued output drain, with a bound independent of descendants.
      drainTimer = setTimeout(() => finish(code ?? 1), drainMs);
    });
    child.once('close', code => finish(code ?? 1));
  });
}

export function taskFailureMessage(output, code) {
  if(/HOOK_EXIT_WECHAT_FIRST/.test(output))return '请先从系统托盘完全退出当前微信，再打开项目配置的微信 4.1.8.27；现有微信没有被强制关闭。';
  if(/HOOK_SETTINGS_CHANGED/.test(output))return 'Hook 连接设置已变化，请重新准备组件并重启助手服务。';
  if(/HOOK_LEGACY_COMPONENT_LOADED/.test(output))return '当前微信还加载了旧组件。请使用项目准备的独立 4.1.8.27 客户端，并从托盘退出后重新打开。';
  if(/HOOK_MATCHING_CLIENT_MISSING/.test(output))return '未找到微信 4.1.8.27。请在连接设置选择对应的 Weixin.exe。';
  if(/HOOK_CONNECTION_METADATA_REQUIRED/.test(output))return '请先在设置中打开微信并完成登录，再到概览启动助手；程序会自动准备微信连接。';
  if(/HOOK_STOP_SERVICES_BEFORE_BIND/.test(output))return '请先停止助手服务，再到概览启动助手；程序会自动准备 Hook 连接。';
  if(/HOOK_NON_LOOPBACK_LISTENER/.test(output))return '新 Hook 需要只监听 127.0.0.1。请准备新组件配置，再退出并重新打开匹配微信。';
  if(/HOOK_SUPPLIED_DLL_NOT_LOADED|HOOK_SUPPLIED_DLL_HASH_MISMATCH/.test(output))return '你提供的 Hook 组件尚未通过校验，请准备组件并从项目页面打开匹配微信。';
  if(/HOOK_CONTACTS_RESPONSE_INVALID/.test(output))return '微信 Hook 的好友列表接口返回了无法识别的数据，消息接收服务未能完成初始化。请查看下方具体错误及 receiver.stderr.log；出错接口为 /api/get_frien_lists。';
  if(/HOOK_GROUPS_RESPONSE_INVALID/.test(output))return '微信 Hook 的群列表接口返回了无法识别的数据，消息接收服务未能完成初始化。请查看下方具体错误及 receiver.stderr.log；出错接口为 /api/get_chatroom_list。';
  if(/HOOK_UPSTREAM_UNAVAILABLE|HOOK_CONTACTS_UNAVAILABLE/.test(output))return '微信 Hook 的联系人或消息接口暂未就绪。请确认 4.1.8.27 已登录并完成消息同步，查看消息接收服务日志。';
  if (/DSH_NOT_CONFIGURED/.test(output)) return '请先在“首次配置”点击“下载安装 DSH”，安装后选择 DSH 程序位置并保存设置。';
  if (/DSH_PLUGIN_NOT_READY/.test(output)) return 'DSH 插件尚未就绪，请在 DSH 添加并启用本机插件，再从托盘完整退出并重新打开 DSH。';
  const port=/\bport=(\d{1,5})\b/.exec(output)?.[1],portLabel=port?'端口 '+port:'配置端口';
  if (/ADAPTER_PORT_IN_USE|SERVICE_PORT_IN_USE|SERVICE_PORT_OWNER_MISMATCH/.test(output)) return portLabel+' 已被其他进程占用或绑定。点击“检查占用进程”，核对路径和 PID，经再次确认后处理；也可在连接设置中修改端口。';
  if (/ADAPTER_PORT_DENIED|SERVICE_PORT_DENIED/.test(output)) return 'Windows 拒绝绑定'+portLabel+'，可能涉及系统保留端口或访问限制。请在连接设置中更换该端口再重试；没有监听进程也可能无法使用。';
  if (/SERVICE_PORT_INSPECTION_FAILED/.test(output)) return '无法核对'+portLabel+'的进程归属，启动已停止。请完整退出并重新打开应用，仍失败时查看启动日志。';
  if (/ADAPTER_IDENTITY_MISMATCH/.test(output)) return portLabel+'未返回本实例的适配器身份，可能仍在运行旧版服务。请先重启本实例服务；持续冲突时检查占用进程。';
  if (/RECEIVER_NOT_LISTENING|RECEIVER_HEALTH_TIMEOUT|RECEIVER_CONNECTION_RESET|RECEIVER_HEALTH_INVALID_RESPONSE|RECEIVER_HEALTH_FAILED/.test(output)) return '适配器无法连接微信消息接收服务（'+portLabel+'）。请查看 receiver.stderr.log 中的状态，并停止后重新启动助手服务；这一步尚未确认微信发送组件异常。';
  if (/HOOK_CONNECTION_RESET|HOOK_HEALTH_FAILED/.test(output)) return '微信发送组件连接被中断或检查失败（'+portLabel+'）。请查看 hook-init.log；持续失败时使用“修复微信连接”。';
  if (/ADAPTER_LISTEN_FAILED|ADAPTER_START_FAILED/.test(output)) return '应用适配器未能启动。下方日志已保留失败阶段和系统错误码，请结合 adapter.stderr.log 检查。';
  if (/SERVICE_START_TIMEOUT/.test(output)) return portLabel+'对应的本实例服务未在期限内准备完成。请查看该服务日志，或重启本实例后重试。';
  if (/RECEIVER_PORT_UNAVAILABLE/.test(output)) return '消息接收服务端口已被占用或被 Windows 拒绝。请在连接设置中修改消息接收端口，再启动服务；端口可能被未监听的其他程序占用。';
  if (/port is used by another installation|port is already in use|EADDRINUSE|address already in use/i.test(output)) return '配置端口已被占用。点击“检查占用进程”，核对程序后可选择停止，再重试。';
  if (/WECHAT_OTHER_CLIENT_RUNNING/.test(output)) return '检测到其他版本的微信正在运行。请先从微信托盘正常退出，再点击“打开微信”启动连接设置中的匹配版本。';
  if (/WECHAT_CLIENT_PATH_UNAVAILABLE/.test(output)) return '微信进程路径暂时无法核对。请等待微信完成启动后重试；持续出现时，检查所选程序的权限及占用进程。';
  if (/WECHAT_STARTUP_TIMEOUT/.test(output)) return '已尝试打开匹配微信，但它尚未完成启动。请查看微信窗口是否提示升级或启动失败；确认后再重试。';
  if (/WECHAT_LAUNCH_FAILED/.test(output)) return 'Windows 未能打开所选微信程序。请检查连接设置中的程序路径，并查看下方具体启动错误。';
  if (/HOOK_PROFILE_MISMATCH/.test(output)) return '微信版本或已加载的发送组件不匹配。请正常退出该微信后重新打开，并确认使用对应版本的组件。';
  if (/Another desktop WeChat is running|WECHAT_MULTIPLE/i.test(output)) return '检测到其他微信客户端。点击“检查占用进程”，确认并停止对应微信后，再打开匹配微信。';
  if (/HOOK_CLIENT_UNHEALTHY|HOOK_INITIALIZATION_TIMEOUT|HOOK_NOT_LISTENING/.test(output)) return '微信发送组件尚未就绪。可稍后重试；持续失败时点击“修复微信连接”，核对进程并再次确认后重开匹配微信。详情见 hook-init.log。';
  if (/HOOK_AUTH_FAILED|HOOK_PORT_OWNER_MISMATCH/.test(output)) return '微信发送端口或令牌与当前客户端不一致。请检查占用进程和 hook-init.log；可通过“修复微信连接”重新打开匹配微信。';
  if (/HOOK_HEALTH_TIMEOUT/.test(output)) return '微信发送组件响应超时，请稍后重试；持续失败时查看 hook-init.log。';
  if (/HOOK_HEALTH_INVALID_RESPONSE/.test(output)) return '微信发送端口返回了无效响应，可能被其他程序占用；请检查 hook-init.log 和发送端口。';
  if (/DSH_RELOAD_UPGRADE_REQUIRED/.test(output)) return '当前 DSH 加载的是旧版桥接插件。此次更新后请从托盘退出并重开一次 DSH；新版插件支持自动应用模型和账号变化。';
  if (/DSH_CONFIGURATION_BUSY/.test(output)) return 'DSH 任务仍在执行，设置已保存。任务完成后点击“重新应用”，无需退出 DSH。';
  if (/DSH_RELOAD_FAILED|DSH_RELOAD_TIMEOUT|DSH_CONFIGURATION_APPLY_FAILED|DSH_PROJECT_MISMATCH/.test(output)) return '设置已保存，DSH 桥接配置未能自动应用。请查看下方详细日志后重新应用。';
  if (/ACCOUNT_SWITCH_REQUIRES_DSH_RESTART/.test(output)) return 'DSH 仍绑定旧账号，请点击“重新应用”重载账号连接。';
  if (code === 124) return '操作等待超时。请查看连接检查与日志，确认当前服务状态后重试。';
  if (/ModuleNotFoundError|ImportError|DLL load failed/i.test(output)) return '消息接收组件缺失或无法加载。请重新安装更新后的安装包，然后在首次配置中点击“验证内置环境”。';
  if (/Hook receiver initialization failed: (?:KeyError|FileNotFoundError)/i.test(output)) return '微信消息接收服务缺少配置或所需文件。请检查内置运行环境和连接设置，下方会显示具体错误。';
  if (/receiver exited/i.test(output)) return '微信消息接收服务未能启动。请查看下方具体错误及 receiver.stderr.log，再根据错误检查 Hook 连接或运行环境。';
  if (/HOOK_COMPONENT_UPDATE_PENDING/.test(output)) return '发送组件已更新。点击“修复微信连接”，核对并再次确认后重开匹配微信以应用更新。';
  if (/CouldNotAutoloadMatchingModule|Microsoft\.PowerShell\.Security.*module|Get-AuthenticodeSignature.*ObjectNotFound/is.test(output)) return 'Windows PowerShell 安全模块未能加载。请退出应用后重新打开更新后的 WeChatAgent.exe。';
  if (/WECHAT_LAUNCH_EXITED/i.test(output)) return '微信启动后已退出。若微信提示必须升级，当前固定版本的发送组件需要重新适配；请保留完整微信提示。';
  if (/HOOK_VERSION_MISMATCH|Client version mismatch/i.test(output)) return '微信版本与发送组件不匹配，请在连接设置中选择匹配的微信程序。';
  if (/HOOK_LOGIN_REQUIRED/i.test(output)) return '发送组件已连接，但微信尚未完成登录。请在设置中打开微信并登录，再到概览启动助手。';
  if (/HOOK_ACCOUNT_METADATA_INVALID/i.test(output)) return '微信发送组件未提供有效账号信息。请检查组件版本或使用“修复微信连接”。';
  if (/WeChat-Hook is not ready|BACKEND_UNAVAILABLE|Matching WeChat client missing/i.test(output)) return '匹配微信尚未就绪。点击“打开微信”，登录配置的账号后再启动。';
  if (/Install the DSH plugin|Fully.*reopen DSH|ECONNREFUSED.*11230/i.test(output)) return 'DSH 插件尚未就绪。打开 DSH，启用本项目插件并完整重开后再启动。';
  if (/Invalid project configuration|configuration.*failed/i.test(output)) return '项目配置无效，请检查连接设置与人格文件。';
  return '操作未完成，请查看下方详细信息，修正配置后重试。';
}
