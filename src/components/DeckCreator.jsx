import { useEffect, useRef, useState } from "react";
import { FiMinus, FiPlus, FiTrash2, FiX } from "react-icons/fi";
import { CARD_H, CARD_W, uid } from "../game/game";
import { cropCard, saveDeck } from "../game/decks";

const FRAME_W = 200;
const FRAME_H = FRAME_W * (CARD_H / CARD_W);
const THUMB = 0.25;
const MAX_COPIES = 99;
const MAX_CARDS = 300;

const readImage = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

// Fills the card frame with the image, centered; contain fits the whole image inside it instead.
const fitCrop = (img, contain = false) => {
  const s = (contain ? Math.min : Math.max)(FRAME_W / img.width, FRAME_H / img.height);
  return { s, ox: (FRAME_W - img.width * s) / 2, oy: (FRAME_H - img.height * s) / 2 };
};

// Shows an image through a card-shaped frame at k times the frame size.
function CropView({ img, crop, k = 1 }) {
  return (
    <div className="relative overflow-hidden rounded bg-white" style={{ width: FRAME_W * k, height: FRAME_H * k }}>
      <img
        src={img.src}
        alt=""
        draggable={false}
        className="pointer-events-none absolute left-0 top-0 max-w-none origin-top-left"
        style={{
          width: img.width,
          height: img.height,
          transform: `translate(${crop.ox * k}px, ${crop.oy * k}px) scale(${crop.s * k})`,
        }}
      />
    </div>
  );
}

// Builds a deck from individual card images, each with a copy count and its own crop.
export default function DeckCreator({ onClose }) {
  const [name, setName] = useState("");
  const [entries, setEntries] = useState([]);
  const [activeKey, setActiveKey] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);
  const frameRef = useRef(null);
  const dragRef = useRef(null);

  const active = entries.find((e) => e.key === activeKey);
  const total = entries.reduce((n, e) => n + e.count, 0);

  const update = (key, change) => setEntries((all) => all.map((e) => (e.key === key ? { ...e, ...change(e) } : e)));
  const setCrop = (fn) => activeKey && update(activeKey, (e) => ({ crop: fn(e.crop, e.img) }));

  const addFiles = async (files) => {
    setError("");
    try {
      const imgs = await Promise.all([...files].map(readImage));
      const added = imgs.map((img) => ({ key: uid(), img, crop: fitCrop(img), count: 1 }));
      setEntries((all) => [...all, ...added]);
      if (added.length) setActiveKey(added[added.length - 1].key);
    } catch {
      setError("One of those files could not be read as an image.");
    }
  };

  // Zooms around the frame's center so the part being lined up stays in view.
  const zoom = (k) =>
    setCrop((c) => {
      const cx = FRAME_W / 2;
      const cy = FRAME_H / 2;
      return { s: c.s * k, ox: cx - (cx - c.ox) * k, oy: cy - (cy - c.oy) * k };
    });

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const crop = { ...d.crop, ox: d.crop.ox + e.clientX - d.x, oy: d.crop.oy + e.clientY - d.y };
      setEntries((all) => all.map((x) => (x.key === d.key ? { ...x, crop } : x)));
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // React's wheel listener is passive, so a native one stops the dialog from scrolling while zooming.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      zoomRef.current(Math.exp(-e.deltaY * 0.001));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [activeKey]);

  const setCount = (key, n) => update(key, () => ({ count: Math.min(MAX_COPIES, Math.max(1, Math.floor(n) || 1)) }));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const out = entries.map((e) => ({ img: cropCard(e.img, e.crop, FRAME_W), count: e.count }));
      await saveDeck(name.trim() || "Untitled deck", out);
      onClose();
    } catch {
      setError("Saving failed. The browser may be out of storage space.");
      setSaving(false);
    }
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60" data-ui onMouseDown={(e) => e.stopPropagation()}>
      <div className="flex max-h-[90vh] w-[720px] flex-col gap-3 rounded-xl bg-neutral-900 p-5 text-white shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Create a deck</h2>
          <button className="rounded p-1 hover:bg-white/10" title="Close" onClick={onClose}>
            <FiX size={20} />
          </button>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          Deck name
          <input className="rounded bg-white/10 px-2 py-1" value={name} placeholder="Untitled deck" onChange={(e) => setName(e.target.value)} />
        </label>

        <div className="flex min-h-0 flex-1 gap-4">
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex items-center justify-between text-sm">
              <span>
                {entries.length} {entries.length === 1 ? "card" : "cards"} · {total} in the deck
              </span>
              <button className="flex items-center gap-1 rounded bg-white/10 px-3 py-1 hover:bg-white/20" onClick={() => fileRef.current.click()}>
                <FiPlus /> Add a card
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
            {!entries.length && (
              <p className="rounded bg-white/5 p-4 text-sm text-white/60">
                Add a card to upload its image, then set how many copies of it the deck has. You can pick several images at once.
              </p>
            )}
            <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto pr-1">
              {entries.map((e, i) => (
                <li
                  key={e.key}
                  className={`flex cursor-pointer items-center gap-3 rounded p-2 ${e.key === activeKey ? "bg-emerald-800/60" : "bg-white/5 hover:bg-white/10"}`}
                  onClick={() => setActiveKey(e.key)}
                >
                  <CropView img={e.img} crop={e.crop} k={THUMB} />
                  <span className="flex-1 text-sm">Card {i + 1}</span>
                  <div className="flex items-center gap-1" onClick={(ev) => ev.stopPropagation()}>
                    <button className="rounded bg-white/10 p-1.5 hover:bg-white/20" title="One fewer" onClick={() => setCount(e.key, e.count - 1)}>
                      <FiMinus size={14} />
                    </button>
                    <input
                      className="w-12 rounded bg-white/10 py-1 text-center font-mono text-sm"
                      inputMode="numeric"
                      value={e.count}
                      onChange={(ev) => setCount(e.key, Number(ev.target.value))}
                    />
                    <button className="rounded bg-white/10 p-1.5 hover:bg-white/20" title="One more" onClick={() => setCount(e.key, e.count + 1)}>
                      <FiPlus size={14} />
                    </button>
                    <button
                      className="ml-1 rounded p-1.5 text-white/60 hover:bg-white/10 hover:text-red-300"
                      title="Remove card"
                      onClick={() => {
                        setEntries((all) => all.filter((x) => x.key !== e.key));
                        if (activeKey === e.key) setActiveKey(null);
                      }}
                    >
                      <FiTrash2 size={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex w-[220px] shrink-0 flex-col items-center gap-2">
            {active ? (
              <>
                <p className="text-xs text-white/60">Drag to move the image. Scroll or use the buttons to zoom.</p>
                <div
                  ref={frameRef}
                  className="cursor-move outline-2 outline-yellow-300"
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    dragRef.current = { key: active.key, x: ev.clientX, y: ev.clientY, crop: active.crop };
                  }}
                >
                  <CropView img={active.img} crop={active.crop} />
                </div>
                <div className="grid w-full grid-cols-2 gap-2 text-sm">
                  <button className="rounded bg-white/10 py-1 hover:bg-white/20" onClick={() => zoom(1.05)}>
                    Zoom in
                  </button>
                  <button className="rounded bg-white/10 py-1 hover:bg-white/20" onClick={() => zoom(1 / 1.05)}>
                    Zoom out
                  </button>
                  <button className="rounded bg-white/10 py-1 hover:bg-white/20" onClick={() => setCrop((c, img) => fitCrop(img))}>
                    Fill card
                  </button>
                  <button className="rounded bg-white/10 py-1 hover:bg-white/20" onClick={() => setCrop((c, img) => fitCrop(img, true))}>
                    Whole image
                  </button>
                </div>
              </>
            ) : (
              <p className="pt-8 text-center text-sm text-white/50">Select a card to adjust its crop.</p>
            )}
          </div>
        </div>

        {total > MAX_CARDS && <p className="text-sm text-amber-300">Decks are limited to {MAX_CARDS} cards.</p>}
        {error && <p className="text-sm text-red-300">{error}</p>}

        <div className="flex justify-end gap-2">
          <button className="rounded bg-white/10 px-4 py-2 hover:bg-white/20" onClick={onClose}>
            Cancel
          </button>
          <button
            className="rounded bg-emerald-600 px-4 py-2 enabled:hover:bg-emerald-500 disabled:opacity-40"
            disabled={!entries.length || total > MAX_CARDS || saving}
            onClick={save}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
