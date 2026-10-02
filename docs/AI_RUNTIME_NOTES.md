# AI Runtime Notes

Read this before changing `plugin.js`. It covers what Decaid's plugin host provides, what it does not, the limits that shape the code, and which Decaid versions the plugin can run on.

References like `decaid:lib/src/plugins/plugin_manager.dart` are paths in Decaid's repo; see "External Sources" in `AGENTS.md`. They name symbols, not line numbers, because line numbers differ between Decaid versions.

## Compatibility

The plugin must run on every Decaid version a machine might have, not one specific release. Machines update Decaid on their own schedule.

**The floor is set by manifest permissions.** Decaid rejects the whole manifest if it names a permission that Decaid version does not know (`PluginPermissionsFromJson.fromJson` in `decaid:lib/src/plugins/plugin_manifest.dart` throws `Unknown plugin permission`). The plugin then does not load at all. One permission therefore raises the minimum version for every machine.

| Permission | Needed for | First Decaid release |
|------------|-----------|---------------------|
| `log`, `api` | logging, local API access | before v0.7 |
| `events.machine`, `events.shots` | state transitions, new and edited shots | v0.7.17 |
| `network.websocket` | the server connection (`host.transport`) | v0.8.5 |
| `events.workflow` | workflow changes (`workflowUpdated`) | v0.8.6 |

The minimum supported Decaid is therefore **v0.8.6**. Keep it in sync with the README's Requirements section.

**Prefer events over polling.** Use a Decaid event whenever one exists for the data, even if its permission raises the minimum version; poll only data that has no event (beans, batches, grinders, profiles, settings). Raising the minimum is still a deliberate decision: add the permission to this table, update the README, and say so in the change. Never drop an event for polling just to support an older release.

To find when a permission appeared: `git log --reverse -S"'<name>'" -- lib/src/plugins/plugin_manifest.dart` in a Decaid checkout, then `git tag --contains <commit>`.

**Everything else is optional at runtime.** An endpoint, query parameter, header, field, or event that a version lacks must degrade, not fail:

- `getJson` returns `null` on any error and callers skip that item. A missing endpoint means that collection is not synced, nothing more.
- ETags are used when present; otherwise the response is hashed.
- Unknown query parameters (`includeArchived`, `includeHidden`) are expected to be ignored by versions that lack them.
- Payloads are forwarded verbatim. Do not reshape or validate Decaid data in the plugin; the server stores it as sent and machines differ.
- `hello` reports `decaidVersion` so the server knows what each machine runs.

When you rely on a host behavior, check it at the oldest supported version as well as the newest (`git show v0.8.6:<path>`).

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

- Decaid calls `onLoad(settings)` synchronously inside the generated plugin wrapper and does not await it (search for `plugin.onLoad(` in `decaid:lib/src/plugins/plugin_manager.dart`).
- The load watchdog disables a plugin after three failed loads, or immediately if a load was interrupted by app exit (`decaid:doc/Plugins.md`, "Load watchdog"). `onLoad` therefore schedules `connect` with a zero-delay timer and returns.
- `settings` holds stored values, with manifest defaults filled in by `decaid:lib/src/plugins/plugin_loader_service.dart`. A `secure` setting such as `AuthToken` arrives in memory only; the REST API returns `{isSet}` for it.
- Changing settings with `POST /api/v1/plugins/:id/settings` reloads a loaded plugin. Expect `onUnload` then a fresh `createPlugin` with a new `bootId`.

## fetch

- Plugin code gets a local `const fetch` bound to its bridge token, present only with the `api` permission (the `const fetch =` line in the plugin wrapper in `plugin_manager.dart`). The global `fetch` always rejects.
- Use absolute URLs: `http://localhost:8080/api/v1/...`. Bundled plugins do the same.
- The response object is minimal: `status`, `ok`, `headers.get()`, `text()`, `json()`. No streaming, no `arrayBuffer`.
- Limits are `PluginManager` constructor defaults: `fetchTimeout` (30 seconds) and `maxFetchResponseBytes` (10 MiB) in recent versions.
- `decaid:doc/Plugins.md` says plugin `fetch` cannot reach localhost or private IPs other than the Decaid API. `PluginManager._performFetch` had no such check in v0.8.6. Do not depend on either behavior; use `fetch` for the local API only.

## host.transport (the server connection)

- Requires `network.websocket`. `open({kind: "websocket", url})` resolves `{handle}` once connected; there is no separate open event.
- No custom headers. That is why the auth token is in `hello`.
- `onEvent(handle, cb)` gets `{type: "data", dataType: "text", data}`, `{type: "error", code, message}`, or `{type: "close", code, reason}`. An error may be followed by a close; `onTransportEvent` ignores events for any handle other than the current one, so a single drop triggers one reconnect.
- `send` resolves when the payload is queued, not when the server has it. Delivery is confirmed only by the server's `ack`.
- Limits are `PluginTransportService` constructor defaults in `decaid:lib/src/plugins/plugin_transport_service.dart`: `maxTransportsPerGeneration` (8), `maxPendingOutboundBytes` (1 MiB), `maxQueuedInboundBytes` (1 MiB). A send that would exceed the outbound limit rejects atomically with `transport_resource_limit`. Treat these as host policy that a future version may change, not constants to hard-code beyond the plugin's own `CHUNK_BYTES`.
- No private-address restrictions. Plugin unload closes every transport the generation opened, even if `onUnload` throws.

## Events

| Event | Permission | Payload used |
|-------|-----------|--------------|
| `stateUpdate` | `events.machine` | `state.state`, `state.substate`, temperatures. Arrives several times a second; the plugin forwards transitions only |
| `workflowUpdated` | `events.workflow` | the full workflow. Fires on load and on change only, so the plugin keeps the last one and resends it in each reconnect snapshot |
| `shotStored` | `events.shots` | `{id}` only; the plugin fetches the record |
| `shotUpdated` | `events.shots` | `{id, shot, patch}`; `shot` has no measurements |

Decaid's own docs for the payloads are in `decaid:doc/Plugins.md`. There are no events for beans, batches, grinders, profiles, or settings. Those are polled.

## Logging

`host.log` is recorded at FINEST (the `"[JS:$pluginId]"` log call in `plugin_manager.dart`). At the default INFO level nothing appears in `/api/v1/logs`. For tablet-side debugging, set `logLevel` to FINEST with `POST /api/v1/settings`, and set it back afterwards. The dev harness prints plugin logs directly.

## Storage

`host.storage` (permission `pluginStorage`) is request-and-event: a `read` command returns nothing; the value arrives later as a `storageRead` event. Any durable outbox has to be built around that. The plugin does not use storage yet, and does not declare the permission.

## Known Issues

- **Oversized shot blocks the outbox.** A `shot` frame over the transport's outbound limit (1 MiB, about 2100 samples, roughly a 7-minute shot) is rejected by `send`. `pump` logs the failure and stops, leaving the message unsent at the front of the outbox, so every later `pump` retries it and nothing behind it is sent. Fix by chunking shots (the server needs to reassemble), and by never retrying a message that failed with `transport_resource_limit`.
- **Memory-only outbox.** Messages queued while disconnected are lost if Decaid unloads the plugin first. Shots recover through backfill; machine state transitions do not.
