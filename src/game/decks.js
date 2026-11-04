import { uid } from "./game";

const DB = "pwc_decks";
const STORE = "decks";

// Saved card images are output at this size, matching the uploaded-image cards.
export const CARD_OUT_W = 240;
export const CARD_OUT_H = 336;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => {
      db.close();
      resolve(req?.result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export const listDecks = async () =>
  ((await run("readonly", (s) => s.getAll())) || []).sort((a, b) => b.createdAt - a.createdAt);

// Each entry is one card image and how many copies of it the deck has, so repeated cards are stored once.
export const saveDeck = (name, entries) =>
  run("readwrite", (s) => s.put({ id: uid(), name, entries, createdAt: Date.now() }));

export const deleteDeck = (id) => run("readwrite", (s) => s.delete(id));

// Expands a saved deck into one image per card; decks saved from the old sprite-sheet tool store a flat list.
export const deckImages = (deck) => deck.entries?.flatMap((e) => Array(e.count).fill(e.img)) ?? deck.cards ?? [];

export const deckSize = (deck) => deck.entries?.reduce((n, e) => n + e.count, 0) ?? deck.cards?.length ?? 0;

export const deckCover = (deck) => deck.entries?.[0]?.img ?? deck.cards?.[0];

// Renders the part of img shown in a card-shaped crop frame frameW wide, where the image sits at (ox, oy) scaled by s.
export function cropCard(img, { ox, oy, s }, frameW) {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_OUT_W;
  canvas.height = CARD_OUT_H;
  const ctx = canvas.getContext("2d");
  const k = CARD_OUT_W / frameW;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, CARD_OUT_W, CARD_OUT_H);
  ctx.drawImage(img, ox * k, oy * k, img.width * s * k, img.height * s * k);
  return canvas.toDataURL("image/jpeg", 0.8);
}
