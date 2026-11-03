# 项目目录与清理边界

开发目录通常名为 `WeChatAgent`，公开源码目录为 `WeChatAgent-public`。二者保留相同的运行入口与插件接口；公开版另外维护发布检查、公开预设和发行版构建配置。不要把开发目录整体覆盖到公开版，也不要用文件夹大小判断是否可以删除。

## 源码放在哪里

| 目录 / 文件 | 职责 | 维护方式 |
| --- | --- | --- |
| apps/console-desktop/ | 当前桌面外壳、窗口、托盘、部署与数据位置管理 | 保留，属于当前产品源码。 |
| public/console/ | 控制台页面、交互与样式 | 保留，直接影响界面。 |
| components/qq-bridge/ | 当前消息桥接、微信协议适配、发送与回执链路 | 当前运行入口位于 src/social-bridge.js。 |
| components/weflow-cli/ | NT 数据库读取与相关原生资源 | 按组件自己的维护规范处理，不当作缓存清理。 |
| components/WeChat-Hook/ | 原生发送组件的上游源码 | 按组件来源及许可边界维护。 |
| components/WeFlowComplete/ | 上游参考及开发版使用的 Electron / 打包依赖 | 不因“不是日常启动入口”就删除，构建脚本仍会引用。 |
| packages/dsh-social-bridge-plugin/ | DSH 会话、工具授权、历史及助手模式接入 | 当前桥接宿主。 |
| packages/plugin-api/ | WeChatAgent API v2、ZIP 安装及插件子进程 | 当前本机插件接口。 |
| packages/extension-runtime/ | 旧接口兼容及共享 Schema / 配置校验 | 新插件接口仍复用部分校验，不能直接删除。 |
| packages/native-features/ | 开发版保留的原生功能实现 | 公开版可采用整理后的实现，不要求两套目录逐项相同。 |
| extensions/ | 随项目保留的兼容说明与工具素材 | 和用户安装的 API v2 插件不是同一个目录。 |
| examples/plugins/ | 可公开的 API v2 示例 | 示例 ZIP 和开发规范依赖此处。 |
| optional-extensions/ | 可选扩展源码；鱼的记事本等第一方插件也可在公开版提供 | 按需打包安装，不能按临时文件清理。 |
| optional-extensions/packages/ | 随源码分发、经过内容校验的第一方插件 ZIP | 仅精确白名单包进入 Git；用户自行安装的 plugins/ 仍为私有目录。 |
| scripts/ | 读取器、生命周期、配置、构建、维护与测试脚本 | 测试脚本也是源码。 |
| docs/ | 使用说明、接口规范和架构记录 | 专题报告放 docs/reports/，版本说明放 docs/releases/。 |
| roles/ | 人格卡 | 保留个人卡；公开前核对授权与隐私。 |
| config/*.example.json | 空白配置模板 | 可公开，不包含本机账号信息。 |
| components.json | 组件来源与历史固定版本记录 | 不是程序当前版本号；程序版本看 package.json。 |
| package-lock.json | 根项目依赖锁定 | 保留，不能当作缓存删除。 |

开发版中的 `apps/bridge/`、`apps/weflow/` 属于历史整合参考，当前主链路使用 `components/qq-bridge/` 和独立 NT 读取器。保留原路径以兼容历史资料；新增改动不要同时复制到旧目录，除非确有调用方。

## 私有数据放在哪里

下面这些目录不能进入公开提交或按“无用文件”清理：

| 路径 | 内容 |
| --- | --- |
| config/wechatagent.json | 本机配置、允许的聊天、模型和运行环境设置。 |
| config/plugins.json / config/extensions.json | 本机插件权限、聊天范围和可能包含密钥的设置。 |
| plugins/ | 用户安装的 API v2 插件代码；第一方示例放 examples/plugins/。 |
| state/accounts/、state/weflow/ | 账号作用域、读取连接及受保护凭据。 |
| state/chat-history/、state/social-messages.json | 聊天历史、消息缓冲和处理状态。 |
| state/media/、state/stickers/、state/files/ | 已收录的图片、表情及文件资源。 |
| state/member-memory/、state/fish-notebook/、state/plugins/、state/plugin-documents/、state/plugin-schedules/ | 群友记忆、日记、插件文档和每日计划回执。 |
| state/assistant-tasks/、state/text-deliveries/ | 任务及发送回执状态，不能当作旧测试结果。 |
| state/group-bindings/、state/proactive/、state/search/ | 群绑定、主动聊天及搜索状态。 |
| state/hook/ | 匹配微信、Hook 构建产物及连接资源。 |
| state/desktop/、state/logs/ | 窗口、外观、桌面运行记录及排障日志。 |
| state/backups/、state/console-backups/、state/migrations/ | 既有备份与迁移恢复记录。 |

`state/` 中已有的日期目录可能保存修复证据、源码快照和截图。日期早不等于无用；其中的 `VERIFICATION.json`、报告、截图和回滚副本继续保留。账号数据和原始微信数据库也不能因为安装了新版就删除。

## 发布产物与构建缓存

| 路径 | 处理原则 |
| --- | --- |
| WeChatAgent.exe、release/WeChatAgent/ | 本机桌面启动入口与完整程序，运行中必须保留。 |
| release/installer/ | 公开版保存当前正式安装包及一个上一稳定版本，配套校验文件一起保留；开发版按实际构建保留。 |
| release/plugins/ | 待交付的插件 ZIP，和完整应用安装器分别保存。 |
| release/patches/、release/hotfix/ | 已准备的修复工具，按用途核对，不能直接当缓存删除。 |
| release/installer/win-unpacked/ | 打包中间目录；确认没有进程使用后可删除，下次构建会重新生成。安装包验收前需先重新构建。 |
| state/installer-stage/runtime/ | 可复用的内置 Node/Python 运行环境，部分测试直接使用，保留。 |
| state/installer-stage/nsis*、state/installer-cache/ | 打包工具和下载缓存，保留以支持离线或快速重新构建。 |
| state/installer-stage/app、project、vendor | 上次构建的暂存副本；本轮保留，不影响运行与重新构建。 |
| node_modules/、组件内 node_modules/ | 开发、启动或构建依赖；本轮不删除。 |

安装器文件内容以**上一次实际构建**为准，修改源码不会自动更新旧 EXE。开发版与公开版的发布目录不需要互相复制全部历史文件。

## 本轮整理策略

- 清理已结束的随机测试工程、安装冒烟测试副本、旧安装包解压目录和已验证的历史构建暂存副本。
- 清理本轮功能验证留下的 tmp / tmp-* 等临时工程，保留同目录的验证记录、截图和源码回滚副本。
- 对历史构建副本先与项目外的已验证完整备份比对，再清理；清理前保留其顶层验证文件、日志和辅助脚本到 `state/maintenance/evidence/`。
- 旧安装器归档到两套项目之外的 `WeChatAgent-archives/releases/日期/`，按 development / public 分开，不永久删除可回退版本。
- 新的维护审计结果放 `state/cleanup-日期/`；历史完整备份继续放项目外的 `WeChatAgent-backups/`。二者均不进入公开源码。

清理前核对规范化绝对路径、活动进程、运行配置引用和未提交源码。遇到链接不跟随到外部目标；文件在检查后变化、正在使用或无法确认用途时保留。清理完成后核对入口、发布安装器、运行数据和针对性回归。

## 后续新增文件

用户插件放 `plugins/`，公开示例放 `examples/plugins/`；正式文档放 `docs/`；诊断报告和测试临时工程放 `state/maintenance/` 或已有专题证据目录，避免在根目录堆放日志、截图、下载包和重复源码。不要用 `.gitignore` 代替隐私检查；发布前继续运行 `npm run privacy:check`。
