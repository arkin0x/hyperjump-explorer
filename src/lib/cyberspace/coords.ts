import Decimal from 'decimal.js'

// Cyberspace v2 constants (see ../cyberspace-spec/CYBERSPACE_V2.md)
export const AXIS_BITS = 85n
export const AXIS_UNITS = 1n << AXIS_BITS // 2^85
export const AXIS_MAX = AXIS_UNITS - 1n
export const AXIS_CENTER = 1n << (AXIS_BITS - 1n) // 2^84

// Dataspace cube size used for visualization scaling.
// Note: The hyperjump explorer uses this mapping for *both* planes as a render convention.
export const DATASPACE_AXIS_KM = new Decimal('96056')

export type XyzU85 = { x: bigint; y: bigint; z: bigint; plane: bigint }
export type PositionKm = { xKm: number; yKm: number; zKm: number; plane: 0 | 1 }

export function coordToXyz(coord: bigint): XyzU85 {
  const plane = coord & 1n
  let x = 0n
  let y = 0n
  let z = 0n

  for (let i = 0n; i < AXIS_BITS; i++) {
    z |= ((coord >> (1n + i * 3n)) & 1n) << i
    y |= ((coord >> (2n + i * 3n)) & 1n) << i
    x |= ((coord >> (3n + i * 3n)) & 1n) << i
  }

  return { x, y, z, plane }
}

export function axisU85ToKmFromCenter(u85: bigint): number {
  if (u85 < 0n || u85 > AXIS_MAX) throw new Error('axis value out of range')
  // km_from_center = (u - 2^84) * axis_km / 2^85
  const delta = u85 - AXIS_CENTER
  const km = new Decimal(delta.toString()).mul(DATASPACE_AXIS_KM).div(AXIS_UNITS.toString())
  return km.toNumber()
}

export function dataspaceHalfAxisKm(): number {
  return DATASPACE_AXIS_KM.div(2).toNumber()
}

function isHex64(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s)
}

export function coordHexToCoord256(coordHex: string): bigint {
  const hex = coordHex.trim().toLowerCase()
  if (!isHex64(hex)) throw new Error('expected 32-byte lowercase hex (64 chars)')
  return BigInt(`0x${hex}`)
}

export function coordHexToPositionKm(coordHex: string): PositionKm {
  const coord = coordHexToCoord256(coordHex)
  const { x, y, z, plane } = coordToXyz(coord)

  return {
    xKm: axisU85ToKmFromCenter(x),
    yKm: axisU85ToKmFromCenter(y),
    zKm: axisU85ToKmFromCenter(z),
    plane: plane === 1n ? 1 : 0,
  }
}

export type Sector = { sx: bigint; sy: bigint; sz: bigint; s: string }

export function xyzToSector(x: bigint, y: bigint, z: bigint): Sector {
  const sectorBits = 30n
  const sx = x >> sectorBits
  const sy = y >> sectorBits
  const sz = z >> sectorBits
  return { sx, sy, sz, s: `${sx}-${sy}-${sz}` }
}

export function planeName(plane: bigint | number): 'dataspace' | 'ideaspace' | 'unknown' {
  const p = typeof plane === 'number' ? plane : Number(plane)
  if (p === 0) return 'dataspace'
  if (p === 1) return 'ideaspace'
  return 'unknown'
}
