// A HyperDHT testnet on 127.0.0.1 for the PeerChat load test. It starts with
// no bootstrap nodes of its own, so it never talks to the public DHT, and every
// node binds to loopback, so nothing it does leaves this machine.
import { createRequire } from 'node:module'

const [anchor, size = '20'] = process.argv.slice(2)
const createTestnet = createRequire(anchor)('hyperdht/testnet.js')

const testnet = await createTestnet(Number(size), { host: '127.0.0.1' })
for (const node of testnet.nodes) {
  if (node.address().host !== '127.0.0.1') throw new Error(`testnet node bound to ${node.address().host}`)
}
process.send({ bootstrap: testnet.bootstrap })

async function shutdown () {
  try { await testnet.destroy() } catch {}
  process.exit(0)
}
process.on('message', (message) => { if (message === 'close') shutdown() })
process.on('disconnect', shutdown)
