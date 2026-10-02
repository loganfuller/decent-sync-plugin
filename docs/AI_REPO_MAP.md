# AI Repo Map

Use this for orientation. Read the smallest matching topic note, inspect the named source, and widen only when the task crosses a boundary.

## The One Thing To Know First

`plugin.js` runs inside Decaid's `flutter_js` (QuickJS) runtime on an Android tablet, not in Node or a browser. It reaches the outside world only through the `host` object, and Decaid's docs and source disagree in places. Before relying on any host behavior, read `docs/AI_RUNTIME_NOTES.md`. The dev harness imitates the host closely enough to test logic, not limits.

## Task Routing

| Task | Read first | Then |
|------|-----------|------|
| Any change to `plugin.js` | `docs/AI_RUNTIME_NOTES.md` | the section banner in `plugin.js` that matches |
| Sending a new kind of data | `docs/AI_DATA_NOTES.md` | `decent-sync-server/docs/PROTOCOL.md`, server `Session.on_<type>` |
| Connection, reconnect, backoff, heartbeat | `docs/AI_RUNTIME_NOTES.md` | `connect`, `dropConnection`, `onTransportEvent`, `startHeartbeat` |
| Outbox, acks, resend, ordering | `decent-sync-server/docs/AI_PROTOCOL_NOTES.md` | `enqueue`, `pump`, `ackMessage` |
| Polling collections, change detection | `docs/AI_DATA_NOTES.md` | `COLLECTIONS`, `pollCollections`, `enqueueCollection` |
| Shots and backfill | `docs/AI_DATA_NOTES.md` | `sendShot`, `runBackfill`, `sendShotIndex` |
| Machine identity | `docs/AI_DATA_NOTES.md` | `resolveIdentity` |
| Settings, permissions, version | `docs/AI_BUILD_NOTES.md` | `manifest.json` |
| Installing, testing, releasing | `docs/AI_BUILD_NOTES.md` | `scripts/install-plugin.sh`, `scripts/dev-harness.mjs` |
| What the host actually does | `docs/AI_RUNTIME_NOTES.md` | `../decaid/lib/src/plugins/plugin_manager.dart`, `plugin_transport_service.dart` |

## Coupling

| Changing... | Must also check... | Why |
|-------------|---------------------|-----|
| Any message shape | server `docs/PROTOCOL.md`, server `Session.on_<type>` | Two repos, one contract |
| `resolveIdentity` / `machineId` | server `data/machines/<id>/` | A new id splits one machine's history into two directories |
| `manifest.json` permissions | every installed machine | New permissions hold automatic updates until approved |
| `manifest.json` `version` | `VERSION` in `plugin.js`, release tag | Decaid rejects downgrades; release tag must equal manifest version |
| `COLLECTIONS` | server `collectionFormatters`, `docs/AI_DATA_NOTES.md` | The server prints and stores by collection name |
| Event handling in `onEvent` | `manifest.json` `events.*` permissions | Decaid only delivers events whose permission is declared |

## Production Entry Points

- `plugin.js` — the whole plugin: `createPlugin(host)` returning `onLoad`, `onUnload`, `onEvent`.
- `manifest.json` — id, version, permissions, user settings.

## Dev Tooling

- `scripts/dev-harness.mjs` — runs `plugin.js` in Node against a real Decaid API and a sync server.
- `scripts/install-plugin.sh` — uploads, configures, and enables the plugin on a tablet over Decaid's REST API.

## Source-Of-Truth Order

1. Current `plugin.js` and `manifest.json`.
2. `decent-sync-server/docs/PROTOCOL.md` for the wire contract.
3. Decaid's Dart source, for anything the host does: `../decaid/lib/src/plugins/`. Line numbers in these notes are against Decaid commit `a45961b3`; the tablet runs 0.8.6+2801 (`d4721e53`).
4. Decaid's `doc/Plugins.md` and OpenAPI spec `assets/api/rest_v1.yml`.
5. README and AI notes.

When sources disagree, describe the discrepancy and follow the higher item, unless the task is to reconcile documentation.
