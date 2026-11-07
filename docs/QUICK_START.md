# 安装与首次使用

## Windows 安装包

1. 从 [Releases](https://github.com/wuxiaojiuya/WeChatAgent/releases) 下载所需版本的 Windows x64 安装包，选择程序和数据目录。
2. 准备 **Windows 微信 4.1.8.27** 与独立 DSH Desktop。安装包不包含微信客户端或 DSH。
3. 在连接设置选择微信 Weixin.exe 和 DSH 程序。Hook 已内置，无需填写组件路径和 HTTP 地址。
4. 从托盘完全退出普通微信，通过项目打开微信，登录后点击「连接并验证」。
5. 在 DSH 配置模型，安装并启用本机桥接插件包，按页面提示授权。能力插件会随包自动配置和加载，无需手动注册第二个插件。
6. 添加允许的好友或群聊，选择人格卡、唤醒方式并启动服务。初始允许聊天列表为空。

先用文件传输助手验证文字、语音再开启其他聊天。微信版本必须精确匹配。

## 运行分工

WeChatAgent 管理能力设置、密钥、任务记录、聊天权限、微信收发和环境安装。DSH 能力插件执行绘画、语音合成、音乐来源访问和演唱推理。DSH 中的 AI 根据对话决定使用哪些能力，以及工具调用的顺序；不要求用户在微信中填写歌手、版本或推理参数。

需要生成内容时保持 DSH 打开，并确认其加载的是当前项目的插件。能力页的服务检查、在线歌曲搜索与登录验证、本地试画和试听也经 DSH 执行；缺少插件或连接中断时明确失败，不由 WeChatAgent 本地替代生成，也不自动重放结果未确认的请求。

能力插件的职责变化不会迁移现有音色、模型或环境。它们仍位于数据工作区的 `state/voice-profiles`、`state/rvc-models` 和 `state/maintenance/audio-capabilities`。环境的一键安装、检查和修复继续从 WeChatAgent 设置页操作。

## 能力依赖

| 能力 | 额外要求 |
| --- | --- |
| AI 对话 | DSH Desktop、可用模型和账号/API 配置 |
| 语音回复 | 已加载的 DSH 能力插件、肥鱼 TTS 服务及模型（默认本机端口 9880）和所选 RVC 音色；TTS 合成后再换声 |
| AI 编排翻唱 | 原曲人声 → AI 分析编排 → 所选 RVC 音色换声 → 伴奏混音；安装 RVC/分离环境即可，唱歌不调用 TTS |
| 歌曲检索 | DSH 能力插件访问 QQ/网易云/酷狗的可用音源，不能保证每首可下载；可用本地歌曲 |
| GPT 绘画 | DSH 能力插件及可用的 GPT Image 服务、模型和凭据，在 WeChatAgent 能力页配置 |
| 语音接收 | ASR 服务或本机 Whisper 环境及模型 |
| 图片与视频 | 图像模型、解码抽帧工具，视频语音转写还需要 ASR |

基础安装包包含控制台、项目插件代码、Node.js、Python 和微信 Hook；不包含开发机的音频虚拟环境、权重、参考音频及歌曲。语音与唱歌共用能力页所选音色，上传 `.pth` 和配套 `.index` 后无需在唱歌页重复上传。见 [音频运行环境](AUDIO_RUNTIME.md)。

若要由 AI 帮助安装语音回复和翻唱环境，请把 [AI 安装指南](AI_INSTALL_GUIDE.md) 交给它，按独立环境、官方模型下载和本地试听的顺序完成验证。

## 源码运行

需要 Windows、Node.js 22.13+、Python 3.13、Git、DSH 和匹配微信。

```powershell
git clone https://github.com/wuxiaojiuya/WeChatAgent.git
cd WeChatAgent
npm ci
npm --prefix packages/dsh-social-bridge-plugin ci
python -m pip install -r scripts/reader-requirements.txt
node scripts/project-config.mjs
npm run console:web
```

Git 源码不含 Hook 二进制。将同版本 Release 的 Hook 4.1.8.27 附件解压至根目录，保留 components/supplier-hook/4.1.8.27 层级。安装包已内置。项目配置会把桥接和能力插件一同加载到 DSH；不需要另给能力插件注册独立入口。

桌面开发构建：`npm run desktop:build` 后运行 WeChatAgent.exe。

## 数据与更新

保留安装时的数据目录进行升级。不要提交 state/、plugins/ 或 config/wechatagent.json。下载歌曲默认七天清理。

应用检查本仓库正式 Release，下载并运行安装包更新。私有仓库需登录有权限的 GitHub 账号下载，匿名检查不可用；不要把 GitHub 访问令牌嵌入软件。
