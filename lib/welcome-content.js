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
    a: "Group chats and one to one chats that run on your own devices, not on a company’s servers. Make a room, share its link with friends, and your devices talk to each other directly, end to end encrypted. It comes built into PeerSky, on computers and phones.",
  },
  {
    q: "How does it compare with WhatsApp, Telegram or Signal?",
    a: "Those apps carry every message through servers their company runs, and they sign you up with a phone number. PeerChat has neither. Messages go straight from your device to your friends’, end to end encrypted, and it keeps working on a local network with no internet. If you need protection from a powerful adversary, Signal is built for that. PeerChat is for friends and teams who would rather have nobody in the middle.",
  },
  {
    q: "Do I have to give a phone number or email?",
    a: "No. Pick a name and you’re in. There is no account on a server, so your name lives on your device, not in anyone’s database.",
  },
  {
    q: "Then how do my friends find me?",
    a: "Through a room. Share its invite link, QR code or key, and anyone who has it can join and see who’s there. To talk to one person alone, open their profile in a room you share.",
  },
  {
    q: "What does peer to peer mean for my chats?",
    a: "Your device talks to your friends’ devices directly instead of going through a company’s computers. With no server keeping everyone’s chats, there is nothing to hack, leak, sell or switch off. The one catch: both of you need to be online at the same time for a message to arrive.",
  },
  {
    q: "How does it work without internet?",
    a: "Devices on the same Wi-Fi find each other and talk directly, so there is nothing out on the internet to reach. Any local network will do, even a phone’s hotspot with no data behind it: at a festival, in a power cut, or wherever the internet is down or blocked. Some public Wi-Fi keeps devices apart, and there a hotspot works instead. When you are online, the same rooms reach friends anywhere.",
  },
  {
    q: "How private is it?",
    a: "Everything you send, files included, is encrypted on your device with the room’s key before it leaves, and only the people in the room hold that key. A device has to prove it has the key before yours tells it anything about the room. We collect nothing about you: no tracking, no analytics. Two things to know: people in a chat with you can see your network address, because your device talks to theirs, and a room key never expires, so share it like a house key.",
  },
  {
    q: "What does it cost?",
    a: "Nothing. There are no ads, no subscriptions and no premium tier. With no servers there is no bill to pass on to you and no data to sell. PeerChat is open source, so anyone can read exactly what it does.",
  },
  {
    q: "Can I send big files?",
    a: "Yes, any size your computer has room for: photos, films, whole folders zipped up. Nothing is uploaded to a server and squeezed. Your friends download it straight from your computer, encrypted like your messages, so keep PeerSky open until they have it.",
  },
  {
    q: "Is it on my phone too?",
    a: "Yes. PeerChat is built into PeerSky for iPhone, iPad and Android, with the same rooms as on your computer, so friends on phones and computers chat together.",
  },
  {
    q: "Can I use it on my phone and my computer?",
    a: "Yes, on one phone and as many computers as you like, all at the same time. Link them with Link Device in PeerSky’s settings. Each one shows your name with a fixed label, like ada@mobile or ada@desktop1, and messages reach all of them. Rename yourself on one and the others follow, and a room you join on one shows up on the rest.",
  },
  {
    q: "Who makes PeerChat?",
    a: "P2P Labs, the team behind PeerSky. Nobody owns your chats, us included: they live on your devices. The code is open source on GitHub for anyone to check.",
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
