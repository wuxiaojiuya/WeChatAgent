# QQ 机器人相关内容清理记录

审查与清理日期：2026-11-07。范围为当前仓库的运行入口、模块引用、依赖、配置、页面、构建规则和文档。经用户授权，本次已移除确认无引用的旧代码、旧开关，并修正文档与注释；本地 `QQ.jpg` 的删除被自动审批拦截，未执行，文件仍保留。没有清理用户的配置、模型、音色或聊天数据，也没有发送消息。本次清理尚未重新打包发布。

## 结论

当前项目没有独立的 QQ 机器人接入：未发现 QQ 适配器、QQ 登录页面或 NapCat、Lagrange、go-cqhttp、mirai、oicq、icqq 运行依赖。`components/qq-bridge/` 已裁为微信使用的桥接子集，名称保留了上游来源，不能整目录删除。

本次清理只覆盖未接入当前运行链路的旧 QQ 路由、无引用导出和旧命名开关，主要改善可维护性，不会显著缩小安装包，也没有改变当前微信通信协议。目录名、必要来源通知及旧会话兼容分支继续保留。

## 已执行的清理

| 内容 | 清理依据 | 已执行处理与保留边界 |
| --- | --- | --- |
| `components/qq-bridge/src/core/session-router.mjs` | 清理前为 28,570 字节，包含 `ownerQQ`、`qq-chat`、`qsh-sim` 等旧路由；仓库内未发现该模块及其专属导出的外部调用。 | 已删除旧路由文件并同步源码校验基线；当前微信桥接入口和会话路由保留。重新发行前仍需复核新安装资源。 |
| `components/qq-bridge/src/core/conversation-key.js` 中 `legacyQqKey()` | 清理前只有定义，未发现调用。 | 已定向移除这个函数；同文件的 `buildConversationKey()`、`parseConversationKey()` 仍供微信消息、缓冲和主动聊天使用，文件本身保留。 |
| `scripts/setup.ps1` 中 `IncludeQqDependencies` 开关 | 仅进入旧命名的桥接目录执行 `npm ci`；该包没有依赖项。 | 已移除旧开关及对应分支，保留当前 DSH 插件和 Python 依赖安装。 |
| `components/qq-bridge/src/role-card.js` 中四个无引用导出 | `ROLE_INJECT_MODES`、`roleSectionReport()`、`roleCharStats()`、`GEN1_ROLE_LINE_RE` 没有当前调用方。 | 已移除这四项并修正旧 QQ 专用注释；`selectRoleText()`、`parseRoleSections()` 等当前微信人格解析功能保留。 |
| 旧 QQ 专用注释 | 说明与当前微信子集用途不一致。 | 已修正相应说明，不删除仍被使用的通用网络校验等共用逻辑。 |
| 历史发布后记及旧目录说明 | 属于非运行文案，不是当前 QQ 收发能力。 | 已删除 `docs/releases/0.3.9.md` 的旧后记及署名，保留技术正文与 `0.4.0.md` 中的发布说明链接；修正 `PROJECT_LAYOUT.md` 中已不存在的旧目录说明。 |

以上“未发现调用”以清理前当前仓库内静态引用为界，不代表未知第三方插件绝不使用旧导出。该边界不扩大到用户数据；后续发行仍需执行针对性测试与完整构建验收。

## 本次继续保留的内容

| 内容 | 处理建议 |
| --- | --- |
| 根目录本地 `QQ.jpg` | 455,767 字节，无源码引用，未跟踪且被 `.gitignore` 排除。删除被自动审批拦截，未执行，文件仍保留；它不进入源码包或安装包。 |
| `components/qq-bridge/` 目录名及其 `package.json` / `package-lock.json` 包名 | 可改为微信中性命名，但必须同步迁移 `scripts/manage.ps1`、`scripts/project-config.mjs`、根测试命令、DSH 模块、插件 API、构建校验中的引用。保留 `type: "module"` 和必要来源说明。改名不等于移除运行功能。 |
| `conversation-key.js`、`packages/dsh-social-bridge-plugin/native-context.mjs`、`history-store.mjs`、`work-modes.mjs` 中接受 `qq:` 会话键的分支 | 这是旧会话兼容路径，不是现成的 QQ 登录或收发能力。若决定仅支持微信，可统一收窄解析、标题和历史校验；不能先删除用户历史数据，也不能只改一个正则。 |

## 微信正在使用，必须保留

当前微信运行链路：

```text
微信 Reader / Hook
  → scripts/hook-onebot.mjs
  → OneBot reverse WebSocket
  → WechatOneBotAdapter
  → 消息归一化、媒体接收、消息缓冲
  → SocialEngine / DshPluginClient
  → DSH
```

- `scripts/manage.ps1` 直接从 `components/qq-bridge/src/social-bridge.js` 启动微信桥接；该入口创建 `WechatOneBotAdapter` 和 `SocialEngine`。
- `components/qq-bridge/src/onebot/` 是当前微信内部通信链路。OneBot 常用于 QQ 项目，但本项目已用它连接微信，不能按协议名称删除。
- `scripts/hook-onebot.mjs` 的 `at.data.qq` 和 `social-engine.js` 对它的读取，是 OneBot 的字段格式，当前用于微信 `@` 判断。直接移除会破坏群聊被提及识别。
- `safe-fetch.js`、人格解析、表情与主动聊天策略等被当前项目、插件 API、扩展运行时和 DSH 直接导入，应保留。
- `packages/music-source/`、歌曲来源页面及音乐文档里的“QQ”指 QQ 音乐，不是 QQ 机器人，保留现有歌曲来源。
- 图片文档中的 `qq.com` 可能是微信表情 CDN；不能按域名统一删除。
- 组件 `LICENSE`、`LICENSES.md`、`components.json` 和必要 README 署名用于记录上游来源与许可，保留。清理功能不等于清理版权通知。

## 构建影响与后续验证

本次清理后完整回归 **933/933 通过**，失败、取消和跳过均为 0；插件宿主契约、源码隐私扫描、PowerShell 安装脚本语法及 `git diff --check` 均通过。已按完整当前源码清单刷新 `release-profile.json`，没有生成或替换已发布版本的附件，也没有启动或重启实际微信、DSH 或发送真实微信消息。

`scripts/public-source-check.mjs` 枚举已跟踪和未忽略的源码；源码包和当前安装器会复制其中符合规则的文件。因此旧源码、组件元数据和历史文档仍可能随包发布；被忽略的 `QQ.jpg` 不会进入发布。

本次源码清理尚未重新打包发布，现有安装包与 GitHub Release 附件不会因源码修改自动更新。旧目录名和 `qq:` 会话兼容分支本次未移除；未来若调整，应单独迁移并验证历史兼容性。重新发行前检查：

1. 模块导入、插件宿主契约与配置生成没有断链。
2. 微信连接、私聊/群聊、`@`、分段回复、语音、图片、视频及主动聊天相关离线测试通过。
3. DSH 会话历史、人格与能力授权兼容性符合预期。
4. 源码隐私扫描通过，重新生成打包基线并核对隔离安装/升级资源。

本清单不把旧微信兼容构建器、通用测试工具或 QQ 音乐归入“QQ 机器人可删除代码”，也不据此清理用户的设置、音色、模型和聊天记录。
