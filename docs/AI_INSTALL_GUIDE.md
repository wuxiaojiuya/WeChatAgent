# AI 安装指南：本地语音回复与 RVC 翻唱

这份文档供有终端和文件操作权限的 AI 编程助手使用。用户可以把下面的提示词和本仓库地址交给 AI，让它检查电脑、准备环境并逐项验证。普通聊天模型若不能操作电脑，只能给出命令，不能代为完成安装。

当前源码已提供「设置 → 语音与翻唱环境」的一键安装、修复和检查。Windows x64 CPU 用户优先使用该入口，操作说明见 [音频环境安装](AUDIO_INSTALLER.md)。下文保留手动部署与排障方法，适用于旧版、下载失败或需要自行适配 GPU 的环境。

本指南以 **Windows x64、原生 CPU 推理**为基线，覆盖肥鱼 TTS 和「人声分离 → RVC 换声 → 伴奏混音」。维护机已验证这条路线；本文不是已在所有全新 Windows 系统验证过的一键安装器。NVIDIA、AMD、Intel GPU 路线需要另外适配和实际验收，不能仅更换 PyTorch 下载地址就声称可用。

## 直接交给 AI 的提示词

```text
请帮助我部署 https://github.com/wuxiaojiuya/WeChatAgent 。
先阅读 README.md、docs/QUICK_START.md、docs/AI_INSTALL_GUIDE.md 和
docs/AUDIO_RUNTIME.md，再核对当前源码的实际入口。

目标：在我的 Windows 电脑安装本地肥鱼语音回复和 RVC 翻唱环境，
先生成本地试听，通过后再指导我接入微信。

请先检测项目/数据工作区、Python、Node.js、Git、FFmpeg、内存、磁盘和显卡，
给出缺少的项目与预计下载量，然后在已有安装授权范围内继续。
使用两个独立的 Python 3.11 环境，按指南固定上游版本与关键依赖；
模型从原发布方下载，保留许可、校验文件并记录实际下载版本。
已有安装先检查和复用，不覆盖我的账号配置、模型或 API Key。

不要把 TTS、RVC、微信读取器的 Python 环境混装。
不要仅凭 pip 安装成功或 HTTP health 成功就报告完成。
必须验证短句 TTS，以及一段本地音源的分离、RVC、伴奏混音，
报告音频位置、实际时长、推理设备与失败项。
如果缺少音源，可先完成 TTS，再向我索取本地音频。
本次安装不自动向微信联系人发送消息，也不自行启用新的聊天权限。
若当前项目已经停止，除安装验证所需服务外不要恢复自动聊天。
```

## 1. 确认版本、工作区与硬件

先读 [首次使用](QUICK_START.md)。微信收发需精确匹配 **4.1.8.27**，Hook、DSH 和账号登录按该文档配置。只测试本地音频时可以暂不连接微信。

区分源码根目录和安装包的数据工作区：后者可能是安装时选择的数据目录。以下 `$ProjectRoot` 指实际包含 `scripts/`、`config/` 和 `state/` 的运行工作区，不应指向只读的安装程序目录，也不要照搬维护者的盘符。

| 项目 | 要求或建议 |
| --- | --- |
| 系统 | Windows x64；本指南使用 PowerShell |
| Node.js | 22.13.0 或以上，满足项目 `package.json` |
| Git | 可在子进程的 PATH 中执行，用于固定源码和运行期校验 |
| 音频 Python | 两个独立 Python 3.11 x64 环境；维护机为 3.11.18 |
| 微信读取器 Python | 源码安装按 QUICK_START 使用独立 Python 3.13，依赖见 `scripts/reader-requirements.txt` |
| PyTorch | CPU 构建；TTS 与 RVC 的版本不同，见下一节 |
| FFmpeg | 需要真实 `ffmpeg.exe`；当前翻唱入口固定使用 `C:/ffmpeg-tools/bin/ffmpeg.exe` |
| 内存 | 建议 16 GB 或以上；这是部署建议，不是已认证的最低要求 |
| 磁盘 | 建议至少 25 GB 可用空间，供约 13 GiB 已展开环境、下载与临时音轨使用 |
| 显卡 | CPU 基线不要求独立显卡，推理可能明显慢于音频时长 |

不要强行占用已被其他软件使用的端口。TTS 默认 `127.0.0.1:9880`，可选 ASR 为 `127.0.0.1:9881`，控制台为 `127.0.0.1:3210`。先核对监听进程归属，再决定是否需要停止项目自己的旧服务。

## 2. 固定来源与关键版本

### 源码与模型

| 用途 | 官方来源 | 本项目对接版本或要求 |
| --- | --- | --- |
| 肥鱼声音服务与适配器 | [astrbot_plugin_feiyu_voice](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice) | `76774b499f7d306454562d56348dd63399b6d7e8`，必须保留完整 `server/` |
| TTS 引擎 | [CosyVoice](https://github.com/FunAudioLLM/CosyVoice) | `074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc`，含对应子模块 |
| RVC 引擎 | [Applio](https://github.com/IAHispano/Applio) | `67a38f6abab3e90a55efa534ea3185a222c102f0`，叠加固定服务的兼容文件 |
| 肥鱼 TTS 模型包 | [FeiyuVoice-CosyVoice3](https://huggingface.co/Esmerubphire/FeiyuVoice-CosyVoice3) | 使用带 `manifest.json` 和 `files_sha256.json` 的发布包，校验全部文件 |
| 肥鱼 RVC 权重与索引 | [FeiyuVoice-RVC](https://huggingface.co/Esmerubphire/FeiyuVoice-RVC) | 默认模型 `FeiyuVoice-RVC-v1`；也可在能力页上传有权使用的 RVC 模型 |
| ContentVec / RMVPE | 固定服务的 `server/runtime_compat/upstream_assets.json` | 按其中 URL、目标路径和 SHA256 下载，包含 ContentVec 配置文件 |
| 分离模型 | [Demucs 官方权重](https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th) | SHA256：`8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4` |
| TTS 文本规范化 | [pengzhendong/wetext](https://modelscope.cn/models/pengzhendong/wetext) | 安装时准备 Windows 可用资源，推理时从本地加载 |

模型仓库可能更新。AI 应记录实际取得的 revision 和包内摘要；不能把新包称为维护机已验收版本。肥鱼模型、角色资产和上游代码的许可分别适用，公开下载不等于允许再次上传到自己的公开仓库。这里使用原发布方下载地址，不转载权重。

### 已使用的 CPU 关键依赖

这是关键版本表，**不是完整依赖锁文件**。剩余依赖以固定服务的推理依赖清单为基线解析，成功后在本机保存完整冻结清单。

| 组件 | feiyu-tts | feiyu-cover |
| --- | --- | --- |
| torch / torchaudio | `2.8.0+cpu` / `2.8.0+cpu` | `2.11.0+cpu` / `2.11.0+cpu` |
| numpy | `1.26.4` | `2.4.6` |
| transformers | `4.51.3` | `5.13.1` |
| librosa | `0.10.2` | `0.11.0` |
| soundfile | `0.12.1` | `0.14.0` |
| onnxruntime | `1.22.0`，CPU Provider | `1.22.0`，CPU Provider |
| 其他关键项 | `modelscope==1.20.0`、`wetext==0.0.4`、`HyperPyYAML==1.2.3`、`omegaconf==2.3.0`、`pyworld==0.3.4` | `demucs==4.0.1`、`faiss-cpu==1.14.3`、`scipy==1.17.1`、`omegaconf==2.4.0` |
| TTS HTTP 服务 | 维护机使用 `fastapi==0.115.6`、`uvicorn==0.30.0`；还需服务源码导入的 HTTP/表单依赖 | 无需另建翻唱 HTTP 服务，由项目调用本地 Python |

不要直接执行 CosyVoice 原仓库的整份训练 requirements：其中的 Torch、CUDA、训练和加速组件与本指南不一致。固定肥鱼服务提供 `server/runtime_profiles/requirements-tts.txt` 和 `requirements-rvc.txt`，供推理依赖使用。其 `requirements-service.txt` 还递归引用其他功能依赖，可能与上表的 TTS `soundfile` 版本冲突；安装 AI 应先核对并生成本地兼容的推理清单，不能用 `--no-deps` 隐藏冲突或忽略 `pip check`。

## 3. 创建目录并准备依赖

预期布局如下，全部路径从实际工作区生成：

```text
<ProjectRoot>/
  scripts/                               # 仓库已提供的集成入口
  state/maintenance/audio-capabilities/
    feiyu-cover/
      venv/Scripts/python.exe
      source/astrbot_plugin_feiyu_voice-76774b499f7d306454562d56348dd63399b6d7e8/server/
      applio/                            # 固定 Git 源码、兼容层、ContentVec/RMVPE
      models/demucs/955717e8-8726e21a.th
      models/demucs/download.json
      models/FeiyuVoice-RVC/              # 默认声库，可改用能力页上传的模型
      runtime.cpu.json
      cover_demo.py                      # 旧版就绪检测还检查此文件，见第 5 节
    feiyu-tts/
      venv/Scripts/python.exe
      source/                            # 固定 CosyVoice Git 源码及子模块
      models/FeiyuVoice-CosyVoice3/
      runtime.cpu.json
      normalizer.json
      voice-service.json
      service-data/                      # 本机密钥、任务与音频，不提交 Git
```

在实际工作区执行下列环境骨架。运行前先检查目标目录，已存在的 venv 不覆盖。Python launcher 若不可用，可使用检测到的 Python 3.11 完整路径，或用 uv 创建相同位置的环境。

```powershell
$ProjectRoot = (Get-Location).Path
$AudioRoot = Join-Path $ProjectRoot 'state/maintenance/audio-capabilities'
$CoverRoot = Join-Path $AudioRoot 'feiyu-cover'
$TtsRoot = Join-Path $AudioRoot 'feiyu-tts'
New-Item -ItemType Directory -Force -Path $CoverRoot,$TtsRoot | Out-Null
py -3.11 -m venv (Join-Path $CoverRoot 'venv')
py -3.11 -m venv (Join-Path $TtsRoot 'venv')
$CoverPython = Join-Path $CoverRoot 'venv/Scripts/python.exe'
$TtsPython = Join-Path $TtsRoot 'venv/Scripts/python.exe'
& $CoverPython -m pip install 'torch==2.11.0+cpu' 'torchaudio==2.11.0+cpu' --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE -ne 0) { throw 'Cover Torch installation failed' }
& $TtsPython -m pip install 'torch==2.8.0+cpu' 'torchaudio==2.8.0+cpu' --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE -ne 0) { throw 'TTS Torch installation failed' }
```

接着让安装 AI 完成这些依次依赖的步骤：

1. 用 `git -c core.autocrlf=false clone` 获取上表源码，checkout 精确提交；CosyVoice 执行 `git submodule update --init --recursive`。不要移除 `.git`，运行时会检查 HEAD。
2. 从固定服务读取推理依赖清单，结合版本表分别安装两个环境。RVC 还需要 Demucs 和实际导入的依赖；语音服务需要 HTTP 层依赖。安装后分别运行 `python -m pip check`，记录结果和 `pip freeze`。
3. 校验 `server/runtime_compat/source_sha256.json` 后，把 `server/runtime_compat/Applio/` 覆盖到 Applio 工作树；再按 `upstream_assets.json` 下载并校验通用模型。兼容层使工作树出现已知修改是正常的，不能用 reset 抹掉它。
4. 从模型官方来源下载完整包，使用固定服务 `feiyu_runtime.common.verify_package` 校验；保留 manifest、参考音频、索引及所有许可文件。不能只下一个 `.pth` 或 `.pt` 就当作完整默认声库。
5. 将 Demucs 权重放到布局中的位置，并在同目录生成 `download.json`，内容包含上表官方 `url`、完整 `sha256` 和实际 `size`。当前 `scripts/music-cover.py` 会读取并核验这个文件。
6. FFmpeg 安装到当前入口要求的位置，同时验证 `ffmpeg -version`。若用户已有别处的 FFmpeg，应明确处理项目固定路径的兼容性，不能只把 PATH 中有 FFmpeg 当作完成。Git 必须能被 Python 子进程找到；无须为了占位而创建假的 `tools/mingit`。

## 4. 为本机生成运行配置

两份 `runtime.cpu.json` 均应由本机环境生成，不能复制别人的绝对路径或版本号。格式来自固定服务的 `feiyu_runtime/common.py` 和 `scripts/setup_runtime.py`。

| 字段 | TTS | RVC |
| --- | --- | --- |
| schema | `feiyu-runtime-v1` | 同左 |
| engine / backend / host | `tts` / `cpu` / `windows` | `rvc` / `cpu` / `windows` |
| python | 当前 TTS 环境 `sys.executable` | 当前 cover 环境 `sys.executable` |
| repo / commit | 本机 CosyVoice 路径 / 上表提交 | 本机 Applio 路径 / 上表提交 |
| torch_version / torchaudio_version | 从当前环境实际读取，必须匹配基线 | 同左 |
| precision / onnx_provider | `float32` / `CPUExecutionProvider` | 同左；另设 `f0_device: "cpu"` |
| source_sha256 | 用固定服务的 `setup_runtime.source_manifest(repo)` 生成，含子模块 | 叠加已校验兼容层后生成，包含下载的配置文件 |
| settings | 无需 RVC settings | 从 `server/configs/applio_settings.json` 读取，设置 `precision: "fp32"` |

安装 AI 可在本机 `state/` 下生成辅助脚本：把固定服务 `server/scripts` 加入 Python 导入路径，调用 `source_manifest` 生成摘要，最后用 `validate_profile` 与 `verify_repo` 验证配置。先校验源码版本、兼容层和下载资产，不能对未知或损坏文件重新计算摘要来绕过校验。上游 `setup_runtime.py` 的 CLI 只接受 CUDA/ROCm/XPU，**不能虚构 `--backend cpu` 命令**；CPU 配置按上述格式生成。

在 `feiyu-tts/voice-service.json` 创建以下结构；占位内容必须替换为本机绝对路径，用 JSON 序列化器写入，不能手拼 Windows 反斜杠：

```json
{
  "schema": "feiyu-voice-service-v1",
  "data_dir": "<feiyu-tts 下的 service-data 绝对路径>",
  "max_queue": 16,
  "max_upload_mb": 128,
  "tts": {
    "feiyu": {
      "engine": "cosyvoice3_release",
      "package": "<FeiyuVoice-CosyVoice3 模型包绝对路径>",
      "runtime_profile": "<feiyu-tts/runtime.cpu.json 绝对路径>"
    }
  },
  "rvc": {},
  "singing": null
}
```

这里的 TTS 服务只负责说话。唱歌由本项目本地分离/RVC/混音入口完成，不要求另外安装 SoulX-Singer、制作 MIDI 或调用上游 `/v1/singing`。

Windows 文本规范化还需安装 AI 准备可由 `wetext==0.0.4` 使用的本地资源，确认数字、中文短句能正常处理。`feiyu-tts/normalizer.json` 的格式为 `{"directory":"<本机 WeText 资源绝对路径>"}`。该目录的 `verified-files.json` 必须是资源相对文件名到 SHA256 的映射，覆盖实际使用的资源，并在确认下载来源后生成；集成入口 `scripts/feiyu-site/sitecustomize.py` 会按此校验。不要把其他电脑的 AppData 路径写进配置，也不要依赖聊天时临时下载资源。

## 5. 使用项目实际集成入口

| 用途 | 当前入口 |
| --- | --- |
| TTS 服务 | `scripts/feiyu-service.py`，使用固定服务并生成本项目情绪覆盖层 |
| 翻唱编排 | `scripts/music-cover.py` |
| RVC 实际推理 | `scripts/music-rvc-worker.py`，含中文路径的 FAISS 字节读取适配 |
| 模型上传与检查 | 能力页，以及 `scripts/rvc-inspect.py` |
| 可选 ASR | `scripts/local-speech-service.py`，与 TTS 不是同一服务 |

现有 `scripts/music-capabilities.mjs` 的就绪判断还检查 `feiyu-cover/cover_demo.py`，但当前翻唱调用的是 `scripts/music-cover.py`。安装 AI 应检查正在部署的版本：若仍有该检查，可创建调用正式入口的兼容转发脚本 `cover_demo.py`，内容如下。不要把 `music-cover.py` 原样复制到新目录后直接运行，因为其相对路径会改变。

```python
# 保存到 state/maintenance/audio-capabilities/feiyu-cover/cover_demo.py
from pathlib import Path
import runpy

project = Path(__file__).resolve().parents[4]
runpy.run_path(str(project / "scripts/music-cover.py"), run_name="__main__")
```

`rvc_worker_cpu.py` 属于维护机早期实验脚本，当前仓库的正式翻唱链路使用 `scripts/music-rvc-worker.py`。不要从维护机索要整个 state 目录，也不要仅创建几个空文件骗过就绪检查。

先单独启动 TTS 做验证，**不要为测试安装就启动全部微信聊天服务**：

```powershell
# 在实际工作区运行；此命令在前台持续运行，测试结束后 Ctrl+C。
& $TtsPython -B .\scripts\feiyu-service.py
```

另一个终端检查 `http://127.0.0.1:9880/health`，再打开项目控制台，在「能力 → 语音回复」选择「本机肥鱼服务（自动连接）」，检测后生成本地试听。服务首次生成的 API Key 位于 `data_dir/api_key.txt`，项目自动读取，不要求用户复制填写，不打印、不写入文档。通过 `scripts/feiyu-service.py` 启动时会移除继承的 `FEIYU_API_KEY` 环境变量覆盖，避免进程密钥与磁盘凭据不一致；独立部署的其他服务通过高级自定义配置连接。情绪覆盖层依赖固定服务源码；出现版本不匹配时核对提交，不删除完整性检查。

翻唱在能力页选默认肥鱼模型，或上传自己的 `.pth` 和匹配 `.index`。命令行验收可使用完整默认声库目录，替换下面的音源路径，并为每次运行选新输出目录：

```powershell
$InputAudio = '<至少 10 秒的本地 MP3/FLAC/WAV 完整路径>'
$RvcPackage = Join-Path $CoverRoot 'models/FeiyuVoice-RVC'
$TestOutput = Join-Path $ProjectRoot ('state/audio-install-check/cover-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
& $CoverPython -B .\scripts\music-cover.py --input $InputAudio --start 0 --seconds 10 --model $RvcPackage --output $TestOutput --quality enhanced
if ($LASTEXITCODE -ne 0) { throw 'Local cover validation failed' }
```

使用自有 RVC 模型时，先让能力页完成上传与校验，再用生成的 `state/rvc-models/<模型ID>/` 目录作为 `--model`，不要把一个裸 `.pth` 文件当作模型目录传入。

## 6. 验收标准与交付

安装 AI 应依次报告这些结果，不能把模拟测试通过代替真实推理：

1. **依赖**：两个 Python 均可导入其所需模块；`pip check` 无冲突；CPU Torch 和 ONNX Provider 符合配置，Git 提交、源文件和模型摘要核验通过。
2. **语音**：生成一条简短中文试听 WAV，文件可解码且非静音，检查实际采样率与时长；分别测试数字文本和一条情绪表达。情绪可辨程度最终需要用户试听。
3. **翻唱**：10 秒本地输入确实生成原唱人声、伴奏、RVC 人声及最终混音。查看 `result.json`、`rvc/cover_result.json` 和 `faiss_reads.json`，确认实际载入模型/索引，检查非数值、静音与削波；再让用户试听。
4. **页面接入**：能力页显示已准备，能选择模型并生成本地试听。在线歌曲搜索和抖音解析独立验证；网站无可访问音源或 Cookie 过期不等于 RVC 安装失败。
5. **微信发送**：本地生成成功不代表微信已送达。只有用户另行指定测试聊天并授权发送后才测试，并取得实际回执/播放确认。

交付报告应包含项目和环境位置、Python/依赖版本、模型来源与 revision、验证音频的绝对路径、成功/失败项，以及启停方式。完整依赖冻结清单、下载记录、生成配置与测试音频均保存在本机 `state/`，不上传 GitHub。停止单独启动的测试服务；不要改变用户原先停止的自动聊天状态。

### 可选：接收语音与视频

接收语音还需要 ASR，见 [语音输入](VOICE_INPUT.md)。本地路径为 `state/media-runtime/venv` 和 `state/media-runtime/models/whisper-small`，依赖见 `scripts/media-runtime-requirements.txt`；不应把 ASR 模型混入 TTS 模型目录。`scripts/setup-local-speech.mjs` 会安装并启用插件、授权当前白名单聊天，执行前需明确告知用户这些配置变更。

视频/抖音点唱还需要解码和解析依赖，见 [视频点唱](VIDEO_SINGING.md)。视频理解采用采样帧和音轨转写，并非完整连续观看。v0.1.0 已发布安装包不包含其后的所有源码功能，先核对实际版本。

## 7. 常见失败

### 从另一目录迁移时额外检查

整份复制 `state/maintenance/audio-capabilities` 不能保证直接运行。Python venv 不是通用便携环境；优先在新位置重建并按本机冻结清单安装。确需迁移已有环境时，至少核对 `pyvenv.cfg` 的基础解释器位置、TTS 服务配置的 `data_dir/package/runtime_profile`、两份 runtime profile 的 `python/repo`，并实际运行两个解释器与模型验证。

WeText 资源可能在原部署进程的 `%LOCALAPPDATA%` 中，而非项目目录；沙箱或桌面应用可能将该变量重定向。先确认原配置所指目录真实存在，再按来源与 SHA256 校验完整资源，将其放入当前工作区的 `state/media-runtime/wetext/` 并更新 `normalizer.json`。不要猜某个固定用户的 AppData 路径，也不要只迁移 JSON 而遗漏 tagger/verbalizer 等资源。`no frontend is available`、`TTS returned no audio` 应检查规范化组件和上游日志，不能只重复填写 Key。

DSH 插件安装目录变化后，需要验证插件 health 返回的 `projectRoot` 指向当前工作区。DSH 启动时加载的旧插件不会因为目录复制就自动切换；如果 AI 自己运行在 DSH 内，应让用户完成重启后继续，而不是关闭自己的宿主。旧进程返回 401 可能是项目令牌不一致，不是 TTS 密钥错误。

PowerShell 5.1 发送包含中文的 JSON 时，应显式使用 UTF-8 字节，例如把 JSON 文本通过 `[Text.Encoding]::UTF8.GetBytes($JsonText)` 转为请求 body，并声明 `application/json; charset=utf-8`。不要仅根据终端显示正常判断收到的中文正常，更不要把被编码替换成 `?` 的请求用于模型验收。

| 现象 | 检查与处理 |
| --- | --- |
| `FEIYU_LOCAL_RUNTIME_MISSING` | 检查真实数据工作区、固定服务目录和 `voice-service.json`，不要改指向不存在的路径 |
| Torch、NumPy 或依赖解析冲突 | 确认两个独立 Python；按关键版本与推理清单修复，再运行 `pip check` |
| 找不到 FFmpeg / Git | 核对翻唱固定 FFmpeg 路径，以及 Python 子进程实际继承的 PATH |
| `Runtime source commit changed` / 摘要不匹配 | 检查精确提交、子模块、换行格式和经过校验的 Applio 覆盖层，不修改包内校验文件 |
| `FEIYU_NORMALIZER_INTEGRITY_FAILED` | 检查本机 WeText 目录、资源摘要和 `verified-files.json`，不要删除规范化环节 |
| `FEIYU_EMOTION_ADAPTER_VERSION_MISMATCH` | 对照本项目情绪覆盖层需要的固定服务提交，不能直接使用最新分支替换 |
| FAISS 中文路径错误 | 使用仓库正式 `music-rvc-worker.py` 的字节反序列化入口，不改权重或索引 |
| health 成功但语音失败 | 查看 TTS 工作进程、模型完整性和文本规范化，HTTP 存活并不证明推理可用 |
| 已填 Key 仍不可用 | 本机默认服务无需填写；先区分服务未启动、自动凭据缺失、鉴权失败和模型缺失，按「保存并检测服务」返回结果处理 |
| 翻唱提示输入太短 | 选足够长的片段并检查 `--start`，不通过补静音掩盖音源缺失 |
| CPU 很慢或超时 | 从短句和 10 秒片段开始，记录实际耗时；GPU 加速需另行适配，不虚报速度 |
| 视频下载失败 | 检查平台访问条件，或改发本地视频，不能用其他歌曲冒充该片段 |

进一步阅读：[音频运行环境](AUDIO_RUNTIME.md)、[首次使用](QUICK_START.md)、[许可与来源](../LICENSES.md)。
