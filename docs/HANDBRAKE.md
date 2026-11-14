# HandBrake integration

## Engine and public contract

The adapter runs the official standalone [HandBrakeCLI](https://github.com/HandBrake/HandBrake/releases/tag/1.11.2), with no shell interpolation. Supported options are discovered from the installed CLI's `--help`; native presets, encoder presets/tunes/profiles/levels, source title JSON and progress JSON come from that same executable. The official [CLI reference](https://handbrake.fr/docs/en/latest/cli/command-line-reference.html) describes the encoding semantics. In 1.11.2 on the tested Windows machine the editor exposes 141 encoding options; a different build can expose a different set.

`resources/tagging/media-export.json` registers the media surface, components, groups, localized copy, technical defaults and Agent tools. `media-export.schema.json` validates preview requests. Both are embedded, copied to host outputs and discoverable through `knowledge.list/read`, `schema.get` and `capabilities.describe`. The effective catalog projection supplies catalog source titles; no business tags are named by export code. Presets are stored under the user catalog's `export.presets` setting. Installed system definitions and HandBrake GUI preferences are never modified.

RPCs:

| Command | Input / result |
| --- | --- |
| `export.capabilities` | `{refresh?:boolean}` → engine fingerprint, options, built-in/user presets, public UI contract |
| `export.encoder` | `{encoder:string}` → supported speed/tune/profile/level values |
| `export.preset.resolve` | `{presetName:string,preset?:object,options?:Record<string,string|null>}` → effective native preset JSON after validated overrides |
| `export.scan` | `{filmId?:string,sourcePath?:string}` → persistent scan job ID; exactly one source |
| `export.preview` | request matching `media-export.schema.json` → immutable preview token, targets, preset, attachments, schedule |
| `export.commit` | `{previewToken:string}` → deterministic job IDs and per-target conflicts; retries do not duplicate jobs |
| `export.preset.save/delete` | user-only native preset storage by name |
| `export.log` | `{jobId:string}` → bounded log tail for an export job |
| `export.reveal` | `{jobId:string}` → desktop reveal of a completed result |
| `job.scheduler/configure` | read/save `{maxWorkers:1..16,maxEncoders:1..maxWorkers,paused:boolean}` |
| `job.schedule` | `{id,schedule:{priority:-10..10,notBefore?:ISO8601}}`, only queued/paused jobs |

Input/output, queue-import and preset file write switches are host-managed and cannot be supplied as encoding overrides. Native preset import/export is provided through dedicated controls. Options are passed as individual argv entries, so paths, quotes and flag-like values cannot inject shell commands or replace host-managed destinations. Normal validation checks option availability/arity/numeric values and contradictory selections; codec/container/filter combinations are ultimately validated by HandBrake and their errors appear in the persistent task record and log.

## Scheduling and file safety

A single catalog lease owns scheduling. Admission uses durable priority and submission order, honors `notBefore`, and enforces global and encoder limits before launching handlers. Waiting work consumes no worker slots. Cooperative checkpoint pauses release slots and rejoin admission on resume. Playback tasks registered without a background worker remain independent of background queue suspension. Decreasing a limit drains existing work instead of killing it.

Encoding uses restart-on-pause: cancel the process tree, wait for both pipes and process exit, remove staging files and persist `Paused`. Resume uses the same job ID and a new attempt; it does not claim byte/frame-level continuation. Normal cancellation and shutdown stop the process tree. On Windows a kernel Job Object with [KILL_ON_JOB_CLOSE](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information) also contains the encoder if the host crashes.

Previews freeze exact source IDs/paths, catalog media revisions, real file sizes/timestamps (a metadata tree digest for disc directories), attached subtitle file stamps, engine fingerprint, native preset and overrides. No catalog query runs again during encoding. Each target has a stable job ID and normalized output resource key. Batch commit reports individual conflicts and can be resubmitted safely after partial admission. Sources must remain readable, destination parent directories must already exist, and destination files must not exist. There is no overwrite mode.

Output is encoded in a dedicated staging directory on the destination volume. A successful CLI work-done message, nonempty file, and FFprobe video/duration checks precede a durable SHA-256 receipt. Publication uses a non-overwriting rename while holding the task control gate. A stop cannot relabel an already committed output as cancelled. A restart finding an existing destination accepts it only if it matches that job's durable receipt; otherwise it reports a conflict. Failed/cancelled runs clean only their staging video/preset, leaving sources, pre-existing outputs and diagnostic logs intact. The small staging directory and lease file are retained for ownership/recovery. Logs are bounded to 8 MB per attempt; the UI reads at most the final 64 KB.

## Validation and limits

Real integration tests generate their own media in temporary directories. They exercise source JSON scan, MP4/MOV/MKV/WebM software encoding, duplicate audio output tracks, external UTF-8 SRT, destination/source conflicts, pause/cancel, restart/retry and recovery after a simulated interrupted final state following a completed rename. Scheduler tests independently verify admission, priority, checkpoint-slot release, queue persistence, retry checkpoints and atomic finish behavior. Protocol tests cover split/escaped JSON, option isolation, schema validation and unfamiliar controls. Existing product-neutrality and tagging migration/recovery tests remain enabled.

Windows MAUI and localhost Web share this implementation. Real encoding, GUI flow and builds were checked on Windows x64. macOS/Linux, optical-disc devices and specific hardware encoders have not had live validation here; iOS/Android cannot spawn HandBrakeCLI. Preview does not perform a trial encode, so an unsupported codec/container/filter combination can still fail as a queued task. Upstream GUI-only facilities such as visual crop handles and live before/after image comparisons are not reproduced; the corresponding numeric encoding/filter parameters are available. Encrypted-disc decryption is not added. This integration does not claim feature-for-feature parity with the upstream desktop application's entire UI.

## Distribution

`scripts/setup-handbrake.ps1` pins version 1.11.2 and SHA-256 for Windows x86_64/aarch64 archives. `setup-runtime.ps1` includes it unless `-SkipHandBrake` is specified. The Unix runtime script links an installed CLI; set a custom path in app settings as needed. `publish-windows.ps1` includes the CLI and upstream documentation. HandBrake's `LICENSE` and GPLv2 `COPYING` are preserved in `docs/licenses/` and the runtime's `doc/` folder. See the third-party notice for upstream source links and distribution provenance.
