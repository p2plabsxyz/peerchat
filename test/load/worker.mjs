// Many PeerChat devices in one process, all phones or all desktops, running
// the apps' own PeerChat code. Each device has its own key pair, Hyperswarm and
// DHT node on the loopback testnet. run.mjs drives it over IPC.
//
// A room's log is kept in memory: both apps only append to it, read it by
// index and ask its length and size, and PeerChat never replicates it (it syncs
// over its own frames), so nothing about the network is left out.
import { createRequire, register } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { monitorEventLoopDelay } from 'node:perf_hooks'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const loop = monitorEventLoopDelay({ resolution: 10 })
loop.enable()
let cpuMark = process.cpuUsage()
let cpuAt = Date.now()

let kind = ''
let lib = null
let bootstrap = []
let runDir = ''
let desktopDir = ''
let roomKey = ''
let republicKey = ''
let republicHex = ''
let republicHits = 0
let PeerChatService = null
let poller = null
const devices = new Map()

class Feed extends EventEmitter {
  constructor (device) {
    super()
    this.device = device
    this.entries = []
    this.bytes = 0
  }

  get length () { return this.entries.length }
  get byteLength () { return this.bytes }
  async ready () {}

  async append (entry) {
    const copy = structuredClone(entry)
    this.entries.push(copy)
    this.bytes += Buffer.byteLength(JSON.stringify(copy))
    noteEntry(this.device, copy)
    this.emit('append')
  }

  async get (index) { return structuredClone(this.entries[index]) }
  async close () {}
}

// What each device stored and when: chat messages by id (they carry no type in
// either app), and the lines saying somebody was removed or the room moved.
function noteEntry (d, entry) {
  if (!entry || typeof entry !== 'object') return
  const now = Date.now()
  if (entry.type === 'system') {
    const text = String(entry.text || entry.message || '')
    if (text.includes('was removed from the room') && !d.removalSeenAt) d.removalSeenAt = now
    if (text.includes('has a new key') && !d.moveSeenAt) d.moveSeenAt = now
    return
  }
  if (entry.type !== undefined && entry.type !== 'message') return
  if (typeof entry.id === 'string' && !d.arrivals.has(entry.id)) d.arrivals.set(entry.id, now)
}

const hex = (buf) => lib.b4a.toString(buf, 'hex')

function guardTopic (topic) {
  if (hex(topic) === republicHex) {
    republicHits++
    throw new Error('P2P Republic is off limits in the load test')
  }
}

// Plaintext bytes each way on every connection, after Noise.
function tap (d, conn) {
  conn.on('error', () => {})
  conn.on('data', (b) => { d.stats.rx += b.byteLength })
  const write = conn.write
  conn.write = function (b, ...rest) {
    if (b?.byteLength) d.stats.tx += b.byteLength
    return write.call(this, b, ...rest)
  }
}

async function startNetwork (d) {
  const dht = new lib.HyperDHT({ bootstrap, host: '127.0.0.1', ephemeral: true })
  if (!dht.bootstrapNodes.length) throw new Error('no bootstrap nodes')
  for (const node of dht.bootstrapNodes) {
    if (node.host !== '127.0.0.1') throw new Error(`refusing a bootstrap node off this machine: ${node.host}`)
  }
  const swarm = new lib.Hyperswarm({ keyPair: d.keyPair, dht })
  swarm.on('connection', (conn) => tap(d, conn))
  d.dht = dht
  d.swarm = swarm
  d.sdk = {
    publicKey: d.keyPair.publicKey,
    swarm,
    localSwarm: new EventEmitter(),
    corestore: {
      get: ({ name }) => {
        if (!d.feeds.has(name)) d.feeds.set(name, new Feed(d))
        return d.feeds.get(name)
      },
      createKeyPair: async (name) => (name === 'noise' ? d.keyPair : lib.crypto.keyPair())
    },
    join: (topic, opts) => {
      guardTopic(topic)
      return swarm.join(topic, opts)
    },
    leave: async (topic) => { await swarm.leave(topic) }
  }
  d.online = true
}

async function stopNetwork (d) {
  d.online = false
  try { await d.swarm.destroy() } catch {}
  try { await d.dht.destroy() } catch {}
}

async function loadLibs (phoneDir) {
  const anchor = kind === 'phone' ? path.join(phoneDir, 'package.json') : path.join(desktopDir, 'p2p.js')
  const req = createRequire(anchor)
  lib = { Hyperswarm: req('hyperswarm'), HyperDHT: req('hyperdht'), crypto: req('hypercore-crypto'), b4a: req('b4a') }
  if (kind === 'phone') {
    const peerchat = path.join(phoneDir, 'backend/peerchat')
    PeerChatService = (await import(pathToFileURL(path.join(peerchat, 'service.mjs')).href)).PeerChatService
    const { derivePeerChatTopic } = await import(pathToFileURL(path.join(peerchat, 'protocol.mjs')).href)
    republicKey = (await import(pathToFileURL(path.join(peerchat, 'rooms.mjs')).href)).PRE_JOINED_PEERCHAT_ROOM_KEY
    republicHex = hex(derivePeerChatTopic(republicKey))
  } else {
    register(pathToFileURL(path.join(HERE, 'desktop-loader.mjs')).href, import.meta.url, {
      data: { dir: pathToFileURL(desktopDir + path.sep).href }
    })
    const probe = await import(pathToFileURL(path.join(desktopDir, 'p2p.js')).href + '?dev=probe')
    republicKey = (await import(pathToFileURL(path.join(desktopDir, 'rooms.js')).href + '?dev=probe')).PRE_JOINED_ROOM_KEY
    republicHex = hex(probe.deriveTopic(republicKey))
  }
}

async function makeDevice (idx) {
  const keyPair = lib.crypto.keyPair()
  const d = {
    idx,
    kind,
    name: (kind === 'phone' ? 'Phone ' : 'Desk ') + String(idx).padStart(4, '0'),
    keyPair,
    key: hex(keyPair.publicKey),
    dir: path.join(runDir, `${kind}-${idx}`),
    feeds: new Map(),
    arrivals: new Map(),
    stats: { rx: 0, tx: 0 },
    joinAt: 0,
    joinedAt: 0,
    firstRoomPeerAt: 0,
    removalSeenAt: 0,
    moveSeenAt: 0,
    roomPeers: 0,
    online: false,
    joinError: ''
  }
  mkdirSync(d.dir, { recursive: true })
  await startNetwork(d)
  if (kind === 'phone') {
    d.service = await new PeerChatService({ sdk: d.sdk, storagePath: d.dir }).start()
    // A name and no onboarding, which is what joins P2P Republic.
    d.service.setProfile({ username: d.name })
  } else {
    // A profile and no rooms: P2P Republic is joined by the page's onboarding,
    // never here.
    d.storagePath = path.join(d.dir, 'peersky-chat-rooms.json')
    writeFileSync(d.storagePath, JSON.stringify({ v: 1, profile: { username: d.name }, peerProfiles: {}, pendingDMs: {}, rooms: {} }))
    d.mod = await import(pathToFileURL(path.join(desktopDir, 'p2p.js')).href + '?dev=' + idx)
    d.mod.initChat(d.sdk, { storagePath: d.storagePath, keyPair })
    d.call = async (action, method, body, rk) => {
      const url = `hyper://chat?action=${action}${rk ? `&roomKey=${rk}` : ''}`
      const res = await d.mod.handleChatRequest({ url, method, json: async () => body ?? {} }, d.sdk)
      return JSON.parse(await res.text())
    }
  }
  devices.set(idx, d)
}

async function movedRoomsOf (d) {
  if (d.kind === 'phone') return d.service.movedRoomsMap()
  return (await d.call('get-rooms', 'GET')).movedRooms || {}
}

async function roomPeersOf (d) {
  if (!roomKey || !d.online) return 0
  if (d.kind === 'phone') {
    const shown = d.service.roomKeyFor(roomKey)
    let n = 0
    for (const peer of d.service.peers.values()) if (peer.rooms?.includes(shown)) n++
    return n
  }
  const shown = (await movedRoomsOf(d))[roomKey] || roomKey
  const status = await d.call('net-status', 'GET')
  return (status.peers || []).filter((p) => (p.rooms || []).includes(shown)).length
}

function startPoller () {
  if (poller) return
  let busy = false
  poller = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      for (const d of devices.values()) {
        try {
          d.roomPeers = await roomPeersOf(d)
          if (d.roomPeers > 0 && d.joinAt && !d.firstRoomPeerAt) d.firstRoomPeerAt = Date.now()
        } catch {}
      }
    } finally {
      busy = false
    }
  }, 1000)
  poller.unref?.()
}

const later = (at, fn) => new Promise((resolve) => setTimeout(() => fn().then(resolve, resolve), Math.max(0, at - Date.now())))

async function send (d, text, rk = roomKey) {
  if (d.kind === 'phone') return (await d.service.sendMessage({ roomKey: rk, message: text }))?.id
  const sent = await d.call('send', 'POST', { message: text }, rk)
  if (!sent.sent) throw new Error(sent.error || sent.message || 'not sent')
  return sent.sent.id
}

const handlers = {
  async init (a) {
    kind = a.kind
    bootstrap = a.bootstrap
    runDir = a.runDir
    desktopDir = a.desktopDir
    await loadLibs(a.phoneDir)
    const ids = a.devs.slice()
    while (ids.length) await Promise.all(ids.splice(0, 8).map(makeDevice))
    return { republicHex, devices: [...devices.values()].map((d) => ({ idx: d.idx, id: d.key.slice(0, 8), kind: d.kind })) }
  },

  async create (a) {
    const d = devices.get(a.dev)
    d.joinAt = Date.now()
    if (d.kind === 'desktop') {
      roomKey = (await d.call('create-key', 'POST', { name: a.name })).roomKey
      await d.call('join', 'POST', {}, roomKey)
    } else {
      roomKey = (await d.service.createRoom({ name: a.name, username: d.name })).roomKey
    }
    d.joinedAt = Date.now()
    startPoller()
    return { roomKey }
  },

  // Joins run on their own; status reports how each went.
  async join (a) {
    roomKey = a.roomKey
    startPoller()
    for (const { dev, at } of a.plan) {
      later(at, async () => {
        const d = devices.get(dev)
        d.joinAt = Date.now()
        try {
          if (d.kind === 'phone') await d.service.joinRoom({ roomKey: a.roomKey, username: d.name })
          else {
            const joined = await d.call('join', 'POST', {}, a.roomKey)
            if (joined.error) throw new Error(joined.error)
          }
          d.joinedAt = Date.now()
        } catch (error) {
          d.joinError = error.message
        }
      })
    }
    return true
  },

  async status () {
    return [...devices.values()].map((d) => [
      d.idx, d.online ? d.swarm.connections.size : 0, d.roomPeers, d.stats.rx, d.stats.tx,
      d.joinAt, d.joinedAt, d.firstRoomPeerAt, d.online ? 1 : 0, d.arrivals.size, d.joinError,
      d.removalSeenAt, d.moveSeenAt
    ])
  },

  async send (a) {
    const results = []
    await Promise.all(a.plan.map(({ dev, at, text }) => later(at, async () => {
      const d = devices.get(dev)
      const t = Date.now()
      try {
        const id = await send(d, text)
        if (!id) throw new Error('no id')
        results.push([dev, id, t, ''])
      } catch (error) {
        results.push([dev, null, t, error.message])
      }
    })))
    return results
  },

  // For each eligible device here: which of these messages it stored, and when.
  async collect (a) {
    const perId = {}
    const lat = []
    const perDev = {}
    const last = {}
    for (const dev of a.eligible) {
      const d = devices.get(dev)
      if (!d) continue
      let got = 0
      for (const [id, t0, sender] of a.origins) {
        if (sender === dev) continue
        const t = d.arrivals.get(id)
        if (t === undefined) continue
        got++
        perId[id] = (perId[id] || 0) + 1
        const ms = t - t0
        lat.push(ms)
        if (!(id in last) || ms > last[id]) last[id] = ms
      }
      perDev[dev] = got
    }
    return { perId, lat, perDev, last }
  },

  async stop (a) {
    for (const dev of a.devs) {
      const d = devices.get(dev)
      if (d.kind === 'phone') { try { await d.service.close() } catch {} }
      await stopNetwork(d)
      d.roomPeers = 0
    }
    return true
  },

  // Back as after a restart: same key, same stored rooms and messages.
  async restart (a) {
    for (const dev of a.devs) {
      const d = devices.get(dev)
      await startNetwork(d)
      if (d.kind === 'phone') d.service = await new PeerChatService({ sdk: d.sdk, storagePath: d.dir }).start()
      else d.mod.initChat(d.sdk, { storagePath: d.storagePath, keyPair: d.keyPair })
    }
    return true
  },

  async remove (a) {
    const d = devices.get(a.dev)
    if (d.kind === 'desktop') {
      const removed = await d.call('remove-room-member', 'POST', { roomKey, peerId: a.peerId })
      if (removed.error) throw new Error(removed.error)
      return { movedTo: removed.movedTo || '' }
    }
    const removed = await d.service.removeRoomMember({ roomKey, peerId: a.peerId })
    return { movedTo: removed.movedTo || '' }
  },

  // Where the room went on each device here, if anywhere.
  async moved () {
    const out = []
    for (const d of devices.values()) out.push([d.idx, (await movedRoomsOf(d))[roomKey] || ''])
    return out
  },

  // A device that joins with a key from before the move, as somebody given an
  // old invite would.
  async joinLate (a) {
    const d = devices.get(a.dev)
    if (d.kind === 'phone') await d.service.joinRoom({ roomKey: a.roomKey, username: d.name })
    else await d.call('join', 'POST', {}, a.roomKey)
    return true
  },

  async republic () {
    let inRooms = 0
    for (const d of devices.values()) {
      if (d.kind === 'phone') {
        if (d.service.rooms.has(republicKey)) inRooms++
      } else {
        const listed = await d.call('get-rooms', 'GET')
        if ((listed.rooms || []).some((room) => room.roomKey === republicKey)) inRooms++
      }
    }
    return { hits: republicHits, inRooms }
  },

  async metrics () {
    const now = Date.now()
    const cpu = process.cpuUsage(cpuMark)
    const wall = Math.max(1, now - cpuAt) * 1000
    const mem = process.memoryUsage()
    const out = {
      rss: mem.rss,
      cpuPct: (100 * (cpu.user + cpu.system)) / wall,
      loopP99: loop.percentile(99) / 1e6,
      devices: devices.size
    }
    loop.reset()
    cpuMark = process.cpuUsage()
    cpuAt = now
    return out
  },

  async close () {
    if (poller) clearInterval(poller)
    await Promise.allSettled([...devices.values()].map(async (d) => {
      if (d.kind === 'phone') { try { await d.service.close() } catch {} }
      await stopNetwork(d)
    }))
    setTimeout(() => process.exit(0), 300)
    return true
  }
}

process.on('message', async (m) => {
  try {
    process.send({ id: m.id, ok: true, result: await handlers[m.cmd](m.args || {}) })
  } catch (error) {
    process.send({ id: m.id, ok: false, error: error?.stack || String(error) })
  }
})
process.on('disconnect', () => process.exit(0))
process.on('unhandledRejection', (error) => console.error('[unhandled]', error?.message || error))
