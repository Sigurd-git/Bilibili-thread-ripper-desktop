# BTR Desktop

为官方哔哩哔哩 **macOS 和 Windows 客户端**增加多线程视频下载。保留官方播放器、登录、字幕、弹幕和快捷键。

当前版本 **2026.9.29.1-d2**。macOS 已在 Apple Silicon、官方客户端 **1.19.0 / Electron 22.3.27** 实测。Windows 保留原有安装、更新、卸载和监视程序，已配置 Windows CI 回归；本次修改的 Windows 实机播放尚未验证。

## macOS 安装

先安装并启动过官方哔哩哔哩客户端。下载本项目的 macOS 或双平台安装包并解压，在 `BTR_Desktop` 目录运行：

```bash
bash install.sh install
```

开发者也可以直接使用已构建的仓库：

```bash
git clone https://github.com/Sigurd-git/Bilibili-thread-ripper-desktop.git
cd Bilibili-thread-ripper-desktop
bash install.sh install
```

安装器默认读取 `/Applications/哔哩哔哩.app`，生成独立的 `~/Applications/Bilibili BTR.app`。先完全退出官方客户端，再打开 BTR 副本；两个客户端使用同一份官方账号和个人数据。无需 `sudo`，也无需另外安装 Node：没有 Node 时使用官方客户端自带的 Electron 运行时。

应用装在其他位置时，传入完整路径；BTR 副本必须与官方源应用分开：

```bash
bash install.sh install --source '/Applications/哔哩哔哩.app' --client "$HOME/Applications/Bilibili BTR.app"
```

安装器保存完整原始应用备份，在暂存副本中接入 BTR，更新 `Info.plist` 的 ASAR header hash，再为副本和嵌套可执行文件作本地签名，保留各自已有的 entitlements 和运行时标志。通过 `codesign --verify --deep --strict` 后才替换目标。官方原版保持厂商签名；保留它作为后续维护的运行环境。

macOS 维护文件、记录和原始备份保存在 `~/Library/Application Support/BTR_Desktop`。维护代码复制到独立的版本目录，移动或删除仓库不会影响已安装副本的卸载。日志保存在其中的 `logs` 文件夹。

## Windows 安装

先安装官方哔哩哔哩 Windows 客户端，打开普通 PowerShell，执行：

```powershell
irm https://raw.githubusercontent.com/Sigurd-git/Bilibili-thread-ripper-desktop/main/install.ps1 | iex
```

不要以管理员身份打开 PowerShell；写入受保护的安装目录时，安装器会单独请求系统授权。客户端不在默认的 `C:\Program Files\bilibili` 时，脚本会从安装记录和注册表查找，或让你输入安装目录。

Windows 必须使用包含 `win32` 的双平台安装包；仅在 Mac 构建的包会被 Windows 安装器拒绝，避免误装不含 `.exe` 的包。遇到旧更新器异常，可运行：

```powershell
irm https://raw.githubusercontent.com/Sigurd-git/Bilibili-thread-ripper-desktop/main/force-update.ps1 | iex
```

Windows 维护日志保存在 `%LOCALAPPDATA%\BTR_Desktop\logs`。官方覆盖安装后，现有 BTR Guard 仍能询问是否重新接入；macOS 在官方源升级后重新运行 `bash install.sh install`，即可从新源重新生成副本。

## 播放设置

系统设置第一项是“线程撕裂者”。原生播放器的“齿轮 → 更多播放设置”也提供 CDN 与线程数，两处设置会同步。

- CDN 可选大陆、海外、自定义。自定义只接受 B 站视频服务器，最多 32 个；未选择服务器时按大陆模式处理。
- 自动线程数默认开启，按播放与缓冲状态在 8 至 32 之间调节；手动模式可选择 4 至 128。
- CDN 或线程数在下一次下载请求生效。加速失败交回客户端自身下载；连续失败时暂停当前窗口的加速。
- “显示错误”和 Debug 默认关闭，可在排查时开启。
- 直播加速目前尚未实现，界面显示禁用状态。

![系统设置](docs/images/system-settings.png)

![播放器设置](docs/images/player-settings.png)

网络和 CDN 状态仍会影响缓冲。真实播放验证记录和测试范围见 [docs/verification.md](docs/verification.md)。

## 更新和还原

系统设置中的“检查 BTR 更新”和“卸载 BTR”均使用可信的本地维护代码。自动更新仍需确认。更新只读取本 fork 的 `latest.json`，校验下载来源、平台和整个 ZIP 的 SHA-256；macOS 还会验证 ZIP 路径、文件大小、CRC 和符号链接。Windows 旧版不带 `platforms` 的清单仍可使用，macOS 要求清单明确包含 `darwin`。

macOS 卸载会在退出后完整恢复副本的官方资源和原始签名，再重新打开。也可以完全退出 BTR 副本后手动操作：

```bash
bash install.sh status
bash install.sh remove
```

如果使用了自定义 `--client`，维护时仍需传入相同路径。卸载后保留已恢复的副本、原始备份和用户数据，可以再次安装；手动删除副本后也可以重新运行安装命令重建。macOS 暂不提供独立的原生维护进度窗口，详细结果保存在维护日志。

Windows 仍可从设置卸载，或完全退出后在安装目录执行 `BTR_Desktop.exe remove`。两个平台的卸载均不访问 GitHub。

## 开发和验证

开发工具使用 **Node.js 22 或更高版本**；已安装客户端中的维护代码兼容 Electron 自带的 Node 16。

```bash
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

浏览器测试默认使用 Playwright Chromium；可通过 `BTR_BROWSER_EXECUTABLE_PATH` 指定本机 Chrome。`npm test` 包含 macOS 的原生签名与还原 fixture、跨进程锁测试和 Windows 平台模拟；依赖 Windows PowerShell/.NET 的实机维护用例只在 Windows 运行。macOS 可用 `npm run test:native` 单独运行原生测试。

修改版本时同步 `desktop.json` 和 `package.json`，再运行 `npm run release`。Windows 会编译并校验当前 C# launcher/guard 后生成双平台 ZIP；macOS 跳过 Windows 编译，生成仅支持 macOS 的 ZIP。发布双平台版本应采用 Windows 构建的安装包和对应清单。

`.github/workflows/ci.yml` 为 macOS/Windows 分别构建并测试，上传可审阅的安装包，不自动发布。发布前将匹配的源码、`dist`、`packages` 和 `latest.json` 一起提交；本地生成文件不会自动上传到 GitHub。

`tools/inspect-client.cjs`、`measure-client.cjs` 和 `sample-client.cjs` 仅用于本地开发诊断，读取手动开启的 `127.0.0.1:19391` 调试端口。正常启动不会开启调试端口。

[平台与更新接口](docs/update-interface.md) · [验证记录](docs/verification.md) · [与浏览器版的差异](difference.md)
