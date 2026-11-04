import { uid } from "./game";

// One id per tab that survives a refresh, so a player keeps their hidden area; two tabs still count as two players.
const tabId = sessionStorage.getItem("pwc_player_id") || uid();
sessionStorage.setItem("pwc_player_id", tabId);

// Picked fresh on each join; other players see this player's cursor and selections in it.
const color = `hsl(${Math.floor(Math.random() * 360)} 85% 62%)`;

export const getMe = () => ({ id: tabId, name: localStorage.getItem("pwc_name") || "Player", color });

export const setName = (name) => localStorage.setItem("pwc_name", name);
