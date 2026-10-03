// The first time PeerChat opens on this computer: what it is and the rules,
// before anything else. lib/welcome.js draws it.
import { showWelcome } from "./lib/welcome.js";
import { PEERCHAT_WELCOME } from "./lib/welcome-content.js";

showWelcome(PEERCHAT_WELCOME);
