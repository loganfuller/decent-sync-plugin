# AI Runtime Notes

Read this before changing `plugin.js`. It covers what Decaid's plugin host provides, what it does not, and the limits that shape the code. Line references are to `../decaid` at commit `a45961b3`.

## The Runtime

| | |
|---|---|
| Engine | QuickJS via `flutter_js`, one shared engine for all plugins |
| Language | ES2020; object spread, async/await, optional chaining work |
| Globals | `fetch` (plugin-scoped), `btoa`, `setTimeout`, `clearTimeout`, `Promise`, `JSON`, `Date`, `Math` |
| Missing | `setInterval`, `WebSocket`, `XMLHttpRequest`, DOM, Node modules, `localStorage` |
| Entry | global `createPlugin(host)` returning `{ id, version, onLoad, onUnload, onEvent }` |

Use `setTimeout` chains through `setTimer` for anything periodic.

## Load

- Decaid calls `onLoad(settings)` synchronously while evaluating the plugin (`plugin_manager.dart:2277-2279`) and does not await it.
- The load watchdog disables a plugin after three failed loads, or immediately if a load was interrupted by app exit (`doc/Plugins.md`, "Load watchdog"). `onLoad` therefore schedules `connect` with a zero-delay timer and returns.
- `settings` is the stored values, with defaults from the manifest. A `secure` setting such as `AuthToken` arrives in memory only; the REST API returns `{isSet}` for it.
- Changing settings with `POST /api/v1/plugins/:id/settings` reloads a loaded plugin. Expect `onUnload` then a fresh `createPlugin` with a new `bootId`.

## fetch

- Plugin code gets a local `const fetch` bound to its bridge token, present only with the `api` permission (`plugin_manager.dart:2052`). The global `fetch` always rejects.
- Use absolute URLs: `http://localhost:8080/api/v1/...`. Bundled plugins do the same.
- The response object is minimal: `status`, `ok`, `headers.get()`, `text()`, `json()`. No streaming, no `arrayBuffer`.
- Limits: 30 second timeout, 10 MiB response (`plugin_manager.dart:150-151`).
- `doc/Plugins.md` says plugin `fetch` cannot reach localhost or private IPs other than the Decaid API. `_performFetch` (`plugin_manager.dart:3181`) shows no such check at this commit. Do not depend on either behavior; use `fetch` for the local API only.

## host.transport (the server connection)

- Requires `network.websocket`. `open({kind: "websocket", url})` resolves `{handle}` once connected; there is no separate open event.
- No custom headers. That is why the auth token is in `hello`.
- `onEvent(handle, cb)` gets `{type: "data", dataType: "text", data}`, `{type: "error", code, message}`, or `{type: "close", code, reason}`. An error may be followed by a close; `onTransportEvent` ignores events for any handle other than the current one, so a single drop triggers one reconnect.
- `send` resolves when the payload is queued, not when the server has it. Delivery is confirmed only by the server's `ack`.
- Limits (`plugin_transport_service.dart:44-46`): 8 live transports per plugin generation, 1 MiB pending outbound per transport, 1 MiB queued inbound. A send that would exceed the outbound limit rejects atomically with `transport_resource_limit`.
- No private-address restrictions. Plugin unload closes every transport the generation opened, even if `onUnload` throws.

## Events

| Event | Permission | Payload used |
|-------|-----------|--------------|
| `stateUpdate` | `events.machine` | `state.state`, `state.substate`, temperatures. Arrives several times a second; the plugin forwards transitions only |
| `workflowUpdated` | `events.workflow` | full workflow; also sent on load and controller attach |
| `shotStored` | `events.shots` | `{id}` only; the plugin fetches the record |
| `shotUpdated` | `events.shots` | `{id, shot, patch}`; `shot` has no measurements |

Decaid has no events for beans, batches, grinders, profiles, or settings. Those are polled.

## Logging

`host.log` is recorded at FINEST (`plugin_manager.dart:1120`). At the tablet's default INFO level nothing appears in `/api/v1/logs`. For tablet-side debugging, set `logLevel` to FINEST with `POST /api/v1/settings`, and set it back afterwards. The dev harness prints plugin logs directly.

## Storage

`host.storage` (permission `pluginStorage`) is request-and-event: a `read` command returns nothing; the value arrives later as a `storageRead` event. Any durable outbox has to be built around that. The plugin does not use storage yet, and does not declare the permission.

## Known Issues

- **Oversized shot blocks the outbox.** A `shot` frame over 1 MiB (about 2100 samples, roughly a 7-minute shot) is rejected by `send`. `pump` logs the failure and stops, leaving the message unsent at the front of the outbox, so every later `pump` retries it and nothing behind it is sent. Fix by chunking shots (the server needs to reassemble), and by never retrying a message that failed with `transport_resource_limit`.
- **Memory-only outbox.** Messages queued while disconnected are lost if Decaid unloads the plugin first. Shots recover through backfill; machine state transitions do not.
