'use client'

import { Canvas, useThree } from '@react-three/fiber'
import { Line, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import React, { useEffect, useMemo, useRef } from 'react'

import { dataspaceHalfAxisKm } from '@/lib/cyberspace/coords'

export type BlockPoint = {
  height: number
  position: { x: number; y: number; z: number }
  plane: 0 | 1
}

type Props = {
  blocks: BlockPoint[]
  selectedHeight: number | null
  zoomAllSeq: number
  zoomSelectedSeq: number
  zoomMarkerSeq: number
  faceBlackSunSeq?: number
  showLines: boolean
  multiView: boolean
  // Heights that participate in the "main" chain (e.g. the most-recent window).
  // This prevents accidentally drawing lines from that chain to unrelated blocks
  // that are also rendered (selected block, favorites, nearest, etc.).
  mainChainHeights?: number[]
  favoriteHeights?: number[]
  highlightHeights?: number[]
  markerPosition?: { x: number; y: number; z: number } | null
  onSelectHeight?: (height: number) => void
}

const GRID_COLOR = 0xb000ff
const EARTH_COLOR = 0x2e86ff
const BLACK_SUN_COLOR = 0x5a2d82

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// Render convention: match Cyberspace axes directly.
// -Z points toward the black sun, +Y toward the top grid, and looking toward -Z, screen-right is +X.
function csToThree(p: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: p.x, y: p.y, z: p.z }
}

function buildGridPlane(y: number, half: number, n: number): THREE.BufferGeometry {
  const lines = clamp(Math.floor(n), 3, 512)
  const positions: number[] = []

  for (let i = 0; i < lines; i++) {
    const t = lines === 1 ? 0 : i / (lines - 1)
    const x = lerp(-half, half, t)
    positions.push(x, y, -half, x, y, half)
  }

  for (let i = 0; i < lines; i++) {
    const t = lines === 1 ? 0 : i / (lines - 1)
    const z = lerp(-half, half, t)
    positions.push(-half, y, z, half, y, z)
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  return g
}

function earthEquatorialRadiusKm(): number {
  return 6378137 / 1000
}

function earthPolarRadiusKm(): number {
  const a = earthEquatorialRadiusKm()
  const f = 1 / 298.257223563
  return a * (1 - f)
}

function Ring({ radius, axis }: { radius: number; axis: 'x' | 'y' | 'z' }): React.JSX.Element {
  const pts = useMemo(() => {
    const out: THREE.Vector3[] = []
    const seg = 256
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * Math.PI * 2
      const c = Math.cos(t)
      const s = Math.sin(t)
      if (axis === 'y') out.push(new THREE.Vector3(radius * c, 0, radius * s))
      else if (axis === 'z') out.push(new THREE.Vector3(radius * c, radius * s, 0))
      else out.push(new THREE.Vector3(0, radius * s, radius * c))
    }
    return out
  }, [axis, radius])

  return <Line points={pts} color={0x7fd3ff} transparent opacity={0.65} lineWidth={1} />
}

function Bounds(): React.JSX.Element {
  const half = dataspaceHalfAxisKm()
  // ONOSENDAI uses an 8x8 grid (8 squares per side => 9 grid lines).
  const gridLines = 9

  const top = useMemo(() => buildGridPlane(+half, half, gridLines), [half])
  const bot = useMemo(() => buildGridPlane(-half, half, gridLines), [half])

  return (
    <group>
      <lineSegments geometry={top}>
        <lineBasicMaterial color={GRID_COLOR} transparent opacity={0.5} />
      </lineSegments>
      <lineSegments geometry={bot}>
        <lineBasicMaterial color={GRID_COLOR} transparent opacity={0.5} />
      </lineSegments>
    </group>
  )
}

function Earth(): React.JSX.Element {
  const a = earthEquatorialRadiusKm()
  const b = earthPolarRadiusKm()

  return (
    <group>
      <mesh scale={[a, b, a]}>
        <sphereGeometry args={[1, 64, 32]} />
        <meshStandardMaterial color={EARTH_COLOR} transparent opacity={0.25} roughness={0.65} metalness={0.0} />
      </mesh>
      <mesh scale={[a, b, a]}>
        <sphereGeometry args={[1, 64, 32]} />
        <meshBasicMaterial color={0x7fd3ff} wireframe transparent opacity={0.12} />
      </mesh>
      <Ring radius={a} axis="y" />
      <Ring radius={a} axis="x" />
      <Ring radius={a} axis="z" />
    </group>
  )
}

function BlackSun(): React.JSX.Element {
  const half = dataspaceHalfAxisKm()
  const a = earthEquatorialRadiusKm()

  // Canonical convention: black sun sits on the -Z boundary and faces +Z (toward the origin).
  return (
    <mesh position={[0, 0, -half]} rotation={[0, 0, 0]}>
      <circleGeometry args={[a * 2.2, 96]} />
      <meshStandardMaterial color={BLACK_SUN_COLOR} side={THREE.FrontSide} transparent opacity={0.55} roughness={0.4} />
    </mesh>
  )
}

function ageToRainbowColor(ageT: number): THREE.Color {
  // ageT: 0=newest, 1=oldest.
  // Map newest -> violet, oldest -> red.
  const t = clamp(ageT, 0, 1)
  const hue = 0.75 * (1 - t) // 0.75≈270° (violet) down to 0° (red)
  const c = new THREE.Color()
  c.setHSL(hue, 1.0, 0.55)
  return c
}

function Segment({
  a,
  b,
  opacity,
  colorA,
  colorB,
}: {
  a: THREE.Vector3
  b: THREE.Vector3
  opacity: number
  colorA: THREE.Color
  colorB: THREE.Color
}): React.JSX.Element {
  return (
    <Line
      points={[a, b]}
      vertexColors={[colorA, colorB]}
      transparent
      opacity={opacity}
      lineWidth={1}
      depthWrite={false}
    />
  )
}

function PathLine({ pts }: { pts: { pos: THREE.Vector3; color: THREE.Color }[] }): React.JSX.Element | null {
  if (pts.length < 2) return null
  return (
    <Line
      points={pts.map((p) => p.pos)}
      vertexColors={pts.map((p) => p.color)}
      transparent
      opacity={1}
      lineWidth={1}
      depthWrite={false}
    />
  )
}

function PointsCloud({
  pts,
  fadeStartIdx,
  fadeCount,
  selectedHeight,
  onSelectHeight,
}: {
  pts: { height: number; pos: THREE.Vector3; color: THREE.Color; plane: 0 | 1; ageT: number; isFavorite: boolean; isHighlighted: boolean }[]
  fadeStartIdx: number
  fadeCount: number
  selectedHeight: number | null
  onSelectHeight?: (height: number) => void
}): React.JSX.Element {
  const data = useMemo(() => {
    const n = pts.length
    const positions = new Float32Array(n * 3)
    const colors = new Float32Array(n * 3)

    const favPositions: number[] = []
    const hlPositions: number[] = []

    let selectedPos: THREE.Vector3 | null = null

    for (let i = 0; i < n; i++) {
      const p = pts[i]

      let f = 1.0
      if (n <= fadeCount) {
        f = 0.9 * (1 - p.ageT) + 0.1
      } else if (i >= fadeStartIdx) {
        const t = (i - fadeStartIdx) / Math.max(1, fadeCount - 1)
        f = lerp(1.0, 0.18, t)
      }

      // Keep ideaspace a touch dimmer.
      f *= p.plane === 1 ? 0.75 : 1.0

      // Favorites should stand out even when not selected.
      if (p.isFavorite) f = Math.max(f, 0.85)

      // Highlighted blocks (nearest to marker) should stand out.
      if (p.isHighlighted) f = Math.max(f, 0.9)

      const j = i * 3
      positions[j + 0] = p.pos.x
      positions[j + 1] = p.pos.y
      positions[j + 2] = p.pos.z

      colors[j + 0] = p.color.r * f
      colors[j + 1] = p.color.g * f
      colors[j + 2] = p.color.b * f

      if (p.isFavorite) {
        favPositions.push(p.pos.x, p.pos.y, p.pos.z)
      }

      if (p.isHighlighted) {
        hlPositions.push(p.pos.x, p.pos.y, p.pos.z)
      }

      if (selectedHeight !== null && p.height === selectedHeight) selectedPos = p.pos
    }

    return {
      positions,
      colors,
      selectedPos,
      favPositions: new Float32Array(favPositions),
      hlPositions: new Float32Array(hlPositions),
    }
  }, [fadeCount, fadeStartIdx, pts, selectedHeight])

  return (
    <group>
      <points
        onPointerDown={(e) => {
          e.stopPropagation()
          const idx = (e as unknown as { index?: number }).index
          if (idx === undefined || idx === null) return
          const p = pts[idx]
          if (!p) return
          onSelectHeight?.(p.height)
        }}
      >
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[data.positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[data.colors, 3]} />
        </bufferGeometry>
        <pointsMaterial size={650} sizeAttenuation vertexColors />
      </points>

      {data.favPositions.length > 0 && (
        <points>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[data.favPositions, 3]} />
          </bufferGeometry>
          <pointsMaterial size={1050} sizeAttenuation color={0xffd54d} transparent opacity={0.9} />
        </points>
      )}

      {data.hlPositions.length > 0 && (
        <points>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[data.hlPositions, 3]} />
          </bufferGeometry>
          <pointsMaterial size={1200} sizeAttenuation color={0xff3b3b} transparent opacity={0.85} />
        </points>
      )}

      {data.selectedPos && (
        <mesh position={[data.selectedPos.x, data.selectedPos.y, data.selectedPos.z]}>
          <boxGeometry args={[1200, 1200, 1200]} />
          <meshBasicMaterial color={0xffffff} wireframe transparent opacity={0.95} depthWrite={false} />
        </mesh>
      )}
    </group>
  )
}

function BlocksAndLines({
  blocks,
  selectedHeight,
  showLines,
  mainChainSet,
  favoriteSet,
  highlightSet,
  onSelectHeight,
}: {
  blocks: BlockPoint[]
  selectedHeight: number | null
  showLines: boolean
  mainChainSet: Set<number>
  favoriteSet: Set<number>
  highlightSet: Set<number>
  onSelectHeight?: (height: number) => void
}): React.JSX.Element {
  const fadeCount = 3

  const pts = useMemo(() => {
    const byHeight = [...blocks].sort((a, b) => b.height - a.height)
    const maxH = byHeight.length ? byHeight[0].height : 0
    const minH = byHeight.length ? byHeight[byHeight.length - 1].height : 0
    const range = Math.max(1, maxH - minH)

    return byHeight.map((b) => {
      // 0=newest, 1=oldest (based on absolute height range in the current viewport)
      const ageT = clamp((maxH - b.height) / range, 0, 1)
      return {
        ...b,
        ageT,
        pos: new THREE.Vector3(b.position.x, b.position.y, b.position.z),
        color: ageToRainbowColor(ageT),
        isFavorite: favoriteSet.has(b.height),
        isHighlighted: highlightSet.has(b.height),
      }
    })
  }, [blocks, favoriteSet, highlightSet])

  const n = pts.length
  const fadeStartIdx = Math.max(0, n - fadeCount)
  const renderAsPoints = n >= 10_000

  const chainPts = useMemo(() => pts.filter((p) => mainChainSet.has(p.height)), [mainChainSet, pts])

  const renderLines = () => {
    if (!showLines || chainPts.length < 2) return null

    const cn = chainPts.length
    const fadeStartIdx = Math.max(0, cn - fadeCount)
    const fadeStartSegIdx = Math.max(0, fadeStartIdx - 1)

    // Only draw segments between consecutive heights (prevents false connections).
    const consecutiveSegments: Array<{ a: (typeof chainPts)[number]; b: (typeof chainPts)[number] }> = []
    for (let i = 0; i < cn - 1; i++) {
      const a = chainPts[i]
      const b = chainPts[i + 1]
      if (b.height === a.height - 1) consecutiveSegments.push({ a, b })
    }

    if (cn <= fadeCount) {
      return consecutiveSegments.map((seg, i) => {
        const segAgeT = cn <= 1 ? 0 : (i + 0.5) / Math.max(1, cn - 1)
        const opacity = 0.85 * (1 - segAgeT) + 0.05

        return (
          <Segment
            key={`${seg.a.height}-${seg.b.height}`}
            a={seg.a.pos}
            b={seg.b.pos}
            opacity={opacity}
            colorA={seg.a.color}
            colorB={seg.b.color}
          />
        )
      })
    }

    const main = chainPts.slice(0, fadeStartSegIdx + 1)
    const tails: React.JSX.Element[] = []

    // Draw tail segments (last 3), but still only if consecutive.
    for (let i = fadeStartSegIdx; i <= cn - 2; i++) {
      const a = chainPts[i]
      const b = chainPts[i + 1]
      if (b.height !== a.height - 1) continue

      const t = (i - fadeStartSegIdx) / Math.max(1, fadeCount - 1)
      const opacity = lerp(1.0, 0.18, t)
      tails.push(
        <Segment
          key={`${a.height}-${b.height}`}
          a={a.pos}
          b={b.pos}
          opacity={opacity}
          colorA={a.color}
          colorB={b.color}
        />,
      )
    }

    return (
      <group>
        <PathLine pts={main} />
        {tails}
      </group>
    )
  }

  const heightMap = useMemo(() => {
    const m = new Map<number, (typeof pts)[number]>()
    for (const p of pts) m.set(p.height, p)
    return m
  }, [pts])

  const contextLines = () => {
    if (selectedHeight === null) return null

    const cur = heightMap.get(selectedHeight)
    if (!cur) return null

    const prev = heightMap.get(selectedHeight - 1)
    const next = heightMap.get(selectedHeight + 1)

    const shouldDraw = (a: number, b: number): boolean => {
      if (!showLines) return true
      // If the main chain is being drawn, avoid duplicating the exact same segment.
      return !(mainChainSet.has(a) && mainChainSet.has(b))
    }

    return (
      <group>
        {prev && shouldDraw(prev.height, cur.height) && (
          <Segment
            key={`ctx-${prev.height}-${cur.height}`}
            a={prev.pos}
            b={cur.pos}
            opacity={1}
            colorA={prev.color}
            colorB={cur.color}
          />
        )}
        {next && shouldDraw(cur.height, next.height) && (
          <Segment
            key={`ctx-${cur.height}-${next.height}`}
            a={cur.pos}
            b={next.pos}
            opacity={1}
            colorA={cur.color}
            colorB={next.color}
          />
        )}
      </group>
    )
  }

  return (
    <group>
      {renderAsPoints ? (
        <PointsCloud
          pts={pts}
          fadeStartIdx={fadeStartIdx}
          fadeCount={fadeCount}
          selectedHeight={selectedHeight}
          onSelectHeight={onSelectHeight}
        />
      ) : (
        pts.map((p, i) => {
          const isSelected = selectedHeight !== null && p.height === selectedHeight
          const isFavorite = p.isFavorite
          const isHighlighted = p.isHighlighted

          let ageOpacity = 1.0
          if (n <= fadeCount) {
            ageOpacity = 0.9 * (1 - p.ageT) + 0.1
          } else if (i >= fadeStartIdx) {
            const t = (i - fadeStartIdx) / Math.max(1, fadeCount - 1)
            ageOpacity = lerp(1.0, 0.18, t)
          }

          const planeOpacity = p.plane === 1 ? 0.75 : 1.0
          let opacity = isSelected ? 1.0 : ageOpacity * planeOpacity

          // Favorites should be visually present even when old/faded.
          if (isFavorite && !isSelected) opacity = Math.max(opacity, 0.75)

          // Highlighted blocks (nearest to marker) should be visible.
          if (isHighlighted && !isSelected) opacity = Math.max(opacity, 0.8)

          const size = isSelected ? 820 : isHighlighted ? 720 : isFavorite ? 680 : 540

          return (
            <mesh
              key={p.height}
              position={[p.pos.x, p.pos.y, p.pos.z]}
              onClick={(e) => {
                e.stopPropagation()
                onSelectHeight?.(p.height)
              }}
            >
              <boxGeometry args={[size, size, size]} />
              <meshStandardMaterial
                color={p.color}
                transparent
                opacity={opacity}
                emissive={isSelected ? 0xffffff : isHighlighted ? 0xff3b3b : isFavorite ? 0xffd54d : p.color}
                emissiveIntensity={isSelected ? 0.85 : isHighlighted ? 0.45 : isFavorite ? 0.35 : 0}
              />
            </mesh>
          )
        })
      )}

      {renderLines()}
      {contextLines()}
    </group>
  )
}

type CameraControllerProps = {
  blocks: BlockPoint[]
  selectedHeight: number | null
  zoomAllSeq: number
  zoomSelectedSeq: number
  markerPosition: THREE.Vector3 | null
  zoomMarkerSeq: number
  faceBlackSunSeq?: number
}

function CameraController({
  blocks,
  selectedHeight,
  zoomAllSeq,
  zoomSelectedSeq,
  markerPosition,
  zoomMarkerSeq,
  faceBlackSunSeq,
}: CameraControllerProps): React.JSX.Element {
  const controlsRef = useRef<React.ElementRef<typeof OrbitControls> | null>(null)
  const { camera } = useThree()

  const selectedPos = useMemo(() => {
    if (selectedHeight === null) return null
    const b = blocks.find((x) => x.height === selectedHeight)
    if (!b) return null
    return new THREE.Vector3(b.position.x, b.position.y, b.position.z)
  }, [blocks, selectedHeight])

  const applyOrbit = (camPos: THREE.Vector3, target: THREE.Vector3) => {
    camera.position.copy(camPos)
    camera.lookAt(target)
    controlsRef.current?.target.copy(target)
    controlsRef.current?.update()
  }

  const zoomToAll = () => {
    const half = dataspaceHalfAxisKm()
    applyOrbit(new THREE.Vector3(half * 1.35, half * 0.55, half * 1.25), new THREE.Vector3(0, 0, 0))
  }

  const faceBlackSun = () => {
    const half = dataspaceHalfAxisKm()
    // Put the camera on +Z looking toward the origin so -Z is visually "forward".
    applyOrbit(new THREE.Vector3(0, half * 0.55, half * 1.35), new THREE.Vector3(0, 0, 0))
  }

  const zoomToSelected = () => {
    if (!selectedPos) return

    // Keep orbit center at Earth, but move camera along the ray through the selected point.
    const r = selectedPos.length()
    const dir = r > 0 ? selectedPos.clone().multiplyScalar(1 / r) : new THREE.Vector3(1, 0.55, 1).normalize()
    const camPos = dir.multiplyScalar(r + 12_000)
    applyOrbit(camPos, new THREE.Vector3(0, 0, 0))
  }

  const zoomToMarker = () => {
    if (!markerPosition) return

    // Orbit center should be the marker coordinate.
    const r = markerPosition.length()
    const dir = r > 0 ? markerPosition.clone().multiplyScalar(1 / r) : new THREE.Vector3(1, 0.55, 1).normalize()
    const camPos = markerPosition.clone().add(dir.multiplyScalar(35_000))
    applyOrbit(camPos, markerPosition)
  }

  useEffect(() => {
    zoomToAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    zoomToAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomAllSeq])

  useEffect(() => {
    zoomToSelected()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomSelectedSeq])

  useEffect(() => {
    zoomToMarker()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomMarkerSeq])

  useEffect(() => {
    if (!faceBlackSunSeq) return
    faceBlackSun()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faceBlackSunSeq])

  return <OrbitControls ref={controlsRef} enableDamping dampingFactor={0.08} />
}

function SceneContents({
  blocks,
  selectedHeight,
  showLines,
  mainChainSet,
  favoriteSet,
  highlightSet,
  markerPos,
  onSelectHeight,
}: {
  blocks: BlockPoint[]
  selectedHeight: number | null
  showLines: boolean
  mainChainSet: Set<number>
  favoriteSet: Set<number>
  highlightSet: Set<number>
  markerPos: THREE.Vector3 | null
  onSelectHeight?: (height: number) => void
}): React.JSX.Element {
  return (
    <>
      <color attach="background" args={['#05010a']} />
      <ambientLight intensity={0.45} />
      <directionalLight position={[1, 0.8, 1.2]} intensity={0.9} />

      <Bounds />
      <Earth />
      <BlackSun />

      {markerPos && (
        <mesh position={[markerPos.x, markerPos.y, markerPos.z]}>
          <sphereGeometry args={[260, 18, 14]} />
          <meshStandardMaterial color={0xff2d2d} emissive={0xff2d2d} emissiveIntensity={0.35} />
        </mesh>
      )}

      <BlocksAndLines
        blocks={blocks}
        selectedHeight={selectedHeight}
        showLines={showLines}
        mainChainSet={mainChainSet}
        favoriteSet={favoriteSet}
        highlightSet={highlightSet}
        onSelectHeight={onSelectHeight}
      />
    </>
  )
}

type Axis = 'x' | 'y' | 'z'

function FixedAxisCamera({ axis, half }: { axis: Axis; half: number }): null {
  const { camera, size } = useThree()

  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    const fovDeg = typeof cam.fov === 'number' ? cam.fov : 55
    const fov = THREE.MathUtils.degToRad(fovDeg)
    const aspect = size.height > 0 ? size.width / size.height : 1

    // Distance needed so a square of size (2*half) fits fully in view.
    // Bump margin a bit so the initial 3-up view is slightly zoomed out.
    const margin = 1.14
    const tan = Math.tan(fov / 2)
    const dist = (half * margin) / tan * Math.max(1, 1 / Math.max(0.001, aspect))

    const pos = new THREE.Vector3(0, 0, 0)
    if (axis === 'x') pos.set(dist, 0, 0)
    if (axis === 'y') pos.set(0, dist, 0)
    if (axis === 'z') pos.set(0, 0, dist)

    // Looking straight down the Y axis means the default up vector (0,1,0) is colinear with the view direction.
    // Pick a stable up vector so the orientation doesn't become undefined.
    if (axis === 'y') cam.up.set(0, 0, -1)
    else cam.up.set(0, 1, 0)

    cam.position.copy(pos)
    cam.lookAt(0, 0, 0)
    cam.updateProjectionMatrix()
  }, [axis, camera, half, size.height, size.width])

  return null
}

function ViewLabel({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/50 px-2 py-1 font-mono text-[10px] text-zinc-200">
      {text}
    </div>
  )
}

export default function CyberspaceScene(props: Props): React.JSX.Element {
  const blocks = useMemo(() => props.blocks.map((b) => ({ ...b, position: csToThree(b.position) })), [props.blocks])
  const mainChainSet = useMemo(() => new Set(props.mainChainHeights ?? []), [props.mainChainHeights])
  const favoriteSet = useMemo(() => new Set(props.favoriteHeights ?? []), [props.favoriteHeights])
  const highlightSet = useMemo(() => new Set(props.highlightHeights ?? []), [props.highlightHeights])

  const markerPos = useMemo(() => {
    if (!props.markerPosition) return null
    return new THREE.Vector3(props.markerPosition.x, props.markerPosition.y, props.markerPosition.z)
  }, [props.markerPosition])

  if (props.multiView) {
    const half = dataspaceHalfAxisKm()

    const cell = (axis: Axis, label: string) => (
      <div className="relative h-full w-full overflow-hidden">
        <Canvas
          camera={{ fov: 55, near: 0.1, far: 2_000_000 }}
          gl={{ antialias: true, alpha: true }}
          style={{ width: '100%', height: '100%' }}
        >
          <FixedAxisCamera axis={axis} half={half} />
          <SceneContents
            blocks={blocks}
            selectedHeight={props.selectedHeight}
            showLines={props.showLines}
            mainChainSet={mainChainSet}
            favoriteSet={favoriteSet}
            highlightSet={highlightSet}
            markerPos={markerPos}
            onSelectHeight={props.onSelectHeight}
          />
          <OrbitControls enableRotate={false} enablePan={false} enableDamping dampingFactor={0.08} />
        </Canvas>
        <ViewLabel text={label + ' (scroll to zoom)'} />
      </div>
    )

    return (
      <div className="grid h-full w-full grid-cols-1 gap-px bg-white/10 md:grid-cols-3">
        {cell('y', 'Y+ → Y-')}
        {cell('z', 'Z+ → Z- (black sun)')}
        {cell('x', 'X+ → X-')}
      </div>
    )
  }

  return (
    <Canvas
      camera={{ fov: 55, near: 0.1, far: 2_000_000 }}
      gl={{ antialias: true, alpha: true }}
      style={{ width: '100%', height: '100%' }}
    >
      <SceneContents
        blocks={blocks}
        selectedHeight={props.selectedHeight}
        showLines={props.showLines}
        mainChainSet={mainChainSet}
        favoriteSet={favoriteSet}
        highlightSet={highlightSet}
        markerPos={markerPos}
        onSelectHeight={props.onSelectHeight}
      />

      <CameraController
        blocks={blocks}
        selectedHeight={props.selectedHeight}
        zoomAllSeq={props.zoomAllSeq}
        zoomSelectedSeq={props.zoomSelectedSeq}
        markerPosition={markerPos}
        zoomMarkerSeq={props.zoomMarkerSeq}
        faceBlackSunSeq={props.faceBlackSunSeq}
      />
    </Canvas>
  )
}
