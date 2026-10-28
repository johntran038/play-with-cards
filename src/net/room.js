import mqtt from "mqtt";

// Tried in order; clients always return to the first reachable one so peers converge on one broker.
export const BROKERS = [
  "wss://test.mosquitto.org:8081/mqtt",
  "wss://broker.emqx.io:8084/mqtt",
  "wss://broker.hivemq.com:8884/mqtt",
];

const HEARTBEAT_MS = 5000;
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

export function createRoom({ code, me, isHost, onStatus, onState, onPatch, onPeers, onConnected }) {
  const base = `play-with-cards/v1/${code}`;
  const peers = {};
  let client = null;
  let index = 0;
  let closed = false;

  const send = (topic, payload, opts = {}) => {
    if (client?.connected) client.publish(topic, JSON.stringify(payload), { qos: 1, ...opts });
  };

  const beat = () => {
    send(`${base}/presence`, { id: me.id, name: me.name, host: isHost }, { qos: 0 });
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
      beat();
      onConnected?.();
    });

    c.on("message", (topic, buf) => {
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
        if (isHost && msg.from !== me.id) onPatch(msg.patch);
      }
    });

    c.on("error", () => c.end(true));
    c.on("close", () => {
      if (closed || client !== c) return;
      client = null;
      c.removeAllListeners();
      c.on("error", () => {});
      index = connected ? 0 : (index + 1) % BROKERS.length;
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
    publishState: (state) => send(`${base}/state`, state, { retain: true }),
    sendPatch: (patch) => send(`${base}/patch`, { from: me.id, patch }),
    close() {
      closed = true;
      stopBeat();
      window.removeEventListener("online", kick);
      send(`${base}/presence`, { id: me.id, gone: true }, { qos: 0 });
      client?.end();
    },
  };
}
