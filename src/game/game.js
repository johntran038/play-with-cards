const SUITS = ["spade", "heart", "diamond", "club"];
const NUMBERS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

export const uid = () => Math.random().toString(36).slice(2, 10);

export const CARD_W = 100;
export const CARD_H = 140;

// Rotates a vector clockwise on screen by deg; rotVec(v, -viewRot) turns a direction on the player's screen into table space.
export function rotVec(p, deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.round(Math.cos(r) * 1e9) / 1e9;
  const s = Math.round(Math.sin(r) * 1e9) / 1e9;
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

// The last id in stack.cards is the top card.
export function initialState() {
  const cards = {};
  const ids = [];
  const deck = uid();
  for (const suit of SUITS) {
    for (const number of NUMBERS) {
      const id = uid();
      cards[id] = { id, number, suit, faceUp: false, deck, deckName: "Playing cards" };
      ids.push(id);
    }
  }
  return {
    cards,
    stacks: { [uid()]: { x: -CARD_W / 2, y: -CARD_H / 2, rot: 0, z: 1, cards: ids } },
    tokens: {},
  };
}

// Names an image by a 53-bit hash of its data URL, so the same picture always gets the same id and is sent only once.
export function imageId(url) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < url.length; i++) {
    const ch = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Image ids used by the cards, without repeats.
export const imageIds = (state) => [...new Set(Object.values(state.cards).map((c) => c.imgId).filter(Boolean))];

// Upgrades states saved before tokens, deck tracking or separate images existed. Inline images move into the images map
// and untagged cards get fixed deck ids so the host and players agree on them.
export function normalizeState(state, images = {}) {
  const cards = {};
  for (const [id, raw] of Object.entries(state.cards || {})) {
    let c = raw;
    if (c.img) {
      const { img, ...rest } = c;
      const imgId = imageId(img);
      images[imgId] = img;
      c = { ...rest, imgId };
    }
    if (!c.deck) {
      c = c.imgId
        ? { ...c, deck: "legacy-images", deckName: "Uploaded images" }
        : { ...c, deck: "legacy-playing", deckName: "Playing cards" };
    }
    cards[id] = c;
  }
  return { ...state, cards, tokens: state.tokens || {} };
}

const merge = (current, changes) => {
  const out = { ...current };
  for (const [id, v] of Object.entries(changes || {})) {
    if (v) out[id] = v;
    else delete out[id];
  }
  return out;
};

// A patch maps stack, token and card ids to new values; null deletes.
export function applyPatch(state, patch) {
  return {
    cards: merge(state.cards, patch.cards),
    stacks: merge(state.stacks, patch.stacks),
    tokens: merge(state.tokens || {}, patch.tokens),
  };
}

// Boards and hidden areas always sit beneath everything, so only stacks, counters and dice compete for z.
export const topZ = (state) =>
  Math.max(
    0,
    ...Object.values(state.stacks).map((s) => s.z),
    ...Object.values(state.tokens || {}).filter((t) => !isRect(t)).map((t) => t.z),
  ) + 1;

const live = (state, ids) => ids.filter((id) => state.stacks[id]);

export function shufflePatch(state, ids) {
  const stacks = {};
  for (const id of live(state, ids)) {
    const cards = [...state.stacks[id].cards];
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    stacks[id] = { ...state.stacks[id], cards };
  }
  return { stacks };
}

// Flipping a stack turns it over like a real deck: order reverses and every card toggles.
export function flipPatch(state, ids) {
  const stacks = {};
  const cards = {};
  for (const id of live(state, ids)) {
    const s = state.stacks[id];
    const faceUp = !state.cards[s.cards[s.cards.length - 1]]?.faceUp;
    for (const cid of s.cards) cards[cid] = { ...state.cards[cid], faceUp };
    stacks[id] = { ...s, cards: [...s.cards].reverse() };
  }
  return { stacks, cards };
}

export function rotatePatch(state, ids) {
  const stacks = {};
  for (const id of live(state, ids)) {
    const s = state.stacks[id];
    stacks[id] = { ...s, rot: (s.rot + 90) % 360 };
  }
  return { stacks };
}

// Puts the cut-off half to the right of the deck as the player sees it.
export function cutPatch(state, ids, viewRot = 0) {
  const stacks = {};
  let z = topZ(state);
  const off = rotVec({ x: CARD_W + 20, y: 0 }, -viewRot);
  for (const id of live(state, ids)) {
    const s = state.stacks[id];
    if (s.cards.length < 2) continue;
    const half = Math.floor(s.cards.length / 2);
    stacks[id] = { ...s, cards: s.cards.slice(0, half) };
    stacks[uid()] = { ...s, x: s.x + off.x, y: s.y + off.y, z: z++, cards: s.cards.slice(half) };
  }
  return { stacks };
}

// Turns every card to the majority orientation (ties go face down), returning only the cards that change.
function orient(state, ids) {
  const faceUp = ids.filter((c) => state.cards[c]?.faceUp).length * 2 > ids.length;
  const cards = {};
  for (const c of ids) if (Boolean(state.cards[c]?.faceUp) !== faceUp) cards[c] = { ...state.cards[c], faceUp };
  return cards;
}

// Returns a stack's shared orientation, or null when its cards face different ways.
function facing(state, stack) {
  const up = stack.cards.map((c) => Boolean(state.cards[c]?.faceUp));
  return up.every((u) => u === up[0]) ? up[0] : null;
}

// Stacks the selected cards onto the first selected stack, in selection order.
export function groupPatch(state, ids) {
  const [target, ...rest] = live(state, ids);
  if (!target || rest.length === 0) return null;
  const order = [...state.stacks[target].cards];
  const stacks = {};
  for (const id of rest) {
    order.push(...state.stacks[id].cards);
    stacks[id] = null;
  }
  stacks[target] = { ...state.stacks[target], cards: order, rot: averageRot(state, [target, ...rest]), z: topZ(state) };
  return { stacks, cards: orient(state, order) };
}

// Finds the stack a dragged stack covers by more than half; at least one must be a group and both must face the same way.
// The dragged stack goes on top, so a card dropped on a group tops it and a group dropped on a card buries it.
export function dropTarget(state, id) {
  const s = state.stacks[id];
  if (!s) return null;
  const face = facing(state, s);
  if (face === null) return null;
  let best = null;
  let bestArea = (CARD_W * CARD_H) / 2;
  for (const [oid, o] of Object.entries(state.stacks)) {
    if (oid === id || (s.cards.length < 2 && o.cards.length < 2)) continue;
    const area = Math.max(0, CARD_W - Math.abs(o.x - s.x)) * Math.max(0, CARD_H - Math.abs(o.y - s.y));
    if (area > bestArea && facing(state, o) === face) {
      best = oid;
      bestArea = area;
    }
  }
  return best;
}

const SPLAY_STEP = 30;
const HAND_RADIUS = 170;
const HAND_STEP_DEG = 10;
const HAND_MAX_DEG = 150;
const MIN_SPLAY_PX = 20;

const normRot = (deg) => ((deg % 360) + 360) % 360;

const snapRot = (deg) => normRot(Math.round(deg / 90) * 90);

// Averages angles on the circle so a fan of tilted cards averages to its upright center before snapping.
function averageRot(state, ids) {
  const rad = ids.map((id) => (state.stacks[id].rot * Math.PI) / 180);
  const sin = rad.reduce((t, a) => t + Math.sin(a), 0);
  const cos = rad.reduce((t, a) => t + Math.cos(a), 0);
  return snapRot((Math.atan2(sin, cos) * 180) / Math.PI);
}

// A lone dragged stack straightens to the nearest vertical or horizontal; dragging several keeps their tilts, so a fan moves as a fan.
export function straightRots(state, ids) {
  return Object.fromEntries(
    ids.map((id) => [id, ids.length === 1 ? snapRot(state.stacks[id].rot) : state.stacks[id].rot]),
  );
}

const fanSpread = (n) => (Math.min(HAND_STEP_DEG * (n - 1), HAND_MAX_DEG) * Math.PI) / 180;

// Places n card centers from a to b: a straight row when side is 0, otherwise a fan arc bulging toward side (+1 or -1) with each card tilted along it.
function layout(a, b, n, side) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const theta = fanSpread(n);
  const r = len / (2 * Math.sin(theta / 2));
  return Array.from({ length: n }, (_, k) => {
    const t = k / (n - 1);
    if (!side) return { x: a.x + dx * t, y: a.y + dy * t, rot: 0 };
    const phi = theta * (t - 0.5);
    const along = len / 2 + r * Math.sin(phi);
    const out = side * r * (Math.cos(phi) - Math.cos(theta / 2));
    return { x: a.x + ux * along - uy * out, y: a.y + uy * along + ux * out, rot: (-side * phi * 180) / Math.PI };
  });
}

// Breaks stacks into single cards laid out from a to b, upright for the player (base) and dropping any earlier tilt; makeId lets previews use stable ids.
function splayPatch(state, ids, a, b, side, makeId = uid, base = 0) {
  const src = live(state, ids);
  const order = src.flatMap((id) => state.stacks[id].cards);
  if (order.length < 2) return null;
  let z = topZ(state);
  const stacks = {};
  for (const id of src) stacks[id] = null;
  const newIds = layout(a, b, order.length, side).map((p, i) => {
    const id = makeId(order[i]);
    stacks[id] = { x: p.x - CARD_W / 2, y: p.y - CARD_H / 2, rot: normRot(base + p.rot), z: z++, cards: [order[i]] };
    return id;
  });
  return { ids: newIds, patch: { stacks, cards: orient(state, order) } };
}

// Splays a group in a straight row from its center toward the mouse, snapped to horizontal or vertical, with cards upright for the player.
export function dragSplayPatch(state, id, a, end, { viewRot = 0, makeId } = {}) {
  const b = Math.abs(end.x - a.x) >= Math.abs(end.y - a.y) ? { x: end.x, y: a.y } : { x: a.x, y: end.y };
  if (Math.hypot(b.x - a.x, b.y - a.y) < MIN_SPLAY_PX) return null;
  return splayPatch(state, [id], a, b, 0, makeId, -viewRot);
}

// Lays the cards out centered on their stacks as the player sees them: a row across their screen or a hand fanned toward them.
export function autoSplayPatch(state, ids, curved, viewRot = 0) {
  const src = live(state, ids);
  const n = src.reduce((k, id) => k + state.stacks[id].cards.length, 0);
  if (n < 2) return null;
  const cx = src.reduce((t, id) => t + state.stacks[id].x, 0) / src.length + CARD_W / 2;
  const cy = src.reduce((t, id) => t + state.stacks[id].y, 0) / src.length + CARD_H / 2;
  const theta = fanSpread(n);
  // The fan's arc rises above its chord, so the chord drops by half that height to keep the fan centered.
  const drop = curved ? (HAND_RADIUS * (1 - Math.cos(theta / 2))) / 2 : 0;
  const half = curved ? HAND_RADIUS * Math.sin(theta / 2) : ((n - 1) * SPLAY_STEP) / 2;
  const at = (p) => {
    const w = rotVec(p, -viewRot);
    return { x: cx + w.x, y: cy + w.y };
  };
  return splayPatch(state, src, at({ x: -half, y: drop }), at({ x: half, y: drop }), curved ? -1 : 0, uid, -viewRot);
}

export function dealPatch(state, id) {
  const s = state.stacks[id];
  if (!s || s.cards.length < 2) return null;
  const newId = uid();
  return {
    newId,
    patch: {
      stacks: {
        [id]: { ...s, cards: s.cards.slice(0, -1) },
        [newId]: { ...s, z: topZ(state), cards: s.cards.slice(-1) },
      },
    },
  };
}

// Draws the top card of each target stack just below it as the player sees it, keeping the way the card faces.
export function drawPatch(state, ids, viewRot = 0) {
  const stacks = {};
  let z = topZ(state);
  const off = rotVec({ x: 0, y: CARD_H + 20 }, -viewRot);
  for (const id of live(state, ids)) {
    const s = state.stacks[id];
    if (s.cards.length < 2) continue;
    const top = s.cards[s.cards.length - 1];
    stacks[id] = { ...s, cards: s.cards.slice(0, -1) };
    stacks[uid()] = { ...s, x: s.x + off.x, y: s.y + off.y, z: z++, cards: [top] };
  }
  return { stacks };
}

// Puts a saved deck face down at a point, upright for the player, with the sheet's first card on top.
export function deckPatch(state, imgIds, at, viewRot = 0, deckName = "Deck") {
  const cards = {};
  const deck = uid();
  const ids = imgIds.map((imgId) => {
    const id = uid();
    cards[id] = { id, imgId, faceUp: false, deck, deckName };
    return id;
  });
  return {
    cards,
    stacks: {
      [uid()]: { x: at.x - CARD_W / 2, y: at.y - CARD_H / 2, rot: normRot(-viewRot), z: topZ(state), cards: ids.reverse() },
    },
  };
}

export function addImagesPatch(state, imgIds) {
  const cards = {};
  const deck = uid();
  const ids = imgIds.map((imgId) => {
    const id = uid();
    cards[id] = { id, imgId, faceUp: true, deck, deckName: "Uploaded images" };
    return id;
  });
  const stackId = uid();
  return {
    cards,
    stacks: { [stackId]: { x: CARD_W, y: -CARD_H / 2, rot: 0, z: topZ(state), cards: ids } },
  };
}

// Downscales uploads so a room's state stays well under public broker payload limits.
export function resizeImage(file, maxW = 240) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.75));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

export const COUNTER_W = 160;
export const DIE_SIZE = 64;
export const DICE = [2, 4, 6, 8, 10, 12, 20, 100];

// The default fits a 13-card straight splay; resizing allows a little growth or shrink around it.
export const AREA = { w: 560, h: 200, minW: 420, minH: 170, maxW: 1125, maxH: 600 };
export const BOARD = { w: 1000, h: 700, minW: 300, minH: 200, maxW: 3000, maxH: 2000 };
const LIMITS = { area: AREA, board: BOARD };

// Hidden areas and boards are the rectangles that block each other.
export const isRect = (t) => t.kind === "area" || t.kind === "board";
const AREA_STEP = 8;
const AREA_GAP = 20;

const roll = (sides) => 1 + Math.floor(Math.random() * sides);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export const counterPatch = (state, at) => ({
  tokens: { [uid()]: { kind: "counter", x: at.x - COUNTER_W / 2, y: at.y - 32, z: topZ(state), value: 0 } },
});

export const diePatch = (state, at) => ({
  tokens: { [uid()]: { kind: "die", x: at.x - DIE_SIZE / 2, y: at.y - DIE_SIZE / 2, z: topZ(state), sides: 6, value: roll(6) } },
});

// Rolls a die, switching it to a new die type first when sides is given.
export function rollPatch(state, id, sides) {
  const t = state.tokens[id];
  if (t?.kind !== "die") return null;
  const n = sides ?? t.sides;
  return { tokens: { [id]: { ...t, sides: n, value: roll(n) } } };
}

// Anyone may change counters and dice; a hidden area belongs to its owner and the host; a board only to the host.
export const canEditToken = (t, meId, isHost) =>
  t.kind === "board" ? isHost : t.kind !== "area" || t.owner === meId || isHost;

export const areaOf = (state, owner) =>
  Object.entries(state.tokens).find(([, t]) => t.kind === "area" && t.owner === owner)?.[0] ?? null;

const areaFits = (state, id, rect) =>
  !Object.entries(state.tokens).some(([oid, t]) => oid !== id && isRect(t) && overlaps(rect, t));

// Picks the free spot nearest a point for a new w×h rectangle, trying a grid of offsets around it.
function freeSpot(state, at, w, h) {
  const base = { x: at.x - w / 2, y: at.y - h / 2, w, h };
  const offsets = [];
  for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) offsets.push([i, j]);
  offsets.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
  for (const [i, j] of offsets) {
    const rect = { ...base, x: base.x + i * (w + AREA_GAP), y: base.y + j * (h + AREA_GAP) };
    if (areaFits(state, null, rect)) return rect;
  }
  return null;
}

// A player turned to the side sees the table's x and y swapped, so their new rectangles are created tall and keep swapped limits.
const sideways = (viewRot) => viewRot % 180 !== 0;

export function boardPatch(state, at, viewRot = 0) {
  const vert = sideways(viewRot);
  const rect = freeSpot(state, at, vert ? BOARD.h : BOARD.w, vert ? BOARD.w : BOARD.h);
  return rect && { tokens: { [uid()]: { kind: "board", vert, ...rect } } };
}

// Counters and dice on a board ride along when it moves; their center decides whether they are on it.
const TOKEN_CENTER = { counter: [COUNTER_W / 2, 32], die: [DIE_SIZE / 2, DIE_SIZE / 2] };
export const tokenOnBoard = (t, board) => {
  const [ox, oy] = TOKEN_CENTER[t.kind] ?? [0, 0];
  const cx = t.x + ox;
  const cy = t.y + oy;
  return cx >= board.x && cx <= board.x + board.w && cy >= board.y && cy <= board.y + board.h;
};

// A card counts as inside an area when its center is, which rotation doesn't change.
export const inArea = (stack, area) => {
  const cx = stack.x + CARD_W / 2;
  const cy = stack.y + CARD_H / 2;
  return cx >= area.x && cx <= area.x + area.w && cy >= area.y && cy <= area.y + area.h;
};

// Returns the owner of the hidden area a stack sits in, or null.
export const stackAreaOwner = (state, stack) =>
  Object.values(state.tokens).find((t) => t.kind === "area" && inArea(stack, t))?.owner ?? null;

// Places a new area for this player at the nearest free spot around a point, or returns null if they already have one.
export function areaPatch(state, me, at, viewRot = 0) {
  if (areaOf(state, me.id)) return null;
  const vert = sideways(viewRot);
  const rect = freeSpot(state, at, vert ? AREA.h : AREA.w, vert ? AREA.w : AREA.h);
  return (
    rect && {
      tokens: { [uid()]: { kind: "area", owner: me.id, ownerName: me.name, color: me.color, vert, ...rect } },
    }
  );
}

// Walks an area or board toward a point in small steps, sliding along any rectangle it meets so it never passes over one.
export function moveArea(state, id, to) {
  const t = state.tokens[id];
  let cur = { x: t.x, y: t.y, w: t.w, h: t.h };
  for (let i = 0; i < 500; i++) {
    const dx = to.x - cur.x;
    const dy = to.y - cur.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) break;
    const k = Math.min(1, AREA_STEP / dist);
    const next = [
      { ...cur, x: cur.x + dx * k, y: cur.y + dy * k },
      { ...cur, x: cur.x + dx * k },
      { ...cur, y: cur.y + dy * k },
    ].find((r) => areaFits(state, id, r) && Math.hypot(r.x - cur.x, r.y - cur.y) > 0.01);
    if (!next) break;
    cur = next;
  }
  return { x: cur.x, y: cur.y };
}

// Picks which table corner of a rectangle sits at a screen corner (sx, sy are 0 for left/top, 1 for right/bottom).
export function worldCorner(viewRot, sx, sy) {
  const c = rotVec({ x: sx - 0.5, y: sy - 0.5 }, -viewRot);
  return { x: Math.round(c.x + 0.5), y: Math.round(c.y + 0.5) };
}

// Resizes within the limits while the corner opposite the dragged one stays put, keeping whichever of width or height still clears other rectangles.
export function resizeArea(state, id, w, h, corner = { x: 1, y: 1 }) {
  const t = state.tokens[id];
  const base = LIMITS[t.kind] ?? AREA;
  const lim = t.vert ? { minW: base.minH, maxW: base.maxH, minH: base.minW, maxH: base.maxW } : base;
  const nw = clamp(w, lim.minW, lim.maxW);
  const nh = clamp(h, lim.minH, lim.maxH);
  const sizeW = { w: nw, x: corner.x ? t.x : t.x + t.w - nw };
  const sizeH = { h: nh, y: corner.y ? t.y : t.y + t.h - nh };
  return [{ ...t, ...sizeW, ...sizeH }, { ...t, ...sizeW }, { ...t, ...sizeH }].find((r) => areaFits(state, id, r)) ?? null;
}

// Host-side check of another player's patch: areas change only by their owner, one area each; boards, counters and dice are added only by the host, and boards changed only by the host.
export function guardPatch(state, patch, from) {
  if (!patch?.tokens) return patch;
  const tokens = {};
  for (const [id, t] of Object.entries(patch.tokens)) {
    const old = state.tokens[id];
    if (old?.kind === "board") continue;
    if (old?.kind === "area" && (old.owner !== from || (t && t.owner !== from))) continue;
    if (old && t && t.kind !== old.kind) continue;
    if (!old && t && (t.kind !== "area" || t.owner !== from || areaOf(state, from))) continue;
    tokens[id] = t;
  }
  return { ...patch, tokens };
}

// Lists the table decks whose every card is in this stack; each card remembers the deck it was put on the table with.
export function wholeDecksIn(state, stackId) {
  const stack = state.stacks[stackId];
  if (!stack) return [];
  const inStack = new Set(stack.cards);
  const decks = new Map();
  for (const cid of stack.cards) {
    const c = state.cards[cid];
    if (c?.deck && !decks.has(c.deck)) decks.set(c.deck, c.deckName || "Deck");
  }
  return [...decks]
    .filter(([deck]) => Object.values(state.cards).every((c) => c.deck !== deck || inStack.has(c.id)))
    .map(([deck, name]) => ({ deck, name }));
}

// Takes every card of a table deck off the table; stacks left empty are removed.
export function removeDeckPatch(state, deck) {
  const cards = {};
  for (const c of Object.values(state.cards)) if (c.deck === deck) cards[c.id] = null;
  const stacks = {};
  for (const [id, s] of Object.entries(state.stacks)) {
    const rest = s.cards.filter((cid) => !(cid in cards));
    if (rest.length !== s.cards.length) stacks[id] = rest.length ? { ...s, cards: rest } : null;
  }
  return { cards, stacks };
}
