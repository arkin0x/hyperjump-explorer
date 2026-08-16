import Decimal from 'decimal.js'

// Cyberspace v2 constants (see ../cyberspace-spec/CYBERSPACE_V2.md)
export const AXIS_BITS = 85n
export const AXIS_UNITS = 1n << AXIS_BITS // 2^85
export const AXIS_MAX = AXIS_UNITS - 1n
export const AXIS_CENTER = 1n << (AXIS_BITS - 1n) // 2^84

// Cantor Height 34 scale (CYBERSPACE_V2.md §9.2, §9.7 step 9).
//
// `2^34` Gibsons = 2 metres, therefore 1 Gibson = `2^-33` metres and
// 1 km = `1000 * 2^33` Gibsons. Deriving the axis length from this rather than
// hardcoding it keeps the explorer locked to the spec, and matches the
// reference implementation in cyberspace-cli (`src/cyberspace_core/coords.py`).
//
// This replaces the Cyberspace v1 constant `96056`, which was wrong by a factor
// of ~4.69e7 and placed Earth's surface 13.6 cm from the origin. Decoding the
// §9.8 golden vectors under the value below reproduces the WGS84 ellipsoid:
// equator 6378.14 km, pole 6356.75 km.
export const UNITS_PER_KM = 1000n * (1n << 33n)

// ~4,503,599,627,370.496 km (~0.48 light-years), per §9.2.
export const DATASPACE_AXIS_KM = new Decimal(AXIS_UNITS.toString()).div(UNITS_PER_KM.toString())

// WGS84 equatorial radius, in km. Earth is ~2.8e-9 of the half axis at this
// scale, so the renderer works in normalised units and reaches it by zooming
// rather than by distorting the geometry.
export const EARTH_EQUATORIAL_RADIUS_KM = 6378.137
export const EARTH_POLAR_RADIUS_KM = EARTH_EQUATORIAL_RADIUS_KM * (1 - 1 / 298.257223563)

// Geostationary orbit radius from Earth's centre, in km. Used as a zoom preset:
// the spec calls out GEO as the scale the axis extents must comfortably exceed.
export const GEO_RADIUS_KM = 42164

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

/* ------------------------------------------------------------------ */
/* Render space                                                        */
/* ------------------------------------------------------------------ */

/**
 * The scene is drawn in normalised render units where 1 unit = half the
 * dataspace axis, so the cube spans [-1, 1] on every axis.
 *
 * Kilometres cannot be used directly as world units at the true v2 scale: the
 * half axis is ~2.25e12 km while Earth's radius is ~6.4e3 km, a dynamic range
 * of ~3.5e8 that float32 vertex buffers cannot hold. Normalising keeps every
 * coordinate in a numerically comfortable band and pushes the range problem
 * into the depth buffer, where a logarithmic depth buffer handles it.
 *
 * Positions remain physically true; only the unit changes.
 */
export const RENDER_HALF_AXIS = 1

export function kmToRender(km: number): number {
  return km / dataspaceHalfAxisKm()
}

export function renderToKm(units: number): number {
  return units * dataspaceHalfAxisKm()
}

/** Named camera distances (in render units) spanning the full v2 scale range. */
export type ScalePreset = 'earth' | 'geo' | 'cloud' | 'axis'

export const SCALE_PRESETS: Record<ScalePreset, { label: string; radiusKm: number }> = {
  earth: { label: 'Earth', radiusKm: EARTH_EQUATORIAL_RADIUS_KM },
  geo: { label: 'Geostationary orbit', radiusKm: GEO_RADIUS_KM },
  cloud: { label: 'Hyperjump cloud', radiusKm: 0 }, // filled from actual data extent
  axis: { label: 'Full dataspace axis', radiusKm: 0 }, // filled from the half axis
}

/** Human-readable distance for HUD labels, spanning cm to light-years. */
export function formatKm(km: number): string {
  const a = Math.abs(km)
  if (a < 1e-5) return `${(km * 1e9).toFixed(2)} µm`
  if (a < 1e-2) return `${(km * 1e6).toFixed(2)} mm`
  if (a < 1) return `${(km * 1000).toFixed(2)} m`
  if (a < 1e6) return `${km.toLocaleString(undefined, { maximumFractionDigits: 1 })} km`
  if (a < 1e9) return `${(km / 1e6).toFixed(2)} million km`
  if (a < 9.461e12) return `${(km / 1e9).toFixed(2)} billion km`
  return `${(km / 9.4607e12).toFixed(3)} ly`
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
