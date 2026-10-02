# decent-sync-plugin

A Decaid plugin (`decent-sync.reaplugin`) that streams a Decent espresso
machine's data to a [decent-sync-server](https://github.com/loganfuller/decent-sync-server). Decaid, DYE2
and skins are not modified.

`manifest.json` and `plugin.js` sit at the repo root on purpose. Decaid looks
for the plugin at most one folder deep, and a GitHub archive already adds one
wrapper folder. Keeping them at the root lets the repo be installed directly
with Decaid's `install/github-branch` and `install/github-release` endpoints.

## Requirements

Decaid v0.8.6 or later. That is the first release whose plugin host knows every
permission the plugin declares (`network.websocket` arrived in v0.8.5,
`events.workflow` in v0.8.6). Older versions reject the manifest. The plugin
does not depend on any other version-specific behavior: endpoints or fields a
version lacks are skipped.

## Develop

```bash
node scripts/dev-harness.mjs --simulate   # runs plugin.js in Node against the DE1's API; no tablet changes
```

See `AGENTS.md` and `docs/` for how the plugin works and Decaid's runtime constraints.

## Install

From this checkout, over the machine's REST API:

```bash
scripts/install-plugin.sh <decent-ip> ws://<server-ip>:8787/sync "Home DE1Pro"
AUTH_TOKEN=secret scripts/install-plugin.sh …   # when the server sets SYNC_TOKEN
```

The script uploads the source (`PUT /api/v1/plugins/decent-sync.reaplugin/source`),
writes the settings, and enables the plugin. Run it again after editing.
Decaid rejects an upload with a lower `version` than the installed one.

| Setting | |
|---|---|
| `ServerUrl` | `ws://` on the LAN, `wss://` over the internet |
| `MachineName` | display name on the server |
| `AuthToken` | secure. Must match the server's `SYNC_TOKEN` |
| `PollSeconds` | how often to check for changes (default 30) |

Decaid records `host.log` output at FINEST. To see it at `/api/v1/logs`, set
`logLevel` to FINEST with `POST /api/v1/settings`.

## What it sends

On every connect, the plugin sends a full snapshot: beans, bean batches,
grinders, profiles (archived and hidden ones included), and app, machine and
advanced settings. It also sends the list of shot ids, so the server can
backfill any shots it lacks.

After that, it sends:
- new shots, with measurements
- shot edits
- workflow changes
- machine state and substate transitions
- collection changes, found by polling (ETag or content hash)

The machine's identity is `de1-<BLE MAC>` of Decaid's preferred machine.
The wire format is in decent-sync-server's [docs/PROTOCOL.md](https://github.com/loganfuller/decent-sync-server/blob/main/docs/PROTOCOL.md).

## Decaid constraints that shaped the design

- Plugin `fetch` is used only for Decaid's own API at `http://localhost:8080`.
  Decaid's docs say it cannot reach other private addresses. The server
  connection uses `host.transport` (`network.websocket`), which can reach LAN
  and internet hosts and supports `wss://`.
- Each transport allows at most 1 MiB of pending outbound data. The plugin sends
  frames one at a time, and backfill waits until the outbox drains.
- The plugin uses Decaid events wherever they exist (machine state, shots,
  workflow). Decaid has no change events for beans, grinders, profiles or
  settings, so the plugin polls for those.
- `onLoad` must return quickly, or Decaid's load watchdog disables the plugin.
  The plugin connects asynchronously after load.

## Roadmap

1. **Durable outbox.** The outbox is in memory. Shots are recovered by
   backfill, but machine state changes made while the plugin wasn't running are
   lost. Persist the outbox with `pluginStorage`.
2. **Apply server → machine writes** (beans, batches, grinders, profiles) through
   the local REST API, once the server supports it.
