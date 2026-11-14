# 开发与脚本

## 环境

SDK 由根目录 `global.json` 固定，NuGet 版本由 `Directory.Packages.props` 集中管理。前端使用客户端 `package-lock.json` 与项目内 Node；推荐全局 Node 24 LTS，引导脚本支持 Node 20+。较旧的引导 Node 安装时可能收到 engine 提示，构建、ESLint 与测试使用安装后的项目 Node。

Windows 桌面需要 WebView2。Node 入口会查找 PATH 和标准安装目录中的 PowerShell 7，找不到时使用系统自带的 Windows PowerShell 5.1；不依赖编辑器提供的工具目录，也不要求手工修改 PATH。脚本的执行策略只应用于启动的子进程，不修改用户或系统策略。macOS 需要原生 arm64 Node、对应 SDK、Xcode 和 Homebrew。准备脚本自动准备 MAUI 桌面工作负载；仅 Web 开发使用 `--web` 跳过。Linux 使用 Web 宿主，无需 MAUI。

```sh
npm run setup
node scripts/check.mjs --web
```

`setup` 安装客户端锁定依赖、还原 .NET 工具与项目 NuGet 包，并准备媒体工具和模型。桌面工作负载先通过 .NET 的机器可读清单检查，缺少时才安装当前平台所需项，并跳过自动刷新工作负载清单。`check --install` 先完成同一安装步骤。首次下载需要联网及足够磁盘空间；下载失败时非零退出，未通过校验的 `.partial` 文件不会安装。

`--skip-model` 只跳过 Qwen；`--skip-runtime` 跳过全部媒体运行时和模型；`--web` 跳过桌面工作负载。`node scripts/check.mjs --install --skip-model --require-media` 是 Windows CI 入口：安装媒体工具，并在工具缺失时直接失败，避免跳过真实媒体测试后误报全通过。

## 日常入口

| 命令                             | 行为                                         |
| -------------------------------- | -------------------------------------------- |
| `npm run setup`                  | npm、.NET 工具、桌面工作负载、媒体工具与模型 |
| `npm run setup:runtime`          | 单独准备媒体工具与模型，可加 `--skip-model`  |
| `npm run build`                  | 前端、宿主资源同步与当前平台 .NET 构建       |
| `npm run build -- --web`         | 前端、Web 与测试项目构建，无需 MAUI          |
| `npm run format`                 | CSharpier、根脚本/协作文件和客户端 Prettier  |
| `node scripts/check.mjs`         | 与 CI 相同的完整门禁，包括构建与 Web E2E     |
| `node scripts/check.mjs --web`   | 保留全部测试，但不构建 MAUI                  |
| `npm start`                      | 构建并启动当前平台桌面应用                   |
| `npm run start:web`              | 构建并运行回环 Web 宿主                      |
| `npm start -- --demo`            | 使用隔离演示资料目录                         |
| `npm run test:scripts`           | 脚本回归测试                                 |
| `npm run test:e2e`               | 验证已构建的 Web 宿主，创建临时资料库        |
| `node scripts/sync-branding.mjs` | 从品牌源生成图标与 favicon                   |

脚本根据自身位置定位仓库，不依赖当前工作目录。未知参数立即失败。PowerShell `run.ps1` 是统一启动入口的薄包装；`build-client.ps1` 用于仅构建前端及发布前准备。

`scripts/verify-*.mjs` 是专项验收入口，不等于默认门禁。浏览器类脚本通过参数接收目标调试地址及 Playwright 模块路径，运行前阅读文件开头的参数约定；它们可能操作已启动的资料库，应始终使用演示数据。Apple Silicon 独立验收使用 `node scripts/verify-macos.mjs --check` / `--build` / `--run`，输出至 `.artifacts/`，不自动安装系统工具。

## 运行时与数据

运行时由 `npm run setup` 默认准备。Windows x64 下载固定版本的 FFmpeg 9.0.2、mpv 0.42.0、HandBrakeCLI 1.11.2 和固定提交的 Qwen；安装前检查 SHA-256，保留上游许可证，随后运行工具版本命令。下载缓存位于 `runtime/downloads/`，已校验缓存和模型不会重复下载。安装过程中应关闭正在使用这些工具的 Vroom 实例。

Windows 下载器包含连接超时、低速超时与重试；FFmpeg 使用发布方的 GitHub 镜像和 Gyan 下载站回退，两者校验相同的固定哈希。首次准备需要访问 GitHub / Hugging Face 等下载源；网络受限时可预置同名的官方归档到 `runtime/downloads/`，安装器仍会验证哈希。模型放在 `runtime/models/` 后也必须通过完整哈希校验。

macOS 在已有 Homebrew 的基础上自动安装缺失的 [FFmpeg](https://formulae.brew.sh/formula/ffmpeg)、[mpv](https://formulae.brew.sh/formula/mpv) 和 [HandBrake CLI](https://formulae.brew.sh/formula/handbrake)。Linux 优先使用已有 Homebrew，否则在 Debian/Ubuntu 上通过 apt 安装缺失工具；需要 root 或已授权的无交互 sudo。其他 Linux 发行版需先通过自己的包管理器安装工具。Unix 工具版本由系统包管理器决定，模型仍按固定 SHA-256 校验；实际 macOS/Linux 安装尚需各平台验收。

仓库运行时中建立系统工具的引用，应用不会改写媒体或资料库。独立入口 `npm run setup:runtime` 与完整 setup 使用同一安装逻辑。低层 Windows 脚本仍支持 `-SkipModel` / `-SkipFfmpeg` / `-SkipHandBrake` / `-SkipMpv`。

| 环境变量                                      | 用途                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `VROOM_DATA`                                  | 显式指定资料库目录                                                         |
| `VROOM_RUNTIME`                               | 显式指定媒体工具和模型目录                                                 |
| `VROOM_WEB_URL`                               | 本机调试宿主地址                                                           |
| `VROOM_WEB_TOKEN`                             | 自动化用固定令牌，至少 16 字符；不要提交                                   |
| `VROOM_WEBVIEW_DATA`                          | Windows WebView2 数据目录                                                  |
| `VROOM_TEST_MPV` / `VROOM_TEST_FFMPEG`        | 开启真实解码集成测试的可执行文件绝对路径                                   |
| `VROOM_TEST_HANDBRAKE` / `VROOM_TEST_FFPROBE` | HandBrake 导出集成测试的可执行文件绝对路径，同时需设置 `VROOM_TEST_FFMPEG` |

未设置时，MAUI 使用平台应用数据目录的 `catalog`，Web 使用本机应用数据目录的 `Vroom`。演示模式使用 `artifacts/smoke-data`。备份前退出应用并复制完整资料目录。品牌迁移不自动读取其他应用身份的数据库；原目录与媒体文件保留。

Windows 的 HandBrake 测试优先使用显式测试路径，未设置时查找仓库 `runtime/handbrake/` 与 `runtime/ffmpeg/`。这样可复用已有工具，无需复制运行时或创建目录链接。真实编解码测试只使用临时资料库与合成媒体；缺失工具时会明确跳过。

## 发布与 CI

`powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/publish-windows.ps1` 先检查运行时，再构建到独立临时发布目录；成功后才替换 `artifacts/publish/windows-x64`。失败时保留上次成功产物。可用 `-WithoutModel` 生成不带模型的包。发布包含项目许可证、第三方声明与运行时许可；未实现签名、安装器或自动上传 Release。

CI 使用只读 token、固定 Action 提交与任务超时。Windows 自动安装媒体工具，要求真实编解码测试；跳过大型模型下载。Linux / macOS 使用同一入口（`--web --skip-runtime`），Mac 另编译 Catalyst。`check` 自动发现仓库运行时并设置测试路径，也允许环境变量显式覆盖；原生窗口与移动平台仍需专项验收。Dependabot 按周提出 npm、NuGet 和 Actions 更新 PR，升级前仍需运行全部门禁。

不要为了通过测试修改或重置用户资料库。`.artifacts/` 保存本地日志与测试报告，全部忽略；公开的验收结论只写入文档。
