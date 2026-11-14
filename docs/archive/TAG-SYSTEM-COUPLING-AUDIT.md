> 历史设计记录：当前实现仅支持 v3 契约，不再包含旧数据兼容或迁移。以 [当前架构审查](CURRENT-CONTRACT-REVIEW.md) 和 `resources/tagging/` 为准。

# 标签系统业务耦合审计与迁移清单

日期：2026-11-01。状态：保留改造前证据，v1 迁移已实施；下面说明实际覆盖与剩余边界。配套设计见 [标签系统配置化重构技术设计](TAG-SYSTEM-REDESIGN.md)。

本次扫描覆盖自有 React/TypeScript 客户端、Core、MAUI 宿主、Web 宿主及 smoke 入口，排除 node_modules、编译产物和静态资源副本。重点沿“入口 → 查询 → 赋值 → 事件 → 显示 → 工作区恢复”追踪同一语义，不能只搜索中文名后改几处文案。

审计结论：耦合横跨页面、默认状态、图标、数据库、解析器、去重、资料源、Agent 提示词和迁移路径。上一版设计只列出主要模块，下面补齐具体去向。所有业务声明均归标签定义包的 definitions、rules、sources、catalogPolicy 或 ui 子树，布局和 i18n 不新增第三类配置文件。

## 实施核对

C01–C15、C17–C33 的专有业务决策已迁入默认声明、规则、来源、catalogPolicy 和 UI 配置，旧实现隔离到迁移目录。`ProductNeutralityTests` 扫描活动代码，阻止新增专有 key/枚举/名称分支；测试使用陌生用户标签验证行为。C16 支持配置标注行的值、时间、备注和播放/编辑/清空动作，不等于完整多轨视频剪辑器。C35 的契约、迁移、工作流测试与 README 已更新。

部分目标有边界：C06 未实现完整权重搜索排名；C08/C13 的任意表格/候选模板能力有限；C29 未完整实现逐站点重试与冷却；C34 中立宿主的旧任务/错误文字尚未全部结构化。扩展节点和事件以公开清单的 implemented/reserved 为准。查询分组不展开多值数组，配置重投影尚未分阶段换代。业务决策已迁移不代表表中所有远期 UI/性能目标已实现。

## 1 逐项迁移清单（改造前证据）

| 编号 | 位置与当前证据 | 迁入的声明 | 验收方式 |
| --- | --- | --- | --- |
| C01 | Client/App.tsx：固定收藏/未看过入口与查询字符串 | 标签 navigation、placements 与 ui.navigation | 删去这两个定义后入口消失；换 key 后仍可导航 |
| C02 | App.tsx、ManagementPages.tsx、workspace.ts：“标签与演员”、TAGS & PEOPLE、搜索演员等文案 | ui.navigation / ui.layouts 的 LocalizedText；默认统一“标签” | 导航、页面标题、tab、搜索提示及无障碍名称一起变化 |
| C03 | workspace-icons.tsx：根据 favorites/unwatched/hidden ID 选专有图标 | navigation.icon、ui.tabPresentation；对象/动作图标角色契约 | 更换入口 ID 不改变图标语义，组与成员不撞图标 |
| C04 | workspace.ts：tab 标题和旧中文名称重映射 | titleBinding、稳定 viewId 与一次性迁移表 | 切语言不改变 tab ID、分组、顺序或草稿 |
| C05 | browser-state.ts：固定 rating 状态 | 以 fieldKey/filterId 为键的动态筛选草稿 | 新增另一数值筛选不加 TS 状态属性 |
| C06 | LibraryPage.tsx：搜索只拼 title/code/tag 三字段 | catalogPolicy.search.fields、matchMode、权重与 label | 增减搜索字段只改声明；输入仍编译成有类型 AST |
| C07 | LibraryPage.tsx：固定评分筛选、排序选项、评分/番号分组 | query 能力、facets、library.filters/sorts/groupings 区域 | 新标签能筛选/排序/分组，停用字段不会扩宽结果 |
| C08 | LibraryPage.tsx：列表列固定为番号/评价/时长/大小 | ui.layouts 的表格列与 placements | 同一声明控制海报、列表和智能列表结果 |
| C09 | components.tsx/FilmCard：右上角收藏、左上角高度、底部评分、编号占位 | 卡片布局区域、可交互值组件、display 和 ui.identity | 只换 schema 即可把另一布尔标签放右上角 |
| C10 | FilmCard、LibraryPage、FilmPage、DuplicatesPage：code 优先于 title 的标题回退 | ui.identity 的数据绑定与回退次序 | tab、卡片、去重组标题使用同一解析器 |
| C11 | FilmPage.tsx：固定标题/评分/收藏/已看输入、保存参数 | film.details 布局、动态 form 与 annotations.batch | 任意字段类型都可加入，保存只写变更字段 |
| C12 | FilmPage.tsx：演员紫色、番号/评分不能移除、kindNames | 标签 display.token、writes、query 与通用只读状态 | 无 kind 数值分支；只读提示来自同一声明 |
| C13 | FilmPage.tsx、ClientApi.film.get：suggestedPeople 与固定“路径中的演员候选” | 通用 candidate collection、规则 targetKey、候选条目布局 | 新增厂牌或日期识别也出现在同一候选区 |
| C14 | FilmPage.tsx：固定文件与来源、简介、片段区域 | section/field-set/collection 布局、数据源与 provenance 绑定 | 可增删分区和改变列布局，不改页面 JSX |
| C15 | PlayerPage.tsx：硬编码整片标签云、单一 tagName、固定点/区间输入 | player.inspector 布局、作用范围选择器与通用 TagInput | 数字、评级、多选都可标记整部/点/区间，遵守声明 temporal |
| C16 | PlayerPage.tsx：片段行只显示标签名、时间与备注 | 时间轴轨道及条目模板、value view、row actions | 每条标注显示自己的类型化值，条目动作可配置 |
| C17 | PlayerPage.tsx：信息侧栏固定编码/时长/分辨率/路径 | 通用 inspector profile 与只读 field-set | 与信息页复用字段、来源和 formatter，不再复制逻辑 |
| C18 | PlayerPage.tsx：截图下载文件名优先使用 code | ui.naming 的规范值表达式与宿主文件名净化 | 切语言不改默认文件名；没有编号也可稳定命名 |
| C19 | usePlayback.ts、ClientApi.film.position：ended 直接写 Watched | 播放事实事件 + automation，位置由播放账本维护 | 删除观看状态声明不影响播放；旧事件不覆盖新人工状态 |
| C20 | DuplicatesPage.tsx：默认番号、演员/厂牌复选项、画质比较项 | catalogPolicy.dedup、比较布局、建议排序与解释文案 | 任意标签组合可成为查重规则，不再依赖 Kind 1/2/4 |
| C21 | DuplicateService.cs：Height/Size 固定保留排序，Archived 写入 | 声明式推荐排序、复核后标注操作；资源分组仍为事务能力 | 规则切换可改变推荐，用户选择与资源分组保持原子性 |
| C22 | ManagementPages.tsx：固定标签类型、禁止改名/删除某些 kind、tagtree 按名称 | 声明类型能力、来源与写策略；查询使用 key | 同名标签不混用，用户覆盖可独立管理 |
| C23 | ViewsPage：固定 DSL 示例、排序与分组选项 | 动态 QuerySchema、UI message、声明示例 | 新标签无需更新前端文案或枚举 |
| C24 | SettingsPage 与 AppSettings：单一 metadataUrlTemplate、{code} 提示 | sources 配置与 source editor | 可以多个来源、任意输入属性；凭据单独保管 |
| C25 | Models.cs/types.ts：TagKind、FilmRating、ratingNames/kindNames、固定业务字段 | TagDefinition/ResolvedTagValue、facets、LocalizedText | 运行时不存在特殊业务枚举；迁移适配层例外 |
| C26 | CatalogDatabase/CatalogRepository：五档 seed、固定列、号码规范化、评分同步、protected kind | 数据包默认声明、通用标注写服务、类型索引 | 移除系统默认包后仓库仍可服务其他合法定义 |
| C27 | QueryAsync/FilterCompiler：固定字段白名单、archived 默认谓词、中文“未分类”当组键 | catalogPolicy + Query AST；分组键为 typed-null，显示文案本地化 | NULL 组不会与名称叫“未分类”的实际值合并 |
| C28 | PathTagParser/LibraryScanner：固定番号模式、评价词、演员识别、探测与补全条件 | rules、匹配别名、事实事件、数据状态谓词 | UI 语言变化不改变解析结果；旧规则用夹具等价验证 |
| C29 | MetadataService.cs：JavBus/NFO 的查询参数、字段、匹配、来源顺序、合并与标题锁 | sources + enrichment + per-value provenance/editPolicy | 同一网页只获取一次，多标签复用，不覆盖人工值 |
| C30 | BackgroundOperations/AgentTools：默认 Code 去重与专有更新参数 | catalogPolicy.dedup 与通用原子命令 | 后台和 UI 使用同一默认配置 |
| C31 | AgentTools.cs/LocalAgent：提示词固定 0–4 评分和 rating >= 2；AgentPage 固定“按番号”等例子 | 从有效定义生成工具语义，agentHints 与本地化示例 | 换评分范围/名称后模型不继续使用旧五档 |
| C32 | LocalMediaServer.cs：/poster 路由直接读取 Film.PosterPath | assetRef 解析与受限资源服务；图片用途由声明绑定 | 可配置另一图片标签，不能借 assetRef 读取任意文件 |
| C33 | styles.css：film-rating 等用途专用样式，固定技术 formatter | 通用组件/区域样式与 Spectrum token；format 由声明选择 | 换标签 key 不需要新增 CSS；布局仍统一对齐 |
| C34 | Jobs/Audit/ClientApi 错误返回：保存最终中文句子 | messageRef + typed args + message revision；宿主中立词条包 | 历史任务换语言可读，结构化错误码不随语言变 |
| C35 | README、tests、Smoke：五档查询和固定标签夹具 | 旧行为迁移夹具、新 schema 契约夹具与文档 | 旧兼容用例保留，不把旧业务规则继续装入运行时 |

表中 Client 指 `src/Vroom.Client/src`，Core 类型位于 `src/Vroom.Core`。这是按可追踪行为归并的清单，不把重复命中行冒充独立功能。

## 2 必须保留的技术约束

以下命中不应机械搬进用户可修改的业务 schema：

| 能力 | 保留在宿主的部分 | 配置可以决定的部分 |
| --- | --- | --- |
| FFmpeg/FFprobe | 真实编码、时长、画面尺寸、流偏移、取消和进程隔离 | 事实如何变成标签、如何格式化和展示 |
| 播放与时间标注 | 媒体身份、原始时间轴、精确范围校验、当前播放实例 | 哪些事件触发标签规则、标注输入与轨道显示 |
| 文件系统 | 授权根、真实路径、路径比较规则、资源读取和写入边界 | 路径解析策略、展示名、导出文件名模板 |
| 数据库 | 外键、CAS、事务、参数化 SQL、任务与 outbox 持久化 | 标签的业务约束、默认查询、分组与去重策略 |
| 网络与资源 | 访问授权、协议、目标地址校验、响应限额、资源令牌 | 来源 URL/提取方式/字段映射，限制只能收紧 |
| 标签关系 | 无环、key 身份、引用一致性 | 节点、边、标签值及分类入口 |
| 工作区 | 保活、焦点、拖动、关闭草稿保护、tab 对象身份 | 标题绑定、入口、对象图标与动作图标的配置 |

特别是 usePlayback.ts 中用真实 duration 限制 seek 和 LocalMediaServer 中的播放能力令牌，属于技术真实性与安全边界。把它们改成读取可被用户停用的标签，反而会损坏播放。读取位置应改为 MediaResource/PlaybackFacts DTO，与业务标签投影分开，而非删除这些约束。

## 3 产品语言的统一

默认导航和管理页统一为“标签”；“演员”只是内置包中的一个分类入口，不再属于管理模块名称。播放器原“标签与片段”默认改为“标注”，覆盖整部、时间点和区间；可通过布局标题的 LocalizedText 修改。

标签页搜索默认文案为“搜索标签”，根据有效定义的搜索能力执行。子节点区域称为“包含的标签”，类型列展示声明的输入/值类型或用户配置的分类，不再映射 Custom/Performer/Studio 枚举。定义、关联、使用情况的动作名称保持明确，并全部进入 i18n 词条。

系统固定视图恢复按稳定 ID 重新解析标题；仅用户主动命名的视图/副本保存其自定义文字。禁止每次启动都按旧中文标题做字符串替换，这会破坏多语言和用户自定义标题。旧“标签与演员”等名称只允许留在一次性迁移映射与测试夹具中。

## 4 验收与防止再次耦合

1. 编译时扫描通用模块对 `core.rating/core.favorite/core.cast` 等具体 key 的引用，默认业务包、显式迁移和测试夹具以外禁止出现。
2. 禁止业务代码读取 `kind === 1/2/3/4`、ratingNames、专有 watched/favorite 字段，以及按显示名称构造查询。
3. 禁止将 tag key 拼成 CSS 类选择业务颜色；只允许组件 ID、slot/region ID 和设计 token。
4. 使用另一套无评分/演员/番号的样例配置运行：例如片长、学习进度、来源频道、笔记。信息页、标注、查询、查重、导入导出和 Agent 仍应可用。
5. 用随机 key 重命名整套默认声明，保持引用同步。行为不变才说明没有隐藏的 key 判断。
6. 切换 zh-CN/en/RTL 与伪本地化，核对导航、tab、空状态、错误、Tooltip、读屏文案及 Monaco 说明；结果集合和规则输出不能因语言改变。
7. 每项迁移交付时登记实际改动文件与验证记录；本审计表不会因新增设计段落就被标为“已完成”。
