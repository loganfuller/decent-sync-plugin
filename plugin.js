// Decent Sync — streams this machine's data to a central sync server.
//
// Transport: one outbound WebSocket (host.transport, `network.websocket`).
// Plugin `fetch` is only used against Decaid's own API on localhost.
//
// Delivery: every data message carries a unique `id` and stays in the outbox
// until the server acks it, so a dropped connection resends whatever was not
// acknowledged. The server de-duplicates by `id`.
function createPlugin(host) {
  "use strict";

  const PLUGIN_ID = "decent-sync.reaplugin";
  const VERSION = "0.1.1";
  const PROTOCOL = 1;
  const API = "http://localhost:8080/api/v1";

  const HEARTBEAT_MS = 30000;
  const MIN_RECONNECT_MS = 1000;
  const MAX_RECONNECT_MS = 60000;
  const MAX_OUTBOX = 200;
  const CHUNK_BYTES = 256 * 1024;
  const BACKFILL_LOW_WATER = 3;

  // Polled for changes. Archived/hidden records are included so archive and
  // visibility changes propagate too.
  const COLLECTIONS = [
    { key: "beans", path: "/beans?includeArchived=true" },
    { key: "beanBatches", path: "/bean-batches?includeArchived=true" },
    { key: "grinders", path: "/grinders?includeArchived=true" },
    { key: "profiles", path: "/profiles?includeHidden=true" },
    // chargingState carries live battery level; it is not a setting.
    { key: "appSettings", path: "/settings", omit: ["chargingState"] },
    { key: "machineSettings", path: "/machine/settings" },
    { key: "machineAdvancedSettings", path: "/machine/settings/advanced" },
  ];

  const bootId = randomId();
  let settings = {};
  let identity = null;
  let unloaded = false;

  let handle = null;
  let connGen = 0;
  let connecting = false;
  let ready = false;
  let reconnectDelay = MIN_RECONNECT_MS;
  const timers = {};

  let seq = 0;
  const outbox = [];
  let pumping = false;

  const fingerprints = {};
  const backfill = [];
  const sentShots = new Set();
  let backfilling = false;
  let lastMachineState = null;
  let lastWorkflow = null;

  function log(msg) {
    host.log(`[decent-sync] ${msg}`);
  }

  function randomId() {
    return (
      Date.now().toString(36) +
      "-" +
      Math.floor(Math.random() * 0xffffffff).toString(36)
    );
  }

  // djb2 — only used to detect change on endpoints without an ETag.
  function hash(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
  }

  function setTimer(name, ms, fn) {
    clearTimer(name);
    timers[name] = setTimeout(() => {
      delete timers[name];
      fn();
    }, ms);
  }

  function clearTimer(name) {
    if (timers[name] !== undefined) {
      clearTimeout(timers[name]);
      delete timers[name];
    }
  }

  async function getJson(path) {
    try {
      const res = await fetch(API + path);
      return res.ok ? await res.json() : null;
    } catch (e) {
      log(`GET ${path} failed: ${e.message || e}`);
      return null;
    }
  }

  // ---------------------------------------------------------------- identity

  async function resolveIdentity() {
    const [info, machine, appSettings] = await Promise.all([
      getJson("/info"),
      getJson("/machine/info"),
      getJson("/settings"),
    ]);
    // The preferred machine's BLE address is persisted by Decaid, so it is
    // available even before the DE1 connects; the serial number is not.
    const mac = appSettings && appSettings.preferredMachineId;
    const serial = machine && machine.serialNumber;
    const machineId = mac
      ? "de1-" + String(mac).replace(/[^0-9a-f]/gi, "").toLowerCase()
      : serial
        ? `${machine.model || "de1"}-${serial}`.toLowerCase()
        : "install-" + bootId;
    return {
      machineId,
      name:
        settings.MachineName ||
        (machine ? `${machine.model} #${machine.serialNumber}` : machineId),
      model: machine ? machine.model : null,
      serialNumber: serial || null,
      firmware: machine ? machine.version : null,
      decaidVersion: info ? info.fullVersion : null,
      localIp: info ? info.localIp : null,
    };
  }

  // -------------------------------------------------------------- connection

  function scheduleReconnect() {
    if (unloaded) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
    setTimer("reconnect", delay, connect);
  }

  async function connect() {
    if (unloaded || connecting || handle) return;
    if (!settings.ServerUrl) {
      log("ServerUrl is not set; not connecting");
      return;
    }
    connecting = true;
    try {
      identity = await resolveIdentity();
      const opened = await host.transport.open({
        kind: "websocket",
        url: settings.ServerUrl,
      });
      if (unloaded) {
        host.transport.close(opened.handle).catch(() => {});
        return;
      }
      handle = opened.handle;
      connGen++;
      const myHandle = handle;
      host.transport.onEvent(myHandle, (event) =>
        onTransportEvent(myHandle, event),
      );
      log(`connected to ${settings.ServerUrl} as ${identity.machineId}`);
      await sendNow("hello", {
        protocol: PROTOCOL,
        pluginVersion: VERSION,
        bootId,
        token: settings.AuthToken || null,
        ...identity,
      });
    } catch (e) {
      log(`connect failed: ${e.message || e}`);
      dropConnection();
    } finally {
      connecting = false;
    }
  }

  function dropConnection() {
    const old = handle;
    handle = null;
    ready = false;
    clearTimer("heartbeat");
    clearTimer("poll");
    if (old) host.transport.close(old).catch(() => {});
    scheduleReconnect();
  }

  function onTransportEvent(h, event) {
    if (h !== handle) return;
    if (event.type === "data" && event.dataType === "text") {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        log("ignoring non-JSON frame from server");
        return;
      }
      onServerMessage(msg);
    } else if (event.type === "error" || event.type === "close") {
      log(
        `connection ${event.type}: ${event.message || event.reason || event.code || ""}`,
      );
      dropConnection();
    }
  }

  function onServerMessage(msg) {
    switch (msg.type) {
      case "welcome":
        ready = true;
        reconnectDelay = MIN_RECONNECT_MS;
        log(`server welcomed ${identity.machineId}`);
        startHeartbeat();
        pump();
        // A fresh full snapshot on every (re)connect: the server may have
        // restarted, and it de-duplicates anything it already holds.
        for (const k in fingerprints) delete fingerprints[k];
        resendWorkflow();
        pollCollections().then(sendShotIndex);
        break;
      case "ack":
        ackMessage(msg.id);
        break;
      case "requestShots":
        for (const id of msg.ids || []) {
          if (backfill.indexOf(id) === -1) backfill.push(id);
        }
        log(`server requested ${backfill.length} shot(s)`);
        runBackfill();
        break;
      case "error":
        log(`server error: ${msg.message}`);
        break;
    }
  }

  function startHeartbeat() {
    setTimer("heartbeat", HEARTBEAT_MS, async () => {
      if (!ready) return;
      await sendNow("heartbeat", {
        outbox: outbox.length,
        backfill: backfill.length,
      }).catch(() => {});
      startHeartbeat();
    });
  }

  // ------------------------------------------------------------------ outbox

  function envelope(type, data) {
    seq++;
    return {
      v: PROTOCOL,
      id: `${bootId}:${seq}`,
      seq,
      type,
      machineId: identity ? identity.machineId : null,
      sentAt: new Date().toISOString(),
      data,
    };
  }

  // Control frames bypass the outbox: they are meaningless if resent later.
  function sendNow(type, data) {
    if (!handle) return Promise.reject(new Error("not connected"));
    return host.transport.send(handle, {
      type: "text",
      data: JSON.stringify(envelope(type, data)),
    });
  }

  function enqueue(type, data) {
    if (outbox.length >= MAX_OUTBOX) {
      const dropped = outbox.shift();
      log(`outbox full; dropped ${dropped.env.type} ${dropped.env.id}`);
    }
    outbox.push({ env: envelope(type, data), sentOn: 0 });
    pump();
  }

  // Sends unsent messages one at a time so a burst never exceeds the
  // transport's 1 MiB outbound limit.
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (ready && handle) {
        const next = outbox.find((m) => m.sentOn !== connGen);
        if (!next) break;
        const gen = connGen;
        await host.transport.send(handle, {
          type: "text",
          data: JSON.stringify(next.env),
        });
        next.sentOn = gen;
      }
    } catch (e) {
      log(`send failed: ${e.message || e}`);
    } finally {
      pumping = false;
    }
  }

  function ackMessage(id) {
    const i = outbox.findIndex((m) => m.env.id === id);
    if (i !== -1) outbox.splice(i, 1);
    runBackfill();
  }

  // ------------------------------------------------------------ collections

  async function pollCollections() {
    for (const c of COLLECTIONS) {
      if (!ready) return;
      try {
        const prev = fingerprints[c.key];
        const headers = prev && prev.etag ? { "If-None-Match": prev.etag } : {};
        const res = await fetch(API + c.path, { headers });
        if (res.status === 304 || !res.ok) continue;
        let text = await res.text();
        let value = JSON.parse(text);
        if (c.omit) {
          for (const k of c.omit) delete value[k];
          text = JSON.stringify(value);
        }
        const etag = res.headers.get("etag");
        const fp = { etag, hash: etag || hash(text) };
        if (prev && prev.hash === fp.hash) continue;
        fingerprints[c.key] = fp;
        enqueueCollection(c.key, value, text.length);
      } catch (e) {
        log(`poll ${c.key} failed: ${e.message || e}`);
      }
    }
    schedulePoll();
  }

  function schedulePoll() {
    const seconds = Math.max(5, Number(settings.PollSeconds) || 30);
    setTimer("poll", seconds * 1000, () => {
      if (ready) pollCollections();
    });
  }

  function enqueueCollection(key, value, size) {
    if (!Array.isArray(value) || size <= CHUNK_BYTES) {
      enqueue("collection", { collection: key, part: 1, parts: 1, value });
      return;
    }
    const chunks = [];
    let current = [];
    let bytes = 0;
    for (const item of value) {
      const n = JSON.stringify(item).length;
      if (current.length && bytes + n > CHUNK_BYTES) {
        chunks.push(current);
        current = [];
        bytes = 0;
      }
      current.push(item);
      bytes += n;
    }
    if (current.length) chunks.push(current);
    chunks.forEach((items, i) =>
      enqueue("collection", {
        collection: key,
        part: i + 1,
        parts: chunks.length,
        value: items,
      }),
    );
  }

  // ------------------------------------------------------------------ shots

  async function sendShotIndex() {
    const ids = await getJson("/shots/ids");
    if (ids) enqueue("shotIndex", { ids });
  }

  async function sendShot(id, reason) {
    const shot = await getJson("/shots/" + encodeURIComponent(id));
    if (shot) {
      sentShots.add(id);
      enqueue("shot", { reason, shot });
    }
    else log(`shot ${id} could not be read`);
  }

  // Backfill is flow-controlled by the outbox so a large history never sits
  // in memory all at once.
  async function runBackfill() {
    if (backfilling) return;
    backfilling = true;
    try {
      while (ready && backfill.length && outbox.length < BACKFILL_LOW_WATER) {
        const id = backfill.shift();
        if (!sentShots.has(id)) await sendShot(id, "backfill");
      }
    } finally {
      backfilling = false;
    }
  }

  // ----------------------------------------------------------------- events

  // workflowUpdated fires on load and on change only, so the latest workflow
  // is kept and included in each reconnect snapshot.
  function onWorkflow(workflow) {
    lastWorkflow = workflow;
    enqueue("workflow", workflow);
  }

  function resendWorkflow() {
    const pending = outbox.some((m) => m.env.type === "workflow");
    if (lastWorkflow && !pending) enqueue("workflow", lastWorkflow);
  }

  function onMachineState(payload) {
    const s = payload && payload.state;
    if (!s) return;
    const key = `${s.state}/${s.substate}`;
    if (key === lastMachineState) return;
    const from = lastMachineState;
    lastMachineState = key;
    enqueue("machineState", {
      from,
      to: key,
      state: s.state,
      substate: s.substate,
      at: payload.timestamp || new Date().toISOString(),
      groupTemperature: payload.groupTemperature,
      steamTemperature: payload.steamTemperature,
    });
  }

  return {
    id: PLUGIN_ID,
    version: VERSION,

    onLoad(s) {
      settings = s || {};
      log(`loaded v${VERSION} (boot ${bootId}); server ${settings.ServerUrl}`);
      // Never block load: the host watchdog disables slow-loading plugins.
      setTimer("reconnect", 0, connect);
    },

    onUnload() {
      unloaded = true;
      for (const name in timers) clearTimer(name);
      if (handle) host.transport.close(handle).catch(() => {});
      handle = null;
    },

    onEvent(event) {
      try {
        switch (event.name) {
          case "stateUpdate":
            onMachineState(event.payload);
            break;
          case "workflowUpdated":
            onWorkflow(event.payload);
            break;
          case "shotStored":
            sendShot(event.payload.id, "stored");
            break;
          case "shotUpdated":
            enqueue("shotUpdated", event.payload);
            break;
        }
      } catch (e) {
        log(`event ${event.name} failed: ${e.message || e}`);
      }
    },
  };
}
