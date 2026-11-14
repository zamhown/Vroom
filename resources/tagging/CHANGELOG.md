# Public contract changes

Every change to a file in `resources/tagging/` that alters what a host, client, Agent or exported package may rely on is recorded here with its reason. Bump `clientApiVersion` when RPC shapes change and the built-in package version when `core.tagdefs.json` changes. The product is unreleased, so only the current contract is supported; there are no readers for earlier shapes.

## clientApiVersion 15 · core package 3.12.2

- **Heart icons (3.12.2)**: registers Spectrum `Heart` and `HeartFilled` in the shared icon catalog and icon-toggle parameter contract. The built-in favorite definition uses outlined/filled hearts for its inactive/active states and a heart in navigation, consistently across cards and the playback queue. This is a presentation-only definition revision; stored values and annotation semantics are unchanged.

- **Shared page chrome and case presentation**: every page ribbon docks through the shared page toolbar host, including film details. Task tabs use compact height and collapsed chrome has equal vertical insets. Case presentation reserves separate status/artwork/action regions; bottom metadata stays below the title, and hover commands no longer cover the artwork. Existing resource visibility, inherited disabled conditions, slots and command contracts are preserved.

- **Ribbon hierarchy (3.12.1)**: page identity and count sit beside a distinct task selector; a single command surface uses captions above consistently sized controls. The collection toolbar occupies a fixed page header above the content scroll viewport, retaining its top inset and clipping scrolling cards below its boundary. Default browsing groups have clearer names. Poster sizing is a named popover with its visible label and value. Narrow containers retain named groups, falling back to an all-commands popover when the group names themselves cannot fit. No command, annotation or query contract changes.

- **Ribbon layout**: registers `ribbon-layout@1` for `film.details` and `library.actions`. Resource-authored `ribbon → ribbon-tab → ribbon-group → action-bar/control` nodes define localized task tabs, groups and command order. Controls reference the single `$defs.layoutControl` capability registry; unavailable controls, orphan groups and malformed nesting are rejected before publication. Optional film ribbon `binding` references an identity definition. The collection surface does not evaluate per-film conditions.
- **Collection commands**: registers import, play, query, save-view, select, copy, scan, export and remove commands with surface restrictions. The default list uses Browse/Organize tabs; film details use Film/Information. Collapsed state and selected task are retained per workspace tab; narrow containers expose groups through Spectrum popovers. Interface preferences do not alter definitions or film values.

## clientApiVersion 14 · core package 3.11.0

- **Batch enrichment**: adds resource-authored `library.actions` and reviewed `metadata.bulk.preview/commit/status`, with frozen targets/revisions, atomic per-film checkpoints, persistent retry/cancel and conflict reporting. Source-wide failures stop the current attempt with `deferred` items instead of failing every remaining film; cooldown outcomes retain the original localized `cause` and `retryAt`.
- **Poster presentation**: `ui.identity.*` members are now schema-checked expressions (`title`, `tabTitle`, `primaryImage`, `primaryImagePresentation`). The new `primaryImagePresentation` returns a registered `host-capabilities.json.imagePresentations` entry (`image@1`, `disc-case@1` with `view` and `spine`) and may read `primaryImageFacts` (`image.width`, `image.height`, `image.aspectRatio`). Film reads add `presentation.imageSize` and `presentation.imagePresentation` (parameter defaults filled in, `null` when the result is not a registered presentation). Reason: film lists show each poster at its own ratio, and an unfolded disc case as a 3D case or one cover, without product code knowing which field holds that choice.
- **Built-in package**: adds `core.poster.presentation` (vocabulary `core.poster.presentations`: whole poster, disc case 3D/front/back). When unset, posters with a width ÷ height between 1.4 and 1.6 are shown as a 3D disc case. Built-in package 3.11.0.

## clientApiVersion 13 · core package 3.10.0

- **Capability files**: playback presentation, native mpv settings and requests, external player profiles and online subtitles moved from `host-capabilities.json` to `playback-capabilities.json` (`urn:vroom:schema:playback-capabilities:1`). Reason: the host file mixed the tagging contract with unrelated domains.
- **Value contract**: `value.schema` always describes one value; `cardinality: "many"` stores a duplicate-free array of such values and the host derives the array schema. Array schemas on many-valued fields are rejected. Reason: cardinality and the array schema had to be kept in sync by hand. Built-in package 3.7.0.
- **Enumerable fields**: the referenced collection is `value.vocabulary` (part of the value contract) and permission to create new terms is the write policy `writes.createTerms: { namespace? }`; the separate `options` object is removed. Built-in package 3.8.0.
- **Localized text**: a literal is a locale-to-text map such as `{"zh-CN":"评价","en":"Rating"}`; the per-text `defaultLocale`/`values` wrapper is gone. Readers use the requested locale, its language, the package `i18n.defaultLocale`, then the first entry. Shared messages keep `{params, values}` and are referenced with `{message, args}`. The default display style no longer repeats a label; the host names it. Built-in package 3.9.0 (about 15% smaller).
- **Placement order**: placements no longer carry `order`/`priority` numbers; each region lists its members in `ui.placementOrder.<slot>` and unlisted members follow in key order. The field designer moves a field earlier or later within a region. Built-in package 3.10.0.
- **Workspace**: field management and configuration management are one "Fields and values" workspace with fields, values and rules/configuration sections; `ui.placementOrder` is a user-layer configuration kind.

## clientApiVersion 12 · core package 3.6.0

- **Errors**: every RPC error is a message ID (`error.CODE` for domain codes, `host.*` for host messages) with optional `errorArgs` and a JSON Pointer `path`. Unexpected failures return `error.unexpected` with a `diagnosticId` instead of exception text. Failed tasks store the same IDs. Reason: users saw raw codes and exception text.
- **Task states** are camelCase names (`queued`, `running`, `completed`, …) instead of enum ordinals. Reason: ordinals leaked into client code as magic numbers.
- **New RPCs**: `changes.wait` (long-poll change feed replacing per-second polling), `library.remove` and `films.remove` (archive, then remove without orphans), `view.delete`, `maintenance.run`, `maintenance.status`, `runtime.status`. `settings.save` was removed; use `settings.patch`. Bootstrap adds `version`, `dataDirectory` and `platform`.
- **Media follow-up work** is one `media.process` task per library instead of one `media.probe`/`metadata.enrich` task per file.
- **`value.default`** (definition value contract): a rule expression over discovery facts that is projected for films without an annotation and never written as an annotation. A field with `writes.manual: false` and no rules is derived from facts. Built-in constant and fact-copy discovery rules were replaced by defaults. Reason: up to fifteen annotations, history rows and events were written per discovered film.
- **Query**: `includeArchived` is renamed `ignoreDefaultQuery` (it skips `catalogPolicy.defaultQuery`). New host `scope`: `continue-watching`, `recently-played`, `recently-added`. Grouped queries without an explicit sort return films ordered by group with a `groupKey`.
- **`catalogPolicy.defaultSort`** is an `orderBy` item (`tag`, `direction`, `nulls`, `mode`) and is schema-validated.
- **`query.groupBy` capabilities** are `value`, `member` and `facet`; `facet` covers every declared band set (was `facet:<id>` strings).
- **Rules**: rule IDs must be meaningful (not purely numeric) and unique per field; `manualClearBlocksAutomatic` is rejected on fields that cannot be edited manually.
- **Icons**: the icon registry is the single source; publication rejects unregistered icons. Registered `Text`, `TextAlignLeft`, `Number`, `Slider`, `Toggle`, `Image`, `Calendar`.
- **Sources**: `refresh: "missing" | "always"`; automatic enrichment consults a `missing` source only while a field it fills has no annotation.
- **Expressions**: removed the unused bitwise operators `bit-and`, `bit-or`, `bit-not`, `shift-left`, `shift-right`.
- **Removed reserved structures**: `templates`, `extensions`, `ui.navigation`, `ui.tabPresentation`, `reservedEvents`. Host features (fields and values, configuration, export) are host navigation.
- **Built-in package**: removed `core.position` (playback position is a host clock); `core.unwatched` became `core.watched`; the labels field is named Keywords; automatic person suggestions read only the file name; rule IDs are descriptive.
- **Facts**: `file.relativePath` is relative to the library root for every entry point (file name for direct file imports).

### 工作区消息侧栏

新增资源配置的 `workspace.sidebar` / `activity-feed` 与只读 `activity.list`，统一展示批量修改、导入、补全等持久化任务和待审核建议。支持最近更新排序、游标分页、待处理筛选、按工作区保存折叠状态与建议对比审核；不建立第二套标注/任务存储。
