# 图片接收与识图

当前仅使用微信 **4.1.8.27 内置 Hook**。图片身份和下载字段来自 Hook 回调与项目消息缓存；不读取微信客户端数据库、不扫描微信账号目录、不抓取数据库密钥。接入流程见 [Hook 接入](SUPPLIER_HOOK_41827.md)。

## 普通图片

`scripts/hook-receiver.py` 接收回调，`hook_receiver_core.py` 核对消息类型、来源、聊天授权和完整身份。图片 XML 提供 CDN 标识、AES 字段与长度，兼容 `cdnmidimgurl_size`、`length`、`hevc_mid_size`。重复回调不能替换原消息的下载标识。

优先调用 Hook 的 `/api/cdn_download`，依次兼容 `imgType: 2` 和 `3`。CDN 不可用时，只有原消息具备绑定当前项目连接和会话的短 `msgId`，才使用 `/api/download_img`；不会截断 64 位 `newMsgId` 作为短 ID，也不查询数据库补齐字段。

下载写入 Hook 自身 ASCII 运行目录中的独立 `.part` 文件。代码等待大小和修改时间稳定，检查文件头、解码、大小及像素限制，再次核对资源归属与聊天权限后保存。HTTP 成功不代表文件已经写完；密文长度不直接当作解密后长度。WXGF 普通照片通过有时限的单帧解码处理。

接收服务返回带会话绑定和 SHA-256 校验的图片数据。DSH 插件保存为原生附件，提交给支持图片输入的模型，无需模型读取本地路径。SSE / OneBot 只携带图片引用，不向模型提供下载地址、AES 字段、令牌或本机路径。

只出现 `[图片]` 或“未提供画面”表示没有成功提供画面；模型不能据此猜测。图片回复与绘画发送是独立能力，不能通过一条文字占位证明已经识图或发图。

## 表情包

类型 `47` 及受支持的表情卡片使用相同的消息绑定链路。优先使用项目已收录的表情资源；`wechat.media.allowStickerCdn` 为 `true` 时可下载原消息自带的腾讯 `wxapp.tc.qq.com` 或 `vweixinf.tc.qq.com` 地址。不会扫描微信表情数据库或账号缓存目录。

回源强制 HTTPS、不使用环境代理、禁止重定向，原始字节上限 8 MiB、总期限 20 秒；解密结果必须与原消息 MD5 相符。不使用任意 URL、聊天文本中的链接或模型指定路径。

`wechat.media.allowStickerCdnAlias` 默认关闭。启用后仅将旧 `vweixinf.tc.qq.com` 主机映射到腾讯 `wxapp.tc.qq.com`，保留原路径和查询，继续验证 TLS 和 MD5。

GIF 最多解码 32 帧并受总像素限制，最多选三帧形成拼图。WXGF 使用 `imageio-ffmpeg`，最多处理 24 帧、12 秒并采样三张画面。模型看到的是采样画面。

## 引用、追问与失败

引用图片需要同一聊天的原消息已被项目缓存。回调内嵌的引用文字可直接使用；附件身份缺失时明确报错，不查询微信历史或用其他聊天的图片替代。

收到“这张图是什么”等追问时，可关联同一聊天、同一发言人最近十分钟且在最后二十条消息内的普通图片。新图片和明确引用优先；其他附件、分享链接或其他群成员的图片会阻断向更早图片回退。过期或项目未接收的图片需重新发送。

附件准备失败时，Bridge 可用一次明确标记“没有提供图片”的文字输入继续处理；会话绑定、完整性或模型轮次错误不通过此方式重试。不会因为一张图无法取得就声称已经看过它。

每批最多四张图片；普通图片最长边最多 2048 像素，表情拼图最多 1280 像素，每张传输上限 768 KiB。图片准备共用 75 秒期限。完成后通过 DSH 原生 `image/offload` 事件释放图像输入，避免普通聊天持续提交历史画面。

## 安装与排查

安装包内置媒体依赖；源码安装使用 `scripts/hook-requirements.txt`。`python -B scripts/hook-receiver.py --check-runtime` 仅验证导入和运行环境，不读取微信账号或媒体内容。

DSH 需要支持图片输入的模型，以及可用的原生附件服务。`MODEL_IMAGE_INPUT_UNSUPPORTED` 表示模型不支持图像，`NATIVE_IMAGE_SERVICES_UNAVAILABLE` 表示缺少 DSH 服务。`IMAGE_MESSAGE_IDENTITY_NOT_FOUND` 表示项目缓存里没有完整原消息；表情的 `IMAGE_STICKER_LOCAL_COPY_UNAVAILABLE` 表示项目没有可用资源且未允许 CDN 回源，`IMAGE_STICKER_CONTENT_MISMATCH` 表示摘要不符。

日志位于 `state/logs/`，图片索引和处理缓存位于 `state/media/`。这些都是项目私有数据。状态接口 `/api/v1/receiver/status` 标明 `messageSource: supplier-callback`、`historySource: project-cache`、`wechatDatabaseAccess: false`。

修改 Python 接收代码后重载项目接收服务；修改 DSH 插件代码后按页面提示重载插件。日常设置保存后供后续消息使用，不因图片配置要求重开微信。维护重试接口只处理项目已登记的完整入站身份，不补查微信历史。

当前自动化覆盖模拟 Hook 图片/语音/视频回调、专用下载、项目缓存、会话权限、解码与错误处理；本次移除数据库链路没有向微信联系人自动发送测试消息。
