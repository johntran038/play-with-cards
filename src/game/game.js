const SUITS = ["spade", "heart", "diamond", "club"];
const NUMBERS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

export const uid = () => Math.random().toString(36).slice(2, 10);

export const CARD_W = 100;
export const CARD_H = 140;

// The last id in stack.cards is the top card.
export function initialState() {
  const cards = {};
  const ids = [];
  for (const suit of SUITS) {
    for (const number of NUMBERS) {
      const id = uid();
      cards[id] = { id, number, suit, faceUp: false };
      ids.push(id);
    }
  }
  return {
    cards,
    stacks: { [uid()]: { x: -CARD_W / 2, y: -CARD_H / 2, rot: 0, z: 1, cards: ids } },
  };
}

// A patch maps stack ids to new stacks (null deletes) and card ids to new cards.
export function applyPatch(state, patch) {
  const stacks = { ...state.stacks };
  for (const [id, s] of Object.entries(patch.stacks || {})) {
    if (s) stacks[id] = s;
    else delete stacks[id];
  }
  return { cards: { ...state.cards, ...(patch.cards || {}) }, stacks };
}

export const topZ = (state) =>
  Math.max(0, ...Object.values(state.stacks).map((s) => s.z)) + 1;

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

export function cutPatch(state, ids) {
  const stacks = {};
  let z = topZ(state);
  for (const id of live(state, ids)) {
    const s = state.stacks[id];
    if (s.cards.length < 2) continue;
    const half = Math.floor(s.cards.length / 2);
    stacks[id] = { ...s, cards: s.cards.slice(0, half) };
    stacks[uid()] = { ...s, x: s.x + CARD_W + 20, z: z++, cards: s.cards.slice(half) };
  }
  return { stacks };
}

// Stacks the selected cards onto the first selected stack, in selection order.
export function groupPatch(state, ids) {
  const [target, ...rest] = live(state, ids);
  if (!target || rest.length === 0) return null;
  const cards = [...state.stacks[target].cards];
  const stacks = {};
  for (const id of rest) {
    cards.push(...state.stacks[id].cards);
    stacks[id] = null;
  }
  stacks[target] = { ...state.stacks[target], cards, z: topZ(state) };
  return { stacks };
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

// Draws the top card of each target stack and lays it face up just below the stack.
export function drawPatch(state, ids) {
  const stacks = {};
  const cards = {};
  let z = topZ(state);
  for (const id of live(state, ids)) {
    const s = state.stacks[id];
    if (s.cards.length < 2) continue;
    const top = s.cards[s.cards.length - 1];
    cards[top] = { ...state.cards[top], faceUp: true };
    stacks[id] = { ...s, cards: s.cards.slice(0, -1) };
    stacks[uid()] = { ...s, y: s.y + CARD_H + 20, z: z++, cards: [top] };
  }
  return { stacks, cards };
}

export function addImagesPatch(state, urls) {
  const cards = {};
  const ids = urls.map((img) => {
    const id = uid();
    cards[id] = { id, img, faceUp: true };
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
