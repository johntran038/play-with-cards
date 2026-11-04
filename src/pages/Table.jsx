import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { FiMove, FiSettings, FiX } from "react-icons/fi";
import CardFace from "../components/CardFace";
import DeckCreator from "../components/DeckCreator";
import DeckPicker from "../components/DeckPicker";
import { getImages, putImages } from "../game/images";
import { getMe } from "../game/player";
import { createRoom, MAX_STATE_BYTES } from "../net/room";
import {
  addImagesPatch, applyPatch, autoSplayPatch, cutPatch, dealPatch, drawPatch, dropTarget, flipPatch, groupPatch,
  initialState, dragSplayPatch, resizeImage, rotatePatch, shufflePatch, straightRots, topZ, uid, CARD_W, CARD_H,
  areaOf, areaPatch, boardPatch, canEditToken, isRect, tokenOnBoard, counterPatch, diePatch, guardPatch, inArea, moveArea, resizeArea, rollPatch,
  stackAreaOwner, normalizeState, COUNTER_W, DIE_SIZE, DICE, deckPatch, imageId, imageIds, removeDeckPatch, rotVec, decksIn, worldCorner,
  playingCardsPatch, returnDeckPatch,
} from "../game/game";

const HOVER_TO_DISPLAY_MS = 1000;
const DISPLAY_EXIT_MS = 500;
const DRAG_THRESHOLD_PX = 4;
const PREVIEW_PREFIX = "preview:";
// Matches the animate-toast duration in App.css.
const TOAST_MS = 1200;
const LIVE_MS = 50;
// A finished remote drag stays drawn this long so cards don't snap back while the host's saved state is on its way.
const LIVE_LINGER_MS = 1000;
const LIVE_EASE = "left 80ms linear, top 80ms linear";

// Each angle turns the table clockwise on this player's screen; a player on the table's left looks at it turned 270°.
const ORIENTATIONS = [
  ["Standard", 0],
  ["Upside down", 180],
  ["Left side", 270],
  ["Right side", 90],
];

const centeredView = (rot = 0) => ({ x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 1, rot });

// The table layer draws as translate, then rotate, then scale, so screen points map back by undoing those in reverse.
const toWorld = (sx, sy, v) => rotVec({ x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom }, -v.rot);
const toWorldDelta = (dx, dy, v) => rotVec({ x: dx / v.zoom, y: dy / v.zoom }, -v.rot);

// Turns the view to a new angle while keeping the table point at the middle of the screen where it is.
function turnView(v, rot) {
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const w = toWorld(cx, cy, v);
  const s = rotVec({ x: w.x * v.zoom, y: w.y * v.zoom }, rot);
  return { ...v, rot, x: cx - s.x, y: cy - s.y };
}

// Covers its table-space parent but faces the player, so text and corner handles inside read the player's way.
function Upright({ w, h, rot, children }) {
  const side = rot % 180 !== 0;
  return (
    <div
      className="pointer-events-none absolute left-1/2 top-1/2"
      style={{ width: side ? h : w, height: side ? w : h, transform: `translate(-50%, -50%) rotate(${-rot}deg)` }}
    >
      {children}
    </div>
  );
}

const previewOwner = (id) => id.slice(PREVIEW_PREFIX.length).split(":")[0];

// Draws another player's in-progress drag or splay over the shared state, skipping things this client doesn't have yet.
function applyLive(state, pid, ov) {
  if (ov.move || ov.tok) {
    const stacks = {};
    for (const [id, [x, y, z, rot]] of Object.entries(ov.move || {})) {
      if (state.stacks[id]) stacks[id] = { ...state.stacks[id], x, y, z, rot };
    }
    const tokens = {};
    for (const [id, [x, y, w, h]] of Object.entries(ov.tok || {})) {
      const t = state.tokens[id];
      if (t) tokens[id] = isRect(t) ? { ...t, x, y, w, h } : { ...t, x, y };
    }
    return applyPatch(state, { stacks, tokens });
  }
  const { id, start, end, rot } = ov.splay;
  const makeId = (c) => `${PREVIEW_PREFIX}${pid}:${c}`;
  const res = state.stacks[id] && dragSplayPatch(state, id, start, end, { viewRot: rot, makeId });
  return res ? applyPatch(state, res.patch) : state;
}

export default function Table() {
  const { code } = useParams();
  const isHost = sessionStorage.getItem(`pwc_host_${code}`) === "1";
  const me = useMemo(() => getMe(), []);
  const saveKey = `pwc_room_${code}`;

  // A save from before images were split out carries them inline; they move into the images map here.
  const [boot] = useState(() => {
    const images = {};
    const saved = isHost && localStorage.getItem(saveKey);
    if (saved) return { state: normalizeState(JSON.parse(saved), images), images };
    return { state: isHost ? initialState() : { cards: {}, stacks: {}, tokens: {} }, images };
  });
  const [state, setState] = useState(boot.state);
  const [images, setImages] = useState(boot.images);
  const stateRef = useRef(state);
  const publishedRef = useRef(new Set());
  const requestedRef = useRef(new Set());
  const [status, setStatus] = useState({ url: "", connected: false });
  const [peers, setPeers] = useState({});
  const rotKey = `pwc_view_rot_${code}`;
  const [view, setView] = useState(() => {
    const saved = Number(localStorage.getItem(rotKey));
    return centeredView(ORIENTATIONS.some(([, r]) => r === saved) ? saved : 0);
  });
  const [deckModal, setDeckModal] = useState(null);
  const [tooBig, setTooBig] = useState(0);
  const [selection, setSelected] = useState([]);
  const [hovered, setHovered] = useState(null);
  const [preview, setPreview] = useState(null);
  const [splayPath, setSplayPath] = useState(null);
  const [dropId, setDropId] = useState(null);
  const [menu, setMenu] = useState(null);
  const [box, setBox] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [live, setLive] = useState({});
  const [hoveredToken, setHoveredToken] = useState(null);
  const [tokenSel, setTokenSel] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Text being typed into counters, kept apart from the shared value so partial input like "-" isn't lost.
  const [drafts, setDrafts] = useState({});
  const liveOutRef = useRef({ data: { c: null, sel: [], ov: null }, timer: null });
  const roomRef = useRef(null);
  const tableRef = useRef(null);

  // Shows a fading popup at each table point; from is the player who shuffled, or null for this player.
  const addToasts = useCallback((at, from) => {
    const added = at.map((p) => ({ key: uid(), x: p.x, y: p.y, from }));
    setToasts((t) => [...t, ...added]);
    setTimeout(() => setToasts((t) => t.filter((x) => !added.includes(x))), TOAST_MS);
  }, []);
  const dragRef = useRef(null);
  const hoverRef = useRef({ display: false, enter: null, exit: null });

  // Grouping and remote patches delete stacks, so selection only exposes ids that still exist.
  const selected = useMemo(() => selection.filter((id) => state.stacks[id]), [selection, state.stacks]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Each player's orientation is remembered per room in this browser.
  useEffect(() => {
    localStorage.setItem(rotKey, String(view.rot));
  }, [rotKey, view.rot]);

  useEffect(() => {
    const room = createRoom({
      code,
      me,
      isHost,
      onStatus: setStatus,
      onPeers: setPeers,
      onState: (s) => {
        const found = {};
        setState(normalizeState(s, found));
        if (Object.keys(found).length) setImages((all) => ({ ...all, ...found }));
      },
      onImage: (id, url) => {
        setImages((all) => (all[id] ? all : { ...all, [id]: url }));
        putImages({ [id]: url }).catch(() => {});
      },
      onPatch: (p, from) => setState((s) => applyPatch(s, guardPatch(s, p, from))),
      onLive: (msg) =>
        setLive((all) => {
          const prev = all[msg.id];
          const linger = msg.ov
            ? null
            : prev?.ov
              ? { ov: prev.ov, until: Date.now() + LIVE_LINGER_MS }
              : (prev?.linger ?? null);
          return { ...all, [msg.id]: { ...msg, linger } };
        }),
      onEvent: (ev) => addToasts(ev.at, ev.id),
      onConnected: () => {
        // A new connection may be a different broker, which has none of the images yet.
        publishedRef.current = new Set();
        if (isHost) room.publishState(stateRef.current);
      },
    });
    roomRef.current = room;
    return () => room.close();
  }, [code, me, isHost, addToasts]);

  // Clears each finished remote drag once its linger time is up.
  useEffect(() => {
    const untils = Object.values(live).map((l) => l.linger?.until).filter(Boolean);
    if (!untils.length) return;
    const t = setTimeout(
      () =>
        setLive((all) =>
          Object.fromEntries(
            Object.entries(all).map(([id, l]) => [id, l.linger?.until <= Date.now() ? { ...l, linger: null } : l]),
          ),
        ),
      Math.max(0, Math.min(...untils) - Date.now()) + 10,
    );
    return () => clearTimeout(t);
  }, [live]);

  // Merges live changes and sends the latest snapshot at most every LIVE_MS.
  const pushLive = useCallback((part) => {
    const out = liveOutRef.current;
    Object.assign(out.data, part);
    if (out.timer) return;
    out.timer = setTimeout(() => {
      out.timer = null;
      roomRef.current?.sendLive(out.data);
    }, LIVE_MS);
  }, []);

  // Loads images the cards need from this browser's cache, each id at most once per page load.
  useEffect(() => {
    const missing = imageIds(state).filter((id) => !images[id] && !requestedRef.current.has(id));
    if (!missing.length) return;
    for (const id of missing) requestedRef.current.add(id);
    getImages(missing)
      .then((found) => Object.keys(found).length && setImages((all) => ({ ...found, ...all })))
      .catch(() => {});
  }, [state, images]);

  // Keeps every image this browser has in its cache, including ones from older inline saves.
  useEffect(() => {
    putImages(boot.images).catch(() => {});
  }, [boot]);

  // The host sends each image the table uses once per connection and clears ones it no longer uses.
  useEffect(() => {
    if (!isHost || !status.connected) return;
    const room = roomRef.current;
    const used = new Set(imageIds(state));
    for (const id of used) {
      if (images[id] && !publishedRef.current.has(id) && room?.publishImage(id, images[id])) publishedRef.current.add(id);
    }
    for (const id of publishedRef.current) {
      if (used.has(id)) continue;
      room?.clearImage(id);
      publishedRef.current.delete(id);
    }
  }, [state, images, isHost, status]);

  // Stores new card images, then returns their ids for the cards to reference.
  const addImages = useCallback((urls) => {
    const found = {};
    const ids = urls.map((url) => {
      const id = imageId(url);
      found[id] = url;
      return id;
    });
    setImages((all) => ({ ...all, ...found }));
    putImages(found).catch(() => {});
    return ids;
  }, []);

  // The host is the source of truth: it saves locally and republishes the retained state on every change.
  useEffect(() => {
    if (!isHost) return;
    const t = setTimeout(() => {
      const bytes = roomRef.current?.publishState(state);
      if (bytes !== undefined) setTooBig(bytes > MAX_STATE_BYTES ? bytes : 0);
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

  // Stack ids never contain commas, so the joined string is a cheap change check for the selection.
  const selKey = selected.join(",");
  const peerCount = Object.keys(peers).length;
  useEffect(() => {
    pushLive({ sel: selKey ? selKey.split(",") : [] });
  }, [selKey, peerCount, pushLive]);

  // Raises the stacks above everything and starts dragging them; positions are only broadcast on release.
  const beginMove = useCallback(
    (s, ids, sx, sy, v) => {
      let z = topZ(s);
      const origin = {};
      const raised = {};
      const rots = straightRots(s, ids.filter((sid) => s.stacks[sid]));
      for (const sid of ids) {
        if (!s.stacks[sid]) continue;
        origin[sid] = { x: s.stacks[sid].x, y: s.stacks[sid].y, rot: rots[sid] };
        raised[sid] = { ...s.stacks[sid], z: z++ };
      }
      commit({ stacks: raised }, { localOnly: true });
      dragRef.current = { kind: "cards", sx, sy, view: v, origin, moved: false, target: null };
    },
    [commit],
  );

  const splay = useCallback(
    (ids, curved) => {
      const res = autoSplayPatch(stateRef.current, ids, curved, view.rot);
      if (!res) return;
      commit(res.patch);
      setSelected(res.ids);
    },
    [commit, view.rot],
  );

  // Shuffling shows a popup above each deck for every player, so everyone can see a shuffle happened.
  const shuffle = useCallback(
    (ids) => {
      const s = stateRef.current;
      commit(shufflePatch(s, ids));
      // Deck centers are sent; each player draws the popup above the deck as they see it.
      const at = ids
        .filter((id) => s.stacks[id]?.cards.length > 1)
        .map((id) => ({ x: Math.round(s.stacks[id].x + CARD_W / 2), y: Math.round(s.stacks[id].y + CARD_H / 2) }));
      if (!at.length) return;
      addToasts(at, null);
      roomRef.current?.sendEvent({ type: "shuffle", at });
    },
    [commit, addToasts],
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.metaKey || deckModal) return;
      if (e.key === "Escape") {
        setMenu(null);
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "backspace") {
        const id = hoveredToken ?? tokenSel;
        const t = id && stateRef.current.tokens[id];
        // Boards are only removed from the host's right-click menu, never by Backspace.
        if (t && t.kind !== "board" && canEditToken(t, me.id, isHost)) {
          e.preventDefault();
          commit({ tokens: { [id]: null } });
          setTokenSel(null);
          setHoveredToken(null);
        }
        return;
      }
      const ids = targets();
      if (key === "s" && e.shiftKey) {
        e.preventDefault();
        if (ids.length) splay(ids, e.ctrlKey);
        return;
      }
      if (e.ctrlKey) return;
      if (key === "s") {
        if (ids.length) shuffle(ids);
        return;
      }
      const actions = { r: rotatePatch, f: flipPatch, c: cutPatch, g: groupPatch, d: drawPatch };
      const make = actions[key];
      // Cut and draw place cards relative to how this player sees the table.
      if (make && ids.length) commit(make(stateRef.current, ids, view.rot));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [targets, commit, splay, shuffle, hoveredToken, tokenSel, me.id, isHost, view.rot, deckModal]);

  // Wheel zoom needs a non-passive listener so the page itself does not scroll.
  useEffect(() => {
    const el = tableRef.current;
    const onWheel = (e) => {
      // Panels and dialogs keep their own scrolling and zoom.
      if (e.target.closest("[data-ui]")) return;
      e.preventDefault();
      setView((v) => {
        const zoom = Math.min(4, Math.max(0.2, v.zoom * Math.exp(-e.deltaY * 0.0015)));
        const k = zoom / v.zoom;
        return { ...v, zoom, x: e.clientX - (e.clientX - v.x) * k, y: e.clientY - (e.clientY - v.y) * k };
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
      const far = Math.hypot(dx, dy) > DRAG_THRESHOLD_PX;
      if (d.kind === "pan") {
        if (far) d.moved = true;
        setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
      } else if (d.kind === "box") {
        d.box = {
          left: Math.min(d.sx, e.clientX),
          top: Math.min(d.sy, e.clientY),
          width: Math.abs(dx),
          height: Math.abs(dy),
        };
        setBox(d.box);
      } else if (d.kind === "ctrl") {
        // Ctrl-dragging a group deals its top card without touching the selection; on a lone card the release still counts as a ctrl+click.
        const dealt = far && dealPatch(stateRef.current, d.id);
        if (!dealt) return;
        commit(dealt.patch);
        beginMove(applyPatch(stateRef.current, dealt.patch), [dealt.newId], d.sx, d.sy, d.view);
      } else if (d.kind === "splay") {
        const p = toWorld(e.clientX, e.clientY, d.view);
        d.end = { x: p.x + d.off.x, y: p.y + d.off.y };
        setSplayPath({ id: d.id, start: d.start, end: d.end });
        pushLive({ ov: { splay: { id: d.id, start: d.start, end: d.end, rot: d.view.rot } } });
      } else if (d.kind === "token") {
        const s = stateRef.current;
        const t = s.tokens[d.id];
        if (!t || (!d.moved && !far)) return;
        d.moved = true;
        const wd = toWorldDelta(dx, dy, d.view);
        const want = { x: d.origin.x + wd.x, y: d.origin.y + wd.y };
        const pos = isRect(t) ? moveArea(s, d.id, want) : want;
        const ox = pos.x - d.origin.x;
        const oy = pos.y - d.origin.y;
        // Cards in a hidden area, and cards, counters and dice on a board, travel with it.
        const stacks = {};
        const move = {};
        for (const [sid, o] of Object.entries(d.carry)) {
          if (!s.stacks[sid]) continue;
          stacks[sid] = { ...s.stacks[sid], x: o.x + ox, y: o.y + oy };
          move[sid] = [Math.round(stacks[sid].x), Math.round(stacks[sid].y), stacks[sid].z, stacks[sid].rot];
        }
        const moved = { [d.id]: { ...t, ...pos } };
        const tok = { [d.id]: [Math.round(pos.x), Math.round(pos.y), t.w ?? 0, t.h ?? 0] };
        for (const [tid, o] of Object.entries(d.carryTok)) {
          if (!s.tokens[tid]) continue;
          moved[tid] = { ...s.tokens[tid], x: o.x + ox, y: o.y + oy };
          tok[tid] = [Math.round(moved[tid].x), Math.round(moved[tid].y), 0, 0];
        }
        commit({ tokens: moved, stacks }, { localOnly: true });
        pushLive({ ov: { move, tok } });
      } else if (d.kind === "resize") {
        const s = stateRef.current;
        if (!s.tokens[d.id]) return;
        // The handle sits at the player's bottom-right, which can be any table corner, so it grows away from the opposite one.
        const wd = toWorldDelta(dx, dy, d.view);
        const w = d.origin.w + (d.corner.x ? wd.x : -wd.x);
        const h = d.origin.h + (d.corner.y ? wd.y : -wd.y);
        const r = resizeArea(s, d.id, w, h, d.corner);
        if (!r) return;
        d.moved = true;
        commit({ tokens: { [d.id]: r } }, { localOnly: true });
        pushLive({ ov: { tok: { [d.id]: [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)] } } });
      } else {
        d.moved = true;
        const s = stateRef.current;
        const stacks = {};
        // Tilted cards, such as ones taken from a fan, straighten to the nearest vertical or horizontal once dragged.
        const wd = toWorldDelta(dx, dy, d.view);
        for (const [id, o] of Object.entries(d.origin)) {
          if (s.stacks[id]) {
            stacks[id] = { ...s.stacks[id], x: o.x + wd.x, y: o.y + wd.y, rot: o.rot };
          }
        }
        commit({ stacks }, { localOnly: true });
        const move = {};
        for (const [id, st] of Object.entries(stacks)) move[id] = [Math.round(st.x), Math.round(st.y), st.z, st.rot];
        pushLive({ ov: { move } });
        const ids = Object.keys(d.origin);
        d.target = ids.length === 1 ? dropTarget(applyPatch(s, { stacks }), ids[0]) : null;
        setDropId(d.target);
      }
    };
    const onUp = (e) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      if (liveOutRef.current.data.ov) pushLive({ ov: null });
      const s = stateRef.current;
      if (d.kind === "pan") {
        // A right click that never dragged opens the die or group menu instead of panning.
        if (d.moved) return;
        const kind = s.tokens[d.token]?.kind;
        if (kind === "die") setMenu({ kind: "die", id: d.token, x: e.clientX, y: e.clientY });
        else if (s.stacks[d.stack]?.cards.length > 1) setMenu({ kind: "stack", id: d.stack, x: e.clientX, y: e.clientY });
        else if (kind === "board" && isHost && !d.stack) setMenu({ kind: "board", id: d.token, x: e.clientX, y: e.clientY });
      } else if (d.kind === "token" || d.kind === "resize") {
        const t = s.tokens[d.id];
        if (!d.moved || !t) return;
        const stacks = {};
        for (const sid of Object.keys(d.carry || {})) if (s.stacks[sid]) stacks[sid] = s.stacks[sid];
        const moved = { [d.id]: t };
        for (const tid of Object.keys(d.carryTok || {})) if (s.tokens[tid]) moved[tid] = s.tokens[tid];
        commit({ tokens: moved, stacks });
      } else if (d.kind === "box") {
        setBox(null);
        if (!d.box) return;
        // Adds every stack the box touches, bottom-most first so grouping keeps the order they are laid out in.
        // A turned view can swap or flip the box corners in table space, so the edges are taken from both.
        const p = toWorld(d.box.left, d.box.top, d.view);
        const q = toWorld(d.box.left + d.box.width, d.box.top + d.box.height, d.view);
        const a = { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y) };
        const b = { x: Math.max(p.x, q.x), y: Math.max(p.y, q.y) };
        const hits = Object.entries(s.stacks)
          .filter(([, st]) => st.x < b.x && st.x + CARD_W > a.x && st.y < b.y && st.y + CARD_H > a.y)
          .sort((p, q) => p[1].z - q[1].z)
          .map(([id]) => id);
        setSelected((sel) => [...sel.filter((id) => s.stacks[id]), ...hits.filter((id) => !sel.includes(id))]);
      } else if (d.kind === "ctrl") {
        setSelected((sel) => (sel.includes(d.id) ? sel.filter((x) => x !== d.id) : [...sel, d.id]));
      } else if (d.kind === "splay") {
        setSplayPath(null);
        const res = dragSplayPatch(s, d.id, d.start, d.end, { viewRot: d.view.rot });
        if (res) {
          commit(res.patch);
          setSelected(res.ids);
        }
      } else if (d.moved) {
        setDropId(null);
        if (d.target && s.stacks[d.target]) {
          commit(groupPatch(s, [d.target, ...Object.keys(d.origin)]));
          setSelected([d.target]);
          return;
        }
        const stacks = {};
        for (const id of Object.keys(d.origin)) if (s.stacks[id]) stacks[id] = s.stacks[id];
        commit({ stacks });
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [commit, beginMove, pushLive, isHost]);

  const onTableDown = (e) => {
    setMenu(null);
    if (e.button === 2 && (e.ctrlKey || e.metaKey)) {
      dragRef.current = { kind: "box", sx: e.clientX, sy: e.clientY, view };
    } else if (e.button === 2) {
      const stack = e.target.closest("[data-stack]")?.dataset.stack;
      const token = e.target.closest("[data-token]")?.dataset.token;
      dragRef.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false, stack, token };
    } else if (e.button === 0) {
      setSelected([]);
      setTokenSel(null);
    }
  };

  // Counters and dice drag for anyone, a hidden area for its owner and the host, a board for the host from its handle; otherwise clicks fall through to the table.
  const onTokenDown = (e, id) => {
    const s = stateRef.current;
    const t = s.tokens[id];
    if (!t || e.button !== 0 || !canEditToken(t, me.id, isHost)) return;
    e.stopPropagation();
    setMenu(null);
    if (e.target.closest("input, button")) return;
    setTokenSel(id);
    const carry = {};
    const carryTok = {};
    if (isRect(t)) {
      for (const [sid, st] of Object.entries(s.stacks)) if (inArea(st, t)) carry[sid] = { x: st.x, y: st.y };
    } else {
      commit({ tokens: { [id]: { ...t, z: topZ(s) } } }, { localOnly: true });
    }
    if (t.kind === "board") {
      for (const [tid, o] of Object.entries(s.tokens)) {
        if (!isRect(o) && tokenOnBoard(o, t)) carryTok[tid] = { x: o.x, y: o.y };
      }
    }
    dragRef.current = {
      kind: "token", id, sx: e.clientX, sy: e.clientY, view, origin: t, carry, carryTok, moved: false,
    };
  };

  const onResizeDown = (e, id) => {
    const t = stateRef.current.tokens[id];
    if (!t || e.button !== 0) return;
    e.stopPropagation();
    setTokenSel(id);
    const corner = worldCorner(view.rot, 1, 1);
    dragRef.current = { kind: "resize", id, sx: e.clientX, sy: e.clientY, view, corner, origin: t, moved: false };
  };

  const setCounter = (id, value) => {
    const t = stateRef.current.tokens[id];
    if (t) commit({ tokens: { [id]: { ...t, value } } });
  };

  const onCounterType = (id, text) => {
    setDrafts((all) => ({ ...all, [id]: text }));
    const n = Number(text);
    if (text.trim() !== "" && Number.isInteger(n)) setCounter(id, n);
  };

  // New tokens appear in the middle of what this player is looking at.
  const viewCenter = () => {
    const p = toWorld(window.innerWidth / 2, window.innerHeight / 2, view);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  };

  // Ctrl waits for movement to choose between dealing and toggling selection; shift on a group draws a splay path.
  const onStackDown = (e, id) => {
    setMenu(null);
    if (e.button !== 0) return;
    e.stopPropagation();
    setTokenSel(null);
    const s = stateRef.current;
    const stack = s.stacks[id];
    if (!stack) return;
    if (e.ctrlKey || e.metaKey) {
      dragRef.current = { kind: "ctrl", id, sx: e.clientX, sy: e.clientY, view };
    } else if (e.shiftKey && stack.cards.length > 1) {
      const center = { x: stack.x + CARD_W / 2, y: stack.y + CARD_H / 2 };
      const p = toWorld(e.clientX, e.clientY, view);
      const off = { x: center.x - p.x, y: center.y - p.y };
      setSelected([id]);
      dragRef.current = { kind: "splay", id, sx: e.clientX, sy: e.clientY, view, off, start: center, end: center };
    } else {
      const ids = selected.includes(id) ? selected : [id];
      setSelected(ids);
      beginMove(s, ids, e.clientX, e.clientY, view);
    }
  };

  // Groups in selection order like G, but moves the result onto the double-clicked card.
  const onStackDoubleClick = (id) => {
    if (selected.length < 2 || !selected.includes(id)) return;
    const s = stateRef.current;
    const patch = groupPatch(s, selected);
    if (!patch) return;
    const [base] = selected;
    patch.stacks[base] = { ...patch.stacks[base], x: s.stacks[id].x, y: s.stacks[id].y };
    commit(patch);
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
    commit(addImagesPatch(stateRef.current, addImages(urls)));
  };

  // While shift-dragging, the table shows the splay result under preview ids that are never committed.
  const splayPreview = useMemo(
    () =>
      splayPath &&
      dragSplayPatch(state, splayPath.id, splayPath.start, splayPath.end, {
        viewRot: view.rot,
        makeId: (c) => `${PREVIEW_PREFIX}${me.id}:${c}`,
      }),
    [state, splayPath, me.id, view.rot],
  );

  // Only players still sending heartbeats are drawn, so a closed tab's cursor and drag disappear with it.
  const remote = Object.values(live).filter((l) => peers[l.id]);
  const colorOf = (id) => (typeof peers[id]?.color === "string" ? peers[id].color : "#ffffff");
  let shown = splayPreview ? applyPatch(state, splayPreview.patch) : state;
  const remoteMoved = new Set();
  const remoteSel = {};
  for (const l of remote) {
    const ov = l.ov || l.linger?.ov;
    if (ov) shown = applyLive(shown, l.id, ov);
    for (const id of Object.keys(ov?.move || {})) remoteMoved.add(id);
    for (const id of Object.keys(ov?.tok || {})) remoteMoved.add(id);
    for (const id of l.sel) remoteSel[id] = colorOf(l.id);
  }

  const onTableMove = (e) => {
    const p = toWorld(e.clientX, e.clientY, view);
    pushLive({ c: { x: Math.round(p.x), y: Math.round(p.y) } });
  };

  // Cards in another player's hidden area show their back to everyone but that player.
  const topCard = (stack) => {
    const raw = shown.cards[stack.cards[stack.cards.length - 1]];
    const card = raw?.imgId ? { ...raw, img: images[raw.imgId] } : raw;
    const owner = card && stackAreaOwner(shown, stack);
    return owner && owner !== me.id ? { ...card, faceUp: false } : card;
  };
  const previewStack = preview && shown.stacks[preview];
  const previewCard = previewStack && topCard(previewStack);
  const hostOnline = isHost || Object.values(peers).some((p) => p.host);
  const sorted = Object.entries(shown.stacks).sort((a, b) => a[1].z - b[1].z);
  // Boards render first so they sit under hidden areas, cards and the other tokens.
  const tokens = Object.entries(shown.tokens).sort((a, b) => (b[1].kind === "board") - (a[1].kind === "board"));
  const hasArea = Boolean(areaOf(state, me.id));
  const nameOf = (id, fallback) => (id === me.id ? me.name : (peers[id]?.name ?? fallback ?? "Player"));
  const areaColor = (t) => (t.owner === me.id ? me.color : peers[t.owner] ? colorOf(t.owner) : (t.color ?? "#ffffff"));

  const menuItems =
    menu?.kind === "board"
      ? [["Remove board", "", () => commit({ tokens: { [menu.id]: null } })]]
      : menu?.kind === "die"
      ? [
          ["Roll", "Double-click", () => commit(rollPatch(stateRef.current, menu.id))],
          ...DICE.map((n) => [
            `d${n}`,
            state.tokens[menu.id]?.sides === n ? "✓" : "",
            () => commit(rollPatch(stateRef.current, menu.id, n)),
          ]),
        ]
      : [
          ["Shuffle", "S", () => shuffle([menu?.id])],
          ["Splay straight", "Shift+S", () => splay([menu?.id], false)],
          ["Splay hand", "Ctrl+Shift+S", () => splay([menu?.id], true)],
          // Only the host adds decks, so only the host can gather one back or take a whole one off the table.
          ...(isHost && menu?.kind === "stack"
            ? decksIn(state, menu.id).map(({ deck, name, whole }) =>
                whole
                  ? [
                      `Delete deck "${name}"`,
                      "",
                      () => {
                        if (window.confirm(`Remove every card of "${name}" from the table? This can't be undone.`)) {
                          commit(removeDeckPatch(stateRef.current, deck));
                        }
                      },
                      `delete:${deck}`,
                    ]
                  : [
                      `Return all cards to "${name}"`,
                      "",
                      () => commit(returnDeckPatch(stateRef.current, menu.id, deck)),
                      `return:${deck}`,
                    ],
              )
            : []),
        ];

  const settings = [
    {
      label: "Add hidden area",
      note: hasArea ? "You already have one" : "",
      disabled: hasArea,
      run: () => commit(areaPatch(stateRef.current, me, viewCenter(), view.rot)),
    },
  ];
  const hostSettings = [
    { label: "Add counter", run: () => commit(counterPatch(stateRef.current, viewCenter())) },
    { label: "Add dice", run: () => commit(diePatch(stateRef.current, viewCenter())) },
    { label: "Add board", run: () => commit(boardPatch(stateRef.current, viewCenter(), view.rot)) },
    { label: "Create a deck", note: "Cut a sheet of card images into a saved deck", run: () => setDeckModal("create") },
    { label: "Add a deck", note: "Put one of your saved decks on the table", run: () => setDeckModal("pick") },
  ];

  const tokenEvents = (id) => ({
    "data-token": id,
    onMouseDown: (e) => onTokenDown(e, id),
    onMouseEnter: () => setHoveredToken(id),
    onMouseLeave: () => setHoveredToken((h) => (h === id ? null : h)),
  });

  return (
    <div
      ref={tableRef}
      className="fixed inset-0 select-none overflow-hidden bg-emerald-900"
      onMouseDown={onTableDown}
      onMouseMove={onTableMove}
      onMouseLeave={() => pushLive({ c: null })}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) rotate(${view.rot}deg) scale(${view.zoom})` }}
      >
        {tokens.map(([id, t]) => {
          const sel = tokenSel === id ? "outline-3 outline-yellow-300" : "";
          const ease = remoteMoved.has(id) ? LIVE_EASE : undefined;
          if (t.kind === "board") {
            // The body only reports the board under right-clicks; moving starts from the corner handle.
            return (
              <div
                key={id}
                data-token={id}
                className="absolute rounded-lg border-4 border-amber-950 shadow-xl"
                style={{ left: t.x, top: t.y, width: t.w, height: t.h, zIndex: 0, background: "#7a4a24", transition: ease }}
              >
                {isHost && (
                  <Upright w={t.w} h={t.h} rot={view.rot}>
                    <div
                      className="pointer-events-auto absolute -right-1 -top-1 flex h-7 w-7 cursor-move items-center justify-center rounded-bl-lg rounded-tr-md bg-amber-950 text-amber-200"
                      title="Move board"
                      onMouseDown={(e) => onTokenDown(e, id)}
                    >
                      <FiMove size={16} />
                    </div>
                    <div
                      className="pointer-events-auto absolute -bottom-1 -right-1 h-5 w-5 cursor-se-resize rounded-br-md rounded-tl-lg bg-amber-950"
                      title="Resize board"
                      onMouseDown={(e) => onResizeDown(e, id)}
                    />
                  </Upright>
                )}
              </div>
            );
          }
          if (t.kind === "area") {
            const color = areaColor(t);
            const editable = canEditToken(t, me.id, isHost);
            return (
              <div
                key={id}
                {...tokenEvents(id)}
                className={`absolute rounded-xl border-2 bg-black/45 ${sel} ${editable ? "cursor-move" : ""}`}
                style={{ left: t.x, top: t.y, width: t.w, height: t.h, zIndex: 0, borderColor: color, transition: ease }}
              >
                <Upright w={t.w} h={t.h} rot={view.rot}>
                  <span className="absolute left-2 top-1 text-xs font-semibold" style={{ color }}>
                    {t.owner === me.id ? "Your hidden area" : `${nameOf(t.owner, t.ownerName)}'s hidden area`}
                  </span>
                  {editable && (
                    <div
                      className="pointer-events-auto absolute bottom-0 right-0 h-4 w-4 cursor-se-resize rounded-tl rounded-br-xl"
                      style={{ background: color }}
                      onMouseDown={(e) => onResizeDown(e, id)}
                    />
                  )}
                </Upright>
              </div>
            );
          }
          // Only a counter's number turns to face the player; the − and + buttons keep their place.
          if (t.kind === "counter") {
            return (
              <div
                key={id}
                {...tokenEvents(id)}
                className={`absolute flex cursor-move flex-col rounded-lg bg-black/75 px-3 pb-4 text-white shadow-lg ${sel}`}
                style={{ left: t.x, top: t.y, width: COUNTER_W, zIndex: t.z, transition: ease }}
              >
                <div className="flex h-5 items-center justify-center">
                  <div className="h-1 w-10 rounded-full bg-white/40" />
                </div>
                <div className="flex items-center gap-1">
                  <button className="h-8 w-8 rounded bg-white/10 text-lg" onClick={() => setCounter(id, t.value - 1)}>
                    −
                  </button>
                  <input
                    className="h-8 w-0 flex-1 cursor-text rounded bg-white/10 text-center font-mono"
                    style={{ transform: `rotate(${-view.rot}deg)` }}
                    inputMode="numeric"
                    value={drafts[id] ?? String(t.value)}
                    onChange={(e) => onCounterType(id, e.target.value)}
                    onBlur={() => setDrafts((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k !== id)))}
                  />
                  <button className="h-8 w-8 rounded bg-white/10 text-lg" onClick={() => setCounter(id, t.value + 1)}>
                    +
                  </button>
                </div>
              </div>
            );
          }
          return (
            <div
              key={id}
              {...tokenEvents(id)}
              className={`absolute flex cursor-move flex-col items-center justify-center rounded-xl bg-white text-black shadow-lg ${sel}`}
              style={{ left: t.x, top: t.y, width: DIE_SIZE, height: DIE_SIZE, zIndex: t.z, transition: ease }}
              onDoubleClick={() => commit(rollPatch(stateRef.current, id))}
            >
              <div className="flex flex-col items-center" style={{ transform: `rotate(${-view.rot}deg)` }}>
                <span className="text-2xl font-bold leading-none">{t.value}</span>
                <span className="text-[10px] text-black/60">d{t.sides}</span>
              </div>
            </div>
          );
        })}
        {sorted.map(([id, stack]) => {
          const card = topCard(stack);
          if (!card) return null;
          const isPreview = id.startsWith(PREVIEW_PREFIX);
          const owner = isPreview ? previewOwner(id) : null;
          const mine = owner === me.id || selected.includes(id);
          // Other players' selections and splay previews are outlined in their color.
          const theirs = !mine && (owner ? peers[owner] && colorOf(owner) : remoteSel[id]);
          // Highlights use outline because Tailwind rings are box-shadows, which the deck's inline stacked shadow overrides.
          const ring =
            id === dropId
              ? "outline-4 outline-offset-2 outline-sky-400"
              : mine
                ? "outline-4 outline-yellow-300"
                : theirs
                  ? "outline-4"
                  : "";
          return (
            <div
              key={id}
              data-stack={id}
              className="absolute"
              style={{
                left: stack.x,
                top: stack.y,
                width: CARD_W,
                height: CARD_H,
                zIndex: stack.z,
                transform: `rotate(${stack.rot}deg)`,
                pointerEvents: isPreview ? "none" : undefined,
                transition: remoteMoved.has(id) ? LIVE_EASE : undefined,
              }}
              onMouseDown={(e) => onStackDown(e, id)}
              onMouseEnter={() => onStackEnter(id)}
              onMouseLeave={onStackLeave}
              onDoubleClick={() => onStackDoubleClick(id)}
            >
              <div
                className={`rounded-lg ${ring}`}
                style={{
                  boxShadow: stack.cards.length > 1 ? "3px 3px 0 #0006, 6px 6px 0 #0004" : "",
                  outlineColor: theirs && id !== dropId ? theirs : undefined,
                }}
              >
                <CardFace card={card} />
              </div>
              {stack.cards.length > 1 && (
                <span
                  className="absolute -right-2 -top-2 rounded-full bg-black/80 px-2 text-xs text-white"
                  style={{ transform: `rotate(${-(stack.rot + view.rot)}deg)` }}
                >
                  {stack.cards.length}
                </span>
              )}
            </div>
          );
        })}
        {toasts.map((t) => (
          // The wrapper turns to face the player at the deck's center, so the popup rises off the top edge they see.
          <div
            key={t.key}
            className="pointer-events-none absolute"
            style={{ left: t.x, top: t.y, zIndex: 1e9, transform: `rotate(${-view.rot}deg)`, transformOrigin: "0 0" }}
          >
            <div
              className="animate-toast absolute left-0 rounded-full bg-black/80 px-3 py-1 text-sm font-semibold whitespace-nowrap text-white"
              style={{ top: -CARD_H / 2 }}
            >
              {t.from ? (
                <>
                  <span style={{ color: colorOf(t.from) }}>{peers[t.from]?.name ?? "Someone"}</span> shuffled
                </>
              ) : (
                "Shuffled"
              )}
            </div>
          </div>
        ))}
        {remote.map(
          (l) =>
            l.c && (
              <div
                key={l.id}
                className="pointer-events-none absolute flex items-start"
                style={{
                  left: l.c.x,
                  top: l.c.y,
                  zIndex: 1e9 + 1,
                  transform: `rotate(${-view.rot}deg) scale(${1 / view.zoom})`,
                  transformOrigin: "0 0",
                  transition: LIVE_EASE,
                }}
              >
                <svg width="20" height="20" viewBox="0 0 20 20">
                  <path
                    d="M2 1 L2 16 L6 12 L9 19 L12 18 L9 11 L15 11 Z"
                    fill={colorOf(l.id)}
                    stroke="white"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                </svg>
                <span
                  className="mt-4 rounded px-1.5 text-xs font-semibold whitespace-nowrap text-black"
                  style={{ background: colorOf(l.id) }}
                >
                  {peers[l.id].name}
                </span>
              </div>
            ),
        )}
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
        <button className="rounded bg-white/10 px-2 py-1" onClick={() => setView((v) => centeredView(v.rot))}>
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
        {tooBig > 0 && (
          <span className="text-amber-300" title="Other players only see the table up to the last change that fit.">
            Table too big to sync ({(tooBig / 1048576).toFixed(1)} MB of {(MAX_STATE_BYTES / 1048576).toFixed(1)} MB). Remove some cards.
          </span>
        )}
      </div>

      <div className="absolute bottom-3 left-3 rounded-lg bg-black/60 p-2 text-xs text-white/80">
        <div className="text-sm">
          You: <b style={{ color: me.color }}>{me.name}</b> · Players:{" "}
          {Object.values(peers)
            .filter((p) => p.id !== me.id)
            .map((p, i) => (
              <span key={p.id}>
                {i > 0 && ", "}
                <b style={{ color: colorOf(p.id) }}>{p.name}</b>
              </span>
            ))}
        </div>
        <div>Right-drag pan · right-click group menu · wheel zoom · click select · ctrl+click multi · ctrl+right-drag box select</div>
        <div>Ctrl+drag deal · shift+drag splay · drop a group on a group to combine · double-click selection to group</div>
        <div>S shuffle · Shift+S splay · Ctrl+Shift+S hand · R rotate · F flip · C cut · G group · D draw</div>
        <div>Double-click die roll · right-click die type · Backspace removes hovered or selected token</div>
      </div>

      <button
        data-ui
        className="absolute right-3 top-3 rounded-lg bg-black/60 p-2 text-white"
        title="Settings"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setSettingsOpen(true)}
      >
        <FiSettings size={20} />
      </button>

      {settingsOpen && (
        <aside
          data-ui
          className="absolute right-0 top-0 flex h-full w-72 flex-col gap-4 overflow-y-auto bg-black/85 p-4 text-white shadow-2xl"
          style={{ zIndex: 10 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Settings</h2>
            <button className="rounded p-1 hover:bg-white/10" title="Close" onClick={() => setSettingsOpen(false)}>
              <FiX size={20} />
            </button>
          </div>
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-white/50">Orientation</h3>
            <div className="grid grid-cols-2 gap-2">
              {ORIENTATIONS.map(([label, rot]) => (
                <button
                  key={rot}
                  className={`rounded px-3 py-2 text-sm ${view.rot === rot ? "bg-emerald-600" : "bg-white/10 hover:bg-white/20"}`}
                  onClick={() => setView((v) => turnView(v, rot))}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>
          {[
            ["Player", settings],
            ...(isHost ? [["Host", hostSettings]] : []),
          ].map(([title, items]) => (
            <section key={title} className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-white/50">{title}</h3>
              {items.map((item) => (
                <button
                  key={item.label}
                  disabled={item.disabled}
                  className="flex flex-col items-start rounded bg-white/10 px-3 py-2 text-left enabled:hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={item.run}
                >
                  <span>{item.label}</span>
                  {item.note && <span className="text-xs text-white/60">{item.note}</span>}
                </button>
              ))}
            </section>
          ))}
        </aside>
      )}

      {box && (
        <div
          className="pointer-events-none absolute border-2 border-sky-400 bg-sky-400/20"
          style={box}
        />
      )}

      {menu && (
        <div
          className="absolute flex min-w-52 flex-col rounded-lg bg-black/85 p-1 text-sm text-white shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {menuItems.map(([label, keys, run, id]) => (
            <button
              key={id ?? label}
              className="flex justify-between gap-4 rounded px-3 py-1 text-left"
              onClick={() => {
                run();
                setMenu(null);
              }}
            >
              <span>{label}</span>
              <span className="text-white/50">{keys}</span>
            </button>
          ))}
        </div>
      )}

      {previewCard && (
        <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 drop-shadow-2xl">
          <CardFace card={previewCard} size={110} />
        </div>
      )}

      {deckModal === "create" && <DeckCreator onClose={() => setDeckModal(null)} />}
      {deckModal === "pick" && (
        <DeckPicker
          onClose={() => setDeckModal(null)}
          onPick={(urls, name) => commit(deckPatch(stateRef.current, addImages(urls), viewCenter(), view.rot, name))}
          onPickPlaying={() => commit(playingCardsPatch(stateRef.current, viewCenter(), view.rot))}
        />
      )}
    </div>
  );
}
