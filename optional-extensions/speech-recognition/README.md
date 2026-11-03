# 语音识别 API 插件

WeChatAgent API v2 可选插件。接口地址、密钥、模型和请求映射均由安装者配置；没有内置服务商、API 地址或账号。默认配置不会上传任何语音。

## 1.2.0 协议、模型与实际语音状态

参照 DSH 的模型接入方式，把协议、基础地址和模型 ID 分开处理。没有内置服务商地址、模型或凭据。模型读取和语音检测使用同一套协议解析与鉴权规则。

| API 协议 | 地址与请求 |
| --- | --- |
| 自动 | 识别常见完整路径；保留旧 JSON 模板及非标准字段映射 |
| 语音转写 API | 基础地址追加 `/audio/transcriptions`，标准 multipart 文件上传 |
| Chat 音频（Base64） | 基础地址追加 `/chat/completions`，发送 `input_audio.data` 与 `format: wav` |
| Chat 音频（Data URL） | 相同路径，音频使用 `data:audio/wav;base64,...`；适用于要求该形式的兼容接口 |
| Anthropic Messages | 按原生鉴权读取 `/v1/models`；标准消息协议不作为语音转写入口 |
| 自定义请求 | 完整 POST 地址，使用下方高级字段和模板，兼容原有配置 |

基础地址保留网关路径与版本前缀，不自动切换到服务根路径或其他域名。已填完整识别路径时不会重复追加；与所选协议矛盾则明确报错。标准协议自动生成鉴权和请求体、解析转写结果；自定义鉴权头继续有效。Chat 模式的额外参数可在高级设置 `extraFieldsJson` 填写 JSON 对象，不能覆盖 model、messages 或 stream。标准协议不允许空模型名；API Key 会去掉首尾空白，非法换行或字符在发起网络请求前提示。

模型发现支持 `data` 数组及网关 `models` 对象映射，映射键作为可调用的模型别名。Anthropic 使用 `x-api-key` 和版本头，其他标准模式使用 Bearer 鉴权。读取成功仅说明目录可用，不证明某模型能处理音频；声明只接受文本的模型不会成为语音候选。界面不自动替换模型，需要选择后检测。

诊断区同时显示合成短句检查与最近一条微信语音的实际结果。较新的真实转写错误会覆盖较早的合成检测成功状态。运行状态仅记录时间、成功与否、阶段和错误码，不保存音频、转写内容或密钥，配置代次变化后旧状态失效。失败占位明确说明消息已收到、转写失败及错误码，避免被模型误报为没有收到消息。

全局两条识别并发之外的语音会在有界队列内等待；停止服务会取消等待，不发起新的上传。不会因 403、模型不匹配或超时而轮流更换协议重传。

协议依据：[OpenAI 官方 Chat 音频文档](https://developers.openai.com/api/docs/guides/audio-chat-completions)、[Anthropic Messages 参考](https://platform.claude.com/docs/en/api/messages/create)。服务商扩展、实时 WebSocket 和动态签名仍需专门适配。

## 1.1.1 模型发现与配置检测

新版配置页提供模型下拉选择和接口状态。填入接口与密钥后会按常见协议自动尝试同一服务的模型列表地址；“读取模型”也可手动刷新。服务使用特殊路径时，在高级设置填写 `modelsEndpoint` 和 `modelsResponsePath`。`autoReadModels` 可关闭自动读取。未提供列表接口或列表权限不足时仍可手动填写模型 ID。

模型列表由服务返回，部分服务会列出文本模型。实时或 WebSocket 模型单独标记，不会自动作为 HTTP 语音候选选中；需要服务提供 HTTP 兼容适配才能使用。界面标注“语音候选”，不会将列表可见当作已经完成语音识别，也不会自动轮流调用所有模型。

点击“检测配置”会检查请求格式与本机 WAV 转换组件，并向所配置 API 发送一次插件自带的短测试音频。该音频是离线合成的“语音识别测试”，不含聊天语音；识别测试可能使用服务商额度。只有返回短句匹配、且实际输入转换组件就绪时才显示“配置已验证”。原始 SILK 配置下，WAV 测试成功仍会提示实际 SILK 输入待验证。

状态会区分模型列表不可用、鉴权失败、模型栏填网址、JSON 模板缺少音频、WAV 转换组件未就绪、超时、结果路径错误和测试短句不匹配。更改接口、密钥、模型或请求设置后，旧检测结果失效。留空保存秘密字段继续保留原值。

检测可在插件未启用时由本机配置页明确触发：运行的是宿主自带的受审查检测逻辑，不加载已安装插件的任意 JavaScript，也不获得聊天、历史或音频读取权限。读取模型是 GET 请求，不自动上传测试音频；只有点击“检测配置”才执行一次音频测试。检测成功也不会自动启用插件。

新界面需要配套新版宿主。旧宿主仍可使用基础转写，但不会自动获得模型选择和配置状态面板。

## 运行方式

微信收到语音 → 宿主核对当前账号、聊天和插件授权 → 读取该消息的音频 → 本插件调用配置的 API → 将转写文字交给原聊天模型 → 原有微信发送流程回复。

需要新版宿主能力 `voice-input-v1` 和 `actions-v1`。`audio_read` 仅允许读取本次宿主绑定的原消息，不能填写文件路径、其他聊天或任意下载地址。助手模式继续检查发送者授权。识别过程不额外调用聊天模型。

本交付只提供源码和 ZIP，不安装、不启用，不重启现有服务。只有安装者填入接口并明确授权聊天后才可上传音频。旧版宿主不能只靠导入这个 ZIP 获得语音接收能力，需要配套更新语音宿主源码。

## 接口配置

以下两种自定义请求均使用 HTTP POST；请先将 API 协议选为 `custom`。`endpoint` 是完整地址，不会拼接或推断服务商路径。支持 HTTPS；本机开发服务可使用 `http://127.0.0.1:端口/路径`、`http://localhost:端口/路径` 或 IPv6 回环。禁止 URL 用户凭据和自动重定向。

### multipart/form-data

适用于常见的文件转写接口。配置：

- `endpoint`：服务商提供的完整 POST 地址。
- `apiKey`：本机输入的真实密钥；默认使用 `Authorization: Bearer <apiKey>`。
- `authHeader` / `authPrefix`：可改为自定义密钥头，或者清空前缀。
- `headersJson`：额外请求头的 JSON 对象，作为秘密设置隐藏；可用于自定义鉴权头。不要自行设置 multipart 的 Content-Type 和 boundary。
- `model`：真实模型 ID；留空时不发送模型字段。
- `audioFormat`：`wav` 或 `silk`。
- `fileField` / `modelField` / `languageField`：服务要求的字段名。
- `extraFieldsJson`：额外的字符串、数字或布尔字段，例如 `{"response_format":"json"}`。
- `responseMode`：`json` 或 `text`。
- `responsePath`：JSON 中转写文字的位置，例如 `text`、`data.text`、`results.0.text`。留空表示整个响应本身是字符串。

### JSON 请求

将 `requestMode` 设为 `json`，按服务商协议配置 `jsonTemplate`，例如：

```json
{
  "model": "{{model}}",
  "input": {"audio": "{{audio_base64}}", "language": "{{language}}"},
  "sample_rate": "{{sample_rate}}"
}
```

支持占位符：`{{audio_base64}}`、`{{audio_data_url}}`、`{{model}}`、`{{language}}`、`{{filename}}`、`{{mime_type}}`、`{{sample_rate}}`、`{{audio_bytes}}`。模板先解析为 JSON 再替换值，因此文本中的引号和换行不会破坏 JSON；独占一个值的数字占位符保留数字类型。不会执行代码或表达式。

这不是所有厂商私有协议的通用 SDK。需要 TC3/HMAC 等动态签名、异步提交后轮询、WebSocket 或特殊二进制协议的服务，须使用提供上述 HTTP 协议的兼容网关或另写协议适配器；仅填写 URL 和 Key 不会自动完成这些协议。

## 音频与依赖

默认上传 WAV。新版宿主内置固定版本 `silk-wasm` 格式转换组件，并实际运行合成音频编解码来检查可用性；内置 Python 3.13 无需 pip 或 pilk。这只是轻量音频解码，不下载识别模型，不使用 GPU。开发环境可继续使用已有 pilk 作为兼容回退，清单位于 `scripts/voice-requirements.txt`。只更新插件 ZIP 不会给旧宿主补齐解码组件。

如果 API 接受原始微信 SILK，可把 `audioFormat` 改成 `silk`，不需要 WAV 解码依赖。格式声明不保证特定 API 接受微信封装，实际服务需用样本验证。

只处理当前收到、当前授权聊天的语音，不启动历史批量扫描、不回放旧消息。语音最长 60 秒；音频上限 2 MiB。API 默认 20 秒超时，可设 1–25 秒；整项动作最多 33 秒。JSON 响应最多 64 KiB，转写文本最多 4000 字符。

失败时给模型明确的“语音未能识别”占位，保留原发送者及顺序，后续文字继续处理。不会根据空结果编造语音内容，不自动重试上传。全局最多两条识别并发，同一聊天保序。缓存仅保留进程内最近 128 项，按账号、聊天、消息和完整设置隔离，重启清空；不落盘保存音频或转写缓存。原消息引用索引由宿主保存在 `state/voices/`，转写结果作为聊天文字沿用原有历史存储。

API Key 和额外请求头不进入聊天内容；管理接口隐藏这两个秘密设置，但本机配置仍需妥善保管。音频会发送到自己填写的 API 地址；插件的 Node 子进程是故障隔离，并非操作系统沙箱。

## 打包与验证

在项目根目录：

```powershell
node scripts/pack-plugin.mjs optional-extensions/speech-recognition release/plugins/speech-recognition-1.2.0.zip
node --test scripts/test-speech-recognition.mjs
node --test scripts/test-speech-diagnostics.mjs
```

Python 合成数据库边界测试为 `scripts/test-voice-input.py`，使用项目配置的 Python 运行。测试只调用本机临时模拟 API，不使用真实语音、凭据、服务商或微信联系人。

未来安装时，在“能力 → 能力目录”导入 ZIP，填写配置、授权读取语音并选择聊天。第一次更新宿主需按主项目说明完整重载 DSH 及后台；本次未执行这些操作。
