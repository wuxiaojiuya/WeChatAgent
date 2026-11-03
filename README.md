# WeChatAgent

**让微信 AI 朋友拥有自己的性格、声音与歌声。**

由 [wuxiaojiuya](https://github.com/wuxiaojiuya) 维护的 Windows 微信 AI 助手定制版。

[下载安装](https://github.com/wuxiaojiuya/WeChatAgent/releases) · [首次使用](docs/QUICK_START.md) · [提交问题](https://github.com/wuxiaojiuya/WeChatAgent/issues) · [更新记录](RELEASE_NOTES.md)

## 功能

| 功能 | 说明 |
| --- | --- |
| 自然聊天 | 好友/群聊白名单、唤醒词、人格卡、上下文、成员记忆与主动消息 |
| 管理员审批 | 好友可设为管理员，AI 提议人格变更后向管理员申请同意 |
| 原生语音 | 发送微信语音条；AI 自行选择语音或文字，以及情绪和表达强度 |
| 对话点歌 | 直接说「你会唱朋友的酒 DJ 版吗」，AI 选择歌曲、版本并发起翻唱 |
| RVC 翻唱 | 人声/伴奏分离 → 上传的 RVC 模型换声 → 混音；支持移调与质量优化 |
| 歌曲来源 | QQ 音乐、网易云、酷狗或本地音源；下载缓存默认七天清理 |
| 消息理解 | 语音转写、图片、引用内容与附件、视频抽帧和音轨转写 |
| 能力与插件 | 能力页面按需配置，保留插件 API、记事本和扩展入口 |

## 运行要求

- Windows x64，当前发布版精确适配 **微信 4.1.8.27**。
- 独立安装的 DSH Desktop，以及可用的对话模型。
- 语音、唱歌、ASR 需要相应服务、推理环境和模型；基础安装包不包含大型音频模型资源。
- 图片和视频需要支持图像输入的模型，实际理解能力取决于所配置的模型。

Hook 随 Windows 安装包提供，无需填写 DLL 路径或自定义 HTTP 接口地址。不要混用不同微信版本的组件。

## 快速开始

1. 从 Releases 下载 Windows 安装包。
2. 在连接设置选择匹配微信与 DSH，通过项目打开微信并登录、验证连接。
3. 配置模型、启用桥接插件，添加允许的聊天并选择人格。
4. 在「能力」按需启用语音和唱歌。

详细步骤及源码运行见 [安装与首次使用](docs/QUICK_START.md)，音频依赖见 [音频运行环境](docs/AUDIO_RUNTIME.md)。

## 文档

- [4.1.8.27 Hook](docs/SUPPLIER_HOOK_41827.md)
- [多模态消息理解](docs/MEDIA_UNDERSTANDING.md)
- [语音输入](docs/VOICE_INPUT.md) · [引用消息](docs/QUOTE_MESSAGES.md)
- [插件开发](docs/PLUGIN_DEVELOPMENT.md)
- [数据存储](docs/DATA_STORAGE.md) · [发布流程](docs/GITHUB_PUBLISHING.md)

## 发布与隐私

首版 **v0.1.0**。主页、下载和更新源均为本仓库。应用检查正式 Release；仅推送代码不会触发版本更新。私有仓库的附件需要有权限的 GitHub 账号登录下载，匿名更新检查无法读取私有 Release。

配置、API Key、聊天记录、歌曲和私人模型保存在本机，不随源码或安装包分发。反馈问题时请移除账号、聊天内容及凭据。

## 许可与来源

本项目基于既有 WeChatAgent 代码定制，新增修改由 wuxiaojiuya 维护。保留原有代码和依赖所需的版权、许可及来源记录，详见 [LICENSE](LICENSE)、[LICENSES.md](LICENSES.md) 和 [components.json](components.json)。微信、DSH、Hook、模型与音乐内容分别适用其自身条款。
