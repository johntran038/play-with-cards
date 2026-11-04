const DB = "pwc_images";
const STORE = "images";

// Card images are cached in this browser by content id, so a host who reloads can resend them and players don't refetch them.
function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putImages(map) {
  const entries = Object.entries(map);
  if (!entries.length) return;
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    for (const [id, url] of entries) tx.objectStore(STORE).put(url, id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// Returns the cached images among ids; missing ones are left out.
export async function getImages(ids) {
  if (!ids.length) return {};
  const db = await open();
  const out = {};
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    for (const id of ids) {
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => {
        if (req.result) out[id] = req.result;
      };
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return out;
}
