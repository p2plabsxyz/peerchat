// PeerChat load test: hundreds of phone and desktop devices running the apps'
// own PeerChat code in one room, on a DHT testnet on this machine that cannot
// reach the public network. P2P Republic is never joined. See README.md.
//
// The same files are in PeerSky Mobile (test/load/peerchat) and in PeerChat
// (test/load). Each runs its own app's devices, and the other app's too when
// its checkout is next to this one or named with --phone or --desktop.
//
//   npm run test:load:peerchat -- --devices 200     (PeerSky Mobile)
//   node test/load/run.mjs --devices 200             (PeerChat)
import { fork, execSync } from 'node:child_process'
import { existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

// Which checkout this is: PeerChat's has p2p.js two folders up.
const IN_PEERCHAT = existsSync(path.join(HERE, '../../p2p.js'))
const ROOT = path.resolve(HERE, IN_PEERCHAT ? '../..' : '../../..')
const PHONE_DIR = findPhone(option('phone', process.env.PEERSKY_MOBILE_DIR || ''))
const DESKTOP_DIR = IN_PEERCHAT && !option('desktop', '') ? ROOT : findDesktop(option('desktop', process.env.PEERCHAT_DIR || ''))
const N = Number(option('devices', 50))
// A tenth desktops, as many rooms are mostly phones, unless one app is missing.
const DESKTOPS = !PHONE_DIR ? N : DESKTOP_DIR ? Number(option('desktops', Math.max(1, Math.round(N * 0.1)))) : 0
const PHONES = N - DESKTOPS
// The late joiner, who comes with the key from before a move.
const LATE_KIND = PHONE_DIR ? 'phone' : 'desktop'
const PER_WORKER = Number(option('per-worker', 20))
const STEADY_RATE = Number(option('steady-rate', 2))
const BUSY_RATE = Number(option('busy-rate', 5))
const JOIN_GAP_MS = Number(option('join-gap', 50))
const PHASES = option('phases', 'steady,burst,busy,catchup,removal').split(',')
const OUT = option('out', '')

// The phone's code: the folder given, this checkout, or one next to it.
function findPhone (given) {
  const candidates = given ? [given] : IN_PEERCHAT ? [path.join(ROOT, '../peersky-mobile')] : [ROOT]
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'backend/peerchat/service.mjs'))) return path.resolve(dir)
  }
  if (given) throw new Error(`No backend/peerchat/service.mjs in ${given}`)
  return ''
}

// The desktop's PeerChat: the folder given, or one next to this checkout.
function findDesktop (given) {
  const candidates = given
    ? [given]
    : [path.join(ROOT, '../peerchat'), path.join(ROOT, '../peersky-browser/src/pages/p2p/peerchat')]
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'p2p.js'))) return path.resolve(dir)
  }
  if (given) throw new Error(`No PeerChat p2p.js in ${given}`)
  return ''
}

const runDir = mkdtempSync(path.join(os.tmpdir(), 'peerchat-load-'))
const results = { devices: N, desktops: DESKTOPS, phones: PHONES, startedAt: new Date().toISOString(), phases: {} }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts)
const round = (x, d = 1) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d)

function dist (values) {
  const s = values.filter((v) => v != null).sort((a, b) => a - b)
  if (!s.length) return { n: 0 }
  const at = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
  return { n: s.length, min: s[0], p50: at(50), p95: at(95), max: s[s.length - 1] }
}

function sample (list, n) {
  const copy = list.slice()
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, n)
}

// Memory the machine could still give, counting what macOS keeps inactive.
function availableGB () {
  try {
    if (process.platform === 'darwin') {
      const out = execSync('vm_stat').toString()
      const page = Number(/page size of (\d+)/.exec(out)?.[1] || 16384)
      const pages = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(out)?.[1] || 0)
      return ((pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * page) / 2 ** 30
    }
    const info = execSync('cat /proc/meminfo').toString()
    return Number(/MemAvailable:\s+(\d+)/.exec(info)?.[1] || 0) / 2 ** 20
  } catch {
    return os.freemem() / 2 ** 30
  }
}

function guardMemory () {
  const gb = availableGB()
  if (gb < 2.5) throw new Error(`stopping: only ${round(gb)} GB of memory left`)
}

const children = []
const pending = new Map()
let seq = 0

function spawn (file, argv, logName) {
  const out = openSync(path.join(runDir, logName), 'a')
  const child = fork(path.join(HERE, file), argv, { cwd: runDir, stdio: ['ignore', out, out, 'ipc'] })
  children.push(child)
  return child
}

function rpc (w, cmd, a = {}, timeoutMs = 15 * 60_000) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${cmd} timed out on worker ${w.n}`)) }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    // A worker that has gone answers with an error here, not an 'error' event.
    w.proc.send({ id, cmd, args: a }, (error) => {
      if (!error) return
      clearTimeout(timer)
      pending.delete(id)
      reject(error)
    })
  })
}

const workers = []
const devInfo = new Map()
const all = (cmd, argsFor = () => ({})) => Promise.all(workers.map((w) => rpc(w, cmd, argsFor(w))))
const byWorker = (devs) => workers.map((w) => [w, devs.filter((d) => devInfo.get(d).worker === w)]).filter(([, d]) => d.length)

async function statusAll () {
  const rows = (await all('status')).flat()
  return new Map(rows.map(([idx, conns, roomPeers, rx, tx, joinAt, joinedAt, firstRoomPeerAt, online, arrivals, joinError, removalSeenAt, moveSeenAt]) => [
    idx, { idx, conns, roomPeers, rx, tx, joinAt, joinedAt, firstRoomPeerAt, online, arrivals, joinError, removalSeenAt, moveSeenAt }
  ]))
}

async function metricsAll () {
  const list = await all('metrics')
  return {
    rssMB: round(list.reduce((s, m) => s + m.rss, 0) / 1e6, 0),
    cpuPct: round(list.reduce((s, m) => s + m.cpuPct, 0), 0),
    loopP99MaxMs: round(Math.max(...list.map((m) => m.loopP99)), 0),
    availableGB: round(availableGB(), 1)
  }
}

async function deliveryOf (origins, eligible) {
  const eligibleSet = new Set(eligible)
  const parts = await Promise.all(workers.map((w) => rpc(w, 'collect', {
    origins,
    eligible: eligible.filter((dev) => devInfo.get(dev).worker === w)
  })))
  const perId = {}
  const last = {}
  const lat = []
  const perDev = {}
  for (const part of parts) {
    for (const [id, n] of Object.entries(part.perId)) perId[id] = (perId[id] || 0) + n
    for (const [id, ms] of Object.entries(part.last)) last[id] = Math.max(last[id] ?? 0, ms)
    for (const ms of part.lat) lat.push(ms)
    Object.assign(perDev, part.perDev)
  }
  let expected = 0
  let delivered = 0
  let fully = 0
  const everyone = []
  for (const [id, , sender] of origins) {
    const want = eligible.length - (eligibleSet.has(sender) ? 1 : 0)
    const got = perId[id] || 0
    expected += want
    delivered += got
    if (got >= want) {
      fully++
      if (want > 0) everyone.push(last[id])
    }
  }
  return {
    deliveredPct: expected ? (100 * delivered) / expected : null,
    fullyDelivered: fully,
    latencyMs: dist(lat),
    everyoneMs: dist(everyone),
    perDev
  }
}

async function messagePhase (name, plan, waitMs, eligible) {
  guardMemory()
  const before = await statusAll()
  await metricsAll()
  const tStart = Date.now()
  const sends = (await Promise.all(byWorker([...new Set(plan.map((p) => p.dev))]).map(([w, devs]) => rpc(w, 'send', { plan: plan.filter((p) => devs.includes(p.dev)) })))).flat()
  const lastAt = Math.max(...plan.map((p) => p.at))
  await sleep(Math.max(0, lastAt + waitMs - Date.now()))
  const after = await statusAll()
  const metrics = await metricsAll()
  const seconds = (Date.now() - tStart) / 1000
  const ok = sends.filter((s) => s[1])
  const origins = ok.map(([dev, id, t]) => [id, t, dev]).sort((a, b) => a[1] - b[1])
  const delivery = await deliveryOf(origins, eligible)
  const rxPerMsg = []
  const rxRate = []
  for (const dev of eligible) {
    const a = before.get(dev)
    const b = after.get(dev)
    if (!a || !b) continue
    rxRate.push((b.rx - a.rx) / 1024 / seconds)
    if (ok.length) rxPerMsg.push((b.rx - a.rx) / ok.length)
  }
  const out = {
    sent: ok.length,
    sendFailures: sends.length - ok.length,
    eligible: eligible.length,
    deliveredPct: delivery.deliveredPct,
    fullyDelivered: delivery.fullyDelivered,
    latencyMs: delivery.latencyMs,
    everyoneMs: delivery.everyoneMs,
    rxKBps: dist(rxRate),
    rxBytesPerMessage: dist(rxPerMsg),
    metrics
  }
  results.phases[name] = out
  log(`${name}: ${out.sent} sent (${out.sendFailures} failed) to ${out.eligible} devices, ${round(out.deliveredPct, 2)}% delivered, ` +
    `last device after p50 ${out.everyoneMs.p50} ms / max ${out.everyoneMs.max} ms, ${round(out.rxBytesPerMessage.p50 / 1024)} KB in per message`)
  return { out, origins, delivery }
}

// A set number of messages a second for a minute, each author at most one
// every six seconds, well inside the per-author and spam limits.
function ratePlan (eligible, rate, word) {
  const authors = sample(eligible, Math.min(eligible.length, Math.ceil(rate * 6)))
  const start = Date.now() + 2000
  return Array.from({ length: rate * 60 }, (_, i) => ({ dev: authors[i % authors.length], at: start + (i * 1000) / rate, text: `${word} ${i}` }))
}

async function main () {
  log(`${N} devices (${DESKTOPS} desktops, ${PHONES} phones), ${round(availableGB())} GB free`)
  if (PHONE_DIR) log(`phone code ${PHONE_DIR}`)
  if (DESKTOP_DIR) log(`desktop code ${DESKTOP_DIR}`)

  const anchor = PHONE_DIR ? path.join(PHONE_DIR, 'package.json') : path.join(DESKTOP_DIR, 'p2p.js')
  const dhtProc = spawn('dht.mjs', [anchor, '20'], 'dht.log')
  const { bootstrap } = await new Promise((resolve, reject) => {
    dhtProc.once('message', resolve)
    dhtProc.once('exit', (code) => reject(new Error(`testnet exited ${code}`)))
  })
  if (!bootstrap.every((node) => node.host === '127.0.0.1')) throw new Error('testnet is not local')

  // One more phone than asked for, which joins only after the room moves, with
  // the key from before, as somebody holding an old invite would.
  const groups = []
  const desktops = DESKTOPS + (LATE_KIND === 'desktop' ? 1 : 0)
  const phones = PHONES + (LATE_KIND === 'phone' ? 1 : 0)
  for (let i = 0; i < desktops; i += PER_WORKER) groups.push({ kind: 'desktop', devs: range(i, Math.min(desktops, i + PER_WORKER)) })
  for (let i = 0; i < phones; i += PER_WORKER) groups.push({ kind: 'phone', devs: range(desktops + i, desktops + Math.min(phones, i + PER_WORKER)) })
  groups.forEach((g, n) => {
    const proc = spawn('worker.mjs', [], `worker-${n}-${g.kind}.log`)
    const w = { n, kind: g.kind, devs: g.devs, proc }
    proc.on('message', (m) => {
      const waiting = pending.get(m.id)
      if (!waiting) return
      pending.delete(m.id)
      clearTimeout(waiting.timer)
      if (m.ok) waiting.resolve(m.result)
      else waiting.reject(new Error(m.error))
    })
    workers.push(w)
  })
  const inits = await Promise.all(workers.map((w) => rpc(w, 'init', { kind: w.kind, devs: w.devs, bootstrap, runDir, phoneDir: PHONE_DIR, desktopDir: DESKTOP_DIR })))
  inits.forEach((r, i) => r.devices.forEach((d) => devInfo.set(d.idx, { ...d, worker: workers[i] })))
  if (new Set(inits.map((r) => r.republicHex)).size !== 1) throw new Error('the apps disagree on the Republic topic')

  // Device 0 makes the room: a desktop when there is one, as with P2P Republic.
  const creatorWorker = devInfo.get(0).worker
  const { roomKey } = await rpc(creatorWorker, 'create', { dev: 0, name: 'Load test' })
  const LATE = LATE_KIND === 'phone' ? N : DESKTOPS
  const joiners = sample([...devInfo.keys()].filter((idx) => idx !== 0 && idx !== LATE), N - 1)
  const joinStart = Date.now() + 2000
  await all('join', (w) => ({ roomKey, plan: joiners.filter((dev) => devInfo.get(dev).worker === w).map((dev) => ({ dev, at: joinStart + joiners.indexOf(dev) * JOIN_GAP_MS })) }))
  const lastJoin = joinStart + (joiners.length - 1) * JOIN_GAP_MS
  let stableSince = 0
  let lastConns = -1
  for (;;) {
    await sleep(5000)
    guardMemory()
    const rows = [...(await statusAll()).values()].filter((r) => r.idx !== LATE)
    const inRoom = rows.filter((r) => r.firstRoomPeerAt).length
    const conns = rows.reduce((s, r) => s + r.conns, 0)
    log(`joining: ${inRoom}/${N} in the room, ${Math.round(conns / 2)} connections`)
    const now = Date.now()
    if (Math.abs(conns - lastConns) <= Math.max(4, conns * 0.01)) stableSince ||= now
    else stableSince = 0
    lastConns = conns
    if (now > lastJoin + 20_000 && inRoom === N && stableSince && now - stableSince >= 15_000) break
    if (now > lastJoin + 150_000) break
  }
  const st = await statusAll()
  const rows = [...st.values()].filter((r) => r.idx !== LATE)
  results.join = {
    inRoom: rows.filter((r) => r.firstRoomPeerAt).length,
    toFirstRoomPeerMs: dist(rows.filter((r) => r.firstRoomPeerAt && r.idx !== 0).map((r) => r.firstRoomPeerAt - r.joinAt)),
    connectionsPerDevice: dist(rows.map((r) => r.conns)),
    metrics: await metricsAll()
  }
  log(`in the room: ${results.join.inRoom}/${N}; connections p50 ${results.join.connectionsPerDevice.p50}, max ${results.join.connectionsPerDevice.max}`)
  const eligible = [...devInfo.keys()].filter((idx) => idx !== LATE && st.get(idx)?.firstRoomPeerAt)

  if (PHASES.includes('steady')) await messagePhase('steady', ratePlan(eligible, STEADY_RATE, 'Steady'), 20_000, eligible)
  if (PHASES.includes('burst')) {
    const at = Date.now() + 2000
    await messagePhase('burst', sample(eligible, Math.min(50, Math.floor(eligible.length / 2))).map((dev) => ({ dev, at, text: `Burst ${dev}` })), 20_000, eligible)
  }
  if (PHASES.includes('busy')) await messagePhase('busy', ratePlan(eligible, BUSY_RATE, 'Busy'), 30_000, eligible)

  if (PHASES.includes('catchup') && eligible.length >= 20) {
    guardMemory()
    const k = Math.max(2, Math.min(10, Math.round(eligible.length / 10)))
    const desks = eligible.filter((i) => i !== 0 && devInfo.get(i).kind === 'desktop')
    const phones = eligible.filter((i) => devInfo.get(i).kind === 'phone')
    const away = [...sample(desks, Math.floor(k / 2)), ...sample(phones, k - Math.min(desks.length, Math.floor(k / 2)))]
    await Promise.all(byWorker(away).map(([w, devs]) => rpc(w, 'stop', { devs })))
    await sleep(5000)
    const staying = eligible.filter((d) => !away.includes(d))
    const { origins } = await messagePhase('catchupWhileAway', ratePlan(staying, 5, 'While away'), 10_000, staying)
    await Promise.all(byWorker(away).map(([w, devs]) => rpc(w, 'restart', { devs })))
    await sleep(45_000)
    const back = await deliveryOf(origins, away)
    const newest = await deliveryOf(origins.slice(-200), away)
    results.phases.catchupBack = {
      away: away.length,
      missed: origins.length,
      got: away.map((dev) => back.perDev[dev] ?? 0),
      ofNewest200: away.map((dev) => newest.perDev[dev] ?? 0)
    }
    log(`back after missing ${origins.length}: got ${results.phases.catchupBack.got.join(', ')}; of the newest 200: ${results.phases.catchupBack.ofNewest200.join(', ')}`)
  }

  if (PHASES.includes('removal')) {
    guardMemory()
    // Somebody removed by the creator: the removal reaches everyone, the room
    // moves to a new key, and everyone but the person removed follows.
    const target = sample(eligible.filter((i) => i !== 0 && devInfo.get(i).kind === 'phone'), 1)[0] ?? sample(eligible.filter((i) => i !== 0), 1)[0]
    const others = eligible.filter((i) => i !== target && i !== 0)
    const t0 = Date.now()
    const { movedTo } = await rpc(creatorWorker, 'remove', { dev: 0, peerId: devInfo.get(target).id })
    let knew = []
    let moved = []
    for (let i = 0; i < 30; i++) {
      await sleep(2000)
      const s = await statusAll()
      knew = others.filter((dev) => s.get(dev)?.removalSeenAt >= t0)
      const where = new Map((await all('moved')).flat())
      moved = others.filter((dev) => where.get(dev) === movedTo)
      if (knew.length === others.length && moved.length === others.length) break
    }
    const where = new Map((await all('moved')).flat())
    const removal = {
      target,
      devices: others.length,
      knewOfRemoval: knew.length,
      followedNewKey: moved.length,
      targetFollowed: where.get(target) === movedTo,
      movedTo: Boolean(movedTo)
    }
    // Somebody new with the old key, as with an invite from before the move.
    await rpc(devInfo.get(LATE).worker, 'joinLate', { dev: LATE, roomKey })
    await sleep(15_000)
    // Written now: it goes to the new room, so neither the person removed nor
    // the late joiner gets it.
    const writers = sample(others, 5)
    const after = await messagePhase('afterMove', writers.map((dev, i) => ({ dev, at: Date.now() + 1000 + i * 200, text: `After the move ${i}` })), 10_000, others)
    // Everyone who moved got them, from the new room, and the two left out did not.
    removal.movedDeliveredPct = round(after.out.deliveredPct, 2)
    const outside = await deliveryOf(after.origins, [target, LATE])
    removal.removedGotNewMessages = outside.perDev[target] || 0
    removal.lateJoinerGotNewMessages = outside.perDev[LATE] || 0
    results.phases.removal = removal
    log(`removal: ${knew.length}/${others.length} knew, ${moved.length}/${others.length} followed the new key; ` +
      `new messages for the removed device: ${removal.removedGotNewMessages}, for a late joiner with the old key: ${removal.lateJoinerGotNewMessages}`)
  }

  const republic = await all('republic')
  results.republic = { joinAttempts: republic.reduce((s, r) => s + r.hits, 0), devicesWithRepublic: republic.reduce((s, r) => s + r.inRooms, 0) }
  log(`P2P Republic: ${results.republic.joinAttempts} join attempts refused, ${results.republic.devicesWithRepublic} devices in it`)
  printGrid()
}

function printGrid () {
  const p = results.phases
  const pct = (phase) => (phase ? `${round(phase.deliveredPct, 2)}%` : '-')
  const lines = [
    `| | ${N} devices |`,
    '|---|---|',
    `| Joined the room | ${results.join.inRoom} |`,
    `| Connections per device (median, max) | ${results.join.connectionsPerDevice.p50}, ${results.join.connectionsPerDevice.max} |`,
    `| Messages delivered (steady, burst, busy) | ${pct(p.steady)}, ${pct(p.burst)}, ${pct(p.busy)} |`,
    `| Time until the last device had a message (steady chat) | ${p.steady ? `${round(p.steady.everyoneMs.max / 1000, 2)} s` : '-'} |`,
    `| Devices back after missing ${p.catchupBack?.missed ?? 300} messages | ${p.catchupBack ? `got the newest ${Math.min(...p.catchupBack.ofNewest200)}` : '-'} |`,
    `| Data received per message, per device | ${p.steady ? `${round(p.steady.rxBytesPerMessage.p50 / 1024)} KB` : '-'} |`,
    `| Devices that learned of a removal | ${p.removal ? `${p.removal.knewOfRemoval} of ${p.removal.devices}` : '-'} |`,
    `| Devices that followed the new key | ${p.removal ? `${p.removal.followedNewKey} of ${p.removal.devices}` : '-'} |`,
    `| Messages delivered in the new room | ${p.removal ? `${p.removal.movedDeliveredPct}%` : '-'} |`,
    `| New messages the removed device got | ${p.removal ? p.removal.removedGotNewMessages : '-'} |`,
    `| New messages a late joiner with the old key got | ${p.removal ? p.removal.lateJoinerGotNewMessages : '-'} |`
  ]
  results.grid = lines.join('\n')
  console.log('\n' + results.grid + '\n')
}

function range (a, b) {
  return Array.from({ length: b - a }, (_, i) => a + i)
}

let failed = null
try {
  await main()
} catch (error) {
  failed = error
  results.error = error.stack || String(error)
  log('FAILED', error.message)
} finally {
  results.endedAt = new Date().toISOString()
  if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2))
  await Promise.allSettled(workers.map((w) => rpc(w, 'close', {}, 60_000)))
  for (const child of children) {
    if (child.connected) child.send('close', () => {})
  }
  await sleep(1500)
  for (const child of children) {
    try { child.kill('SIGKILL') } catch {}
  }
  // Everything the devices kept goes, unless asked to keep it.
  if (flag('keep')) log(`kept ${runDir}`)
  else rmSync(runDir, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
