# AI Data Notes

Read this when changing what the plugin reads from Decaid or sends to the server. For the wire format see `decent-sync-server:docs/PROTOCOL.md`; for Decaid field definitions see `decaid:assets/api/rest_v1.yml` at the version in question. Fields vary by Decaid version: treat all of them as optional.

## Sources to Messages

| Message | Decaid source | Notes |
|---------|---------------|-------|
| `hello` | `GET /info`, `/machine/info`, `/settings` | re-resolved on every connect, so a DE1 that connected after load is picked up |
| `collection` `beans` | `GET /beans?includeArchived=true` | ETag |
| `collection` `beanBatches` | `GET /bean-batches?includeArchived=true` | ETag. Roux batches live here, linked by `beanId` |
| `collection` `grinders` | `GET /grinders?includeArchived=true` | ETag |
| `collection` `profiles` | `GET /profiles?includeHidden=true` | ETag. About 180 KB for 74 profiles; may arrive in parts |
| `collection` `appSettings` | `GET /settings` minus `chargingState` | content hash |
| `collection` `machineSettings` | `GET /machine/settings` | content hash; fails while the DE1 is disconnected |
| `collection` `machineAdvancedSettings` | `GET /machine/settings/advanced` | content hash; fails while the DE1 is disconnected |
| `workflow` | `workflowUpdated` event | profile, dose and yield targets, bean batch, grinder, setting. The last one is resent in each reconnect snapshot |
| `machineState` | `stateUpdate` event | transitions only |
| `shot` | `shotStored` event, then `GET /shots/:id` | full record with `measurements` |
| `shotUpdated` | `shotUpdated` event | no measurements |
| `shotIndex` | `GET /shots/ids` | every shot id, on each connect |

Archived beans, batches and grinders and hidden profiles are included so archiving and hiding propagate. Without the flags, Decaid omits them.

## Change Detection

- On every `welcome`, fingerprints are cleared and every collection is sent in full. The server may have restarted, and it ignores what it already has.
- Afterwards every `PollSeconds` (minimum 5, default 30): endpoints with an ETag are fetched with `If-None-Match`, so unchanged lists cost a 304. Others are compared by a djb2 hash of the response text.
- Add volatile fields to a collection's `omit` list, as with `chargingState`, or the collection resends on every poll.

## Identity

`machineId` is, in order of preference:

1. `de1-<hex>` from `/settings` `preferredMachineId`, the DE1's BLE MAC. Decaid persists it, so it is known at load even before the DE1 connects.
2. `<model>-<serial>` from `/machine/info`, available only while the DE1 is connected.
3. `install-<bootId>`, unique per load. Only used if Decaid has no preferred machine; it splits history.

Changing this order changes the id of every existing machine. Shots also carry capture-time identity in `workflow.machine` (`serialNumber`, `model`, `firmwareVersion`) independent of `machineId`.

## Shot Records

- Ids are Decaid UUIDs, or `de1app-<epoch>` for history imported from the legacy Tcl app.
- `measurements[]` are about 4.8 samples per second, about 490 bytes each as JSON. Each has `machine` (state, pressure, flow, temperatures, frame), `scale` (weight, weightFlow), and `volume`.
- `workflow.context` holds what the user picked: `beanBatchId`, `coffeeRoaster`, `coffeeName`, `grinderId`, `grinderModel`, `grinderSetting`, `targetDoseWeight`, `targetYield`, and DYE2 extras such as basket.
- `annotations` holds post-shot data: `actualDoseWeight`, `actualYield`, `enjoyment`, `espressoNotes`, and other plugins' markers in `extras` (for example `uploaded_to_decent`, `visualizerId`).

## Not Synced Yet

KV-store namespaces (`/api/v1/store/:namespace`, used by DYE2 for favourites, recipes and baskets), steam records (`/api/v1/steams`), presence and wake schedules, and skins. Add them as collections when needed; check DYE2's `docs/KV_CONTRACT.md` before reading its namespaces.
