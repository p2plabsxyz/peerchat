// What PeerChat shows the first time it opens on this computer: the same four
// points, questions and rules as the phone app, worded for a computer. Kept in
// step with the phone's app/peerchat/intro-state.mjs and questions.mjs.

export const WELCOME_POINTS = [
  "Messages go straight from your computer to theirs, end to end encrypted. No server in the middle, no account to create, nobody else holding your chats.",
  "You both need to be online at the same time. Nothing is stored for you while you are away, so messages only arrive when both of you are connected.",
  "Keep PeerSky open so friends can reach you.",
  "Works with no internet at all. Any local network will do. When the internet is cut off, or never reached you in the first place, PeerChat keeps working.",
];

export const WELCOME_QUESTIONS = [
  {
    q: "What is PeerChat?",
    a: "A chat app that runs on your own devices instead of a company’s servers. Make a room, share its link with friends, and your messages go straight from your device to theirs, end to end encrypted. It comes built into PeerSky.",
  },
  {
    q: "Where do my chats live?",
    a: "On your devices, and nowhere else. No company computer keeps everyone’s conversations, so there is nothing to hack, leak, sell or switch off. That is what peer to peer means: your device talks to your friends’ devices directly. The one catch is that you both need to be online at the same time for a message to arrive.",
  },
  {
    q: "Who can read my messages?",
    a: "Only the people in the room. Everything you send, files too, is encrypted on your device with the room’s key, and only people who hold that key can open it. A device has to prove it has the key before yours tells it anything about the room. We collect nothing about you: no tracking, no analytics. Two things to know: people you chat with can see your network address, because your device connects to theirs, and a room key never expires, so share it like a house key.",
  },
  {
    q: "Why don’t I need an account?",
    a: "Because there is no server to sign in to. Pick a name and you’re in. Your name and your chats live on your device, not in anyone’s database, so there is no phone number or email to hand over.",
  },
  {
    q: "How do I find my friends?",
    a: "Through a room. Share its invite link, QR code or key, and anyone who has it can join and see who’s there. To talk to one person alone, open their profile in a room you share.",
  },
  {
    q: "How does it work without internet?",
    a: "Devices on the same Wi-Fi find each other and talk directly, so there is nothing out on the internet to reach. Any local network will do, even a phone’s hotspot with no data behind it: at a festival, in a power cut, or wherever the internet is down or blocked. Some public Wi-Fi keeps devices apart, and there a hotspot works instead. When you are online, the same rooms reach friends anywhere.",
  },
  {
    q: "Is it on my phone too?",
    a: "Yes. PeerChat is built into PeerSky for iPhone, iPad and Android. Use it on one phone and as many computers as you like, all at the same time: link them with Link Device in PeerSky’s settings and they share your name and your rooms. Each shows up with its own label, like ada@mobile or ada@desktop1, and messages reach all of them.",
  },
  {
    q: "How big a file can I send?",
    a: "Any size your computer has room for: photos, films, whole folders zipped up. Nothing is uploaded to a server and squeezed. Your friends download it straight from your computer, encrypted like your messages, so keep PeerSky open until they have it.",
  },
  {
    q: "Why not just use WhatsApp or Signal?",
    a: "Use whatever works for you. Those apps carry every message through servers their company runs, and they sign you up with a phone number. PeerChat has neither: messages go straight between devices, end to end encrypted, and it keeps working on a local network with no internet. If you need protection from a powerful adversary, Signal is built for that. PeerChat is for friends and teams who would rather have nobody in the middle.",
  },
  {
    q: "What’s the catch?",
    a: "There isn’t one. PeerChat is free, with no ads, no subscriptions and nothing to upgrade to. With no servers there is no bill to pass on and no data to sell. It is made by P2P Labs, the team behind PeerSky, and it is open source, so anyone can check that it does what this page says.",
  },
];

export const WELCOME_RULES = [
  "No sexual content or nudity, ever.",
  "No threats, harassment, bullying or hate.",
  "No spam, scams, or other people’s private details.",
  "Block anyone who bothers you and report them. We read every report within 24 hours.",
  "You start in P2P Republic, a public room anyone can join. You can leave it from the chat list.",
];

export const PEERCHAT_WELCOME = {
  id: "peerchat",
  icon: "./assets/app-icon.png",
  title: "Chat directly with your peers",
  points: WELCOME_POINTS.map((body) => ({ body })),
  questions: WELCOME_QUESTIONS,
  rules: {
    items: WELCOME_RULES,
    note: "There is no tolerance for objectionable content or abusive users. Clicking I understand means you agree to these rules.",
  },
  action: "I understand",
};
