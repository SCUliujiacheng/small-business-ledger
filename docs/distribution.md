# 下载版的运行方式

下载版不要求使用者安装 Python、Node 或开发工具。程序和账目分开放：更新程序不能覆盖账本，卸载前仍应手动导出备份。

## 三个平台

- Windows：64 位便携 ZIP，解压后启动；包含 Python 和已构建界面，打开本机浏览器记账。
- macOS：Apple Silicon 和 Intel 分别提供 `.app` ZIP，在对应机器上构建、启动验证。
- Android：直接安装的 APK，包含 Python 与界面，在应用内离线运行；数据在应用私有目录，卸载会删除，更新保留。

桌面版使用已有 FastAPI 接口。Android 只替换 HTTP 传输层，金额、余额、CSV、JSON 恢复、幂等、SQLite 事务和自动备份继续调用同一套 Python 业务函数。两种传输层要用相同输入做契约测试。

手机中的本机端口也需要认证。每次启动生成新的随机会话，原生界面通过 HttpOnly cookie 访问，只允许本次回环地址；不开放局域网服务，也不加载外部网页。导入和导出使用系统文件选择器，不索取整个存储空间的权限。Android 版本禁用系统自动云备份，用户可主动导出。

## 发布检查

发布流水线分别在 Windows、macOS 和 Android 构建环境运行。桌面程序需要脱离源码目录启动通过；Android 需要在模拟器安装并验证本机服务、界面与数据持久化。所有附件提供 SHA-256 校验文件，构建与源码提交对应。

Android 使用仓库外保管的持久发布签名，后续更新不更换密钥。Windows 代码签名和 Apple Developer ID / 公证需要相应证书，不能把未签名版本称作已认证应用。首批跨平台下载作为预览版，说明已测试的平台与尚未验证的设备。

## 另外两个项目

RAG 与 Agent Reliability Lab 的中英文仓库也提供同样的下载入口。桌面版保留原运行引擎；Android 使用标准库离线实现，单独标注移动版来源，并验证固定语料检索或六个故障场景的关键结果。它们不能冒用桌面完整基准的版本标识，也不能宣称带有未打包的模型、外部服务或多进程保证。

打包依据：[PyInstaller 的平台构建要求](https://pyinstaller.org/en/stable/usage.html)、[Chaquopy 的 Python 和 Android 支持范围](https://chaquo.com/chaquopy/doc/current/android.html)。
