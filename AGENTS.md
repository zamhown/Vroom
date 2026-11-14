# Repository constraints

## Product neutrality (mandatory)

- Product code must not know any particular film tag, label, category, value band, business key, or default identity rule. No branches on rating/favorite/watched/performer/code/studio, `TagKind`, specific `core.*` keys, translated labels, or equivalent numeric discriminators in the active product path.
- Business definitions, navigation, placements, identity/title fallbacks, query/search/dedup policies, initialization, enrichment, and automation belong in the versioned public tag definition resources. Changing those resources must change behavior without changing C#, TypeScript, JSX, or CSS.
- Only default resource files and test fixtures may name concrete business tags. Storage contains neutral media facts and schema-driven annotation projections. Do not add a special-purpose repository/service/component to evade this rule.
- This product is unreleased: support only the current public contract. Do not introduce old-format readers, migration code, duplicate representations, legacy physical columns, or draft conversion. Reject unsupported formats explicitly. Development sample catalogs may be recreated; media files and unrelated catalogs must not be deleted. Definition changes within the current contract still preserve history and invalid-annotation diagnostics.
- All UI, queries, deduplication, automation and Agent reads use the same effective annotation projection. Incompatible raw annotations stay in history/diagnostics and never leak into normal reads. User definitions replace system definitions by key; never modify the installed system layer from a user operation.
- Media identity, real file paths, FFmpeg facts, playback clocks, authorization, transactions, concurrency control and DAG acyclicity remain host invariants. Display tags cannot change those facts or bypass these invariants.
- Every built-in tag must have a meaningful localized description. User descriptions are optional. Render description, provenance and field actions in the same shared field-info popover for hover and click; use the shared searchable/creatable Tag Select rather than separate select and create fields. Form sizing and ordering are generic component/layout behavior, with optional schema hints; never branch on a concrete tag key.
- All schema-authored user-facing copy uses the shared localized text contract, including help, errors, accessibility and editor descriptions. Stable IDs, parser aliases, regular expressions and stored values are not translations.
- Follow `docs/I18N.md`: interface copy lives in versioned ICU language packs and code references stable message IDs, never literal copy or language-specific branches. Keep interface packs independent from declaration translations; translation choices are their declared/installed union. Persist preferences after first-launch system matching. Language changes must preserve drafts and mounted players.
- UI layout comes from registered surfaces, layout nodes, regions, components and commands. Use Spectrum design tokens, shared spacing, system fonts, and the existing maximum-width page container. Do not add tag-specific CSS or remount video when configuration/locale changes.
- Follow `docs/DESIGN-GUIDELINES.md` for all UI work. Form hierarchy comes from grouping, alignment and ownership before typography: keep help and local actions with their controls, use shared FormLayout/FormField primitives, small subdued captions, normal-contrast values, restrained borders, and container-based responsive sizing. Never substitute placeholders for visible field labels.

## Value entity boundary (mandatory)

- Tag declarations describe fields; only films and independent enumerable value entities (`term`) are annotation subjects. Never annotate a field declaration or create a boolean declaration for a new enum option.
- Value identity is an immutable stable ID, separate from localized names and field keys. Equal names do not imply equal identity. Collections and configuration groups are metadata, not synthetic annotation fields.
- Every enumerable value uses a stable `{ "term": "id" }` reference; never add a second string/literal codec. Every mutation path must preserve one acyclic effective term-reference graph across all fields. Validate the final transaction graph; preserve incompatible raw records for diagnostics. UI, query, bulk and Agent must share subject/vocabulary/reference validation.

## Public contract and built-in Agent

- `resources/tagging/` is the authoritative, versioned public schema/defaults/knowledge resource. Package it with both hosts and expose it through the knowledge API. Keep runtime validators, Monaco completion, exported packages and Agent tool documentation consistent with it.
- Value contracts (`value.schema`, `value.cardinality` and, for enumerable fields, `value.vocabulary`) are authoritative. `value.schema` describes one value; cardinality derives the set form; the referenced value collection belongs to the contract, not to presentation options. Recommend and validate input controls from public capabilities; never change a stored data type merely because a presentation component changed. Do not introduce a second independently mutable type discriminator.
- Register executable component/executor parameters and compatible types in `host-capabilities.json`; editor dependencies must not duplicate that registry. Validate configuration semantically before preview/publication. All film query consumers use `query.schema.json` and the typed query compiler, including scopes, references, sorting and grouping.
- Compile only `DefinitionDocument`; a client projection with appended terms must never enter the configuration compiler. Keep effective projection updates and DAG checks in the same transaction, batch page reads, and avoid full reprojection for label-only edits. WAL readers must observe a complete committed generation.
- The built-in Agent must discover definitions and read the same public schema before constructing unfamiliar values. It may edit only the user layer. All writes go through the normal validation, generation/revision checks, reviewable previews and audited command APIs; there is no privileged Agent bypass.
- Bulk annotation must freeze target IDs and revisions in a preview, validate values, be resumable/cancellable through the persistent task center, and report conflicts rather than silently overwriting concurrent edits. Never run a mutable query repeatedly during execution.
- Definition changes, imports and bulk operations must preserve original data and support failure recovery. Never reset a user's catalog to make tests pass.

## Validation

- Test schema validation, merged DAG cycles, override precedence, valid intersections, import/export, unsupported-format rejection, stale writes and bulk retry/cancel behavior with temporary databases.
- Test dynamic UI and public contracts with unfamiliar tag keys and definitions; tests must not merely repeat the implementation. Add a regression check for concrete business-tag dependencies outside the approved boundaries.
- Run relevant .NET tests, TypeScript/build checks and frontend tests. Record actual validation and limitations; do not describe a design or stub as shipped functionality.

## Engineering gates

- Run `node scripts/check.mjs` before committing; CI (`.github/workflows/ci.yml`) runs the same gates. It covers CSharpier, Prettier, ESLint, `tsc`, Vitest, `dotnet build` (warnings are errors) and `dotnet test`.
- Format with `dotnet csharpier format .` and `npm --prefix src/Vroom.Client run format`. Package versions live in `Directory.Packages.props`; the product version lives only in `Directory.Build.props` (`VroomVersion`).
- Client npm scripts use the project Node runtime from `node_modules/.bin`; run ESLint through `npm run lint`, not a global Node.
