# 系统标签 3.12.1

由 `resources/tagging/core.tagdefs.json` 登记；下表仅作说明，运行时以资源为准。

| 名称 | 稳定 key | 对象 | 录入组件 |
| --- | --- | --- | --- |
| 评价 | `core.rating` | 影片 | `rating@1` |
| 收藏 | `core.favorite` | 影片 | `toggle@1` |
| 已看过 | `core.watched` | 影片 | `toggle@1` |
| 标题 | `core.title` | 影片 | `text@1` |
| 番号 | `core.code` | 影片 | `text@1` |
| 简介 | `core.description` | 影片 | `textarea@1` |
| 海报 | `core.poster` | 影片 | `asset@1` |
| 海报展示方式 | `core.poster.presentation` | 影片 | `select@1` |
| 显示状态 | `core.visibility` | 影片 | `select@1` |
| 主演 | `core.cast` | 影片、时间点、区间 | `multi-select@1` |
| 厂牌 | `core.studio` | 影片 | `multi-select@1` |
| 标签 | `core.labels` | 影片、标签值、时间点、区间 | `multi-select@1` |
| 文件路径 | `core.file.path` | 影片 | `text@1` |
| 文件大小 | `core.file.size` | 影片 | `number@1` |
| 添加时间 | `core.added` | 影片 | `text@1` |
| 修改时间 | `core.modified` | 影片 | `text@1` |
| 时长 | `core.duration` | 影片 | `number@1` |
| 画面宽度 | `core.video.width` | 影片 | `number@1` |
| 画面高度 | `core.video.height` | 影片 | `number@1` |
| 帧率 | `core.video.fps` | 影片 | `number@1` |
| 视频编码 | `core.video.codec` | 影片 | `text@1` |
| 音频编码 | `core.audio.codec` | 影片 | `text@1` |
| 所属影片库 | `core.library` | 影片 | `text@1` |
| 性别 | `core.person.gender` | 标签值 | `select@1` |
| 出生日期 | `core.person.birthdate` | 标签值 | `date@1` |
| 发行日期 | `core.release-date` | 影片 | `date@1` |
| 导演 | `core.director` | 影片 | `multi-select@1` |
| 系列 | `core.series` | 影片 | `multi-select@1` |
| 语言 | `core.languages` | 影片 | `multi-select@1` |
| 笔记 | `core.notes` | 影片、时间点、区间 | `textarea@1` |

字段声明不能被标注；“出生日期”“性别”的主体是人物集合中的具体值实体。未知日期/评分保持未设置。标签值的名称、描述和别名是实体自身元数据，不额外创建同义字段。

“海报展示方式”未设置时，由 `ui.identity` 的 `primaryImagePresentation` 按海报宽高比自动判断：介于 1.4 与 1.6 之间（接近 3:2）视为影碟包装盒展开图，以影碟-3D 展示，其余完整展示。

39 个字段、6 个配置分组、9 个值集合。字段清单以 `resources/tagging/core.tagdefs.json` 为准，本表只是说明。禁止用验收字段或测试人物填充系统包。
