# 原生语音接入说明已迁移

当前通过项目内置的微信 **4.1.8.27 Hook** 调用 `/api/send_voice` 或 `/api/send_mp3_voice`。不再使用旧版语音部署包、4.1.10.27 DLL 或数据库回执检查。

接口、回执与时长限制见 [当前 Hook 接入说明](SUPPLIER_HOOK_41827.md)，语音生成环境见 [音频运行环境](AUDIO_RUNTIME.md)。
