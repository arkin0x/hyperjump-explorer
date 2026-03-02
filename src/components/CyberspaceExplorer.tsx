'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'

import CyberspaceScene, { type BlockPoint } from '@/components/scene/CyberspaceScene'
import { coordHexToCoord256, coordHexToPositionKm, coordToXyz, planeName, xyzToSector } from '@/lib/cyberspace/coords'
import type { PositionKm } from '@/lib/cyberspace/coords'
import { parseHyperjumpAnchor, type HyperjumpAnchor, type NostrEvent } from '@/lib/hyperjumps/anchor'
import { kind321ByHeightFilter, kind321LatestFilter, NostrRelay, type NostrFilter } from '@/lib/nostr/relay'

const DEFAULT_RELAY_URL = process.env.NEXT_PUBLIC_NOSTR_RELAY_URL ?? 'wss://cyberspace.nostr1.com'

function fmt(n: number | null): string {
  return n === null ? '—' : String(n)
}

const BLOCK_SPAN_OPTIONS = [5, 10, 21, 50, 100, 1_000, 10_000, 100_000, 1_000_000] as const
export type BlockSpan = (typeof BLOCK_SPAN_OPTIONS)[number]

function sampleCountForSpan(span: BlockSpan): number {
  // Reasonable caps to keep fetch + render bounded while still giving much more context.
  if (span <= 10_000) return span
  if (span === 100_000) return 10_000
  return 20_000 // 1,000,000
}

function computeDisplayHeights(latestHeight: number, span: BlockSpan): number[] {
  const earliest = Math.max(0, latestHeight - span + 1)
  const count = sampleCountForSpan(span)

  // Linear for small spans, log-sampled for large spans.
  const heights = new Set<number>()
  heights.add(latestHeight)
  heights.add(earliest)

  if (span <= 10_000) {
    for (let h = latestHeight; h >= earliest && heights.size < count; h--) heights.add(h)
  } else {
    // Offsets in [0..span-1], log-distributed: denser near 0 (newest), sparser toward oldest.
    const maxOffset = latestHeight - earliest
    const denom = Math.max(1, count - 1)

    for (let i = 0; i < count; i++) {
      const t = i / denom
      const offset = Math.floor(Math.exp(t * Math.log(maxOffset + 1)) - 1)
      heights.add(latestHeight - offset)
    }
  }

  return Array.from(heights)
    .filter((h) => h >= earliest && h <= latestHeight)
    .sort((a, b) => b - a)
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function kind321ByHeightsFilter(heights: number[]): NostrFilter {
  return { kinds: [321], '#B': heights.map(String), limit: heights.length }
}

export default function CyberspaceExplorer(): React.JSX.Element {
  const relayUrl = DEFAULT_RELAY_URL

  const relayRef = useRef<NostrRelay | null>(null)
  const latestSeenHeightRef = useRef<number | null>(null)
  const selectedHeightRef = useRef<number | null>(null)
  const newModeRef = useRef<boolean>(true)

  const [status, setStatus] = useState<string>('disconnected')
  const [anchorsByHeight, setAnchorsByHeight] = useState<Map<number, HyperjumpAnchor>>(() => new Map())
  const anchorsByHeightRef = useRef<Map<number, HyperjumpAnchor>>(anchorsByHeight)
  const [latestSeenHeight, setLatestSeenHeight] = useState<number | null>(null)
  const [selectedHeight, setSelectedHeight] = useState<number | null>(null)
  const [newMode, setNewMode] = useState<boolean>(true)

  const [heightInput, setHeightInput] = useState<string>('')

  const [zoomAllSeq, setZoomAllSeq] = useState(0)
  const [zoomSelectedSeq, setZoomSelectedSeq] = useState(0)
  const [zoomMarkerSeq, setZoomMarkerSeq] = useState(0)
  const [faceBlackSunSeq, setFaceBlackSunSeq] = useState(0)

  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [showLines, setShowLines] = useState(true)
  const [multiView, setMultiView] = useState(false)

  const [detailsCollapsed, setDetailsCollapsed] = useState(true)

  const [blockSpan, setBlockSpan] = useState<BlockSpan>(100)
  const [prefetchStatus, setPrefetchStatus] = useState<string>('')

  const [favorites, setFavorites] = useState<number[]>([])
  const [showFavorites, setShowFavorites] = useState<boolean>(true)

  const [coordInput, setCoordInput] = useState<string>('')
  const [coordError, setCoordError] = useState<string>('')
  const [markerPos, setMarkerPos] = useState<PositionKm | null>(null)
  const [nearestHeights, setNearestHeights] = useState<number[]>([])
  const anchorPosCacheRef = useRef<Map<number, PositionKm>>(new Map())

  useEffect(() => {
    try {
      const raw = localStorage.getItem('hyperjump_favorites_v1')
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      const hs = parsed
        .map((x) => (typeof x === 'number' ? x : Number.parseInt(String(x), 10)))
        .filter((x) => Number.isFinite(x) && x >= 0)
      const uniq = Array.from(new Set(hs)).sort((a, b) => b - a)
      setFavorites(uniq)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('hyperjump_favorites_v1', JSON.stringify(favorites))
    } catch {
      // ignore
    }
  }, [favorites])

  useEffect(() => {
    latestSeenHeightRef.current = latestSeenHeight
  }, [latestSeenHeight])

  useEffect(() => {
    anchorsByHeightRef.current = anchorsByHeight
  }, [anchorsByHeight])

  useEffect(() => {
    selectedHeightRef.current = selectedHeight
  }, [selectedHeight])

  useEffect(() => {
    newModeRef.current = newMode
  }, [newMode])

  // Space toggles the main panel collapse state.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ' && e.code !== 'Space') return
      if (e.altKey || e.ctrlKey || e.metaKey) return

      const t = e.target as HTMLElement | null
      const tag = t?.tagName?.toLowerCase()
      const isEditable =
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        t?.isContentEditable === true ||
        t?.getAttribute?.('role') === 'textbox'

      if (isEditable) return

      e.preventDefault()
      setPanelCollapsed((v) => !v)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const baseDisplayHeights = useMemo(() => {
    if (latestSeenHeight === null) return []
    return computeDisplayHeights(latestSeenHeight, blockSpan)
  }, [latestSeenHeight, blockSpan])

  const sceneHeights = useMemo(() => {
    const out = new Set<number>(baseDisplayHeights)

    if (selectedHeight !== null) {
      out.add(selectedHeight)

      const prev = selectedHeight - 1
      const next = selectedHeight + 1

      if (prev >= 0) out.add(prev)

      // Avoid "future" height placeholders (prevents confusing context-line behavior at the tip).
      if (latestSeenHeight !== null && next <= latestSeenHeight) out.add(next)
    }

    if (showFavorites) {
      for (const h of favorites) out.add(h)
    }

    for (const h of nearestHeights) out.add(h)

    return Array.from(out).sort((a, b) => b - a)
  }, [baseDisplayHeights, favorites, latestSeenHeight, nearestHeights, selectedHeight, showFavorites])

  const selectedAnchor = useMemo(() => {
    if (selectedHeight === null) return null
    return anchorsByHeight.get(selectedHeight) ?? null
  }, [anchorsByHeight, selectedHeight])

  const selectedDecoded = useMemo(() => {
    if (!selectedAnchor) return null
    try {
      const c = coordHexToCoord256(selectedAnchor.coordHex)
      const xyz = coordToXyz(c)
      const sector = xyzToSector(xyz.x, xyz.y, xyz.z)
      return { ...xyz, sector }
    } catch {
      return null
    }
  }, [selectedAnchor])

  const sceneBlocks: BlockPoint[] = useMemo(() => {
    const blocks: BlockPoint[] = []

    const pushAnchor = (a: HyperjumpAnchor) => {
      try {
        const pos = coordHexToPositionKm(a.coordHex)
        blocks.push({
          height: a.height,
          plane: pos.plane,
          position: { x: pos.xKm, y: pos.yKm, z: pos.zKm },
        })
      } catch {
        // ignore
      }
    }

    for (const h of sceneHeights) {
      const a = anchorsByHeight.get(h)
      if (a) pushAnchor(a)
    }

    if (selectedAnchor && !sceneHeights.includes(selectedAnchor.height)) {
      pushAnchor(selectedAnchor)
    }

    return blocks
  }, [anchorsByHeight, sceneHeights, selectedAnchor])

  // Connect + subscribe to latest kind=321 events (limit 100)
  useEffect(() => {
    const relay = new NostrRelay(relayUrl)
    relayRef.current = relay

    let cancelled = false
    let sub: string | null = null

    const upsertAnchor = (a: HyperjumpAnchor) => {
      setAnchorsByHeight((prev) => {
        const next = new Map(prev)
        const existing = next.get(a.height)
        if (!existing || a.createdAt >= existing.createdAt) next.set(a.height, a)
        return next
      })

      setLatestSeenHeight((prev) => {
        const next = prev === null ? a.height : Math.max(prev, a.height)
        return next
      })

      const prevLatest = latestSeenHeightRef.current
      const nextLatest = prevLatest === null ? a.height : Math.max(prevLatest, a.height)
      latestSeenHeightRef.current = nextLatest

      if (newModeRef.current) {
        // Auto-follow highest-seen height.
        setSelectedHeight(nextLatest)
      } else if (selectedHeightRef.current === null) {
        // If no selection exists yet (rare), select something.
        setSelectedHeight(nextLatest)
      }
    }

    const onEvent = (ev: NostrEvent) => {
      const a = parseHyperjumpAnchor(ev)
      if (!a) return
      upsertAnchor(a)
    }

    ;(async () => {
      setStatus(`connecting: ${relayUrl}`)
      try {
        await relay.connect()
        if (cancelled) return
        setStatus(`connected: ${relayUrl}`)

        // Spec requirement: latest hyperjump fetch uses kinds:[321] limit:100.
        sub = relay.subscribe(kind321LatestFilter(100), { onEvent })
      } catch (e) {
        if (cancelled) return
        setStatus(`error: ${e instanceof Error ? e.message : String(e)}`)
      }
    })()

    return () => {
      cancelled = true
      if (sub) relay.closeSub(sub)
      relay.close()
      relayRef.current = null
    }
  }, [relayUrl])

  // One-shot fetch when user navigates to a height we haven't seen in the latest window.
  const inflightFetch = useRef<Set<number>>(new Set())
  useEffect(() => {
    const h = selectedHeight
    if (h === null) return
    if (anchorsByHeight.has(h)) return
    if (inflightFetch.current.has(h)) return

    const relay = relayRef.current
    if (!relay) return

    inflightFetch.current.add(h)
    setStatus((s) => (s.startsWith('error:') ? s : `fetching height ${h}…`))

    ;(async () => {
      try {
        const ev = await relay.fetchOne(kind321ByHeightFilter(h), 12_000)
        if (!ev) {
          setStatus(`not found on relay: height ${h}`)
          return
        }
        const a = parseHyperjumpAnchor(ev)
        if (!a) {
          setStatus(`invalid anchor event at height ${h}`)
          return
        }
        setStatus(`loaded height ${h}`)
        setAnchorsByHeight((prev) => {
          const next = new Map(prev)
          const existing = next.get(a.height)
          if (!existing || a.createdAt >= existing.createdAt) next.set(a.height, a)
          return next
        })
      } catch (e) {
        setStatus(`error: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        inflightFetch.current.delete(h)
      }
    })()
  }, [anchorsByHeight, selectedHeight])

  const selectHeightUser = (h: number) => {
    setNewMode(false)
    setSelectedHeight(h)
  }

  // Prefetch the display set so the scene fills in quickly when using large spans.
  const prefetchSeq = useRef(0)
  useEffect(() => {
    const relay = relayRef.current
    if (!relay) return
    if (latestSeenHeight === null) return

    const seq = ++prefetchSeq.current
    const heights = sceneHeights

    ;(async () => {
      const toFetch = heights.filter((h) => !anchorsByHeightRef.current.has(h))
      if (toFetch.length === 0) {
        setPrefetchStatus('')
        return
      }

      setPrefetchStatus(`loading ${toFetch.length} heights…`)

      let loaded = 0
      for (const group of chunk(toFetch, 200)) {
        if (prefetchSeq.current !== seq) return

        try {
          const evs = await relay.fetchMany(kind321ByHeightsFilter(group), 20_000)
          if (prefetchSeq.current !== seq) return

          const anchors: HyperjumpAnchor[] = []
          for (const ev of evs) {
            const a = parseHyperjumpAnchor(ev)
            if (a) anchors.push(a)
          }

          if (anchors.length) {
            setAnchorsByHeight((prev) => {
              const next = new Map(prev)
              for (const a of anchors) {
                const existing = next.get(a.height)
                if (!existing || a.createdAt >= existing.createdAt) next.set(a.height, a)
              }
              return next
            })
          }

          loaded += group.length
          setPrefetchStatus(`loading ${Math.max(0, toFetch.length - loaded)} heights…`)
        } catch {
          // keep going; individual relays may refuse large tag lists
          loaded += group.length
          setPrefetchStatus(`loading ${Math.max(0, toFetch.length - loaded)} heights…`)
        }
      }

      if (prefetchSeq.current === seq) setPrefetchStatus('')
    })()
  }, [sceneHeights, latestSeenHeight])

  const jumpToLatest = () => {
    if (latestSeenHeightRef.current === null) return
    setNewMode(true)
    setSelectedHeight(latestSeenHeightRef.current)
    // Leave marker state as-is; users may want it to stay while following new blocks.
  }

  const clearMarker = () => {
    setCoordError('')
    setMarkerPos(null)
    setNearestHeights([])
  }

  const locateCoord = () => {
    setCoordError('')

    const raw = coordInput.trim()
    const raw2 = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw
    const m = raw2.match(/([0-9a-fA-F]{64})/)
    const hex = m ? m[1].toLowerCase() : ''
    if (!hex) {
      setCoordError('Expected a 32-byte hex coord (64 hex chars), optionally prefixed with 0x.')
      return
    }

    let pos: PositionKm
    try {
      pos = coordHexToPositionKm(hex)
    } catch (e) {
      setCoordError(e instanceof Error ? e.message : String(e))
      return
    }

    setMarkerPos(pos)
    setZoomMarkerSeq((x) => x + 1)

    // Find 5 nearest blocks among currently loaded anchors (any plane).
    const best: { h: number; d2: number }[] = []

    const pushBest = (h: number, d2: number) => {
      best.push({ h, d2 })
      best.sort((a, b) => a.d2 - b.d2)
      if (best.length > 5) best.pop()
    }

    for (const [h, a] of anchorsByHeightRef.current.entries()) {
      let ap = anchorPosCacheRef.current.get(h)
      if (!ap) {
        try {
          ap = coordHexToPositionKm(a.coordHex)
          anchorPosCacheRef.current.set(h, ap)
        } catch {
          continue
        }
      }

      const dx = ap.xKm - pos.xKm
      const dy = ap.yKm - pos.yKm
      const dz = ap.zKm - pos.zKm
      const d2 = dx * dx + dy * dy + dz * dz

      if (best.length < 5) pushBest(h, d2)
      else if (d2 < best[best.length - 1].d2) pushBest(h, d2)
    }

    setNearestHeights(best.map((x) => x.h))
  }

  const selectedIndex = selectedHeight === null ? -1 : baseDisplayHeights.indexOf(selectedHeight)
  const sliderValue = selectedIndex >= 0 ? selectedIndex : 0

  return (
    <div className="relative h-dvh w-dvw overflow-hidden">
      <div className="absolute inset-0">
        <CyberspaceScene
          blocks={sceneBlocks}
          selectedHeight={selectedHeight}
          zoomAllSeq={zoomAllSeq}
          zoomSelectedSeq={zoomSelectedSeq}
          zoomMarkerSeq={zoomMarkerSeq}
          faceBlackSunSeq={faceBlackSunSeq}
          showLines={showLines}
          multiView={multiView}
          mainChainHeights={baseDisplayHeights}
          favoriteHeights={favorites}
          markerPosition={markerPos ? { x: markerPos.xKm, y: markerPos.yKm, z: markerPos.zKm } : null}
          highlightHeights={nearestHeights}
          onSelectHeight={(h) => selectHeightUser(h)}
        />
      </div>

      <div
        className={
          'pointer-events-none absolute inset-0 p-4 flex flex-col ' + (panelCollapsed ? 'justify-end' : 'justify-start')
        }
      >
        <div
          className={
            'pointer-events-auto rounded-xl border border-white/10 bg-black/60 text-sm text-zinc-100 backdrop-blur max-h-[calc(100dvh-2rem)] ' +
            (panelCollapsed ? 'w-auto p-2' : 'w-full max-w-xl p-4 flex flex-col overflow-hidden')
          }
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPanelCollapsed((v) => !v)}
                className={
                  'rounded-lg px-2 py-1.5 hover:bg-white/15 ' +
                  (panelCollapsed ? 'bg-purple-500/25 text-purple-200' : 'bg-white/10')
                }
                title={panelCollapsed ? 'Expand panel (Space)' : 'Collapse panel (Space)'}
                aria-label={panelCollapsed ? 'Expand panel (Space)' : 'Collapse panel (Space)'}
              >
                ☰
              </button>

              {!panelCollapsed && (
                <span
                  className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-zinc-200"
                  title="Shortcut: Space toggles the panel"
                >
                  Space
                </span>
              )}

              {!panelCollapsed && (
                <>
                  <div className="font-semibold">Hyperjump Explorer</div>
                  <div className="text-xs text-zinc-300">kind=321</div>
                </>
              )}

              {panelCollapsed && (
                <div className="flex items-center gap-2 text-xs text-zinc-200">
                  <span className="font-mono">sel={fmt(selectedHeight)}</span>
                  <span className="font-mono">latest={fmt(latestSeenHeight)}</span>
                </div>
              )}
            </div>

              <button
                type="button"
                onClick={jumpToLatest}
                className={
                  'cursor-pointer rounded-full px-3 py-1 text-xs font-semibold hover:bg-white/10 ' +
                  (newMode ? 'bg-emerald-500/20 text-emerald-200' : 'bg-zinc-500/20 text-zinc-200')
                }
                title="Enable NEW mode and jump to latest-seen height"
              >
                NEW {newMode ? 'ON' : 'OFF'}
              </button>
          </div>

          {!panelCollapsed && (
            <div className="mt-2 flex-1 overflow-y-auto overscroll-contain pr-1">
              <div className="text-xs text-zinc-300">{status}</div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-white/5 p-2">
                  <div className="text-xs text-zinc-400">Latest seen height</div>
                  <div className="font-mono text-sm">{fmt(latestSeenHeight)}</div>
                </div>
                <div className="rounded-lg bg-white/5 p-2">
                  <div className="text-xs text-zinc-400">Selected height</div>
                  <div className="font-mono text-sm">{fmt(selectedHeight)}</div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => selectedHeight !== null && selectHeightUser(Math.max(0, selectedHeight - 1))}
                  className="rounded-lg bg-white/10 px-3 py-1.5 hover:bg-white/15"
                  disabled={selectedHeight === null}
                >
                  Prev
                </button>
                <button
                  type="button"
                  onClick={() => selectedHeight !== null && selectHeightUser(selectedHeight + 1)}
                  className="rounded-lg bg-white/10 px-3 py-1.5 hover:bg-white/15"
                  disabled={selectedHeight === null}
                >
                  Next
                </button>

                <button
                  type="button"
                  onClick={() => setZoomSelectedSeq((x) => x + 1)}
                  className="rounded-lg bg-white/10 px-3 py-1.5 hover:bg-white/15"
                  disabled={selectedHeight === null || multiView}
                  title={multiView ? 'Disable 3-up view to use orbit controls' : undefined}
                >
                  Zoom to selected
                </button>
                <button
                  type="button"
                  onClick={() => setZoomAllSeq((x) => x + 1)}
                  className="rounded-lg bg-white/10 px-3 py-1.5 hover:bg-white/15"
                  disabled={multiView}
                  title={multiView ? 'Disable 3-up view to use orbit controls' : undefined}
                >
                  Zoom to all
                </button>

                <button
                  type="button"
                  onClick={() => setFaceBlackSunSeq((x) => x + 1)}
                  className="rounded-lg bg-white/10 px-3 py-1.5 hover:bg-white/15"
                  title={
                    multiView
                      ? 'Disable 3-up view to use orbit controls'
                      : 'Canonical orientation: look toward the black sun (-Z)'
                  }
                  disabled={multiView}
                >
                  Face black sun
                </button>

                <button
                  type="button"
                  onClick={() => setShowLines((v) => !v)}
                  className={
                    'rounded-lg px-3 py-1.5 hover:bg-white/15 ' +
                    (showLines ? 'bg-purple-500/25 text-purple-200 hover:bg-purple-500/30' : 'bg-white/10')
                  }
                  title="Toggle connecting lines"
                >
                  Lines {showLines ? 'ON' : 'OFF'}
                </button>

                <button
                  type="button"
                  onClick={() => setMultiView((v) => !v)}
                  className={
                    'rounded-lg px-3 py-1.5 hover:bg-white/15 ' +
                    (multiView ? 'bg-purple-500/25 text-purple-200 hover:bg-purple-500/30' : 'bg-white/10')
                  }
                  title="Toggle 3-up axis-aligned view"
                >
                  3-up {multiView ? 'ON' : 'OFF'}
                </button>

                <button
                  type="button"
                  onClick={() => setShowFavorites((v) => !v)}
                  className={
                    'rounded-lg px-3 py-1.5 hover:bg-white/15 ' +
                    (showFavorites ? 'bg-purple-500/25 text-purple-200 hover:bg-purple-500/30' : 'bg-white/10')
                  }
                  title="Toggle rendering of favorited blocks"
                >
                  Favorites {showFavorites ? 'ON' : 'OFF'}
                </button>
              </div>

              <div className="mt-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-zinc-400">
                    Showing {baseDisplayHeights.length.toLocaleString()} blocks (span {blockSpan.toLocaleString()}, sample{' '}
                    {sampleCountForSpan(blockSpan).toLocaleString()})
                    {showFavorites && favorites.length > 0 ? (
                      <span className="ml-2 text-zinc-500">+ {favorites.length.toLocaleString()} favorites</span>
                    ) : null}
                  </div>
                  <div className="font-mono text-xs text-zinc-300">
                    {baseDisplayHeights.length > 0
                      ? `${baseDisplayHeights[0].toLocaleString()} → ${baseDisplayHeights[baseDisplayHeights.length - 1].toLocaleString()}`
                      : '—'}
                  </div>
                </div>

                <div className="mt-2 flex items-center gap-2">
                  <label className="text-xs text-zinc-400">Blocks</label>
                  <select
                    value={blockSpan}
                    onChange={(e) => {
                      const v = Number.parseInt(e.target.value, 10) as BlockSpan
                      if (BLOCK_SPAN_OPTIONS.includes(v)) setBlockSpan(v)
                    }}
                    className="rounded-lg bg-black/30 px-2 py-1 text-xs ring-1 ring-white/10"
                  >
                    {BLOCK_SPAN_OPTIONS.map((v) => (
                      <option key={v} value={v}>
                        {v.toLocaleString()}
                      </option>
                    ))}
                  </select>
                  <div className="text-xs text-zinc-500">{prefetchStatus}</div>
                </div>

                <input
                  type="range"
                  min={0}
                  max={Math.max(0, baseDisplayHeights.length - 1)}
                  value={sliderValue}
                  onChange={(e) => {
                    const idx = Number.parseInt(e.target.value, 10)
                    const h = baseDisplayHeights[idx]
                    if (Number.isFinite(h)) selectHeightUser(h)
                  }}
                  className="mt-1 w-full"
                  disabled={baseDisplayHeights.length === 0}
                />
              </div>

              <form
                className="mt-3 flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  const h = Number.parseInt(heightInput.trim(), 10)
                  if (!Number.isFinite(h) || h < 0) return
                  selectHeightUser(h)
                }}
              >
                <input
                  value={heightInput}
                  onChange={(e) => setHeightInput(e.target.value)}
                  placeholder="Enter block height"
                  className="w-48 rounded-lg bg-black/30 px-3 py-2 font-mono text-sm outline-none ring-1 ring-white/10 focus:ring-2 focus:ring-emerald-500/40"
                />
                <button
                  type="submit"
                  className="rounded-lg bg-emerald-500/20 px-3 py-2 text-sm font-semibold text-emerald-200 hover:bg-emerald-500/25"
                >
                  Jump
                </button>
              </form>

              <form
                className="mt-3 rounded-lg bg-white/5 p-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  locateCoord()
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold text-zinc-200">Locate coordinate</div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={clearMarker}
                      className="rounded-lg bg-white/10 px-2 py-1 text-xs hover:bg-white/15"
                      disabled={!markerPos && nearestHeights.length === 0 && !coordError}
                    >
                      Clear
                    </button>
                    <button
                      type="submit"
                      className="rounded-lg bg-rose-500/20 px-2 py-1 text-xs font-semibold text-rose-200 hover:bg-rose-500/25"
                    >
                      Drop marker
                    </button>
                  </div>
                </div>

                <textarea
                  value={coordInput}
                  onChange={(e) => setCoordInput(e.target.value)}
                  placeholder="Paste coord256 hex (32 bytes / 64 hex chars)"
                  rows={2}
                  spellCheck={false}
                  className="mt-2 w-full resize-none rounded-lg bg-black/30 px-3 py-2 font-mono text-xs outline-none ring-1 ring-white/10 focus:ring-2 focus:ring-rose-500/40"
                />

                {coordError ? <div className="mt-2 text-xs text-rose-300">{coordError}</div> : null}

                {markerPos ? (
                  <div className="mt-2 text-xs text-zinc-300">
                    Marker plane={markerPos.plane} ({planeName(markerPos.plane)})
                  </div>
                ) : null}

                {nearestHeights.length > 0 ? (
                  <div className="mt-2 text-xs text-zinc-300">
                    Nearest blocks:{' '}
                    <span className="font-mono">
                      {nearestHeights
                        .slice()
                        .sort((a, b) => b - a)
                        .map((h) => (
                          <button
                            key={h}
                            type="button"
                            onClick={() => selectHeightUser(h)}
                            className="ml-2 rounded bg-white/10 px-1.5 py-0.5 hover:bg-white/15"
                          >
                            {h}
                          </button>
                        ))}
                    </span>
                  </div>
                ) : null}
              </form>

              <div className="mt-3 rounded-lg bg-white/5 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <div className="text-xs font-semibold text-zinc-200">Selected block details</div>
                    <button
                      type="button"
                      onClick={() => {
                        if (selectedHeight === null) return
                        setFavorites((prev) => {
                          const s = new Set(prev)
                          if (s.has(selectedHeight)) s.delete(selectedHeight)
                          else s.add(selectedHeight)
                          return Array.from(s).sort((a, b) => b - a)
                        })
                      }}
                      className={
                        'rounded-lg bg-white/10 px-2 py-1 text-xs hover:bg-white/15 ' +
                        (selectedHeight !== null && favorites.includes(selectedHeight) ? 'text-yellow-300' : 'text-zinc-200')
                      }
                      disabled={selectedHeight === null}
                      title={selectedHeight !== null && favorites.includes(selectedHeight) ? 'Unfavorite' : 'Favorite'}
                    >
                      {selectedHeight !== null && favorites.includes(selectedHeight) ? '★' : '☆'}
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => setDetailsCollapsed((v) => !v)}
                    className="rounded-lg bg-white/10 px-2 py-1 text-xs hover:bg-white/15"
                    title={detailsCollapsed ? 'Show details' : 'Hide details'}
                  >
                    {detailsCollapsed ? 'Show' : 'Hide'}
                  </button>
                </div>

                {!detailsCollapsed && (
                  <>
                    {!selectedAnchor ? (
                      <div className="mt-1 text-xs text-zinc-400">No block selected yet.</div>
                    ) : (
                      <div className="mt-2 grid grid-cols-1 gap-2">
                        <div>
                          <div className="text-xs text-zinc-400">Anchor event id</div>
                          <div className="break-all font-mono text-xs">{selectedAnchor.eventId}</div>
                        </div>
                        <div>
                          <div className="text-xs text-zinc-400">Coord (C tag, Merkle root)</div>
                          <div className="break-all font-mono text-xs">{selectedAnchor.coordHex}</div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <div className="text-xs text-zinc-400">Plane</div>
                            <div className="font-mono text-xs">{selectedDecoded ? `${selectedDecoded.plane} (${planeName(selectedDecoded.plane)})` : '—'}</div>
                          </div>
                          <div>
                            <div className="text-xs text-zinc-400">Sector (S)</div>
                            <div className="font-mono text-xs">{selectedDecoded ? selectedDecoded.sector.s : '—'}</div>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 gap-2">
                          <div>
                            <div className="text-xs text-zinc-400">Block hash (H)</div>
                            <div className="break-all font-mono text-xs">{selectedAnchor.blockHash ?? '—'}</div>
                          </div>
                          <div>
                            <div className="text-xs text-zinc-400">Prev hash (P)</div>
                            <div className="break-all font-mono text-xs">{selectedAnchor.prevBlockHash ?? '—'}</div>
                          </div>
                          <div>
                            <div className="text-xs text-zinc-400">Next hash (N)</div>
                            <div className="break-all font-mono text-xs">{selectedAnchor.nextBlockHash ?? '—'}</div>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="mt-2 text-[11px] text-zinc-400">Relay: {relayUrl}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
