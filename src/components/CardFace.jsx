import { useEffect, useRef } from "react";
import { PlayingCard, PlayingCardElement } from "card-factory";

// Renders a card-factory front or back; image cards use card-factory's back when face down and a placeholder while their image loads.
export default function CardFace({ card, size = 40 }) {
  const ref = useRef(null);
  const isImageCard = Boolean(card.img || card.imgId);
  const showImage = isImageCard && card.faceUp;

  useEffect(() => {
    const host = ref.current;
    if (!host || showImage) return;
    const el = PlayingCardElement(new PlayingCard(card.number || "A", card.suit || "spade"));
    const node = card.faceUp ? el.front : el.back;
    if (card.faceUp) node.classList.remove("flipped");
    host.replaceChildren(node);
    return () => host.replaceChildren();
  }, [card.number, card.suit, card.faceUp, showImage]);

  return (
    <div
      className="card-parent relative"
      style={{ "--card-size": `${size}px` }}
    >
      {showImage && card.img && (
        <img
          src={card.img}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full rounded-[10%] object-cover"
        />
      )}
      {showImage && !card.img && (
        <div className="absolute inset-0 flex items-center justify-center rounded-[10%] bg-neutral-300 text-xs text-neutral-600">
          Loading…
        </div>
      )}
      {!showImage && <div ref={ref} className="absolute inset-0" />}
    </div>
  );
}
