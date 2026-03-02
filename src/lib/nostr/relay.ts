import type { NostrEvent } from '@/lib/hyperjumps/anchor'

export type NostrFilter = {
  ids?: string[]
  authors?: string[]
  kinds?: number[]
  since?: number
  until?: number
  limit?: number
  // Nostr tag queries are specified as "#<tagName>": [values]
  [key: `#${string}`]: string[] | undefined
}

type SubHandlers = {
  onEvent: (ev: NostrEvent) => void
  onEose?: () => void
  onClose?: () => void
  oneShot?: boolean
}

function subId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return Math.random().toString(16).slice(2)
}

export class NostrRelay {
  private url: string
  private ws: WebSocket | null = null
  private subs = new Map<string, SubHandlers>()
  private openPromise: Promise<void> | null = null

  constructor(url: string) {
    this.url = url
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  async connect(): Promise<void> {
    if (this.isOpen) return
    if (this.openPromise) return this.openPromise

    this.openPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws

      ws.onopen = () => resolve()
      ws.onerror = () => {
        this.ws = null
        this.openPromise = null
        reject(new Error(`Failed to connect to relay: ${this.url}`))
      }
      ws.onclose = () => {
        for (const [, h] of this.subs) h.onClose?.()
        this.subs.clear()
        this.ws = null
        this.openPromise = null
      }

      ws.onmessage = (msg) => {
        let data: unknown
        try {
          data = JSON.parse(String(msg.data))
        } catch {
          return
        }

        if (!Array.isArray(data) || data.length < 2) return
        const [type, sid] = data
        if (typeof type !== 'string' || typeof sid !== 'string') return

        const handlers = this.subs.get(sid)
        if (!handlers) return

        if (type === 'EVENT') {
          const ev = data[2] as NostrEvent
          handlers.onEvent(ev)
          if (handlers.oneShot) {
            // For one-shot queries, close after first result.
            this.closeSub(sid)
          }
          return
        }

        if (type === 'EOSE') {
          handlers.onEose?.()
          if (handlers.oneShot) this.closeSub(sid)
          return
        }
      }
    })

    return this.openPromise
  }

  close(): void {
    if (!this.ws) return
    try {
      this.ws.close()
    } catch {
      // ignore
    }
    this.ws = null
    this.subs.clear()
    this.openPromise = null
  }

  subscribe(filter: NostrFilter, handlers: SubHandlers): string {
    const sid = subId()
    this.subs.set(sid, handlers)

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('relay websocket not open')
    }

    this.ws.send(JSON.stringify(['REQ', sid, filter]))
    return sid
  }

  closeSub(sid: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.subs.delete(sid)
      return
    }
    try {
      this.ws.send(JSON.stringify(['CLOSE', sid]))
    } finally {
      this.subs.delete(sid)
    }
  }

  async fetchOne(filter: NostrFilter, timeoutMs: number = 10_000): Promise<NostrEvent | null> {
    await this.connect()
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('relay websocket not open')

    return await new Promise<NostrEvent | null>((resolve) => {
      let done = false
      let sid: string | null = null

      const finish = (v: NostrEvent | null) => {
        if (done) return
        done = true
        clearTimeout(t)
        if (sid) this.closeSub(sid)
        resolve(v)
      }

      sid = this.subscribe(filter, {
        oneShot: true,
        onEvent: (ev) => finish(ev),
        onEose: () => finish(null),
      })

      const t = setTimeout(() => finish(null), timeoutMs)
    })
  }

  async fetchMany(filter: NostrFilter, timeoutMs: number = 15_000): Promise<NostrEvent[]> {
    await this.connect()
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('relay websocket not open')

    return await new Promise<NostrEvent[]>((resolve) => {
      let done = false
      let sid: string | null = null
      const events: NostrEvent[] = []

      const finish = () => {
        if (done) return
        done = true
        clearTimeout(t)
        if (sid) this.closeSub(sid)
        resolve(events)
      }

      sid = this.subscribe(filter, {
        onEvent: (ev) => events.push(ev),
        onEose: () => finish(),
        onClose: () => finish(),
      })

      const t = setTimeout(() => finish(), timeoutMs)
    })
  }
}

export function kind321LatestFilter(limit: number = 100): NostrFilter {
  return { kinds: [321], limit }
}

export function kind321ByHeightFilter(height: number): NostrFilter {
  return { kinds: [321], '#B': [String(height)], limit: 1 }
}
