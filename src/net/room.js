import mqtt from "mqtt";
import { imageId } from "../game/game";

// Tried in order; clients always return to the first reachable one so peers converge on one broker.
export const BROKERS = [
  "wss://test.mosquitto.org:8081/mqtt",
  "wss://broker.emqx.io:8084/mqtt",
  "wss://broker.hivemq.com:8884/mqtt",
];

const HEARTBEAT_MS = 5000;
const DEAD_BROKER_MS = 60000;
// broker.emqx.io drops a client that publishes about 1 MB; images travel separately, so this only guards against a runaway state.
export const MAX_STATE_BYTES = 900 * 1024;
export const PEER_TIMEOUT_MS = 15000;

// Background tabs throttle setInterval to once a minute, which is what drops idle hosts; worker timers are not throttled.
function workerInterval(fn, ms) {
  try {
    const url = URL.createObjectURL(
      new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: "text/javascript" }),
    );
    const worker = new Worker(url);
    worker.onmessage = fn;
    return () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }
}

const num = (v) => typeof v === "number" && Number.isFinite(v);
const point = (p) => (p && num(p.x) && num(p.y) ? { x: p.x, y: p.y } : null);
const MAX_LIVE_IDS = 500;

// Keeps only id → [four numbers] entries, the shape used for live stack and token positions.
function quads(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [id, v] of Object.entries(obj).slice(0, MAX_LIVE_IDS)) {
    if (Array.isArray(v) && v.length === 4 && v.every(num)) out[id] = v;
  }
  return out;
}

// Live messages can come from anyone on a public broker, so only well-formed fields are kept.
function readLive(msg) {
  if (typeof msg?.id !== "string") return null;
  const sel = Array.isArray(msg.sel) ? msg.sel.filter((s) => typeof s === "string").slice(0, MAX_LIVE_IDS) : [];
  let ov = null;
  if (msg.ov?.move || msg.ov?.tok) {
    ov = { move: quads(msg.ov.move), tok: quads(msg.ov.tok) };
  } else if (typeof msg.ov?.splay?.id === "string" && point(msg.ov.splay.start) && point(msg.ov.splay.end)) {
    const rot = [0, 90, 180, 270].includes(msg.ov.splay.rot) ? msg.ov.splay.rot : 0;
    ov = { splay: { id: msg.ov.splay.id, start: point(msg.ov.splay.start), end: point(msg.ov.splay.end), rot } };
  }
  return { id: msg.id, c: point(msg.c), sel, ov };
}

const MAX_EVENT_POINTS = 50;

// Only shuffle events exist so far; anything else or malformed is ignored.
function readEvent(msg) {
  if (typeof msg?.id !== "string" || msg.type !== "shuffle" || !Array.isArray(msg.at)) return null;
  const at = msg.at.slice(0, MAX_EVENT_POINTS).map(point).filter(Boolean);
  return at.length ? { id: msg.id, type: "shuffle", at } : null;
}

export function createRoom({ code, me, isHost, onStatus, onState, onPatch, onPeers, onLive, onEvent, onImage, onConnected }) {
  const base = `play-with-cards/v1/${code}`;
  const peers = {};
  const failedAt = {};
  let client = null;
  let index = 0;
  let closed = false;

  const send = (topic, payload, opts = {}) => {
    if (client?.connected) client.publish(topic, JSON.stringify(payload), { qos: 1, ...opts });
  };

  // Goes back to the first broker so peers converge, but skips any that failed recently instead of retrying it on every reconnect.
  const firstLive = () => {
    const now = Date.now();
    const i = BROKERS.findIndex((_, k) => !(now - (failedAt[k] ?? -Infinity) < DEAD_BROKER_MS));
    return i === -1 ? 0 : i;
  };
  const nextAfter = (k) => {
    for (let step = 1; step <= BROKERS.length; step++) {
      const i = (k + step) % BROKERS.length;
      if (!(Date.now() - (failedAt[i] ?? -Infinity) < DEAD_BROKER_MS)) return i;
    }
    return (k + 1) % BROKERS.length;
  };

  const beat = () => {
    send(`${base}/presence`, { id: me.id, name: me.name, color: me.color, host: isHost }, { qos: 0 });
    const now = Date.now();
    for (const [id, p] of Object.entries(peers)) {
      if (now - p.seen > PEER_TIMEOUT_MS) delete peers[id];
    }
    onPeers({ ...peers });
  };

  function open() {
    const url = BROKERS[index];
    let connected = false;
    onStatus({ url, connected: false });
    const c = mqtt.connect(url, {
      clientId: `pwc_${me.id}_${Math.random().toString(36).slice(2, 6)}`,
      keepalive: 20,
      connectTimeout: 6000,
      reconnectPeriod: 0,
      will: { topic: `${base}/presence`, payload: JSON.stringify({ id: me.id, gone: true }), qos: 0 },
    });
    client = c;

    c.on("connect", () => {
      connected = true;
      onStatus({ url, connected: true });
      c.subscribe([`${base}/state`, `${base}/patch`, `${base}/presence`], { qos: 1 });
      c.subscribe(`${base}/live`, { qos: 0 });
      c.subscribe(`${base}/event`, { qos: 1 });
      c.subscribe(`${base}/img/+`, { qos: 1 });
      beat();
      onConnected?.();
    });

    c.on("message", (topic, buf) => {
      // Image payloads are raw data URLs; one is only accepted when it hashes to its topic id, so nobody can swap a card's picture.
      const imgPrefix = `${base}/img/`;
      if (topic.startsWith(imgPrefix)) {
        const id = topic.slice(imgPrefix.length);
        const url = buf.toString();
        if (url.startsWith("data:image/") && imageId(url) === id) onImage?.(id, url);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (topic.endsWith("/presence")) {
        if (msg.gone) delete peers[msg.id];
        else {
          const isNew = !peers[msg.id];
          peers[msg.id] = { ...msg, seen: Date.now() };
          // Answer newcomers right away so they don't wait a full heartbeat to see who is here.
          if (isNew && msg.id !== me.id) beat();
        }
        onPeers({ ...peers });
      } else if (topic.endsWith("/state")) {
        if (!isHost) onState(msg);
      } else if (topic.endsWith("/patch")) {
        if (isHost && msg.from !== me.id) onPatch(msg.patch, msg.from);
      } else if (topic.endsWith("/live")) {
        const live = readLive(msg);
        if (live && live.id !== me.id) onLive?.(live);
      } else if (topic.endsWith("/event")) {
        const ev = readEvent(msg);
        if (ev && ev.id !== me.id) onEvent?.(ev);
      }
    });

    c.on("error", () => c.end(true));
    c.on("close", () => {
      if (closed || client !== c) return;
      client = null;
      c.removeAllListeners();
      c.on("error", () => {});
      if (!connected) failedAt[index] = Date.now();
      index = connected ? firstLive() : nextAfter(index);
      setTimeout(() => !closed && open(), connected ? 500 : 1500);
    });
  }

  const stopBeat = workerInterval(beat, HEARTBEAT_MS);
  const kick = () => {
    if (client && !client.connected) client.end(true);
  };
  window.addEventListener("online", kick);
  open();

  return {
    // Returns the state's size in bytes; a state over the limit isn't sent, because brokers disconnect clients that publish it.
    publishState(state) {
      const payload = JSON.stringify(state);
      const bytes = new TextEncoder().encode(payload).length;
      if (bytes <= MAX_STATE_BYTES && client?.connected) {
        client.publish(`${base}/state`, payload, { qos: 1, retain: true });
      }
      return bytes;
    },
    sendPatch: (patch) => send(`${base}/patch`, { from: me.id, patch }),
    // Retained so players who join later still receive every image; returns false when offline so the caller can retry.
    publishImage(id, url) {
      if (!client?.connected) return false;
      client.publish(`${base}/img/${id}`, url, { qos: 1, retain: true });
      return true;
    },
    // An empty retained message deletes an image the table no longer uses from the broker.
    clearImage(id) {
      if (client?.connected) client.publish(`${base}/img/${id}`, "", { qos: 1, retain: true });
    },
    // Cursor, selection and in-progress drags are fire-and-forget; a dropped frame is replaced by the next one.
    sendLive: (live) => send(`${base}/live`, { id: me.id, ...live }, { qos: 0 }),
    // One-off table events such as shuffles; not retained, so players who join later don't replay them.
    sendEvent: (ev) => send(`${base}/event`, { id: me.id, ...ev }),
    close() {
      closed = true;
      stopBeat();
      window.removeEventListener("online", kick);
      send(`${base}/presence`, { id: me.id, gone: true }, { qos: 0 });
      client?.end();
    },
  };
}
