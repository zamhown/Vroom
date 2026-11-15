<p align="center"><img src="resources/branding/vroom.svg" width="88" height="88" alt="Vroom" /></p>

# Vroom

私人视频资料馆。使用 .NET MAUI、React / Adobe React Spectrum、SQLite 与 FFmpeg，提供本地影片管理、播放、声明式标签、批量处理与本地助手。

[![CI](https://github.com/zamhown/Vroom/actions/workflows/ci.yml/badge.svg)](https://github.com/zamhown/Vroom/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-white.svg)](LICENSE)

**项目尚未发布。** Windows 与 macOS 使用原生桌面宿主；macOS 已接入页内隔离播放和完整打包入口，实机范围与发布边界见 [macOS 指南](docs/MACOS.md)。Android / iOS 为实验性目标，Linux 可运行本机 Web 宿主。源码仓库不包含媒体、资料库、模型或运行时二进制。

## 快速开始

安装 Git、Node.js（建议 24 LTS；引导脚本支持 20+）与 `global.json` 指定的 .NET SDK。Windows 还需要 WebView2；准备脚本兼容系统自带的 Windows PowerShell 5.1，无需另外安装 PowerShell 7。MAUI 工作负载由准备脚本自动准备。

```powershell
git clone https://github.com/zamhown/Vroom.git
cd Vroom
npm run setup

# Windows 桌面
npm start

# 或本机 Web 宿主（默认 http://127.0.0.1:5248）
npm run start:web
```

Web 宿主输出带 `?token=` 的访问地址，先用该地址建立会话。不要将令牌写入提交或问题报告。添加影片库时选择媒体所在目录；索引与媒体文件分开保存。

`npm run setup` 一次完成锁定 npm 依赖、.NET 工具、桌面工作负载与媒体运行时准备，默认下载 FFmpeg、ffprobe、mpv、HandBrakeCLI 和 Qwen 模型。Windows 下载使用固定版本与 SHA-256 校验，缓存保存在被 Git 忽略的 `runtime/`；重复执行复用已校验的下载。

不需要本地模型时使用 `npm run setup -- --skip-model`；仅开发 Web 时可加 `--web` 跳过 MAUI；已自行管理媒体工具时可加 `--skip-runtime`。也可用 `npm run setup:runtime` 单独补齐运行时。项目内 Node 不修改全局安装。macOS / Linux 安装与平台边界见 [开发指南](docs/DEVELOPMENT.md)。

## 能力与设计

- 本地多路径影片库、后台扫描、缩略图、元数据来源与候选确认。
- 原文件与 HLS 播放、字幕、断点、队列和原生 mpv 接入；不同平台能力见开发指南。
- 字段、枚举实体、界面布局、查询、去重与补全由公开版本化定义驱动。
- 用户定义独立覆盖系统层；变更预览、并发检查、历史与无效标注诊断共用有效投影。
- 多标签工作区与持久任务中心，支持批量操作的冻结目标、重试和取消。
- 本地 Qwen 助手发现公开 schema，通过正常审核与审计命令执行操作。小模型不能保证理解所有复杂指令。

## 仓库结构

```text
.config/                .NET 本地工具清单
.github/                CI、依赖更新、Issue / PR 模板
docs/                   架构、开发、设计、国际化、第三方许可
resources/branding/     品牌 SVG 源文件
resources/localization/ 界面 ICU 语言包
resources/tagging/      公开 schema、默认定义与 Agent 知识
scripts/                安装、构建、检查、启动、发布与验收
src/Vroom.App/          MAUI 原生宿主
src/Vroom.Client/       React 共享界面与前端测试
src/Vroom.Core/         应用服务、存储、媒体与标签引擎
src/Vroom.Web/          仅本机调试宿主
tests/Vroom.Tests/      .NET 测试与契约夹具
tools/Vroom.Smoke/      使用合成媒体的端到端验收
Vroom.sln               .NET 解决方案
```

## 开发与验证

```powershell
npm run format
node scripts/check.mjs
# 首次安装并验证：node scripts/check.mjs --install
# 安装媒体工具并要求真实编解码测试：node scripts/check.mjs --install --skip-model --require-media
# 只构建 Web / Core（无需 MAUI）：node scripts/check.mjs --web
```

同一检查入口用于本地和 CI，覆盖仓库卫生、生成文件、脚本测试、格式、ESLint、TypeScript、Vitest、生产前端构建、包体预算、.NET 构建 / 测试与真实 Web 宿主端到端测试。真实媒体解码测试需要额外运行时，缺少时会明确跳过；这些测试与原生窗口的视觉验收不能由普通构建代替。

Windows 发布：`powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/publish-windows.ps1`，输出到 `artifacts/publish/windows-x64/`。输出未签名，不是安装器，须保留整个目录及第三方许可。

macOS 使用相同的 `npm run setup` / `npm start`。发布运行 `npm run publish:macos -- --without-model`，生成内置媒体运行时的 `.app`、ZIP、校验和及验证报告；正式签名与公证步骤见 [macOS 开发与发布](docs/MACOS.md)。

## 文档

- [开发与脚本](docs/DEVELOPMENT.md) · [贡献指南](CONTRIBUTING.md) · [安全报告](SECURITY.md)
- [macOS 开发、发布与验收](docs/MACOS.md)
- [架构](docs/ARCHITECTURE.md) · [公开标签契约](resources/tagging/KNOWLEDGE.md) · [默认标签](docs/SYSTEM-TAGS.md)
- [界面准则](docs/DESIGN-GUIDELINES.md) · [国际化](docs/I18N.md) · [品牌资源](docs/BRANDING.md)
- [迁移与验证记录](docs/REPOSITORY-MIGRATION.md) · [历史验收记录](docs/VALIDATION.md)

Vroom 源码采用 [MIT](LICENSE) 许可证。第三方组件、模型和媒体工具保留各自许可证，详见 [第三方声明](docs/THIRD-PARTY-NOTICES.md)。
