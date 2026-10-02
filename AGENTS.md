# Agent Instructions

For unfamiliar or multi-file tasks, read `docs/AI_REPO_MAP.md` first. For known files or exact symbols, open them directly. Read the topic notes only when the task needs them; do not preload them all.

decent-sync-plugin is the machine half of Decent Sync: a Decaid plugin (`decent-sync.reaplugin`) that runs on each Decent espresso machine's tablet and streams shots, beans, batches, grinders, profiles, settings, and machine activity to `decent-sync-server` over one WebSocket. It must work without modifying Decaid, DYE2, or skins.

## Quick Commands

```bash
node --check plugin.js                                       # syntax check
node scripts/dev-harness.mjs --simulate                      # run against the DE1 API + local server, no tablet changes
SERVER_URL=ws://127.0.0.1:8799/sync node scripts/dev-harness.mjs --seconds 0   # until Ctrl-C
scripts/install-plugin.sh 192.168.4.33 ws://<server-ip>:8787/sync "Home DE1Pro"   # real install; ask first
```

## Always

- Preserve existing work. Keep changes focused; do not rewrite unrelated code or documentation.
- Default to the current branch and leave changes local. Never push, tag, publish a release, or create a remote repository unless explicitly asked.
- Ask before installing onto a real machine. `scripts/install-plugin.sh` replaces running code on someone's espresso machine; the dev harness does not touch the tablet and is the default way to test.
- Verify host behavior in Decaid's source, not only its docs. `doc/Plugins.md` has been wrong about the runtime before; see `docs/AI_RUNTIME_NOTES.md`.
- Treat `AuthToken` as a secret. It is a `secure` setting; never log it or put it in an envelope other than `hello`.
- Update an AI note only when a reusable, non-obvious constraint changes. Remove stale guidance instead of accumulating history.

## Hard Rules

- The wire contract is `decent-sync-server:docs/PROTOCOL.md`. Any message change needs the matching server change and a `docs/PROTOCOL.md` update in that repo. Call out the cross-repo change explicitly.
- `manifest.json` and `plugin.js` stay at the repo root. Decaid resolves a plugin at most one directory deep and GitHub archives add one, so moving them breaks branch and release installs.
- `manifest.json` `id` stays `decent-sync.reaplugin` and must equal the `id` returned by `createPlugin`. Changing it installs a second plugin instead of upgrading.
- Bump `version` in `manifest.json` and `VERSION` in `plugin.js` together. Decaid rejects a lower version (409) and GitHub release tags must equal the manifest version.
- Adding a manifest permission blocks automatic updates on every machine until a person approves it. Avoid new permissions unless the feature needs them, and say so when you add one.
- Don't couple the plugin to one Decaid version. Machines run different releases. Manifest permissions set the minimum supported version, because Decaid rejects a manifest with any permission it does not know; everything else (endpoints, fields, headers) must degrade when absent. See Compatibility in `docs/AI_RUNTIME_NOTES.md`.
- Prefer Decaid events over polling. Poll only data that has no event, and never trade an event for polling just to support an older release.
- `onLoad` must return immediately. Decaid calls it synchronously and its load watchdog disables plugins that block. Start network work from a timer.
- Every data message goes through `enqueue` so it is acked and resent. Only `hello` and `heartbeat` may use `sendNow`.
- Send frames one at a time through `pump`. Decaid's transport rejects a send that would push pending outbound data past 1 MiB.
- `fetch` is for Decaid's own API at `http://localhost:8080/api/v1` only. All traffic to the sync server goes through `host.transport`.
- Plain ES2020 in one file, no build step and no bundler. The runtime is QuickJS inside `flutter_js`: no DOM, no Node modules, no `setInterval`.
- No emojis in comments or documentation.

## Code Style

- Single `createPlugin(host)` closure. Group code by the existing section banners (identity, connection, outbox, collections, shots, events).
- Log through `log()` so lines carry the `[decent-sync]` prefix.
- Timers go through `setTimer` / `clearTimer` so `onUnload` can cancel them all.
- Put rationale and debugging history in the matching `docs/AI_*_NOTES.md`, not in long code comments.

## Vocabulary

| Term | Meaning |
|------|---------|
| Decaid | the Flutter app on the tablet (internal name ReaPrime; hence `.reaplugin` and REA-prefixed APIs) |
| host | the `host` object Decaid passes to `createPlugin` |
| outbox | unacked data messages held in memory |
| collection | a polled Decaid list or settings object: `beans`, `beanBatches`, `grinders`, `profiles`, `appSettings`, `machineSettings`, `machineAdvancedSettings` |
| backfill | shots the server asked for with `requestShots` |
| machine | one DE1 plus its tablet, identified by `machineId` (`de1-<BLE MAC>`) |

## External Sources

Paths written `<name>:<path>` are relative to that repo's root. Notes cite files and symbols, never line numbers, because line numbers change between versions.

| Name | Repo | Which version to read |
|------|------|-----------------------|
| `decaid` | [decentespresso/decaid](https://github.com/decentespresso/decaid) | the one the question is about: a machine's `hello.decaidVersion`, the minimum supported release (see Compatibility in `docs/AI_RUNTIME_NOTES.md`) for compatibility questions, or `main` for upcoming changes |
| `decent-sync-server` | [loganfuller/decent-sync-server](https://github.com/loganfuller/decent-sync-server) | `main`; the two repos change together |

To read one, use `$DECAID_DIR` or `$DECENT_SYNC_SERVER_DIR` if set, or a checkout you already have; never assume where a checkout lives. `git show <tag>:<path>` reads a version without checking it out. Without a checkout: `gh api 'repos/decentespresso/decaid/contents/<path>?ref=<tag>' -H 'Accept: application/vnd.github.raw'`.

## Deep References

- Fast file routing: `docs/AI_REPO_MAP.md`.
- Decaid plugin runtime, permissions, limits, footguns: `docs/AI_RUNTIME_NOTES.md`.
- Which Decaid endpoints and events feed which messages: `docs/AI_DATA_NOTES.md`.
- Install, versioning, dev harness, releases: `docs/AI_BUILD_NOTES.md`.
- Wire contract and delivery semantics: `decent-sync-server:docs/PROTOCOL.md`, `decent-sync-server:docs/AI_PROTOCOL_NOTES.md`.
- Decaid's plugin guide and host source: `decaid:doc/Plugins.md`, `decaid:lib/src/plugins/`.

## Don't

- Don't install onto the tablet without being asked.
- Don't move `manifest.json` or `plugin.js` out of the repo root.
- Don't add a manifest permission casually.
- Don't block in `onLoad`.
- Don't send data messages outside the outbox.
