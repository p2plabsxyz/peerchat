// Gives every desktop device its own copy of each file in the desktop
// PeerChat folder. p2p.js and moderation.js keep their rooms, peers and spam
// counters at module level, so devices sharing one copy would share them. A
// module imported as p2p.js?dev=7 passes ?dev=7 on to its local imports.
let dir = ''

export async function initialize (data) {
  dir = data.dir
}

export async function resolve (specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  const tag = /[?&]dev=([^&]+)/.exec(context.parentURL || '')
  if (tag && result.url.startsWith(dir) && !result.url.includes('/node_modules/') && !result.url.includes('?')) {
    return { ...result, url: `${result.url}?dev=${tag[1]}` }
  }
  return result
}
