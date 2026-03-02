export type NostrEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export type HyperjumpAnchor = {
  eventId: string
  pubkey: string
  createdAt: number
  kind: 321
  height: number
  coordHex: string
  blockHash?: string
  prevBlockHash?: string
  nextBlockHash?: string
  net?: string
  raw: NostrEvent
}

function getTag(tags: string[][], key: string): string | undefined {
  // Nostr tags are [<name>, <value>, ...]
  for (const t of tags) {
    if (t.length >= 2 && t[0] === key) return t[1]
  }
  return undefined
}

export function parseHyperjumpAnchor(ev: NostrEvent): HyperjumpAnchor | null {
  if (ev.kind !== 321) return null

  const coordHex = getTag(ev.tags, 'C')?.toLowerCase()
  const heightStr = getTag(ev.tags, 'B')

  if (!coordHex || !heightStr) return null
  if (!/^[0-9a-f]{64}$/.test(coordHex)) return null

  const height = Number.parseInt(heightStr, 10)
  if (!Number.isFinite(height) || height < 0) return null

  return {
    eventId: ev.id,
    pubkey: ev.pubkey,
    createdAt: ev.created_at,
    kind: 321,
    height,
    coordHex,
    blockHash: getTag(ev.tags, 'H')?.toLowerCase(),
    prevBlockHash: getTag(ev.tags, 'P')?.toLowerCase(),
    nextBlockHash: getTag(ev.tags, 'N')?.toLowerCase(),
    net: getTag(ev.tags, 'net'),
    raw: ev,
  }
}
