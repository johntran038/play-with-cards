import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import CardFace from "../components/CardFace";
import { getMe } from "../game/player";
import { createRoom } from "../net/room";
import {
  addImagesPatch, applyPatch, cutPatch, dealPatch, drawPatch, flipPatch, groupPatch,
  initialState, resizeImage, rotatePatch, shufflePatch, topZ, CARD_W, CARD_H,
} from "../game/game";

const HOVER_TO_DISPLAY_MS = 1000;
const DISPLAY_EXIT_MS = 500;

const centeredView = () => ({ x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 1 });

export default function Table() {
  const { code } = useParams();
  const isHost = sessionStorage.getItem(`pwc_host_${code}`) === "1";
  const me = useMemo(() => getMe(), []);
  const saveKey = `pwc_room_${code}`;

  const [state, setState] = useState(() => {
    const saved = isHost && localStorage.getItem(saveKey);
    if (saved) return JSON.parse(saved);
    return isHost ? initialState() : { cards: {}, stacks: {} };
  });
  const stateRef = useRef(state);
  const [status, setStatus] = useState({ url: "", connected: false });
  const [peers, setPeers] = useState({});
  const [view, setView] = useState(centeredView);
  const [selected, setSelected] = useState([]);
  const [hovered, setHovered] = useState(null);
  const [preview, setPreview] = useState(null);
  const roomRef = useRef(null);
  const tableRef = useRef(null);
  const dragRef = useRef(null);
  const hoverRef = useRef({ display: false, enter: null, exit: null });

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const room = createRoom({
      code,
      me,
      isHost,
      onStatus: setStatus,
      onPeers: setPeers,
      onState: (s) => setState(s),
      onPatch: (p) => setState((s) => applyPatch(s, p)),
      onConnected: () => isHost && room.publishState(stateRef.current),
    });
    roomRef.current = room;
    return () => room.close();
  }, [code, me, isHost]);

  // The host is the source of truth: it saves locally and republishes the retained state on every change.
  useEffect(() => {
    if (!isHost) return;
    const t = setTimeout(() => {
      roomRef.current?.publishState(state);
      try {
        localStorage.setItem(saveKey, JSON.stringify(state));
      } catch {
        // Storage quota can be exceeded by many uploaded images; the broker copy still exists.
      }
    }, 150);
    return () => clearTimeout(t);
  }, [state, isHost, saveKey]);

  const commit = useCallback(
    (patch, { localOnly = false } = {}) => {
      if (!patch) return;
      setState((s) => applyPatch(s, patch));
      if (!localOnly && !isHost) roomRef.current?.sendPatch(patch);
    },
    [isHost],
  );

  const targets = useCallback(
    () => (selected.length ? selected : hovered ? [hovered] : []),
    [selected, hovered],
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.ctrlKey || e.metaKey) return;
      const ids = targets();
      const s = stateRef.current;
      const actions = { s: shufflePatch, r: rotatePatch, f: flipPatch, c: cutPatch, g: groupPatch, d: drawPatch };
      const make = actions[e.key.toLowerCase()];
      if (make && ids.length) commit(make(s, ids));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [targets, commit]);

  // Wheel zoom needs a non-passive listener so the page itself does not scroll.
  useEffect(() => {
    const el = tableRef.current;
    const onWheel = (e) => {
      e.preventDefault();
      setView((v) => {
        const zoom = Math.min(4, Math.max(0.2, v.zoom * Math.exp(-e.deltaY * 0.0015)));
        const k = zoom / v.zoom;
        return { zoom, x: e.clientX - (e.clientX - v.x) * k, y: e.clientY - (e.clientY - v.y) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (d.kind === "pan") {
        setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
        return;
      }
      d.moved = true;
      const s = stateRef.current;
      const stacks = {};
      for (const [id, o] of Object.entries(d.origin)) {
        if (s.stacks[id]) stacks[id] = { ...s.stacks[id], x: o.x + dx / d.zoom, y: o.y + dy / d.zoom };
      }
      commit({ stacks }, { localOnly: true });
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.kind !== "cards" || !d.moved) return;
      const s = stateRef.current;
      const stacks = {};
      for (const id of Object.keys(d.origin)) if (s.stacks[id]) stacks[id] = s.stacks[id];
      commit({ stacks });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [commit]);

  const onTableDown = (e) => {
    if (e.button === 2) {
      dragRef.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    } else if (e.button === 0) {
      setSelected([]);
    }
  };

  // Shift-drag pulls the top card off a stack so cards can be dealt.
  const onStackDown = (e, id) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    let s = stateRef.current;
    let ids;
    if (e.shiftKey) {
      const dealt = dealPatch(s, id);
      if (dealt) {
        s = applyPatch(s, dealt.patch);
        commit(dealt.patch);
        id = dealt.newId;
      }
      ids = [id];
      setSelected(ids);
    } else if (e.ctrlKey || e.metaKey) {
      ids = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
      setSelected(ids);
      return;
    } else {
      ids = selected.includes(id) ? selected : [id];
      setSelected(ids);
    }
    let z = topZ(s);
    const origin = {};
    const raised = {};
    for (const sid of ids) {
      origin[sid] = { x: s.stacks[sid].x, y: s.stacks[sid].y };
      raised[sid] = { ...s.stacks[sid], z: z++ };
    }
    commit({ stacks: raised }, { localOnly: true });
    dragRef.current = { kind: "cards", sx: e.clientX, sy: e.clientY, zoom: view.zoom, origin, moved: false };
  };

  // Hovering 1s enters display mode; in display mode previews are instant until the pointer is off cards for 0.5s.
  const onStackEnter = (id) => {
    const h = hoverRef.current;
    setHovered(id);
    clearTimeout(h.exit);
    clearTimeout(h.enter);
    if (h.display) setPreview(id);
    else
      h.enter = setTimeout(() => {
        h.display = true;
        setPreview(id);
      }, HOVER_TO_DISPLAY_MS);
  };
  const onStackLeave = () => {
    const h = hoverRef.current;
    setHovered(null);
    clearTimeout(h.enter);
    h.exit = setTimeout(() => {
      h.display = false;
      setPreview(null);
    }, DISPLAY_EXIT_MS);
  };

  const onUpload = async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (!files.length) return;
    const urls = await Promise.all(files.map((f) => resizeImage(f)));
    commit(addImagesPatch(stateRef.current, urls));
  };

  const topCard = (stack) => state.cards[stack.cards[stack.cards.length - 1]];
  const previewStack = preview && state.stacks[preview];
  const previewCard = previewStack && topCard(previewStack);
  const hostOnline = isHost || Object.values(peers).some((p) => p.host);
  const sorted = Object.entries(state.stacks).sort((a, b) => a[1].z - b[1].z);

  return (
    <div
      ref={tableRef}
      className="fixed inset-0 select-none overflow-hidden bg-emerald-900"
      onMouseDown={onTableDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
      >
        {sorted.map(([id, stack]) => {
          const card = topCard(stack);
          if (!card) return null;
          const isSel = selected.includes(id);
          return (
            <div
              key={id}
              className="absolute"
              style={{
                left: stack.x,
                top: stack.y,
                width: CARD_W,
                height: CARD_H,
                zIndex: stack.z,
                transform: `rotate(${stack.rot}deg)`,
              }}
              onMouseDown={(e) => onStackDown(e, id)}
              onMouseEnter={() => onStackEnter(id)}
              onMouseLeave={onStackLeave}
            >
              <div
                className={`rounded-lg ${isSel ? "ring-4 ring-yellow-300" : ""}`}
                style={{ boxShadow: stack.cards.length > 1 ? "3px 3px 0 #0006, 6px 6px 0 #0004" : "" }}
              >
                <CardFace card={card} />
              </div>
              {stack.cards.length > 1 && (
                <span className="absolute -right-2 -top-2 rounded-full bg-black/80 px-2 text-xs text-white">
                  {stack.cards.length}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div
        className="absolute left-3 top-3 flex flex-wrap items-center gap-2 rounded-lg bg-black/60 p-2 text-sm text-white"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Link to="/" className="rounded bg-white/10 px-2 py-1">Leave</Link>
        <span>
          Room <b className="font-mono">{code}</b> {isHost ? "(host)" : ""}
        </span>
        <button className="rounded bg-white/10 px-2 py-1" onClick={() => navigator.clipboard?.writeText(code)}>
          Copy code
        </button>
        <button className="rounded bg-white/10 px-2 py-1" onClick={() => setView(centeredView())}>
          Center table
        </button>
        {isHost && (
          <label className="cursor-pointer rounded bg-white/10 px-2 py-1">
            Add card images
            <input type="file" accept="image/*" multiple hidden onChange={onUpload} />
          </label>
        )}
        <span className={status.connected ? "text-emerald-300" : "text-red-300"}>
          {status.connected ? "Connected" : "Connecting"} · {status.url.replace(/^wss:\/\//, "").split(":")[0]}
        </span>
        {status.connected && !hostOnline && <span className="text-amber-300">Host offline</span>}
      </div>

      <div className="absolute bottom-3 left-3 rounded-lg bg-black/60 p-2 text-xs text-white/80">
        <div>{me.name} · Players: {Object.values(peers).map((p) => p.name).join(", ")}</div>
        <div>Right-drag pan · wheel zoom · click select · ctrl+click multi · shift+drag deal</div>
        <div>S shuffle · R rotate · F flip · C cut · G group · D draw</div>
      </div>

      {previewCard && (
        <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 drop-shadow-2xl">
          <CardFace card={previewCard} size={110} />
        </div>
      )}
    </div>
  );
}
