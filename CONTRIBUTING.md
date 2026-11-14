# 贡献指南

先阅读 [AGENTS.md](AGENTS.md)、[开发指南](docs/DEVELOPMENT.md) 和所涉及的公开契约。Issue 与 PR 可使用中文或英文。

1. 从当前主分支创建工作分支，保持修改范围明确。
2. 用 `npm run setup` 安装锁定依赖；桌面构建另需平台 MAUI 工作负载。
3. 用临时数据库和合成媒体验证。不要提交个人资料库、媒体、令牌、模型、运行时或构建产物。
4. 执行 `npm run format` 和 `node scripts/check.mjs`。Linux 或仅 Web 开发可用 `--web`，PR 中说明未运行的平台检查。
5. 提交 PR，描述具体问题、结果与实际验证。界面修改附代表性状态的截图，避免展示私有资料。

产品保持标签中立。业务定义只在公开资源和测试夹具内声明；不要把具体字段键写进服务、组件或样式。UI 文案通过版本化语言包引用；字段文案使用公开本地化合同。

产品版本只在 `Directory.Build.props` 的 `VroomVersion` 修改；NuGet 版本在 `Directory.Packages.props`；npm 依赖修改必须同步客户端锁文件。公开 schema 的变更同时更新验证器、编辑器、知识包与测试。

漏洞请按 [安全报告](SECURITY.md) 处理，避免在公开 Issue 中披露可利用细节或凭证。
