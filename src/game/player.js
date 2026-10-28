import { uid } from "./game";

// One id per page load, so two tabs in the same browser count as two players.
const tabId = uid();

export const getMe = () => ({ id: tabId, name: localStorage.getItem("pwc_name") || "Player" });

export const setName = (name) => localStorage.setItem("pwc_name", name);
