# Vroom 2.0 迁移说明

## 框架与前端

2026-11-01 检查本机安装的 SDK：8.0.201、9.0.203、10.0.403；选择最新的 10.0.403。实际使用其 `dotnet new maui` 创建新模板，迁入 Vroom 的应用标识、图标和领域服务。MAUI 为工作负载提供的 10.0.110，XAML 使用 SourceGen；Windows RID 从 `win10-x64` 更新为 `win-x64`。Mac Catalyst 最低版本按新模板为 17.0。

删除 Blazor / Razor 共享前端，改为 `Vroom.Client`：React 19.3.1、Semi Design 2.104.0、Video.js 8.24.2。MAUI 仅保留原生启动、窗口、目录选择和 HybridWebView。构建后的静态文件同步到 `Vroom.App/Resources/Raw/wwwroot` 与 `Vroom.Web/wwwroot`；没有 CDN 运行时依赖。播放器代码按需加载。

JavaScript 使用带请求 ID 的原始消息与 C# `ClientApi` 通信；支持并发响应和 Unicode 大参数，避免依赖反射调用端点。Windows 按 MAUI 10.0.110 的原始传输协议双向 URI 编解码，保留百分号和 NUL；WKWebView、Android 使用对应消息通道。调试 Web 宿主通过带专用请求头的本机 HTTP API 调用同一个 ClientApi。所有业务校验仍由 Core 完成，文件路径不会交给浏览器直接打开。

## 标签页语义

Semi Tabs 启用 `keepDOM`、`lazyRender`，以稳定 ID 保存每个视图。首次访问挂载，切换后保持组件和 DOM；关闭才卸载。影片详情、播放器、去重复核、管理页、助手均独立打开。复制影片视图会产生新 ID，可独立修改筛选、排序、分页和滚动位置。

可序列化状态保存在 SQLite 的 `workspace.v2` 设置中，包括草稿、队列、标注编辑内容和去重选择。常规更新合并写入，退出时尽力补写；异常退出时恢复最后一次持久化状态。带未保存修改的标签页关闭前有提示。字幕文件对象、正在打开的系统对话框和浏览器全屏状态不跨进程恢复。

隐藏播放标签页会暂停音视频，保留播放器实例、位置、速度和标注状态；回到标签页后手动继续，避免多路音频叠加。关闭播放页释放该页的流会话，任务历史仍在。HLS 缓存闲置三分钟回收，重新打开时从影片位置重建。

## 任务记录与恢复

`background_jobs` 保存完整任务快照；`job_events` 保存状态变迁。新任务先落库再执行，UI 不拥有扫描或推理的取消令牌。完成、失败、取消和中断记录均不自动裁剪；任务中心按页检索。运行时最多三个普通任务和两个独立转码会话。

| 状态/能力 | 行为 |
| --- | --- |
| 暂停 | 扫描、批量补全支持。先显示“等待暂停”，当前 I/O 返回并到达检查点后显示“已暂停” |
| 继续 | 当前进程从检查点继续，保留已完成计数 |
| 停止 | 向队列、媒体进程、HTTP 和推理传递取消；已提交的资料保留；NAS 内核 I/O 阻塞时显示“正在停止”并等待返回 |
| 应用退出或崩溃 | 运行/排队/停止中任务在下次初始化标为“意外中断”，保留参数、进度、错误、结果与历史 |
| 重试/恢复 | 可重入任务沿用原 ID，增加执行次数，重新执行幂等步骤；不是任意机器指令的续跑 |
| 不可重放 | 有副作用的 Agent 执行和临时转码流不自动重放；从原功能重新发起，避免重复修改或恢复过期 URL |
| 单实例 | `tasks.lock` 独占资料目录；第二个实例明确拒绝启动任务服务，不修改第一个实例的任务状态 |

纳入中心的任务：影片库扫描、媒体探测、预览帧、单部/批量资料补全、去重检查、本地模型规划、Agent 执行、FFmpeg 转码。Agent 工具目录新增任务查询、暂停、恢复，合计 36 项。

旧数据库只增加表和 schema version，不重建影片、标签、视图或标注。旧版本的内存任务没有可迁移的记录；从 v2 发起的任务开始永久留档。正式目录和应用标识维持不变；运行升级前退出旧客户端，备份整个资料目录。

## 播放器

采用成熟的 Video.js 8 播放器及其 VHS HLS 引擎，关闭浏览器原生 controls。提供自定义控制栏、倍速、快进退、音量、全屏、画中画、字幕菜单；外部工作区提供全片时间轴、帧步进、帧预览、A–B 循环、影片/帧/区间标签和临时播放队列。

原文件走 Range；不受 WebView 编解码器支持的内容通过 FFmpeg 转为 H.264/AAC HLS。全片跳转落在当前缓冲之外时重建流；当前缓冲内直接定位。Semi Slider 的受控更新也触发 `onAfterChange`，因此只允许真实用户手势触发 seek，避免播放进度刷新反复重启转码。

帧步进依据 FFprobe 平均帧率；变帧率内容应以时间戳为准。专业控制界面不等同于无损剪辑或逐帧解码器，原文件和浏览器解码能力仍决定精度。

## 构建与发布

```powershell
pwsh ./scripts/build-client.ps1 -Install
npm --prefix src/Vroom.Client test
dotnet test tests/Vroom.Tests
pwsh ./scripts/run.ps1
pwsh ./scripts/publish-windows.ps1
```

Node 24.22.2 作为项目开发依赖下载，不替换机器上的 Node 20。新发布目录为 `artifacts/publish/windows-v2`，保留旧发布目录。复制使用时必须保留整个目录，包括运行时、静态资源、FFmpeg、模型与许可。

Windows 与 Android 的 MAUI 10 构建已验证。Android 的 FFmpeg 子进程及 llama.cpp 后端仍沿用上一版的平台边界：尚未移植，不应将 Android 可编译误认为完整移动版可用。Apple 目标需要 Mac/Xcode 实机验收。

依据：[Microsoft HybridWebView](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/hybridwebview?view=net-maui-10.0)、[Semi Tabs](https://semi.design/en-US/navigation/tabs)、[Video.js React 指南](https://legacy.videojs.org/guides/react/)。
