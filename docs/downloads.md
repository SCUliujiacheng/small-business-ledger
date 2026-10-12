# 下载小本账

下载版包含运行环境，不用安装 Python 或 Node。解压或安装后即可离线记账。

| 设备 | Release 附件 |
| --- | --- |
| Windows 10/11，64 位 | `small-business-ledger-0.3.0-windows-x64.zip` |
| Mac，Apple Silicon（M 系列） | `small-business-ledger-0.3.0-macos-arm64.zip` |
| Mac，Intel | `small-business-ledger-0.3.0-macos-x64.zip` |
| Android 7 及以上，64 位 ARM / x86 | `small-business-ledger-0.3.0-android.apk` |

Mac 构建环境为 macOS 15；更早的系统未验证。32 位 Windows / Android 不在本次支持范围。

## 安装与退出

- Windows：把整个 ZIP 解压到一个文件夹，双击 `small-business-ledger.exe`，不要只移动这个 exe。
- Mac：解压，打开 `small-business-ledger.app`。选与芯片匹配的文件。
- Android：下载 APK，通过系统安装界面安装。只在信任此仓库的情况下，允许你使用的下载应用安装这一 APK。
- 桌面会打开本机启动页，点“打开应用”开始使用，结束时回到启动页点“退出程序”。关闭记账标签页不会停止后台服务。

这批是预览下载版。Windows 暂无发行商代码签名，macOS 只有本地 ad-hoc 签名，未做 Apple Developer ID 公证，系统可能拦截。先核对下载来源和 SHA-256；不要为运行它关闭整个系统的安全保护。公司受管设备请遵守管理员的安装策略。

## 账本在哪里

- Windows：`%LOCALAPPDATA%\small-business-ledger\ledger.db`
- Mac：`~/Library/Application Support/small-business-ledger/ledger.db`
- Android：应用私有目录，不自动上传，也不参加 Android 系统云备份或换机迁移；换手机时请手动导出、恢复备份。

下载版与以前源码版默认使用不同目录。旧账本请先在旧版下载完整 JSON，在下载版的空账本中恢复；不要把 SQLite 文件放进安装目录。更新前先下载一次完整 JSON。桌面替换程序文件、Android 用同签名 APK 覆盖安装，都保留用户数据；**卸载 Android 会删除手机账本和本机快照**。

手机复用桌面的金额、校验、事务、自动快照和备份恢复逻辑。手机文件导入上限 16 MiB（CSV 仍为 2 MiB / 2,000 行）。超过 16 MiB 的 JSON 备份，包括手机自己导出的备份，都不能在手机恢复，请转到桌面恢复、核对后继续使用。导出成功不代表该文件大小适合手机导入；卸载前请检查备份大小并验证能否恢复。备份未加密，请妥善保管。

## 校验和测试范围

同一 Release 的 `SHA256SUMS.txt` 给出每个安装附件的 SHA-256，`build-manifest.json` 记录源码提交、版本与文件大小。Windows 可用 `Get-FileHash 文件名 -Algorithm SHA256`；Mac 可用 `shasum -a 256 文件名`。

发布流水线会在各自系统启动打包程序，检查页面、接口和本机访问限制；Android 在 x86_64 模拟器测试实际 Python/WebView、数据保存及签名安装。尚不能替代不同厂商 ARM 手机、低内存设备和桌面系统警告流程的实机验证。遇到异常请附系统版本、应用版本和复现步骤，不要把真实账目传到公开 Issue。
