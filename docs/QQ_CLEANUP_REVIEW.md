# QQ 机器人相关内容清理审查

审查日期：2026-11-07。范围为当前仓库的运行入口、模块引用、依赖、配置、页面、构建规则和文档。本次仅整理清单，没有删除运行代码、修改用户数据或发送消息。

## 结论

当前项目没有独立的 QQ 机器人接入：未发现 QQ 适配器、QQ 登录页面或 NapCat、Lagrange、go-cqhttp、mirai、oicq、icqq 运行依赖。`components/qq-bridge/` 已裁为微信使用的桥接子集，名称保留了上游来源，不能整目录删除。

该目录当前有 34 个已跟踪文件，合计 266,940 字节（约 261 KiB）。其中仍有少量未接入当前运行链路的旧 QQ 代码，可以进一步清理。删除这些残留主要改善可维护性，不会显著缩小安装包，也不会改变当前微信通信协议。

## 优先清理候选

| 内容 | 当前证据 | 建议处理与注意事项 |
| --- | --- | --- |
| `components/qq-bridge/src/core/session-router.mjs` | 28,570 字节，包含 `ownerQQ`、`qq-chat`、`qsh-sim` 等旧路由；仓库内未发现该模块及其专属导出的外部调用。 | 可以作为首批删除候选。删除后重新生成 `release-profile.json` 和发行包，复核导入、插件契约及测试；不能只删文件而保留旧打包校验基线。 |
| `components/qq-bridge/src/core/conversation-key.js` 中 `legacyQqKey()` | 当前只有定义，未发现调用。 | 可定向移除这个函数；同文件的 `buildConversationKey()`、`parseConversationKey()` 仍供微信消息、缓冲和主动聊天使用，文件本身保留。 |
| `scripts/setup.ps1` 中 `IncludeQqDependencies` 开关 | 仅进入旧命名的桥接目录执行 `npm ci`；该包没有依赖项。 | 可移除旧开关及对应分支，同时更新可能使用该参数的说明与测试，保留当前 DSH 插件和 Python 依赖安装。 |
| 根目录本地 `QQ.jpg` | 455,767 字节，无源码引用，未跟踪且被 `.gitignore` 排除。 | 可清理本地文件；它不进入源码包或安装包，删除不会缩小发布附件。本次未读取或删除图片。 |

以上“未发现调用”以当前仓库内静态引用为界，不代表未知第三方插件绝不使用旧导出。实际删除时应执行针对性测试与完整构建验收。

## 需要迁移或评估后再清理

| 内容 | 处理建议 |
| --- | --- |
| `components/qq-bridge/` 目录名及其 `package.json` / `package-lock.json` 包名 | 可改为微信中性命名，但必须同步迁移 `scripts/manage.ps1`、`scripts/project-config.mjs`、根测试命令、DSH 模块、插件 API、构建校验中的引用。保留 `type: "module"` 和必要来源说明。改名不等于移除运行功能。 |
| `conversation-key.js`、`packages/dsh-social-bridge-plugin/native-context.mjs`、`history-store.mjs`、`work-modes.mjs` 中接受 `qq:` 会话键的分支 | 这是旧会话兼容路径，不是现成的 QQ 登录或收发能力。若决定仅支持微信，可统一收窄解析、标题和历史校验；不能先删除用户历史数据，也不能只改一个正则。 |
| `components/qq-bridge/src/role-card.js` 的旧注释和未使用导出 | `qq_send_message` 注释可修正；`ROLE_INJECT_MODES`、`roleSectionReport()`、`roleCharStats()`、`GEN1_ROLE_LINE_RE` 可另做死代码清理。`selectRoleText()`、`parseRoleSections()` 是当前微信人格功能，不能整文件删除。 |
| `docs/releases/0.3.9.md` 的 QQ 版本历史后记 | 可精简非运行文案；若删除整份历史文档，先处理 `docs/releases/0.4.0.md` 的链接。保留许可证要求的通知。 |
| `docs/PROJECT_LAYOUT.md` 对 `apps/bridge/`、`apps/weflow/` 的说明 | 当前不存在这两个目录，可以修正文档；不应将它们描述为仍在打包的 QQ 模块。 |
| `safe-fetch.js`、`web-reader-fetch.mjs` 等文件中的旧 QQ/MCP 注释 | 可改为符合当前用途的说明，不要因此删除通用网络校验逻辑。 |

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

## 构建影响与建议顺序

`scripts/public-source-check.mjs` 枚举已跟踪和未忽略的源码；源码包和当前安装器会复制其中符合规则的文件。因此旧源码、组件元数据和历史文档仍可能随包发布；被忽略的 `QQ.jpg` 不会进入发布。

建议先删除已确认无调用的旧路由和旧开关，再统一清理会话兼容分支。目录改名可最后单独实施，减少同时更改大量路径造成的回归。每批清理后检查：

1. 模块导入、插件宿主契约与配置生成没有断链。
2. 微信连接、私聊/群聊、`@`、分段回复、语音、图片、视频及主动聊天相关离线测试通过。
3. DSH 会话历史、人格与能力授权兼容性符合预期。
4. 源码隐私扫描通过，重新生成打包基线并核对隔离安装/升级资源。

本清单不把旧微信兼容构建器、通用测试工具或 QQ 音乐归入“QQ 机器人可删除代码”，也不据此清理用户的设置、音色、模型和聊天记录。
