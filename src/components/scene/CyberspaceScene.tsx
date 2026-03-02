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
}

const GRID_COLOR = 0xb000ff
const GOLD_COLOR = 0xf6c65a
const EARTH_COLOR = 0x2e86ff
const BLACK_SUN_COLOR = 0x5a2d82

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// Render convention: flip X to match existing Python/TS visualizers.
function csToThree(p: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: -p.x, y: p.y, z: p.z }
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
  const gridLines = 16

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

  return (
    <mesh position={[0, 0, half]} rotation={[0, Math.PI, 0]}>
      <circleGeometry args={[a * 2.2, 96]} />
      <meshStandardMaterial color={BLACK_SUN_COLOR} side={THREE.FrontSide} transparent opacity={0.55} roughness={0.4} />
    </mesh>
  )
}

function Segment({ a, b, opacity }: { a: THREE.Vector3; b: THREE.Vector3; opacity: number }): React.JSX.Element {
  return <Line points={[a, b]} color={GOLD_COLOR} transparent opacity={opacity} lineWidth={1} />
}

function BlocksAndLines({ blocks, selectedHeight }: { blocks: BlockPoint[]; selectedHeight: number | null }): React.JSX.Element {
  const pts = useMemo(() => {
    const byHeight = [...blocks].sort((a, b) => b.height - a.height)
    return byHeight.map((b) => ({
      ...b,
      pos: new THREE.Vector3(b.position.x, b.position.y, b.position.z),
    }))
  }, [blocks])

  return (
    <group>
      {pts.map((p) => {
        const isSelected = selectedHeight !== null && p.height === selectedHeight
        const r = isSelected ? 420 : 250
        const color = isSelected ? 0xff4d4d : 0xff0000
        const opacity = p.plane === 1 ? 0.75 : 1.0

        return (
          <mesh key={p.height} position={[p.pos.x, p.pos.y, p.pos.z]}>
            <sphereGeometry args={[r, 20, 14]} />
            <meshStandardMaterial color={color} transparent opacity={opacity} />
          </mesh>
        )
      })}

      {pts.slice(0, -1).map((p, i) => {
        const next = pts[i + 1]
        const t = pts.length <= 1 ? 0 : i / (pts.length - 2)
        const opacity = 0.85 * (1 - t) + 0.05
        return <Segment key={`${p.height}-${next.height}`} a={p.pos} b={next.pos} opacity={opacity} />
      })}
    </group>
  )
}

function CameraController({
  blocks,
  selectedHeight,
  zoomAllSeq,
  zoomSelectedSeq,
}: Props): React.JSX.Element {
  const controlsRef = useRef<React.ElementRef<typeof OrbitControls> | null>(null)
  const { camera } = useThree()

  const selectedPos = useMemo(() => {
    if (selectedHeight === null) return null
    const b = blocks.find((x) => x.height === selectedHeight)
    if (!b) return null
    return new THREE.Vector3(b.position.x, b.position.y, b.position.z)
  }, [blocks, selectedHeight])

  const zoomToAll = () => {
    const half = dataspaceHalfAxisKm()
    camera.position.set(half * 1.35, half * 0.55, half * 1.25)
    camera.lookAt(0, 0, 0)
    controlsRef.current?.target.set(0, 0, 0)
    controlsRef.current?.update()
  }

  const zoomToSelected = () => {
    if (!selectedPos) return
    const d = 12_000
    camera.position.set(selectedPos.x + d, selectedPos.y + d * 0.55, selectedPos.z + d)
    camera.lookAt(selectedPos)
    controlsRef.current?.target.copy(selectedPos)
    controlsRef.current?.update()
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

  return <OrbitControls ref={controlsRef} enableDamping dampingFactor={0.08} />
}

export default function CyberspaceScene(props: Props): React.JSX.Element {
  const blocks = useMemo(() => props.blocks.map((b) => ({ ...b, position: csToThree(b.position) })), [props.blocks])

  return (
    <Canvas
      camera={{ fov: 55, near: 0.1, far: 2_000_000 }}
      gl={{ antialias: true, alpha: true }}
      style={{ width: '100%', height: '100%' }}
    >
      <color attach="background" args={['#05010a']} />
      <ambientLight intensity={0.45} />
      <directionalLight position={[1, 0.8, 1.2]} intensity={0.9} />

      <Bounds />
      <Earth />
      <BlackSun />
      <BlocksAndLines blocks={blocks} selectedHeight={props.selectedHeight} />

      <CameraController
        blocks={blocks}
        selectedHeight={props.selectedHeight}
        zoomAllSeq={props.zoomAllSeq}
        zoomSelectedSeq={props.zoomSelectedSeq}
      />
    </Canvas>
  )
}
