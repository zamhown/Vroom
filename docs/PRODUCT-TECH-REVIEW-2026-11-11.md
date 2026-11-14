# Vroom 产品与技术全面审查（2026-11-11）

> 目的：为下一轮优化建立问题清单与改造方向。本文是审查结论与建议，不代表任何改动已实施。
>
> 范围：`resources/`（标签与配置协议、语言包）、`src/Vroom.Core`、`src/Vroom.App`（MAUI）、`src/Vroom.Web`、`src/Vroom.Client`（React）、`tests/`、`tools/`、`scripts/`、`docs/`。
>
> 方法：静态阅读源码与公开资源，并结合本机运行的自动化检查。**没有进行界面实测、真实 NAS/大库压测或 macOS 实机验证**；文中涉及性能与界面状态的判断来自代码路径分析，标注“需复现”的条目应先复现再修改。

## 0. 执行摘要

### 0.1 本次实际验证

| 检查 | 结果 |
| --- | --- |
| `dotnet test tests/Vroom.Tests` | 通过 296、跳过 2（需原生运行时），共 298，耗时约 1 分 25 秒 |
| `npx tsc -b`（Client） | 无错误 |
| `npx vitest run`（Client） | 35 个文件、249 项全部通过 |
| Git 状态 | 仓库**没有任何提交**；索引里有 67 个新增、26 个删除（含已不存在的 `src/Vroom.UI/*`）与 121 个未跟踪文件 |

### 0.2 严重度定义

- **P0**：数据正确性/数据丢失风险、持续性的资源浪费、或会让产品在真实资料库中不可用的问题。下一轮优先处理。
- **P1**：显著的功能缺陷、高频交互问题或明显的架构风险。
- **P2**：设计与结构问题，影响专业度、可维护性或扩展性。
- **P3**：卫生类问题，低风险。

### 0.3 最需要优先处理的十个问题

| # | 级别 | 问题 | 章节 |
| --- | --- | --- | --- |
| 1 | P0 | 扫描时对每个视频**全量读取并计算 SHA-256**；默认每 30 分钟全量重扫且不能关闭；每个文件逐个写库并各自入队探测/补全任务。NAS 资料库会出现持续的磁盘与网络 I/O 风暴 | FN-01、FN-02、ARCH-05 |
| 2 | P0 | 存储无限增长：播放时每 10 秒写一条事件，并把播放位置写成一版新的标注历史；每次发布配置存一份完整包；任务、事件、预览、网页缓存、缩略图均无清理策略 | ARCH-03 |
| 3 | P0 | 移除影片库只删除影片和文件，标注、有效投影、引用边、候选全部成为孤儿数据；界面文案却声称“移除关联标注”。重新添加同一文件夹后生成新 ID，原有评分、收藏无法回连 | FN-03 |
| 4 | P1 | 156 个业务错误码中 152 个没有界面翻译，用户直接看到 `STALE_GENERATION`、`VALUE_REVISION_CONFLICT` 等原始码 | I18N-01 |
| 5 | P1 | `file.relativePath` 事实只在“文件夹扫描”事件中是相对路径，在文件导入、已有影片重算、资料补全中退化为绝对路径；同一规则在不同入口得到不同结果 | FN-04 |
| 6 | P1 | 便携发行目录：首次启动把自动探测到的 FFmpeg/mpv/模型路径**以绝对路径写入设置**，移动或升级目录后仍指向旧位置 | FN-06、XP-09 |
| 7 | P1 | 客户端每秒至少两次轮询；任意值实体变化、收藏点击都会触发完整 `bootstrap`（包含全部值实体）；工作区每次状态变化后 600ms 整体序列化保存（上限 18 MB） | ARCH-06 |
| 8 | P1 | 工程基础缺失：没有提交历史、CI、Lint、格式化与分析器；客户端有 836 行超过 200 字符、35 行超过 1000 字符（最长 4251 字符） | ENG-01～ENG-04 |
| 9 | P1 | 协议冗余与抽象缺口：媒体事实被复制成标注；`cardinality` 与 `schema.type=array` 双重表达；值实体引用的值合同不包含所属集合；`host-capabilities.json` 混入播放、网络、字幕等无关领域 | PR-01～PR-10 |
| 10 | P1 | 动线混乱：导入/新建库/编辑库/Agent 四个入口默认值不一致；保存影片库必然重扫；“新建智能列表”和“管理智能列表”打开同一页面且保存后状态错乱；“标签 / 标签值 / 名为‘标签’的字段”命名冲突 | UX-01～UX-08 |

### 0.4 值得保留的做法

- 预览令牌 → 冻结目标 → 可恢复任务提交的模式，在配置发布、批量标注、导出、重链接中一致使用。
- 用户层与系统层分离、配置世代与字段修订检查、DAG 校验放在同一事务内。
- 公开资源随两个宿主打包，Agent 与界面复用同一套校验与命令路径，模型输出不能授权自身。
- ICU 语言包与运行时校验、首启系统语言匹配；中立性测试阻止具体业务 key 进入产品代码。
- Windows mpv 进程隔离 + GPU 合成的方案，以及对其限制的诚实记录。

这些是后续优化应保持的约束，下文的建议均以不破坏它们为前提。

---

## 1. 产品范围与简化

当前版本未发布，但已同时承担：影片库、可配置标签平台（表单/结构/JSON 三模式设计器 + Monaco）、查询构建器 + SQL 记法、自动规则与试算、多来源资料共识、Wikidata 订阅发现、本地 LLM Agent、HandBrake 导出工作台（141 个编码开关）、mpv 原生播放与合成、外部播放器、在线字幕、代理与断网恢复、作品/版本/分卷/资源集、文件身份与 SHA-256 重链接、带优先级的持久任务中心。

与此同时，个人影片库最基础的闭环（导入 → 浏览 → 播放 → 继续观看 → 找到同类）仍有明显缺口（见第 3 章）。建议下一轮把“基础闭环的完成度”置于“新能力的广度”之前。

| ID | 级别 | 可以更简洁的地方 | 建议 |
| --- | --- | --- | --- |
| SIMP-01 | P1 | “标签管理”和“配置管理”分成两个导航入口；值集合同时出现在“标签管理 → 值”和“配置管理 → vocabularies” | 合并为一个“字段与值”工作区；规则、来源、导航等作为该工作区的二级页签；布局/事件绑定等协议对象放入“高级（JSON）” |
| SIMP-02 | P1 | 新建影片库有三条路径：导入对话框、“新建影片库”页、Agent `library.save`，另有“管理影片库”页 | 统一为“添加媒体”一个流程（选择文件/文件夹 → 目标库 → 开始），影片库设置页只负责编辑 |
| SIMP-03 | P1 | 智能列表可从影片列表“保存为智能列表”创建，也可从智能列表页表单创建；导航里“新建”和“管理”两个入口打开同一个标签页 | 只保留“保存当前查询为智能列表”和右键“编辑条件”；去掉导航中的“新建智能列表” |
| SIMP-04 | P2 | 影片列表工具栏同时有“查询(n)”“保存为智能列表”“选择”，“更多”菜单里又重复“筛选与分组”“保存为智能列表” | 工具栏只保留搜索、排序、视图、查询；其余进入“更多”，避免同一动作出现两次 |
| SIMP-05 | P2 | 定义编辑器有表单/结构/JSON 三种模式 | 普通用户只需要表单；结构树与 JSON 作为“高级”切换，默认隐藏 |
| SIMP-06 | P2 | 本地助手页面同时提供请求框、工具目录、手写工具调用 JSON（`AgentPage.tsx:28`） | 工具目录与手写调用移到开发者模式；或把 Agent 收敛为影片列表搜索框中的“自然语言 → 查询 AST”能力（0.5B 模型对复杂配置编辑不可靠，README 也承认） |
| SIMP-07 | P2 | 导出工作台暴露 141 个编码开关 | 默认只展示方案/位置/开始（已有），高级参数改为可选模块或“导入 HandBrake 预设”即可，减少需要维护和验证的面 |
| SIMP-08 | P2 | 设置页由多张平铺卡片组成，没有分区导航；媒体运行时路径、转码画质、模型路径被放在“诊断”折叠项中（`ManagementPages.tsx:108-115`） | 设置按“通用 / 语言 / 影片库与扫描 / 播放与媒体引擎 / 网络与资料来源 / 智能助手 / 诊断”分区，左侧导航；“关于”只展示产品版本、数据目录与许可证 |

---

## 2. 用户动线问题

| ID | 级别 | 现象与证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| UX-01 | P1 | 同一概念的默认值在四个入口不一致：导入对话框 `autoEnrich=false, probeOnScan=true`（`ImportDialog.tsx:12`）；新建库页 `autoEnrich=true, probeOnScan=true`（`ManagementPages.tsx:30`）；`Library` 记录默认 `AutoEnrich=true, ProbeOnScan=false`（`Models.cs:4`）；Agent `library.save` 只传 id/name/roots/excludes，会把已有库的两个开关重置为记录默认值（`AgentTools.cs:36`） | 用户从不同入口得到不同行为；Agent 编辑名称会悄悄关闭探测 | 在一个领域服务中定义默认值与“部分更新”语义；所有入口调用同一服务；Agent 工具使用 patch 而不是重建记录 |
| UX-02 | P1 | 编辑影片库只有“保存并开始扫描”（`ManagementPages.tsx:32-36,50`），改个名字也会触发完整扫描 | NAS 用户每次小改动都触发全量枚举 | 保存与扫描分离；仅当根目录/排除规则变化时提示“是否立即扫描新增目录” |
| UX-03 | P1 | “选择文件”导入默认新建一个影片库，名称取第一个文件名（`LibraryScanner.cs:71`），目标库选择藏在“导入设置”折叠项中（`ImportDialog.tsx:19`） | 多次导入后出现大量以“xxx.mp4”命名的影片库 | 默认导入到当前影片库或上次使用的库；未指定时进入“未归类”库；库名称从文件夹推导 |
| UX-04 | P1 | 导航“新建智能列表”与“管理智能列表”都打开 id 为 `views` 的同一标签页（`App.tsx:66-67`）。在该页保存后执行 `app.update(tab.id,{params:{viewId}})`（`ViewsPage.tsx:20`），管理页变成了刚保存列表的编辑页，现有列表清单随之隐藏（`ViewsPage.tsx:19` 的 `!current&&`）。代码推断，需界面复现 | 用户找不到列表清单；“新建”不是新建 | 管理页与编辑页使用不同 tab id；保存新建列表后打开独立编辑/结果标签页 |
| UX-05 | P1 | 删除智能列表没有确认、没有撤销（`ViewsPage.tsx:19`） | 误删无法恢复 | 使用确认或提供撤销提示（Toast + 撤销） |
| UX-06 | P1 | 恢复的工作区中若影片已被移除，影片页只显示错误 Toast 和无限转圈（`FilmPage.tsx:14-20`）；影片库已移除时对应列表显示“没有影片” | 启动即见错误，且无法理解原因 | 标签页级“对象不存在”空状态，提供关闭/返回；恢复工作区时校验对象是否存在 |
| UX-07 | P2 | 修改配置后的“发布”需要先预览、再在弹窗确认，而影响预览弹窗中的校验详情、导入详情、不兼容标注直接以 `JSON.stringify` 输出（`TagsPage.tsx:141-143`） | 用户看不懂后果，只能盲点“应用” | 用已有 `OperationPreview` 呈现对象、字段、前后值；原始 JSON 放到开发者模式 |
| UX-08 | P2 | 去重“保留多个”会建立 `film_groups`，“保留一个”则把其余影片的“显示状态”改为隐藏（`DuplicatesPage.tsx:19`）；而媒体结构 v4 已经有“作品 → 版本 → 分卷”。“版本”在两套模型中各有一份 | 用户无法理解“组建影片组”与“版本”的区别；去重结果无法用于版本切换播放 | 去重决策改为“合并为同一作品的多个版本”（使用媒体结构），隐藏仅作为可选动作；逐步淘汰 `film_groups` |
| UX-09 | P2 | 去重、导出、重算、批量标注等任务完成后，结果入口分散在各页的 `JobNotice` 与任务中心；任务中心被逐文件任务淹没（见 ARCH-05） | 用户很难找到“刚才那次操作的结果” | 父子任务；任务中心默认只显示用户发起的顶层任务 |
| UX-10 | P2 | 首次启动直接进入“全部影片”空状态，只有“导入”按钮；没有提示是否开启联网补全、是否需要探测、默认数据目录在哪里 | 用户不知道后台会做什么（包括全量哈希，见 FN-01） | 首次导入完成后给出一次性、可关闭的摘要：已发现 N 部、后台正在读取的内容、可在哪里关闭 |

---

## 3. 产品功能缺陷

| ID | 级别 | 现象与证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| FN-01 | P0 | 扫描到的每个文件若没有内容哈希，`ScheduleMediaAsync` 都会调用 `identity.IdentifyAsync`（`LibraryScanner.cs:79`），入队 `media.fingerprint` 任务，完整读取文件计算 SHA-256（`MediaIdentity.cs:41-56`）；添加版本/分卷也会触发（`ClientApi.cs:174`） | 一个 5 TB 的 NAS 库在首次扫描后会被完整读一遍；和播放争用同一块盘与网络；文件 mtime 变化后还会重算 | 默认使用快速指纹（文件大小 + 头/中/尾若干块的哈希）；完整 SHA-256 只在重链接预览/提交时按需计算；提供设置项并在任务中心显示“后台读取量” |
| FN-02 | P0 | 周期扫描默认 30 分钟，最小 1 分钟、不能关闭（`Models.cs:75`，`LibraryScanner.cs:22,98`，`ManagementPages.tsx:104`）。每次扫描对每个文件：读取文件身份（Windows 打开句柄、Unix 启动 `stat` 进程）→ 写事务 → 写事件 → 检查/入队探测与补全任务 | NAS 硬盘无法休眠；大库每半小时出现上万次写事务 | 增加“仅手动 / 启动时 / 每 N 小时”；未变化文件（路径、大小、mtime 均一致）跳过写入与事件；批量事务；可选文件系统监视 |
| FN-03 | P0 | `RemoveLibraryAsync` 只删除 `films`、`media_files`、`libraries`（`CatalogRepository.cs:28-31`），`tag_heads`、`tag_effective`、`tag_reference_edges`、`tag_candidates`、`tag_scope_index` 均保留。确认文案为“移除库内索引和关联标注”（`ManagementPages.removeIndexedRecordsAndTheirAnnotationsSource`）。重新导入时影片 ID 重新生成，旧标注无法回连 | 文案与实际不符；孤儿数据仍可能影响值实体使用计数；用户以为“移除再加回来”是安全的，实际评分与收藏全部丢失 | 二选一并明确告知：①真正删除标注（同一事务，保留归档导出）；②保留标注并在重新导入时按文件身份/路径回连。移除前提供标注导出；移除操作走正式 RPC，而不是 Agent 工具（见 ARCH-08） |
| FN-04 | P1 | `Facts()` 把 `file.relativePath` 设为绝对路径（`TagQuery.cs:9`）；只有文件夹扫描事件通过 payload 覆盖为相对路径（`LibraryScanner.cs:169`，`TagAutomation.cs:17`）。文件导入（`LibraryScanner.cs:48`）、已有影片重算（`AutomationPlanning.cs:111`）、资料补全（`TagSources.cs:45`）都使用绝对路径 | 默认规则（路径评价分档、人物词典与正则、番号提取）在重算时会匹配盘符、NAS 共享名、根目录名，导致与导入结果不一致；违反“试算与导入一致”的承诺 | 由宿主根据影片库根目录计算真实相对路径并持久化在媒体文件事实中；`Facts()` 不再伪造；为三个入口补一致性测试 |
| FN-05 | P1 | 值选项查询把 `label` 序列化为 JSON 字符串后做 `Contains`（`TagQuery.cs:61`）：搜索 `e`、`zh`、`values`、`defaultLocale` 都会命中全部选项；别名不参与搜索；结果按 ID 而不是名称排序，并截断为 200 项 | 选择人物/厂牌时搜索结果失真，列表顺序看似随机 | 在 `tag_term_catalog` 上建立规范化名称/别名索引（或 FTS）；按当前语言名称排序；分页 |
| FN-06 | P1 | 启动时把 `runtime/` 中探测到的 FFmpeg、FFprobe、mpv、HandBrake、模型路径**写成绝对路径**保存（`ServiceRegistration.cs:48-61`），之后只有值仍为默认占位（如 `"ffmpeg"`）才会重新探测 | 发行目录被移动/替换后仍使用旧路径；README 说明旧发行目录会保留，而两者使用同一个应用数据目录，新版本可能一直调用旧版目录里的运行时 | 设置中保存“自动”而非绝对路径；运行时解析；只有用户显式指定时才持久化绝对路径 |
| FN-07 | P1 | 已删除或离线的文件永远留在列表中；扫描不标记“缺失”，列表没有离线标识，只有播放器出错后才检查可用性（`PlayerPage.tsx:54`） | 资料库随时间积累“幽灵影片” | 扫描结束后对本次未见到的文件标记 `missing`（区分根目录离线与文件消失）；列表显示状态；提供“清理缺失项”审阅流程 |
| FN-08 | P1 | 没有封面时只显示占位图与标题（`components.tsx:33`），宿主已有截帧能力（`FfmpegService.ThumbnailAsync`），但没有用于默认封面 | 没有 NFO 的本地文件在海报视图中几乎无法分辨 | 探测完成后生成默认封面（固定百分比位置），作为 `ui.identity.primaryImage` 的后备事实；悬停预览可复用播放预览 |
| FN-09 | P1 | 缺少影片库的基础入口：继续观看、最近添加、最近播放。观看结束会把位置写为 0（`usePlayback.ts:109`），无法区分“看完”与“未开始” | 用户需要自己记住看到哪里 | 宿主记录播放会话（开始、结束、累计观看时长、是否完成）；默认导航提供“继续观看 / 最近添加”；“未看过”由播放事实派生（见 PR-03） |
| FN-10 | P1 | 分组只返回组合计数，以 chip 形式显示在列表上方，影片仍是平铺分页列表（`LibraryPage.tsx:65`） | “按厂牌/评分分组”看不到分组结果 | 分组视图：按组折叠展示，组内分页或虚拟化 |
| FN-11 | P1 | 影片列表固定每页 30 项，只有上一页/下一页（`LibraryPage.tsx:32,67`，`ui.tsx:68-71`） | 1 万部影片约 334 页，浏览体验差 | 虚拟化网格 + 游标分页；保留跳转到位置的能力 |
| FN-12 | P2 | 排除规则是对完整路径做不区分大小写的子串匹配（`LibraryScanner.cs:128,135`） | 排除 `temp` 会误伤 `Contemporary` | 改为相对根目录的 glob；界面提供预览“将被排除的目录” |
| FN-13 | P2 | 影片库根目录只做 `Path.GetFullPath`（`CatalogRepository.cs:25`）：相对路径会按进程工作目录解析；不校验目录是否存在、是否与其他库重叠 | 同一文件可能进入两个库形成重复；输入错误路径时扫描才报错 | 保存时校验绝对路径、存在性与嵌套/重叠，并就地提示 |
| FN-14 | P2 | 未知帧率默认 30（`Models.cs:20`，`FfmpegService.cs:26-28`） | 逐帧步进、时间标注在 25/24/60fps 或 VFR 素材上偏差 | 未知时保持 `null`，逐帧步进降级为按时间戳或由 mpv 处理 |
| FN-15 | P2 | 设置中的 `settings.save`（整对象覆盖）仍保留在 RPC 中（`ClientApi.cs:120`），客户端只使用 `settings.patch` | 两条写路径，后者可被绕过 | 删除 `settings.save` |
| FN-16 | P2 | 删除影片、标记缺失、手动“从库中移除单部影片”没有正式入口；只能通过“显示状态”隐藏 | 无法纠正误导入 | 单部/批量“从资料库移除（保留源文件）”，与 FN-03 同一语义 |

---

## 4. 交互界面 badcase

| ID | 级别 | 现象与证据 | 建议 |
| --- | --- | --- | --- |
| UI-01 | P1 | 点击卡片上的收藏开关后执行 `app.refresh()`（`Surface.tsx:35`），重新获取完整 `bootstrap`；其他编辑也广泛使用 `app.refresh()` | 局部更新该影片；值实体变化只刷新受影响的列表 |
| UI-02 | P1 | 错误 Toast 显示原始码或原始异常文本（`api.ts:55`，`ui.tsx:104` 的 `Toast.error(String(e))`，`context.tsx:86` 启动失败页 `String(e)`） | 统一错误展示组件：消息 ID + 参数 + 诊断编号；未知异常显示通用文案并提供“打开日志” |
| UI-03 | P1 | 配置页顶部直接显示 `SYSTEM_UPDATE_CONFLICT:code:pointer`（`TagEngine.cs:60`，`TagsPage.tsx:123`） | 提供“内置定义更新与用户覆盖冲突”的解释与处理入口（查看差异、恢复内置、保留覆盖） |
| UI-04 | P2 | 通用 `Table` 用“条目数 × 估算行高 + 36”计算高度（`ui.tsx:80`），任务页传入 130px 估算值（`ManagementPages.tsx:69`） | 违反设计准则“不能用条目数 × 估算行高填充容器”；改为内容高度 + 最大高度滚动，或虚拟化 |
| UI-05 | P2 | 任务详情直接展示参数与结果 JSON（`ManagementPages.tsx:76`）；每一行的操作列内又嵌一个“调度”折叠项（`ManagementPages.tsx:73`） | 详情用字段化摘要；调度只对排队任务显示，放进详情或行菜单 |
| UI-06 | P2 | 扫描间隔数字框每次变动立即保存（`ManagementPages.tsx:104`），与“自由输入在 Enter/失焦时提交”的准则不一致 | 与路径输入一致，在 Enter/失焦提交 |
| UI-07 | P2 | 标签页没有“关闭其他/关闭右侧/全部关闭”，没有溢出菜单，只有左右滚动按钮（`WorkspaceTabBar.tsx:221-243`）；没有 Ctrl/Cmd+W、Ctrl+Tab、Ctrl+F 等全局快捷键 | 补齐桌面应用的标签页管理与快捷键，并遵循平台修饰键 |
| UI-08 | P2 | 主题固定为深色（`context.tsx:88` `colorScheme="dark"`） | 支持跟随系统 / 浅色 / 深色 |
| UI-09 | P2 | 影片库编辑用多行文本框输入路径与排除项（`ManagementPages.tsx:41-44`），占位示例为 `D:\Videos`、`\\NAS\Media` | 使用集合编辑器（每行一个路径，带浏览、校验、移除）；占位示例按平台生成 |
| UI-10 | P2 | 新建字段默认开放整部/时间点/区间三种对象，并默认允许查重与排序（`TagsPage.tsx:111`） | 新建文本字段默认仅“影片”，查重默认关闭，由值类型模板推荐 |
| UI-11 | P2 | 新建字段的 key 为 `user.field.<uuid>`（`TagsPage.tsx:110`），在 SQL 查询记法、导出文件和 Agent 中不可读 | 由名称生成可读 slug（可编辑、创建后不可变），冲突时追加短后缀 |
| UI-12 | P2 | 自定义 CSS 有 26 处 `!important`，多处覆盖 Spectrum `ActionButton` 尺寸与状态（`styles.css:64-84,213`）；响应式仍使用视口媒体查询（`styles.css:536,826`） | 优先使用 Spectrum 组件变体；窄容器使用容器查询，与设计准则一致 |
| UI-13 | P3 | 影片库行用 `<b>` 表示名称（`ManagementPages.tsx:24`）、任务卡片使用粗体数字等，与“不以粗体替代分组”的准则冲突 | 按准则使用标题/字段角色 token |

---

## 5. 产品设计不专业之处

| ID | 级别 | 问题 | 建议 |
| --- | --- | --- | --- |
| PD-01 | P1 | 术语冲突：导航叫“标签管理”，里面的对象是“标签定义”（字段），选项叫“标签值”，内置还有一个名为“标签”的字段（`core.labels`）。工作区页面标题又叫“标签配置”（`workspace.tagConfiguration`） | 建立术语表：字段（Field）/ 值（Value）/ 值集合（Collection）/ 标注（Annotation）；`core.labels` 改名为“关键词”或“分类”；所有界面文案对齐 |
| PD-02 | P1 | “配置管理”向用户暴露协议内部类型：`ui.surfaceBindings`、`ui.tabPresentation`、`eventBindings`、`templates`、`message`、`i18n`（`TagEngine.cs:130`，`TagsPage.tsx:35`） | 面向任务的编辑器（来源、规则、值集合、导航、显示样式），其余只在 JSON 高级模式可见 |
| PD-03 | P1 | 版本号分裂：客户端 `package.json` 2.0.0、MAUI `ApplicationDisplayVersion` 2.0、`bootstrap` 硬编码 `"3.0.0"`（`ClientApi.cs:96`）、内置标签包 3.3.0、客户端 API 11、发布目录 `windows-v3` | 单一产品版本源（如 `Directory.Build.props`），构建时注入客户端与宿主；协议版本独立维护并在“关于”中展示 |
| PD-04 | P2 | 内置“未看过”是否定式布尔（`core.unwatched`），而且由“首次发现即写 true、播放结束写 false”的规则维护 | 正向命名“已看过”，最好由播放事实派生（见 PR-03） |
| PD-05 | P2 | 评价分档英文标签为 “General”，同一字段描述里写 “Basic”（`core.tagdefs.json:99,291`）；“转换与导出”导航的 `defaultLocale` 是 `en`，其余是 `zh-CN`，且没有图标（`core.tagdefs.json:4803`） | 内置资源加文案一致性校验（同一 band 的 label 与 description 引用同一词条） |
| PD-06 | P2 | 评价录入显示 5 颗星，默认展示 10 颗星，紧凑展示 5 颗星（`core.rating`） | 同一字段在三处使用相同符号数，或在描述中解释 |
| PD-07 | P2 | 内置人物正则会把文件路径中任意两个首字母大写的英文单词当作人物候选（`core.tagdefs.json:1196`），CJK+假名规则同样宽泛，且允许自动创建值实体 | 默认规则只作用于文件名；需要明确前缀（如 `主演:`）才创建新人物；其余只匹配已有词典 |
| PD-08 | P2 | 默认资料来源固定指向某个第三方网站，并内置 Cloudflare 验证页的浏览器会话处理（`core.tagdefs.json:3970` 起） | 第三方站点作为用户自行启用/导入的来源包；默认包只保留 NFO 与 Wikidata。这样也降低服务条款、站点改版与维护风险 |
| PD-09 | P2 | “关于”卡片展示 `.NET 10 / MAUI 10.0.110`、`Adobe React Spectrum 2` 等实现细节（`ManagementPages.tsx:116`） | 展示产品版本、数据目录、许可证、日志位置 |
| PD-10 | P3 | Agent 页把模型文件名作为紫色标签显示（`AgentPage.tsx:22`）；工具按名称前缀分组展示 | 展示“模型已就绪/未配置”状态即可 |

---

## 6. 标签与配置协议：可抽象与优化的点

本章针对 `resources/tagging/`。总体问题是：协议在“可配置”上走得很远，但缺少几类基础抽象，导致资源冗长（`core.tagdefs.json` 5285 行、`host-capabilities.json` 6184 行）、写入放大，以及产品代码被迫补位。

### PR-01（P1）媒体事实被复制成标注

**现状**：文件路径、大小、添加/修改时间、时长、宽高、帧率、编码、所属影片库、播放位置共 12 个字段通过 `fact.copy@1` 在事件中写成标注（例如 `core.duration`、`core.position`）。查询 AST 只能引用标签 key，不能引用事实（`query.schema.json` 中没有 `fact` 操作数），这是复制的根本原因。

**问题**：
- 同一事实有两份：`media_files.payload` 与 `tag_heads/tag_history`，重新探测、重链接、切换分卷后可能不一致；多分卷影片的“播放位置”标注无法表达是哪个分卷。
- `core.position` 在每次 `playback.position-saved`（每 10 秒）时写一版新标注历史（`core.tagdefs.json:2343-2405`），与 AGENTS.md “播放时钟是宿主不变量”的约束相冲突。
- 每部影片在 `film.discovered` 时无条件写入 9 条标注（收藏、未看过、显示状态、标题、路径、大小、添加/修改时间、所属库），`media.probed` 后再写 6 条技术事实。

**建议**：引入“派生字段”（derived/fact-bound field）：

```json
{ "key": "core.duration", "value": { "type": "number", "unit": "seconds" },
  "source": { "fact": "probe.duration" } }
```

派生字段只读、不写标注、不产生事件；查询编译器把它编译为对媒体事实视图的列引用（可用 SQLite 生成列或投影表加索引）。`core.position` 直接删除，播放位置只由宿主维护。

### PR-02（P1）值合同存在双重表达，且引用类型的合同不完整

- `value.cardinality: "many"` 与 `schema.type: "array"` 必须同时出现且相互一致，这就是 AGENTS.md 禁止的“第二个可独立修改的类型判别字段”。
- 值实体引用的 schema `{"type":"object","properties":{"term":{"type":"string"}},...}` 在 9 个定义和 `valueTypes` 中逐字重复。
- 引用属于哪个值集合写在 `options.vocabulary`，而不是值合同里；值合同本身无法表达“只能引用人物集合”。

**建议**：值合同使用语义类型，宿主负责展开为 JSON Schema：

```json
"value": { "type": "term", "vocabulary": "core.people", "many": true, "unique": true }
"value": { "type": "date" }
"value": { "type": "integer", "minimum": 1, "maximum": 10, "unit": "score" }
```

`valueTypes` 注册表即为这些类型的唯一来源；`options` 只保留新值创建策略等交互属性。

### PR-03（P1）默认值依赖“发现即写入”的常量规则

`core.favorite=false`、`core.unwatched=true`、`core.visibility=visible` 都通过 `film.discovered` + `value.constant@1` 为每部影片写入一条标注。

**建议**：在值合同中增加读取期默认值 `value.default`，有效投影在缺值时返回默认值并标注来源为 `default`；不写标注、不产生历史。查询编译器对默认值使用 `COALESCE`。“已看过”改为由宿主播放会话派生（FN-09）。

### PR-04（P2）LocalizedText 过于冗长

每个文案都是 `{"defaultLocale":"zh-CN","values":{...}}`，而包级已有 `i18n.defaultLocale`；`display.default.label = 默认展示/Default display` 在 28 个定义中重复。

**建议**：
- 允许直接写 `{"zh-CN":"评价","en":"Rating"}`，默认语言统一取包级设置；
- 重复的通用文案改为引用共享消息（协议已有 `message` 引用形式）；
- 显示样式的名称在未自定义时由宿主提供默认名，不在每个定义中重复。

仅这一项预计可使 `core.tagdefs.json` 缩减三分之一以上。

### PR-05（P2）位置排序分散在各字段中

每个定义自带 `placements[].order`（10、30、42、50、60、100……），想知道“影片详情页按什么顺序显示”需要扫描 39 个定义。

**建议**：布局节点按区域声明有序成员（`region → [{field, view}]`），字段只声明“可放置在哪些区域”；或以分组顺序 + 组内顺序推导，不再使用全局魔法数字。

### PR-06（P2）字符串微语法与不完整的结构

- `query.groupBy: ["value","facet:quality"]`、`placements[].view: "display.compact"` 都在 JSON 中嵌入需要再解析的字符串。
- `catalogPolicy.defaultSort: "core.added"` 没有方向，客户端自行补 `direction:'desc'`（`LibraryPage.tsx:24`，`ViewsPage.tsx:15`），产品决定泄漏到代码中。
- 查询参数 `includeArchived` 名称带有业务含义，实际作用是“是否应用 `catalogPolicy.defaultQuery`”（`TagQuery.cs:23`）。

**建议**：`groupBy: [{"mode":"facet","facet":"quality"}]`；`view: {"display":"compact"}`；`defaultSort` 复用 `query.schema.json` 的 `orderBy` 项；`includeArchived` 改为 `applyDefaultScope:false` 或 `scope:"all"`。

### PR-07（P2）规则身份与写入策略缺少校验

- 17 个内置定义的规则 ID 使用 `"0"`、`"1"` 等数组下标式取值（如 `core.cast`、`core.duration`），而规则身份用于识别“哪条规则写入了这个值”。
- `writes.manual:false` 同时配 `manualClearBlocksAutomatic:true` 没有意义（多个事实字段）。

**建议**：发布校验要求规则 ID 为有意义的稳定标识（至少不是纯数字）并在同一字段内唯一；对无意义组合给出警告。

### PR-08（P1）`host-capabilities.json` 是大杂烩

一个文件包含：JSON Schema `$defs`、组件与执行器注册、值类型、查询限制、事实与事件、55 个表达式运算符、图标、mpv 原生播放设置（`nativePlayback`）、外部播放器、在线字幕、网络代理、媒体结构、导出、客户端 API 版本等 35 个顶层键。`$id` 同时使用 `urn:vroom:schema:*` 与 `https://vroom.local/schemas/*` 两种命名。目录名仍叫 `tagging`，实际已是全部公开契约。

**建议**：拆为 `tagging-capabilities`、`ui-capabilities`（表面、区域、命令、图标）、`playback-capabilities`、`network`、`subtitles`、`media-structure`、`export` 等独立文件，各自版本化；目录改为 `resources/contract/`；统一 `$id` 方案；Agent 的 `knowledge.list` 按领域返回。

### PR-09（P2）图标注册与实际渲染不一致

`host-capabilities.icons` 只登记 26 个图标，但组件与值类型使用了 `Text`、`Number`、`Toggle`、`Calendar`、`Image`、`Slider`、`TextAlignLeft`，这些不在注册表中。客户端有两套映射：`icon-catalog.tsx` 的 `SchemaIcon` 与 `CapabilityIcon.tsx`；未知名称分别静默回退为 Tag 和 Text 图标。`icons.tsx` 中还有 `IconEyeOpened = icon(Clock)`、`IconBolt = icon(Lightbulb)`、`IconPriceTag` 等名不副实的别名。

**建议**：图标注册表成为唯一来源，客户端只有一个映射并由契约测试保证完整；发布校验拒绝未登记图标。

### PR-10（P2）表达式语言过多

当前同时存在：查询谓词 AST（`query.schema.json`）、规则表达式（55 个运算符，含 `bit-and`、`shift-left` 等位运算，`host-capabilities.json:4579` 起）、仅在客户端实现的 SQL 查询记法（`QUERY-SQL.md`，`query-sql.ts`），以及 Agent 工具参数使用的 TypeScript 风格字符串（`"{id:string,subjectKind?:'film'|'term'}"`，`AgentTools.cs:34-57`）。

**建议**：
- 查询谓词与规则表达式共享一个运算符注册表，每个运算符标注“可编译为 SQL / 仅运行时”；删除没有用例的位运算。
- SQL 记法若保留，解析器应在宿主侧也有实现（或只作为客户端编辑视图，不写入任何公开契约）。
- 工具参数改用 JSON Schema（与 `tools.json` 一起生成文档）。

### PR-11（P2）宿主功能的导航放在标签包中

“标签管理”“配置管理”“转换与导出”三个入口来自标签包 `ui.navigation`（`App.tsx:72,85`）。用户覆盖或删除这些条目，宿主功能入口就消失。

**建议**：宿主功能入口由宿主注册；标签包只贡献由字段驱动的导航（如评分分档、收藏）。

### PR-12（P2）资料来源缺少“何时需要补全”的声明

来源只有 `when` 条件与缓存 TTL，没有“仅在字段缺失/过期时补全”的声明；加上开启自动补全的影片库在每次扫描时都会为每部影片入队补全任务（`LibraryScanner.cs:86-87`，只排除正在进行的同类任务），联网补全开启后，缓存过期（默认 1 天，`TagSources.cs:90`）即会对全部影片再抓取一次；同名 NFO 也会在每次扫描后被重新读取。

**建议**：来源增加 `refresh` 策略（`missingFields`、`maxAge`、`onDemandOnly`）；补全任务只在策略命中时入队；按来源批量执行而不是每部影片一个任务。

### PR-13（P3）预留的空结构

`templates: {}`、`eventBindings: {}`、`ui.tabPresentation: {}`、`reservedEvents`。

**建议**：未实现的能力不进入当前格式；需要时随 `formatVersion` 一起加入。

---

## 7. 技术设计与架构

### ARCH-01（P1）单一写闸门与读写混用

`CatalogDatabase.RunAsync` 用一个 `SemaphoreSlim(1,1)` 串行化所有操作，每次新开连接、执行 PRAGMA、`Directory.CreateDirectory`（`CatalogDatabase.cs:14-40`）。只读快照 `ReadAsync` 已存在，但大量纯读取仍走写闸门：影片库、设置、智能列表、任务恢复（`CatalogRepository.cs:17,109,112`）。配置预览在写闸门内做完整重投影再回滚（`TagEngine.cs:145-169`），此前审查已指出 10 万规模单次约 8 秒。

**影响**：配置发布、扫描、批量任务期间，播放位置保存、设置读取、启动 `bootstrap` 都在排队。

**建议**：所有读取走 `ReadAsync`；写事务保持短小（扫描、批量写按 N 条合批）；配置预览改为在只读快照上计算差异（或写入临时数据库），不占用主写闸门；长任务分批提交并允许其他写入穿插。

### ARCH-02（P1）数据库结构分散且没有版本化

媒体表在 `CatalogSchema.cs` 中由 `user_version=4` 管理；25 张标签相关表在 `TagEngine.cs:15-46` 中用 `CREATE TABLE IF NOT EXISTS` 创建，没有版本号。工作区状态、调度策略、语言包、用户设置都塞在 `settings` 键值表中，工作区一行最大 18 MB（`ClientApi.cs:151-161`）。

**建议**：统一的结构版本表与一次性初始化脚本（即使不支持旧格式，也需要在格式不匹配时明确拒绝）；工作区与语言包使用独立表；一次性 v3→v4 升级代码（`CatalogUpgrade.cs`）在用户资料库完成升级后按计划移除，避免长期保留迁移路径。

### ARCH-03（P0）没有任何保留与清理策略

代码中没有对以下表执行过删除：`tag_events`、`tag_rule_runs`、`tag_previews`、`tag_bulk_items`、`tag_idempotency`、`tag_generations`、`tag_source_cache`、`background_jobs`、`job_events`、`audit`。另外：

- 每次播放 10 秒：一条 `tag_events` + 规则执行记录 + `core.position` 标注历史（见 PR-01）。
- 每次发布配置：`tag_generations` 保存一份完整包（`TagEngine.cs:181-182`），并在 `config/user/revisions/<generation>/objects.json` 写一份镜像（`TagEngine.cs:195-201`）。
- 网页来源把最多 4 MiB 的响应正文存入 `tag_source_cache`，过期后不删除。
- `thumbnails/` 截帧缓存只增不减（`FfmpegService.cs:44-46`）。
- `JobCoordinator` 启动时把全部历史任务读入内存（`JobCoordinator.cs:47-64`）。

**建议**：为每类数据定义保留策略（例如：已处理事件 7 天；预览 24 小时；配置世代保留最近 N 份并只存差异；任务按父任务聚合并保留 90 天；缓存按 TTL 删除并限制总量）；后台维护任务执行清理、`PRAGMA optimize`、WAL checkpoint；设置中显示资料库体积与“清理缓存”。

### ARCH-04（P1）配置快照缓存与包体复制

`Current(db)` 每次都从数据库读出完整有效包 JSON，并以“完整 JSON + term stamp”拼接字符串作为缓存键（`TagEngine.cs:85-91`）；缓存超过 4 项即整体清空。`bootstrap` 返回的客户端包附带全部值实体（`TagEngine.cs:78-82`）。

**建议**：以 `(generation, termStamp)` 作为缓存键；客户端包只含定义，值实体按需查询（已有 `terms.query`）；`bootstrap` 支持基于世代的条件获取。

### ARCH-05（P0）任务模型：逐文件任务与全量内存列表

- 扫描时每个文件可能各自产生 `media.fingerprint`、`media.probe`、`metadata.enrich` 三个顶层持久任务（`LibraryScanner.cs:77-88`）；去重判断使用 `jobs.Jobs.Any(...)`，而 `Jobs` 每次访问都对全部记录排序（`JobCoordinator.cs:26`），扫描整体退化为 O(n² log n)。
- `job.list` 对全部任务过滤排序（`JobCoordinator.cs:327-332`），客户端全局每秒调用一次、任务页再每秒调用一次。
- 任务状态以枚举整数持久化（`JobCoordinator.cs:362`），枚举顺序调整会破坏历史数据；客户端用 `[3,4,5,8]` 等魔法数字判断状态。

**建议**：父子任务（扫描任务汇总子步骤进度）；按 `ResourceKey` 建立内存索引；历史分页直接查询数据库；状态持久化为字符串；为客户端生成状态常量。

### ARCH-06（P1）客户端数据同步：轮询 + 全局 revision + 全量刷新

- `events.subscribe` 每 1.2 秒、`job.list(limit 200)` 每 1 秒（`context.tsx:52-53,73-74`），单任务 `useJob` 每 700ms、`waitJob` 每 350ms。
- 收到 `annotation.changed`、`film.discovered`、`media.probed` 等事件时全局 `revision+1`，所有影片列表、影片页、播放器都重新请求；扫描 1 万个文件期间会持续触发。
- 收到 `definition.activated`、`term.changed` 时调用完整 `bootstrap`。
- 工作区任何状态变化 600ms 后整体保存（`context.tsx:60-64`），播放器把字幕全文 `subtitleText` 也保存在标签页状态中（`PlayerPage.tsx:33`）。
- 轮询中的 `catch { }` 吞掉错误（`context.tsx:52,73`），宿主失联时界面没有任何提示。

**建议**：宿主 → 客户端推送通道（WebView 消息；Web 宿主使用 SSE）；事件携带受影响对象，客户端按对象失效；工作区按标签页增量保存，体积大或可再生的数据（字幕全文、完整队列快照）不进入工作区；显示“与本地服务的连接已中断”状态。

### ARCH-07（P1）RPC 层缺少类型契约

`ClientApi.DispatchAsync` 是 130 行的字符串分派，混合多种前缀分派与 `switch`（`ClientApi.cs:36-163`）；参数靠 `Str/Optional/Int/Bool` 手工解析，部分方法有 JSON Schema 校验，部分没有（如 `library.save` 直接反序列化）；多处 `JsonNode.Parse(args.GetRawText())` 重复转换。客户端 `types.ts` 手写复制 C# 模型（`interface Job` 甚至声明了两次）。

未知异常直接返回 `ex.Message`（`ClientApi.cs:32`），可能是 SQLite、IO 等英文原始信息与本机路径。

**建议**：RPC 方法注册表：每个方法声明请求/响应 schema 与处理器；由 schema 或 C# 记录生成 TypeScript 类型与客户端；统一错误信封 `{code, args, pointer, diagnosticId}`；未知异常只返回通用错误码并写入诊断日志。

### ARCH-08（P1）分层与耦合

- `Vroom.Core` 同时承担领域、SQLite、FFmpeg/mpv/HandBrake 进程、HTTP/浏览器抓取（AngleSharp、Chromium CDP）、LLM（LLamaSharp）与应用 API。Web 调试宿主和移动目标也因此引入 LLamaSharp。
- 存储层反向依赖标签层：`CatalogRepository.SavePositionAsync` 调用 `TagEngine.MediaRevision` 并抛出 `TagException`（`CatalogRepository.cs:105`）。
- `TagEngine` 是一个跨约 20 个文件的 `partial class`，内部静态方法被扫描器、媒体服务、外部播放器、资料来源广泛调用。
- 多个类型采用“可选依赖 + 缺省时自行 `new`”的构造方式（`LibraryScanner.cs:28`、`AgentTools.cs:25`、`ClientApi.cs:15`），一旦注入缺失会悄悄产生第二个 `TagEngine`/`TagSources` 实例和独立缓存。
- 界面的正常操作经由 Agent 工具注册表执行：移除影片库、删除智能列表都调用 `tool.call`（`ManagementPages.tsx:24`，`ViewsPage.tsx:19`），Agent 工具既是 AI 接口又是 UI 命令总线。

**建议**：拆分项目（Domain/Contracts、Storage、Tagging、Media、Sources、Intelligence、Application/Api）；媒体修订等领域概念下沉到 Domain；所有依赖显式注入；界面与 Agent 共用应用服务，Agent 工具只是对应用服务的包装。

### ARCH-09（P2）自研 HTTP 媒体服务

`LocalMediaServer` 基于 `TcpListener` 自行解析请求头、Range 与连接管理（362 行）。安全边界设计合理（回环、随机令牌、无路径参数），但自研协议栈需要长期维护和模糊测试。

**建议**：Windows 使用 WebView2 `WebResourceRequested`/自定义 scheme，macOS 使用 `WKURLSchemeHandler`，Web 宿主直接使用 Kestrel 端点；若保留现方案，补充针对请求解析的模糊测试与边界测试。

### ARCH-10（P2）每个媒体事件的额外开销

每次媒体事件（包括每 10 秒的播放位置事件、每个被扫描文件的发现事件）都会重投影该影片全部时间范围标注并校验完整值实体引用图（`TagAutomation.cs:20-21`）。

**建议**：只有涉及值实体主体的写入才执行图校验；时间范围投影只在媒体修订变化时执行。

### ARCH-11（P3）安全加固

- Web 调试宿主除 Host/Origin/自定义请求头外没有令牌，同机其他用户/进程可调用全部 API（`Program.cs:13-28`）。可在启动时生成随机令牌并通过页面注入。
- 资料抓取浏览器使用 `--remote-debugging-port=0`（`SourceBrowser.cs:199`），同机进程可通过 `DevToolsActivePort` 连接；可改用 `--remote-debugging-pipe`。
- `build-client.ps1` 使用 `npm ci --no-audit`，没有任何依赖审计环节。

---

## 8. 代码结构与实现缺陷

| ID | 级别 | 问题与证据 | 建议 |
| --- | --- | --- | --- |
| CODE-01 | P1 | 代码极度压缩：客户端 836 行超过 200 字符、142 行超过 500 字符、35 行超过 1000 字符，`PlayerPage.tsx:183` 一行 4251 字符；Core 428 行超过 200 字符；测试 156 行超过 200 字符 | 引入 Prettier/ESLint 与 `dotnet format`，一次性格式化；Code review 以可读性为准 |
| CODE-02 | P1 | 巨型组件与类：`TagsPage.tsx`（单组件管理定义/值/导入导出/发布/撤销）、`PlayerPage.tsx`、`LibraryPage.tsx`、`Surface.tsx`、`ClientApi`、`JobCoordinator`、`TagEngine` | 按职责拆分：页面容器 + hooks + 展示组件；服务按用例拆分 |
| CODE-03 | P2 | `ui.tsx` 是一层模仿 Semi Design 接口的适配器（`theme="borderless"`、`type="danger"`、`optionList`、`Banner`、`Descriptions`、`Collapse.Panel`、`Typography`、`Skeleton`），部分参数被忽略（`Typography.Title` 的 `heading`、`Skeleton` 占位）；`Checkbox` 伪造 `event.target.checked` | 直接使用 Spectrum 组件与属性；保留的产品级组件只做语义封装 |
| CODE-04 | P2 | 标签配置草稿以 JSON 字符串保存在标签页状态中，表单每次渲染反复 `JSON.parse`（`TagsPage.tsx:46-65,102-104`） | 结构化草稿为唯一状态，JSON 视图由草稿派生 |
| CODE-05 | P2 | TypeScript 中有 279 处 `any`；`tsconfig` 未开启 `noUnusedLocals/noUnusedParameters/noUncheckedIndexedAccess`；大量文件导入了未使用的 `translate` | 收紧编译选项，逐步消除 `any` |
| CODE-06 | P2 | Core 中有 756 处 `JsonObject/JsonNode` 引用、925 次 `.Text("…")/.Flag/.Number/.List/.Map` 字符串取值 | 公开契约保持 JSON，但进入领域层后转换为强类型记录（`DefinitionDocument` 已开始，继续推广到查询、规则、来源、批量写入） |
| CODE-07 | P2 | `AppSettings` 为了字典字段手写 `Equals/GetHashCode`（`Models.cs:77-79`），新增属性时极易遗漏 | 使用不可变有序字典或自定义比较器，或去掉对值相等的依赖 |
| CODE-08 | P2 | `Film` 领域记录仍是 v4 之前的扁平结构（路径、大小、时长、宽高等都在作品上），由视图 `film_projection` 拼出“当前选中分卷”的结果（`CatalogSchema.cs:18-23`） | 作品、版本、分卷、文件分别建模；需要“默认分卷”时显式取 |
| CODE-09 | P2 | 两套图标映射、名不副实的图标别名（见 PR-09） | 统一 |
| CODE-10 | P3 | 死代码与残留：`settings.save` RPC、DI 中未被使用的 `HttpClient` 单例（`ServiceRegistration.cs:35`）、空目录 `src/Vroom.UI`、`src/Vroom.App/Components`、`wwwroot`、`Platforms/Tizen`、未使用库的许可证（`semi-design-LICENSE`、`video.js-LICENSE`）、`node_modules` 中残留 `@douyinfe`、`@dnd-kit`（不在 `package.json`）、`src/Vroom.Client/tsconfig.tsbuildinfo` | 清理 |
| CODE-11 | P3 | 测试文件以开发轮次命名（`JourneyTests`、`SchemaNextTests`），语言包有 202 条 `Journey.*` 词条 | 按功能领域命名 |

---

## 9. 跨平台兼容性

README 已如实说明 macOS 与移动端未完成。以下为代码层面的具体差距，便于纳入一致性验收。

| ID | 级别 | 问题与证据 | 建议 |
| --- | --- | --- | --- |
| XP-01 | P1 | 非 Windows 平台 `PickFolderAsync` 返回 `null`（`NativePlatformActions.cs:21-37`），macOS 只能手动粘贴路径；也没有安全作用域书签 | Mac Catalyst 使用 `UIDocumentPickerViewController`（文件夹模式）并持久化书签 |
| XP-02 | P1 | Unix 上读取文件身份为每个文件启动一次 `/usr/bin/stat` 进程（`FileIdentity.cs:27-33`），扫描、哈希前后都会调用 | 使用 `lstat` P/Invoke 获取 `st_dev/st_ino/birthtime`；沙盒环境下不依赖外部进程 |
| XP-03 | P2 | 路径键只在 Windows 上大写化（`CatalogRepository.cs:32-33`）；macOS 默认文件系统不区分大小写，且可能返回 NFD 形式的 Unicode；SMB 共享与本地输入的规范化形式可能不同 | 按卷能力决定大小写比较；路径键统一做 Unicode 规范化 |
| XP-04 | P2 | 解码进程随宿主退出回收只在 Windows（Job Object）实现（`DecoderLifetime.cs:12`） | macOS 使用进程组 + 父进程监视，或 `posix_spawn` 时设置终止策略 |
| XP-05 | P2 | 原生对话窗口、页内 mpv 合成、全屏控制仅 Windows 实现（`NativeVideoSurface.cs` 非 Windows 分支为空实现） | 已在 ARCHITECTURE 记录；建议在界面上明确告知当前平台的播放模式 |
| XP-06 | P2 | 字体硬编码 `Consolas`（`styles.css:41`），Monaco 字体为 `Consolas, 'Microsoft YaHei UI', 'PingFang SC'`（`styles.css:822`） | 使用 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` 等跨平台栈 |
| XP-07 | P2 | 构建、运行、发布脚本均为 PowerShell 且写死 Windows TFM（`scripts/run.ps1`、`publish-windows.ps1`）；`setup-runtime.sh` 只是软链接系统中的 FFmpeg/HandBrake，没有版本固定 | 跨平台脚本（`dotnet` 工具或 Node 脚本）；macOS 运行时同样固定版本与校验和 |
| XP-08 | P2 | MAUI 项目默认目标包含 android/ios/maccatalyst（`Vroom.App.csproj`），不加 `VroomWindowsOnly` 时需要全部工作负载；移动端功能并不可用；`Platforms/Tizen` 为模板残留 | 默认只构建桌面目标；移动端目标通过显式参数启用 |
| XP-09 | P2 | 两个宿主默认数据目录不同：MAUI 为 `FileSystem.AppDataDirectory/catalog`，Web 宿主为 `LocalApplicationData/Vroom`；便携发行把运行时绝对路径写入设置（FN-06） | 文档化并在设置页显示当前数据目录；运行时路径运行期解析 |
| XP-10 | P3 | 界面示例路径为 Windows 格式（`ManagementPages.tsx:42`） | 按平台生成 |

---

## 10. 国际化与无障碍

| ID | 级别 | 问题与证据 | 建议 |
| --- | --- | --- | --- |
| I18N-01 | P1 | `TagException` 以错误码作为 `Message`（`TagJson.cs:45`），客户端把它当作消息 ID 翻译（`api.ts:55`）；156 个错误码中 152 个在语言包中没有词条，`translate` 找不到时返回原始码（`i18n/index.ts:61`） | 为全部错误码补充词条（带参数与 JSON Pointer 的可读描述）；增加测试：源码中出现的每个错误码都必须在两个内置包中存在 |
| I18N-02 | P2 | 2190 条消息中有 83 条以数字结尾的重复 ID（`ui.cancel2`、`App.settings2`……），206 组文本完全相同（“取消”有 12 个 ID）；ID 按源文件命名（`TagsPage.*`、`ManagementPages.*`）而非语义 | 按功能领域重组 ID；通用动作使用共享 ID；加入 Lint 检查 |
| I18N-03 | P2 | 宿主错误 ID 风格不统一：`host.X.y`、`CATALOG_FORMAT_UNSUPPORTED`、`WORKSPACE_FORMAT_UNSUPPORTED`、`LANGUAGE_PACK_*`、`SUBSCRIPTION_*` 并存 | 统一命名规范 |
| I18N-04 | P2 | `sizeLabel` 固定输出 `GB/MB` 并使用 `toFixed`（`types.ts:35`），而 `formatValue` 使用 `KiB/MiB` + `Intl.NumberFormat`（`tagging/i18n.ts:37`）；同一个大小在不同位置显示不同单位 | 统一使用 `Intl.NumberFormat` 的 `unit` 格式 |
| I18N-05 | P2 | 审计日志在宿主侧拼成 `时间 · 工具 · 摘要` 字符串（`CatalogRepository.cs:143-144`） | 返回结构化记录，客户端本地化显示 |
| A11Y-01 | P2 | 卡片上的播放/详情在悬停或获得焦点时显示（已处理 `focus-within`），但“定位文件”“复制路径”只存在于右键菜单（`components.tsx:26-31`），键盘和触控板用户难以发现 | 为卡片与列表行提供可见的“更多”菜单按钮，与右键菜单共用同一动作清单 |

---

## 11. 工程化约束缺失

| ID | 级别 | 问题 | 建议 |
| --- | --- | --- | --- |
| ENG-01 | P1 | 没有任何提交；索引与工作区严重不一致（索引中仍有已删除的 `src/Vroom.UI/*`），无法审阅差异、回滚或二分定位 | 立即建立基线提交；之后小步提交，提交信息说明原因；为发布打标签 |
| ENG-02 | P1 | 没有 CI | 至少包含：Windows 上 `dotnet build/test`、Client `npm ci && tsc && vitest && build`、契约校验、语言包完整性、中立性测试；macOS/Linux 上编译并运行 Core 测试 |
| ENG-03 | P1 | 没有格式化与 Lint：无 `.editorconfig`、Prettier、ESLint（含 `react-hooks` 规则） | 引入并在 CI 中强制 |
| ENG-04 | P1 | .NET 未启用 `TreatWarningsAsErrors`、`AnalysisLevel`、`EnforceCodeStyleInBuild`；测试编译已有可空警告 | 逐步启用分析器，新代码零警告 |
| ENG-05 | P2 | 依赖治理：没有 `Directory.Packages.props`；`package.json` 中部分依赖使用 `^` 浮动范围；通过 npm 包 `node` 固定 Node 24，而本机全局为 v20；`--no-audit` | 中央包管理；所有依赖精确版本；`.nvmrc`/`engines` 约束；CI 中执行依赖审计与许可证扫描 |
| ENG-06 | P2 | 包体预算：主包约 1.8 MB、Monaco 约 4 MB，`chunkSizeWarningLimit` 被调高到 1600 以消除警告（`vite.config.ts:15`） | 设置体积预算；Monaco 仅在 JSON 高级模式按需加载（已部分 lazy），检查主包中的 Spectrum 与图标导入 |
| ENG-07 | P2 | `scripts/verify-*.mjs` 共 15 个端到端/视觉检查脚本，需要手动启动宿主与 CDP，不在任何流水线中 | 整理为 Playwright 测试，在 CI 的 Web 宿主上运行，截图对比 |
| ENG-08 | P2 | 中立性测试只扫描 `Vroom.Core` 与 `Vroom.Client/src` 的 `.cs/.ts/.tsx`，且基于正则（`ProductNeutralityTests.cs:11-18`） | 扩展到 App、Web、CSS；对资源中的业务 key 建立允许清单 |
| ENG-09 | P2 | 协议治理：`clientApiVersion`、`definitionLanguage`、`formatVersion`、包版本没有变更记录与兼容规则 | 每次契约变化记录变更与理由，CI 检查版本是否随契约变化递增 |
| ENG-10 | P2 | 发布工程：未签名、无安装器、无自动更新、无崩溃报告汇总 | 列入发布前必做项 |
| ENG-11 | P3 | 性能基准（`--tag-benchmark`）只能手动运行 | 在夜间流水线运行并记录趋势 |

---

## 12. 文档治理

| ID | 级别 | 问题 | 建议 |
| --- | --- | --- | --- |
| DOC-01 | P2 | `docs/` 约 50 万字节，`VALIDATION.md` 176 KB、`TAG-SYSTEM-REDESIGN.md` 134 KB，大量为历史过程记录；`MIGRATION-V2/V3`、`TAG-VALUE-MIGRATION-V2` 与 AGENTS.md“不保留迁移”的约束并存 | 历史文档移入 `docs/archive/`；保留“当前架构、当前契约、设计准则、I18N、验证方法”五份活文档；重大决策用 ADR |
| DOC-02 | P2 | 文档与实现不一致：`SYSTEM-TAGS.md` 与 `CURRENT-CONTRACT-REVIEW.md` 写 3.2.0/30 个字段，实际为 3.3.0/39 个定义；`ARCHITECTURE.md:99` 仍写“Film 表示一个实际文件”；`ARCHITECTURE.md:113` 写 4096 上下文/384 输出，代码为 16384/2048（`LocalModel.cs:47,53`） | 字段清单由资源生成；文档纳入 CI 一致性检查 |
| DOC-03 | P3 | README 混合了使用说明、功能清单、平台状态、Mac 验证步骤与 HandBrake 说明 | README 只保留简介、快速开始、平台状态与文档索引 |

---

## 13. 一切会让用户不爽的地方（汇总）

按用户感受归纳，便于产品排期时直接引用：

1. 后台一直在读盘：首次扫描后把每个视频完整读一遍；每 30 分钟再扫一遍，NAS 无法休眠，且不能关闭（FN-01、FN-02）。
2. 任务中心被成千上万条逐文件任务淹没，找不到自己刚才的操作（ARCH-05、UX-09）。
3. 看到 `STALE_GENERATION`、`SYSTEM_UPDATE_CONFLICT:…` 这样的原始错误码（I18N-01、UI-03）。
4. 移除再添加同一个影片库，评分、收藏全部丢失（FN-03）。
5. 删掉的文件永远留在库里，没有封面的影片只显示占位图（FN-07、FN-08）。
6. 改个影片库名字就重新扫描整个 NAS（UX-02）。
7. 导入几个文件就多出几个以文件名命名的影片库（UX-03）。
8. 每页只有 30 部，只能一页页翻；“分组”只给一串计数（FN-10、FN-11）。
9. 搜索人物时输入一个字母就匹配所有选项，顺序看起来是乱的（FN-05）。
10. 点一下收藏，整个界面重新加载一遍数据（UI-01）。
11. 恢复工作区时打开已不存在的影片，页面一直转圈（UX-06）。
12. “新建智能列表”打开的是管理页；删除列表不需要确认（UX-04、UX-05）。
13. 没有“继续观看”“最近添加”（FN-09）。
14. 只能用深色主题；标签页多了无法批量关闭；没有常用快捷键（UI-07、UI-08）。
15. 移动或升级程序目录后，播放和转码可能悄悄调用旧目录里的组件（FN-06）。
16. 在 Mac 上只能手动粘贴文件夹路径（XP-01）。
17. 本地助手对复杂请求不可靠，页面上却展示了大量开发者工具（SIMP-06）。

---

## 14. 建议的优化路线

不承诺时间，仅按依赖关系排序。

### 阶段 0：工程基线（其余工作的前提）

- 建立基线提交并清理索引与死代码（ENG-01、CODE-10）。
- 引入格式化、Lint、分析器，一次性格式化全部代码（CODE-01、ENG-03、ENG-04）。
- 建立 CI：构建、单元测试、契约与语言包完整性、中立性测试（ENG-02、I18N-01 的测试）。
- 统一产品版本源（PD-03）。

### 阶段 1：止血（P0）

- 快速指纹替代全量 SHA-256；周期扫描可关闭、未变化文件零写入、批量事务（FN-01、FN-02）。
- 保留与清理策略、维护任务（ARCH-03）；删除 `core.position` 标注复制（PR-01 的最小子集）。
- 修正影片库移除语义与文案（FN-03）。
- 父子任务与任务内存索引（ARCH-05）。

### 阶段 2：核心闭环与正确性（P1）

- 错误码本地化与统一错误信封（I18N-01、ARCH-07 的错误部分、UI-02、UI-03）。
- `file.relativePath` 事实修正与一致性测试（FN-04）；值选项搜索与排序（FN-05）；运行时路径运行期解析（FN-06）。
- 缺失文件检测、默认封面、继续观看/最近添加、分组视图、虚拟化列表（FN-07～FN-11）。
- 推送通道替代轮询、按对象失效、工作区增量保存（ARCH-06、UI-01）。
- 动线整理：统一导入/建库流程与默认值、保存与扫描分离、智能列表入口修正（UX-01～UX-06、SIMP-02、SIMP-03）。

### 阶段 3：协议与架构演进（P1/P2）

- 协议：派生字段、读取期默认值、语义值类型、LocalizedText 简化、集中式布局顺序、结构化微语法、拆分能力注册表、统一图标注册、收敛表达式语言、宿主功能导航回归宿主（PR-01～PR-13）。由于产品未发布，可直接升级 `formatVersion`，不保留旧格式读取。
- 架构：读写分离与短事务、配置预览不占写闸门、结构版本统一、项目拆分与依赖显式化、类型化 RPC 与 TS 代码生成（ARCH-01、ARCH-02、ARCH-04、ARCH-07、ARCH-08）。
- 前端：拆分巨型组件、移除 Semi 风格适配层、结构化草稿（CODE-02～CODE-05）。
- 产品：术语表与“字段与值”工作区合并、配置管理任务化、开发者模式（PD-01、PD-02、SIMP-01、SIMP-05、SIMP-06）。

### 阶段 4：平台与发布

- macOS 文件夹选择与书签、`lstat` 文件身份、路径规范化、解码进程回收、跨平台脚本与字体（XP-01～XP-07）。
- 签名、安装器、自动更新、Playwright 端到端测试纳入 CI（ENG-07、ENG-10）。

---

## 附录 A：证据索引

| 主题 | 位置 |
| --- | --- |
| 全量哈希 | `src/Vroom.Core/Media/MediaIdentity.cs:41-56`；`src/Vroom.Core/Library/LibraryScanner.cs:77-88`；`src/Vroom.Core/Application/ClientApi.cs:167-177` |
| 周期扫描 | `src/Vroom.Core/Library/LibraryScanner.cs:89-107,110-186`；`src/Vroom.Core/Domain/Models.cs:75` |
| 文件身份 | `src/Vroom.Core/Storage/FileIdentity.cs:15-36` |
| 影片库移除 | `src/Vroom.Core/Storage/CatalogRepository.cs:28-31`；`src/Vroom.Client/src/pages/ManagementPages.tsx:24` |
| 相对路径事实 | `src/Vroom.Core/Tagging/TagQuery.cs:9`；`src/Vroom.Core/Tagging/TagAutomation.cs:16-17`；`src/Vroom.Core/Tagging/AutomationPlanning.cs:111` |
| 选项搜索 | `src/Vroom.Core/Tagging/TagQuery.cs:55-63` |
| 运行时路径持久化 | `src/Vroom.Core/ServiceRegistration.cs:41-72` |
| 写闸门 | `src/Vroom.Core/Storage/CatalogDatabase.cs:14-53` |
| 标签表结构 | `src/Vroom.Core/Tagging/TagEngine.cs:15-46` |
| 配置预览/发布 | `src/Vroom.Core/Tagging/TagEngine.cs:145-201` |
| 播放事件 | `src/Vroom.Core/Application/ClientApi.cs:101-110`；`src/Vroom.Core/Tagging/TagAutomation.cs:11-23`；`resources/tagging/core.tagdefs.json:2343-2410` |
| 任务协调器 | `src/Vroom.Core/Jobs/JobCoordinator.cs:26,37-70,124-128,327-332,362` |
| RPC 分派 | `src/Vroom.Core/Application/ClientApi.cs:17-180`；`src/Vroom.Core/Tagging/TagRpc.cs` |
| 客户端同步 | `src/Vroom.Client/src/context.tsx:41-77`；`src/Vroom.Client/src/api.ts:36-76` |
| 错误码 | `src/Vroom.Core/Tagging/TagJson.cs:45`；`src/Vroom.Client/src/api.ts:55`；`src/Vroom.Client/src/i18n/index.ts:57-67` |
| 适配层 | `src/Vroom.Client/src/ui.tsx` |
| 图标 | `src/Vroom.Client/src/icon-catalog.tsx`；`src/Vroom.Client/src/tagging/CapabilityIcon.tsx`；`src/Vroom.Client/src/icons.tsx:48`；`resources/tagging/host-capabilities.json:4851` |
| 智能列表 | `src/Vroom.Client/src/App.tsx:63-69`；`src/Vroom.Client/src/pages/ViewsPage.tsx:19-20`；`src/Vroom.Client/src/workspace.ts:14-16` |
| 导入与建库 | `src/Vroom.Client/src/components/ImportDialog.tsx:11-23`；`src/Vroom.Client/src/pages/ManagementPages.tsx:28-53`；`src/Vroom.Core/Library/LibraryScanner.cs:62-76` |
| 平台差异 | `src/Vroom.App/NativePlatformActions.cs:21-47`；`src/Vroom.App/NativeVideoSurface.cs:104-109`；`src/Vroom.Core/Media/DecoderLifetime.cs:10-18` |
| 协议冗余 | `resources/tagging/core.tagdefs.json`（`core.rating`、`core.cast`、`core.duration` 等定义）；`resources/tagging/host-capabilities.json:3705`（`valueTypes`）、`:5131`（`nativePlayback`）、`:6153`（`onlineSubtitles`）、`:6161`（`network`） |

---

## 附录 B：实施进度（随提交更新）

每项改动都有独立提交，消息里写明了原因；公开契约的变化另见 `resources/tagging/CHANGELOG.md`，验证结果见 `docs/VALIDATION.md`。

### 已完成

- **工程基线**（ENG-01～ENG-05、ENG-08、ENG-09、CODE-01、CODE-07、CODE-09、CODE-10、PD-03、XP-08）：基线提交；CSharpier、Prettier、ESLint、`.editorconfig`；.NET 警告即错误；中央包版本；单一产品版本 `VroomVersion`；`scripts/check.mjs` 与 CI（Windows 全量、Linux/macOS 核心测试、Mac Catalyst 编译）；中立性扫描覆盖 App/Web/CSS；分层测试；客户端与宿主 RPC 契约测试；契约变更记录；`AppSettings` 相等性不再手写。
- **P0 止血**：采样指纹替代全量 SHA-256（FN-01）；增量扫描、批量写入、可关闭的周期扫描（默认启动时 + 每 6 小时）、按根目录相对路径的段/通配符排除、缺失标记与恢复（FN-02、FN-07、FN-12）；每库一个 `media.process` 队列任务（ARCH-05）；保留与清理（ARCH-03）；影片库与单部影片移除先归档且不留孤儿（FN-03、FN-16）；任务状态按名称持久化，活动资源有索引（ARCH-05）。
- **正确性与核心功能**：运行时路径在使用时解析（FN-06）；`file.relativePath` 在所有入口一致（FN-04）；值选项按全部翻译和别名搜索、按显示名排序（FN-05）；缺失徽标、帧封面、未知帧率不再填 30（FN-07、FN-08、FN-14）；继续观看、最近播放、最近添加（FN-09）；分组结果按组分段（FN-10）；连续加载替代每页 30 部（FN-11）；影片库根目录必须是绝对路径且不能与其他库重叠（FN-13）；`settings.save` 已删除（FN-15）。
- **错误与国际化**：全部错误码与宿主消息都有中英文案，统一错误信封与诊断编号，覆盖测试（I18N-01、I18N-03、UI-02）；系统定义更新冲突以结构化警告展示（UI-03）；62 个编号重复的消息 ID 已合并（I18N-02 部分）；文件大小统一格式（I18N-04）；审计日志改为结构化记录（I18N-05）。
- **同步与交互**：长轮询变更通道替代每秒轮询，详情和播放页只在本片有变化时刷新，断线提示（ARCH-06、UI-01）；工作区不再保存可重建的大字段；导入、建库默认值一致，保存影片库只在目录变化时扫描，所有“新建影片库”入口走同一个添加媒体流程（UX-01～UX-03、SIMP-02）；智能列表管理页与结果页分离，删除前确认（UX-04、UX-05、SIMP-03）；失效标签页说明原因（UX-06）；配置发布预览与不兼容标注以本地化列表展示（UX-07）；首次启动说明导入会做什么（UX-10）；标签页批量关闭与快捷键（UI-07）；主题跟随系统（UI-08）；扫描间隔改为选项（UI-06）；新字段默认只标注整部影片、查重默认关闭、key 可读（UI-10、UI-11）；列表名称与指标不再用粗体标签（UI-13）；任务详情原始数据移入诊断（UI-05）；工具栏与“更多”菜单不再重复（SIMP-04）；助手工具目录、手写调用和协议级配置类型移到开发者工具开关后（SIMP-06、PD-02 部分）；设置页显示每个外部组件实际使用的路径（SIMP-08 部分）；关于页显示版本与资料目录（PD-09）；助手页显示模型是否就绪（PD-10）；跨平台等宽字体与平台化的路径示例（XP-06、XP-10）。
- **协议**：读取期默认值与派生字段替代“发现即写入”的常量和事实复制规则，播放位置不再镜像为标注（PR-01、PR-03）；`defaultSort` 改为 `orderBy` 项、分组能力去掉 `facet:<id>` 字符串、`includeArchived` 改名为 `ignoreDefaultQuery`（PR-06）；规则 ID 与写入策略校验（PR-07）；图标注册表成为唯一来源（PR-09、CODE-09）；删除无用例的位运算（PR-10 部分）；宿主功能入口由宿主注册（PR-11）；资料来源 `refresh` 策略（PR-12）；删除预留空结构（PR-13）；正向的“已看过”（PD-04）；自动人物候选只读文件名（PD-07）；术语“字段与值 / 关键词”（PD-01、PD-05）。
- **架构**：纯读取走 WAL 快照（ARCH-01）；所有表在一个模式中、数据库初始化时创建（ARCH-02）；存储层与领域层不再依赖标签系统，`ErrorIds` 统一错误 ID（ARCH-08 部分）。
- **跨平台**：Mac Catalyst 文件夹选择器与其他桌面的“在文件夹中显示”（XP-01、XP-03，未在 Mac 上运行）；Catalyst 目标编译通过；文档归档与漂移修正（DOC-01、DOC-02）。

- **第二轮补充**：依赖显式注入，不再暗中创建第二个标签引擎（ARCH-08）；编译缓存键不再拼接整包文本、按条淘汰（ARCH-04 部分）；Web 调试宿主每次启动生成会话令牌（ARCH-11 部分）；媒体服务的套接字级边界测试（ARCH-09）；启动包体积预算与夜间查询基准（ENG-06、ENG-11）；跨平台启动脚本 `scripts/run.mjs`（XP-07）；非 Windows 平台说明播放模式（XP-05）；两个宿主的资料目录写入 README 并在关于页显示（XP-09）；影片库目录与排除规则改为逐项编辑（UI-09）；播放相关能力拆到 `playback-capabilities.json`（PR-08 部分）；定义编辑器默认只用表单（SIMP-05）；查重“保留多个”合并为同一影片的多个版本，删除 `film_groups`（UX-08）；测试文件按功能命名（CODE-11 部分）。

- **第四轮补充**：值合同只描述单个值，数组形式由 cardinality 派生；引用的值集合写入值合同 `value.vocabulary`，“允许新建值”改为写入策略 `writes.createTerms`，删除 `options`（PR-02）。
- **第三轮补充**：后续任务记录启动它的父任务，任务详情可在父子之间跳转（UX-09）；Unix 文件身份改为原生 statx/lstat，`stat` 进程只作后备（XP-02，CI 在 Linux/macOS 上验证）；客户端 RPC 方法名由宿主分派代码生成为类型，拼错或删除的接口在类型检查时失败（ARCH-07 部分）；真实编码测试不再与其他测试并行，消除间歇失败。

- **第五轮（用户同意后）**：值集合写入值合同、`writes.createTerms`（PR-02）；多语言文案改为语言映射，默认展示样式不再重复命名（PR-04）；区域声明成员顺序（PR-05）；合并“字段与值”与“配置管理”（SIMP-01）；去掉 58 处 `!important`、网格轨道改用自定义属性（UI-12）；表格按内容高度（UI-04）；`ClientApi` 按领域拆分，`TagsPage` 拆出导入导出与新建逻辑，`PlayerPage` 拆出三个对话框（CODE-02 部分）；真实 Web 宿主上的端到端流程进入 CI（ENG-07，接口级，不含浏览器截图对比）。

### 尚未完成及原因

- **CODE-02 其余、CODE-03～CODE-06、CODE-08**：`PlayerPage` 的播放设置对话框、`TagEngine` 的部分方法仍较大；`ui.tsx` 适配层、配置草稿仍以 JSON 文本保存、`any` 约 320 处、`Film` 扁平记录。这些改动影响面大，需要配合界面验收逐步进行。
- **ARCH-04 其余**：客户端包仍附带全部值实体。按需加载需要把选项搜索和值名称显示改为异步，并由宿主在影片视图中投影值名称。
- **ARCH-07 其余**：方法名已类型化，请求与响应结构尚未生成类型。
- **ARCH-11 其余**：资料抓取浏览器仍使用 `--remote-debugging-port=0`；.NET 在 Windows 上无法直接向子进程传递管道句柄，改用 `--remote-debugging-pipe` 需要单独的进程启动实现。
- **ENG-07 其余**：浏览器级（Playwright）截图对比尚未引入，需要新增依赖。
- **ENG-10**：签名与安装器等待证书和发布渠道选择。
