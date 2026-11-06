# 音频运行环境

当前源码支持在「设置 → 语音与翻唱环境」一键安装、修复或检查 TTS / RVC / SoulX。安装器自动准备三套独立的 Windows x64 CPU 环境、固定版本源码与官方音色，无需自行混装依赖，详见 [安装操作与故障处理](AUDIO_INSTALLER.md)。

音频生成和微信发送是两个环节：肥鱼服务/RVC 生成音频，项目编码后调用 4.1.8.27 Hook 发送微信原生语音条。

需要让 AI 协助安装时，直接提供 [AI 安装指南](AI_INSTALL_GUIDE.md)。其中列出 Windows CPU 基线、独立环境版本、官方模型来源、本机配置与真实音频验收步骤。

## 语音回复

默认选择「本机肥鱼服务（自动连接）」：项目连接 http://127.0.0.1:9880，并按本机 `voice-service.json` 的 `data_dir` 自动读取 `api_key.txt`，无需用户复制填写密钥。环境和模型仍需先安装、服务仍需运行；填入密钥不能替代这些步骤。只有「自定义服务（高级）」需要单独提供地址和访问凭据，项目不会把本机密钥发送给其他地址。AI 可自行决定文字或语音，并选择情绪和强度；实际表现取决于 TTS 模型。

本机 Windows CPU 服务会复用独立的 TTS 推理进程与已加载的同一模型，减少连续语音的重复启动和模型加载。首次请求、切换基础模型或闲置超过 10 分钟后的请求仍需加载；闲置超时或服务停止时自动释放进程和模型内存。每次请求仍验证模型、参考音频及输出校验值，保留 FP32、情绪、所选 RVC 音色与原有质量参数。生成失败不会自动重放该任务或换成其他音色。CPU 的实际推理和 RVC 换声仍需要时间，常驻不代表能够即时生成。

CPU 线程默认使用 4 个；若已进行本机对比测试，可在服务数据目录保留 `tts-performance.json`（`schema: "wechatagent-tts-performance-v1"`、`cpuThreads: 1～8`）使用测得的设置。该文件属于本机状态，不随源码或安装包分发，其他机器需要各自测量；开发排障也可使用 `WECHATAGENT_TTS_CPU_THREADS` 临时覆盖。

## 翻唱

参考 [astrbot_plugin_feiyu_voice](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice)：歌曲检索/本地音源 → 分离伴奏并提取歌词旋律 → SoulX 重新演唱干声 → 所选 .pth 换声 → 混音与限幅 → 微信发送。

在「能力 → 语音回复」统一选择和上传音色，翻唱自动沿用同一份音色档案的配套 RVC 模型。QQ/网易云/酷狗音源受服务及账号权限限制。聊天中可直接点歌，由 AI 判断歌曲与版本。

说话采用「CosyVoice3 合成带情绪的基础语音 → 所选 RVC 模型换声」，翻唱采用「SoulX 演唱干声 → 同一 RVC 模型换声 → 混入原曲伴奏」。在「语音回复 → 上传音色」上传 `.pth` 推理模型及可选 `.index` 即可共用，无需说话录音和录音文字。已有 RVC 音色可直接选择，不必重新上传。说话需 TTS 与 RVC；唱歌需 SoulX 与 RVC。换声失败会明确报错，不会返回其他音色的基础语音。

上传文件只保存在本机 `state/voice-profiles` 和 `state/rvc-models`，不会发布到代码仓库。模型需为已训练并导出的 RVC 推理模型，上传不会自动训练音色。情绪来自基础语音的表达，最终音色与清晰度以实际试听为准。

当前 CPU 适配需要在数据工作区的 state/maintenance/audio-capabilities/feiyu-cover/ 准备 venv/Scripts/python.exe、runtime.cpu.json，以及相关依赖、固定源码与基础模型。一键安装器会准备这些文件和兼容入口 cover_demo.py；翻唱还需要独立的 soulx-singer 环境；正式调用入口为 scripts/music-cover.py、scripts/music-soulx-worker.py 和 scripts/music-rvc-worker.py，rvc_worker_cpu.py 是早期实验脚本，不是当前正式链路的前置文件。

基础安装包不分发大型音频环境或权重。从 v0.2.0 起可在设置页单独下载安装。手动部署时重新创建虚拟环境、安装依赖并调整配置路径，不应直接搬运带开发机绝对路径的 venv。缺少依赖时能力页显示未就绪。模型和音源遵循各自的许可及平台规则。

SoulX 翻唱的新链路、安装与模型来源详见 [SoulX 翻唱说明](SOULX_SINGING.md)。
