import { useEffect, useState } from "react";
import { FiTrash2, FiX } from "react-icons/fi";
import { deckCover, deckImages, deckSize, deleteDeck, listDecks } from "../game/decks";

// Lists the decks saved in this browser; picking one hands one image per card to the table.
export default function DeckPicker({ onClose, onPick }) {
  const [decks, setDecks] = useState(null);
  const [error, setError] = useState("");

  const load = () =>
    listDecks()
      .then(setDecks)
      .catch(() => setError("Saved decks could not be loaded."));

  useEffect(() => {
    load();
  }, []);

  const remove = async (deck) => {
    if (!window.confirm(`Delete "${deck.name}" from this browser?`)) return;
    await deleteDeck(deck.id);
    load();
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60" data-ui onMouseDown={(e) => e.stopPropagation()}>
      <div className="flex max-h-[80vh] w-[480px] flex-col gap-3 rounded-xl bg-neutral-900 p-5 text-white shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Add a deck</h2>
          <button className="rounded p-1 hover:bg-white/10" title="Close" onClick={onClose}>
            <FiX size={20} />
          </button>
        </div>
        {error && <p className="text-sm text-red-300">{error}</p>}
        {decks && !decks.length && (
          <p className="text-sm text-white/60">No saved decks yet. Use Create a deck to make one.</p>
        )}
        <ul className="flex flex-col gap-2 overflow-y-auto">
          {decks?.map((deck) => (
            <li key={deck.id} className="flex items-center gap-3 rounded bg-white/5 p-2">
              <button
                className="flex flex-1 items-center gap-3 rounded text-left hover:bg-white/10"
                onClick={() => {
                  onPick(deckImages(deck), deck.name);
                  onClose();
                }}
              >
                <img src={deckCover(deck)} alt="" className="h-14 w-10 rounded object-cover" />
                <span className="flex flex-col">
                  <span className="font-medium">{deck.name}</span>
                  <span className="text-xs text-white/60">
                    {deckSize(deck)} cards
                    {deck.entries && ` · ${deck.entries.length} different`}
                  </span>
                </span>
              </button>
              <button className="rounded p-2 text-white/60 hover:bg-white/10 hover:text-red-300" title="Delete deck" onClick={() => remove(deck)}>
                <FiTrash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
