# 发布流程

仓库：[wuxiaojiuya/WeChatAgent](https://github.com/wuxiaojiuya/WeChatAgent)。首版 v0.1.0。

```powershell
npm ci
npm --prefix packages/dsh-social-bridge-plugin ci
npm run source:check
npm run installer:runtime
npm run installer:build
npm run source:build
```

打包使用本地 components/supplier-hook/4.1.8.27 中与清单一致的 DLL 和加载器，不使用旧 native Hook，不包含个人配置或微信客户端。Git 源码不提交第三方二进制。

构建产物位于 release/installer/。推送 main 和版本标签，再将安装包、源码 ZIP、Hook ZIP、SHA256SUMS.txt、VERIFICATION.json 发布到正式 Release。

安装包命名必须保持 WeChatAgent-Setup-版本-x64.exe。检查更新的仓库在 scripts/update-check.mjs。仅提交代码不会触发更新；匿名客户端不能访问私有 Release，不要内置 GitHub 访问令牌。

发布前执行隐私扫描和相关测试，核对 SHA256；排除 state/、API Key、聊天、歌曲、模型和 Cookie。
