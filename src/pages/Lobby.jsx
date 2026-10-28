import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getMe, setName } from "../game/player";

const newCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

export default function Lobby() {
  const navigate = useNavigate();
  const [name, setNameInput] = useState(getMe().name);
  const [code, setCode] = useState("");

  const enter = (roomCode, host) => {
    setName(name.trim() || "Player");
    if (host) sessionStorage.setItem(`pwc_host_${roomCode}`, "1");
    navigate(`/room/${roomCode}`);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-emerald-950 text-white">
      <div className="w-80 space-y-4 rounded-xl bg-black/40 p-6">
        <h1 className="text-2xl font-bold">Play With Cards</h1>
        <label className="block text-sm">
          Your name
          <input
            className="mt-1 w-full rounded bg-white/10 px-3 py-2"
            value={name}
            onChange={(e) => setNameInput(e.target.value)}
          />
        </label>
        <button className="w-full rounded bg-emerald-600 py-2" onClick={() => enter(newCode(), true)}>
          Host a room
        </button>
        <div className="flex gap-2">
          <input
            className="w-full rounded bg-white/10 px-3 py-2 uppercase"
            placeholder="Invite code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button
            className="rounded bg-sky-600 px-4"
            disabled={!code.trim()}
            onClick={() => enter(code.trim(), false)}
          >
            Join
          </button>
        </div>
      </div>
    </div>
  );
}
