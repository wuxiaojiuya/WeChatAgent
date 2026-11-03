# 音频运行环境

音频生成和微信发送是两个环节：肥鱼服务/RVC 生成音频，项目编码后调用 4.1.8.27 Hook 发送微信原生语音条。

需要让 AI 协助安装时，直接提供 [AI 安装指南](AI_INSTALL_GUIDE.md)。其中列出 Windows CPU 基线、独立环境版本、官方模型来源、本机配置与真实音频验收步骤。

## 语音回复

默认选择「本机肥鱼服务（自动连接）」：项目连接 http://127.0.0.1:9880，并按本机 `voice-service.json` 的 `data_dir` 自动读取 `api_key.txt`，无需用户复制填写密钥。环境和模型仍需先安装、服务仍需运行；填入密钥不能替代这些步骤。只有「自定义服务（高级）」需要单独提供地址和访问凭据，项目不会把本机密钥发送给其他地址。AI 可自行决定文字或语音，并选择情绪和强度；实际表现取决于 TTS 模型。

## 翻唱

参考 [astrbot_plugin_feiyu_voice](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice)：歌曲检索/本地音源 → 分离人声与伴奏 → RVC 换声 → 混音与限幅 → 微信发送。

使用上传的 RVC 模型，不直接使用 TTS 音色 ID。QQ/网易云/酷狗音源受服务及账号权限限制。聊天中可直接点歌，由 AI 判断歌曲与版本。

当前 CPU 适配需要在数据工作区的 state/maintenance/audio-capabilities/feiyu-cover/ 准备 venv/Scripts/python.exe、runtime.cpu.json，以及相关依赖、固定源码与基础模型。当前就绪检测还检查 cover_demo.py，兼容转发方式见 AI 安装指南；正式调用入口为 scripts/music-cover.py 和 scripts/music-rvc-worker.py，rvc_worker_cpu.py 是早期实验脚本，不是当前正式链路的前置文件。这是现有推理环境适配，并非自动下载安装器。

v0.1.0 基础包不分发这些环境或权重。部署时重新创建虚拟环境、安装依赖并调整配置路径，不应直接搬运带开发机绝对路径的 venv。缺少依赖时能力页显示未就绪。模型和音源遵循各自的许可及平台规则。
