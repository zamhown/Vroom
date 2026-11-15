# macOS 开发、发布与验收

macOS 使用 Mac Catalyst 原生宿主，业务服务、公开定义、查询、标注投影和 React 界面与 Windows 共用。默认页内播放使用独立的 libmpv 解码进程；不是外置 mpv 窗口，也不把解码库装入主进程。

## 准备与启动

使用原生架构的 Node、`global.json` 固定的 .NET SDK / workload set、Xcode 27.2 和 Homebrew。先完成 Xcode 的首次启动与许可步骤。当前 CI 使用提供相应 SDK 的 [xcode-27 runner](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md)，不会让 `macos-latest` 的默认 Xcode 静默改变工具链。

```sh
npm run setup -- --skip-model
npm start -- --demo
node scripts/check.mjs --require-media
VROOM_REQUIRE_GPU=1 npm run test:scripts
```

需要本地助手时运行 `npm run setup:runtime` 下载并校验默认模型。`--skip-model` 不影响资料库、播放与转换。脚本优先使用项目内 Node；若 `.artifacts/dotnet/dotnet` 存在，也会使用这个项目本地 SDK，不修改全局 .NET 安装。工作负载清单允许本地化提示前缀，并检查锁定的 workload set。

准备脚本安装缺失的 FFmpeg、ffprobe、mpv、HandBrakeCLI，编译进程监督器和解码器；MAUI 构建会自动编译当前架构的 Metal 显示模块及 AppKit 窗口适配模块。开发运行时可以引用 Homebrew，发布包必须内置依赖。应用从 Finder 启动不依赖登录 shell 的 PATH。

`npm run verify:macos -- --check` 检查本机环境。`--build` 增加实际解码、GPU 传递与进程隔离测试，并生成合成媒体、独立资料库和 `launch.command`；`--run` 继续启动该测试实例。输出位于 `.artifacts/macos-playback-*/`，不会清空已有资料库。

## 窗口、数据与播放

- 默认数据目录是 `~/Library/Application Support/Vroom/catalog`；`VROOM_DATA` 仍可覆盖。资源、模型和运行时位于应用包的 `Contents/Resources`，应用移动或升级不改变数据位置。
- 文件与目录选择使用系统文档选择器，返回原媒体路径；不把文件选择器的缓存副本当作媒体。Finder 定位沿用实际文件身份。
- 共享 Modal 打开真正的 WKWebView 子窗口，保留同源 opener 和 React portal。编辑草稿、设置、父页面和播放器不因创建窗口或切换语言而重新挂载；独占窗口暂时阻止所属页面输入。系统关闭请求先交给共享取消与忙碌状态保护；关闭、加载失败及初始化超时回收窗口并恢复输入。窗口生命周期留给 Catalyst，不改写它的 NSWindow 场景层级。窗口宽高按 Catalyst / AppKit 坐标换算，并跟随内容高度。
- 新主窗口在所在屏幕的可用区域居中，子窗口相对所属窗口居中，并避开菜单栏与 Dock。内容展开或收起时保持居中；手动移动或调整尺寸后，自动适配保留位置与顶部边缘。创建时也执行定位，不依赖应用已经激活；重新激活或切换 Spaces 不重新移动窗口。
- macOS WebKit 使用公开的 `inactiveSchedulingPolicy=None`，避免桌面界面进程完全挂起后恢复造成的黑屏等待；外部 mpv 播放不属于 WebKit 自身的媒体播放豁免。主窗口与子窗口共享此设置，切换 Spaces 不重载页面、不重建播放器。原生标题栏仅在创建或外观变化时配置，不在每次激活/失焦时重新设置。该策略不承诺后台动画帧率，也不阻止系统休眠。API 语义见 [WebKit 的公开接口](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKPreferences.h)。
- 关闭主窗口立即停止对应播放会话，应用可继续留在 Dock；重新打开时创建新的页面并恢复工作区。资料库与后台任务只做一次应用级初始化。恢复场景时只保留一个主工作区，不恢复已经失去 opener 的旧对话框；Cmd+Q 退出整个应用并回收子进程。
- 每个播放会话使用一个独立 `vroom-decoder`。libmpv 的公开 OpenGL render API 写入 IOSurface；Mach 消息传递表面权利，主进程的 Metal 层直接采样，再由系统与透明 WKWebView 合成。生产路径没有逐帧 CPU 读回。OpenGL 写入完成、Metal 读取完成后才复用表面。
- 私有传输带版本、尺寸上限及发送用户校验；没有全局可查找的 IOSurface ID。播放命令仍经过原有 schema、影片 ID 校验和受限 JSON IPC；原生模块不读取标签定义，不增加 Agent 特权入口。
- 单击、双击、右键、滚轮、键盘、播放设置和队列继续由共享界面处理。全屏通过薄适配模块调用公开 AppKit 窗口 API。原生解码器的崩溃不加载或损坏主进程中的媒体状态，可在原标签页重试。WebKit 内容进程异常退出时清理旧会话和子窗口，并恢复已持久化的工作区。
- `vroom-process-host` 通过 kqueue 观察宿主退出，回收它拥有的工具进程组，包括 SIGKILL。FFmpeg、HandBrake、mpv 和来源浏览器使用相同的生命周期入口。自行配置的运行时若没有监督器，只有正常关闭时的回收保证。

macOS 页内内核使用随运行时编译的 libmpv；自定义 mpv 可执行文件设置用于外置播放器入口，不替换这个渲染模块的链接库。需要更新内核时重新运行准备脚本、参数测试和打包。

## 可搬移应用包

```sh
npm run publish:macos -- --without-model
```

输出为 `artifacts/publish/macos-<架构>/Vroom.app`、`Vroom.zip`、`SHA256SUMS` 和 `validation.json`。发布先清理当前 Release 构建并在独立暂存目录生成，全部步骤成功后才替换上次成功产物；上一个版本保留在 `.previous-*`，失败暂存目录保留用于诊断。不会删除媒体或资料库。

发布脚本递归复制媒体工具、解码器及动态库，重写为包内相对加载路径，处理动态加载的 MoltenVK driver，核对架构，保存来源哈希与 Homebrew 许可证/配方。LLamaSharp 的 Catalyst 资源单独打包，并在中间目录修复上游库残留的构建机 rpath；不修改 NuGet 缓存。发布审计拒绝包外软链接和非系统绝对依赖。

包内工具在精简 PATH 下实际启动；跨进程 GPU 测试再次使用包内的 FFmpeg 和解码器执行。发布还用独立临时资料库实际启动 Release 应用，不设置开发运行时路径，要求 WKWebView 页面通过桥接完成 bootstrap；空白窗口、启动退出及初始化超时都会阻止发布。没有 GPU 的 CI 虚拟机明确跳过 GPU 验收，`validation.json` 不标记为通过；设置 `VROOM_REQUIRE_GPU=1` 则必须执行成功。自动测试不能替代原生窗口的视觉验收。

Catalyst 保留 Apple 的链接处理流程，并通过 `MtouchLink=None` 保留所有程序集中的反射合同和 Objective-C 入口。当前 SDK 中单设 `TrimMode=copy` 仅控制框架程序集，不能保证应用代码不被裁剪；Release 冷启动检查覆盖这个区别。

源码的 Catalyst API 下限对应 macOS 14；**具体发布包的最低系统由所有内置 Mach-O 依赖决定**，写入 `Info.plist` 和 `validation.json`。例如在新系统本地编译的 Homebrew 库可能抬高下限。不能把只在新系统生成的二进制声称为兼容旧系统；支持更早系统需要用相应部署下限的依赖重新构建和验收。

## 签名与公证

默认产物使用 ad-hoc 签名，适合本机开发验证。正式分发使用已有的 Developer ID Application 证书和 `notarytool` Keychain profile：

```sh
export VROOM_CODESIGN_IDENTITY='Developer ID Application: Your Name (TEAMID)'
export VROOM_NOTARY_PROFILE='vroom-notary'
npm run publish:macos -- --sign --notarize
```

流程从内到外签名，验证完整性，向 Apple 提交公证，staple、验证 ticket，并运行 Gatekeeper assessment，最后重新生成 ZIP 和哈希。密码、证书私钥和公证令牌不写入仓库或发布报告。直接分发使用非 App Sandbox 的 Catalyst 应用，保留系统文件授权；没有关闭签名验证或 Gatekeeper 的安装步骤。

`.github/workflows/macos-release.yml` 提供手动发布入口，使用带 `vroom-signing` 标签的受信任 Mac runner 和 `macos-release` environment。runner 需预先安装签名身份与 Keychain profile；配置同名 environment variables。该入口运行完整门禁并强制真实 GPU 验收，上传签名包供下载，不自动创建公开 Release，也不在签名 runner 上运行 PR。

## 当前验收边界

2026-11-14 在 Apple Silicon / macOS 27.2 / Xcode 27.2 上完成了原生构建、系统文件选择和原路径导入、共享播放页、VideoToolbox 解码、全屏进出与原生设置窗口检查。合成媒体的双进程 GPU 测试覆盖真实像素变化、方向与通道、尺寸变化、挂起/杀死一个解码器后另一个继续播放和 seek；进程监督器覆盖宿主异常退出。真实 HandBrake 导出测试使用临时资料库执行四种容器及冲突检查。

仍需单独记录 Intel 实机、HDR/广色域、多显示器跨屏与不同系统版本的验收，不能由 Apple Silicon 的成功结果推断。当前机器没有 Developer ID 签名身份，尚未执行 Apple 公证；默认 Qwen 权重下载受网络限制，不能把原生依赖已打包写成助手推理已验收。具体门禁和后续测量结果见 [验证记录](VALIDATION.md)。

使用的接口依据：[libmpv render API](https://github.com/mpv-player/mpv-examples/tree/master/libmpv)、[IOSurface Mach port](<https://developer.apple.com/documentation/IOSurface/IOSurfaceCreateMachPort(_:)>)、[Apple 跨 GPU 上下文同步](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/OpenCL_MacProgGuide/SynchronizingIOSurfacesAcrossProcessors/SynchronizingIOSurfacesAcrossProcessors.html)、[MAUI 外部分发](https://learn.microsoft.com/en-us/dotnet/maui/mac-catalyst/deployment/publish-outside-app-store?view=net-maui-10.0)。

## 2026-11-14 原生对话框闪退修复

16:11:37 与 16:11:49 的两份系统崩溃报告均落在 `MacDialogWindows.DidReceiveScriptMessage` → `AttachWindow`。统一日志确认是 `System.ExecutionEngineException`：捕获实例的关闭 lambda 需要生成 native-to-managed 包装，而 Release 为 AOT-only，导致 SIGABRT。

关闭回调现使用静态方法、`MonoPInvokeCallback` 标记及静态委托保活，按全进程唯一窗口 token 查找弱引用宿主；关闭时先撤销 token，迟到回调无操作。回调内异常写入本机诊断，不跨越原生边界传播。遵循 [Microsoft 的 AOT 回调约束](https://learn.microsoft.com/en-us/dotnet/api/objcruntime.monopinvokecallbackattribute?view=net-ios-26.5-10.0)，没有开启 JIT 或放宽签名权限。

16 项 DialogWindowTests 与本次文件格式、仓库检查通过；这些普通 .NET 测试不覆盖 Catalyst 回调生成，必须另验 Release 原生窗口。

本次 Release 发布成功：签名/包内依赖审计、隔离资料库冷启动、真实 GPU 解码器测试通过，产物为 `artifacts/publish/macos-arm64/Vroom.app`。AOT 汇编已包含 `wrapper_native_to_managed_Vroom_App_MacDialogWindows_OnCloseRequest_ulong`。

实机成功打开“添加影片”独立窗口，未复现两份报告中的异常。点击系统关闭按钮后，自动化接口持续读取超时；进程仍存活，主线程采样在正常事件等待中，无新增 Vroom 崩溃报告。后续前台复验已通过：日志记录原生窗口 ownership attached=True，点击系统关闭按钮返回主窗口；再连续执行系统关闭、窗口内取消、系统关闭三轮，每轮均恢复主窗口且可再次打开。整个过程保持同一 PID 59733，无新增崩溃报告。此前自动化超时保留为历史观察，不再列为待验收项。证据在 `.artifacts/crash-fix-20261114/window-cycles.json`。未修改或重置资料库、媒体文件；此次启动显示的实际默认资料库路径为 `~/Documents/.config/Vroom/catalog`，与此前文档假设的 Application Support 路径不同。
