# 随源码分发的第一方插件包

speech-recognition-1.2.0.zip 是可配置 API 的语音识别插件，源码在 ../speech-recognition/，需要 voice-input-v1 宿主。新配置页支持自动读取模型和配置检测。接口、密钥和模型默认留空，不默认安装或启用。

重新生成第一方插件包使用 `node scripts/pack-bundled-plugins.mjs`；发布前运行 `node scripts/plugin-host-check.mjs`，会同时检查插件清单、宿主接口和 ZIP 与源码一致性。

fish-notebook-1.0.0.zip 可拖入 WeChatAgent 的“能力 → 能力目录”安装。安装后默认关闭，请明确选择权限与聊天。

对应源码位于 ../fish-notebook/。本 ZIP 已校验与源码逐项一致，不包含日记、账号或设置。开发者重新打包后应同时更新此处及校验文件；其他压缩包仍按发布边界排除。

需要本次新增的动作、文档、当前人设、独立模型生成与每日计划宿主能力。完整使用说明见 ../../docs/FISH_NOTEBOOK.md。
