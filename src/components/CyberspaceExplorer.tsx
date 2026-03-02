'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'

import CyberspaceScene, { type BlockPoint } from '@/components/scene/CyberspaceScene'
import { coordHexToCoord256, coordHexToPositionKm, coordToXyz, planeName, xyzToSector } from '@/lib/cyberspace/coords'
import { parseHyperjumpAnchor, type HyperjumpAnchor, type NostrEvent } from '@/lib/hyperjumps/anchor'
import { kind321ByHeightFilter, kind321LatestFilter, NostrRelay } from '@/lib/nostr/relay'

const DEFAULT_RELAY_URL = process.env.NEXT_PUBLIC_NOSTR_RELAY_URL ?? 'wss://cyberspace.nostr1.com'

function fmt(n: number | null): string {
  return n === null ? '—' : String(n)
}

export default function CyberspaceExplorer(): React.JSX.Element {
  const relayUrl = DEFAULT_RELAY_URL

  const relayRef = useRef<NostrRelay | null>(null)
  const latestSeenHeightRef = useRef<number | null>(null)
  const selectedHeightRef = useRef<number | null>(null)
  const newModeRef = useRef<boolean>(true)

  const [status, setStatus] = useState<string>('disconnected')
  const [anchorsByHeight, setAnchorsByHeight] = useState<Map<number, HyperjumpAnchor>>(() => new Map())
  const [latestSeenHeight, setLatestSeenHeight] = useState<number | null>(null)
  const [selectedHeight, setSelectedHeight] = useState<number | null>(null)
  const [newMode, setNewMode] = useState<boolean>(true)

  const [heightInput, setHeightInput] = useState<string>('')

  const [zoomAllSeq, setZoomAllSeq] = useState(0)
  const [zoomSelectedSeq, setZoomSelectedSeq] = useState(0)

  const [panelCollapsed, setPanelCollapsed] = useState(false)

  useEffect(() => {
    latestSeenHeightRef.current = latestSeenHeight
  }, [latestSeenHeight])

  useEffect(() => {
    selectedHeightRef.current = selectedHeight
  }, [selectedHeight])

  useEffect(() => {
    newModeRef.current = newMode
  }, [newMode])

  const recentHeights = useMemo(() => {
    const hs = Array.from(anchorsByHeight.keys()).sort((a, b) => b - a)
    return hs.slice(0, 100)
  }, [anchorsByHeight])

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

    for (const h of recentHeights) {
      const a = anchorsByHeight.get(h)
      if (a) pushAnchor(a)
    }

    if (selectedAnchor && !recentHeights.includes(selectedAnchor.height)) {
      pushAnchor(selectedAnchor)
    }

    return blocks
  }, [anchorsByHeight, recentHeights, selectedAnchor])

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

  const jumpToLatest = () => {
    if (latestSeenHeightRef.current === null) return
    setNewMode(true)
    setSelectedHeight(latestSeenHeightRef.current)
  }

  const selectedIndex = selectedHeight === null ? -1 : recentHeights.indexOf(selectedHeight)
  const sliderValue = selectedIndex >= 0 ? selectedIndex : 0

  return (
    <div className="relative h-dvh w-dvw overflow-hidden">
      <div className="absolute inset-0">
        <CyberspaceScene
          blocks={sceneBlocks}
          selectedHeight={selectedHeight}
          zoomAllSeq={zoomAllSeq}
          zoomSelectedSeq={zoomSelectedSeq}
          onSelectHeight={(h) => selectHeightUser(h)}
        />
      </div>

      <div className="pointer-events-none absolute inset-0 p-4">
        <div
          className={
            'pointer-events-auto rounded-xl border border-white/10 bg-black/60 text-sm text-zinc-100 backdrop-blur ' +
            (panelCollapsed ? 'w-auto p-2' : 'w-full max-w-xl p-4')
          }
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPanelCollapsed((v) => !v)}
                className="rounded-lg bg-white/10 px-2 py-1.5 hover:bg-white/15"
                title={panelCollapsed ? 'Expand panel' : 'Collapse panel'}
                aria-label={panelCollapsed ? 'Expand panel' : 'Collapse panel'}
              >
                ☰
              </button>

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
                'rounded-full px-3 py-1 text-xs font-semibold ' +
                (newMode ? 'bg-emerald-500/20 text-emerald-200' : 'bg-zinc-500/20 text-zinc-200')
              }
              title="Enable NEW mode and jump to latest-seen height"
            >
              NEW {newMode ? 'ON' : 'OFF'}
            </button>
          </div>

          {!panelCollapsed && (
            <>
              <div className="mt-2 text-xs text-zinc-300">{status}</div>

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
                  disabled={selectedHeight === null}
                >
                  Zoom to selected
                </button>
                <button
                  type="button"
                  onClick={() => setZoomAllSeq((x) => x + 1)}
                  className="rounded-lg bg-white/10 px-3 py-1.5 hover:bg-white/15"
                >
                  Zoom to all
                </button>
              </div>

              <div className="mt-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-zinc-400">Recent window (top {recentHeights.length} / 100)</div>
                  <div className="font-mono text-xs text-zinc-300">
                    {recentHeights.length > 0 ? `${recentHeights[0]} → ${recentHeights[recentHeights.length - 1]}` : '—'}
                  </div>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, recentHeights.length - 1)}
                  value={sliderValue}
                  onChange={(e) => {
                    const idx = Number.parseInt(e.target.value, 10)
                    const h = recentHeights[idx]
                    if (Number.isFinite(h)) selectHeightUser(h)
                  }}
                  className="mt-1 w-full"
                  disabled={recentHeights.length === 0}
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
                  className="rounded-lg bg-emerald-500/20 px-3 py-2 text-sm font-semibold text-emerald-200"
                >
                  Jump
                </button>
              </form>

              <div className="mt-3 rounded-lg bg-white/5 p-3">
                <div className="text-xs font-semibold text-zinc-200">Selected block details</div>
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
              </div>

              <div className="mt-2 text-[11px] text-zinc-400">Relay: {relayUrl}</div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
