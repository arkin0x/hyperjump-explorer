/**
 * Consensus lock for the dataspace scale.
 *
 * CYBERSPACE_V2.md §9.8 publishes golden coord256 values for known GPS points.
 * Every one of them is a point on Earth's surface, so decoding them and taking
 * the radius from the origin MUST reproduce the WGS84 ellipsoid: 6378.137 km at
 * the equator, 6356.752 km at the pole.
 *
 * This is the check that pins the axis scale. Under the Cyberspace v1 constant
 * (96,056 km) these same vectors decode to a radius of 0.000136 km -- Earth's
 * surface 13.6 cm from the origin -- so any drift back to v1 fails loudly here.
 *
 * Run: node scripts/check_golden_vectors.mjs
 */
import process from 'node:process'

const AXIS_BITS = 85n
const AXIS_CENTER = 1n << 84n
const UNITS_PER_KM = 1000n * (1n << 33n) // §9.7 step 9, Cantor Height 34

const WGS84_A_KM = 6378.137
const WGS84_B_KM = WGS84_A_KM * (1 - 1 / 298.257223563)

// §9.8, spec version 2026-03-16-h34-corrected, altitude_m = 0 (clamp to surface).
const GOLDEN = [
  { name: 'origin_equator_prime', lat: 0, lon: 0, hex: 'e000000000000000000001200041040208048040000000000000000000000000' },
  { name: 'equator_east_90', lat: 0, lon: 90, hex: 'e000000000000000000000480010410082012010000000000000000000000000' },
  { name: 'equator_west_90', lat: 0, lon: -90, hex: 'c492492492492492492492012482082410480490000000000000000000000000' },
  { name: 'north_pole', lat: 90, lon: 0, hex: 'e000000000000000000000900004924920020000820000920100824920800020' },
  { name: 'london', lat: 51.5074, lon: -0.1278, hex: 'c492492492492492492492edf5bee7267451c787d95ba4d7840c76d1e33c9940' },
  { name: 'nyc', lat: 40.7128, lon: -74.006, hex: 'c4924924924924924924921f79235dae293ada913e78294253a235239a332854' },
]

function coordToXyz(coord) {
  let x = 0n
  let y = 0n
  let z = 0n
  for (let i = 0n; i < AXIS_BITS; i++) {
    z |= ((coord >> (1n + i * 3n)) & 1n) << i
    y |= ((coord >> (2n + i * 3n)) & 1n) << i
    x |= ((coord >> (3n + i * 3n)) & 1n) << i
  }
  return { x, y, z, plane: coord & 1n }
}

const kmFromCenter = (u) => Number(u - AXIS_CENTER) / Number(UNITS_PER_KM)

/** Expected geocentric radius on the WGS84 ellipsoid at a given latitude. */
function expectedRadiusKm(latDeg) {
  const lat = (latDeg * Math.PI) / 180
  const a = WGS84_A_KM
  const b = WGS84_B_KM
  const c = Math.cos(lat)
  const s = Math.sin(lat)
  // Radius of the ellipsoid surface at geodetic latitude.
  const num = (a * a * c) ** 2 + (b * b * s) ** 2
  const den = (a * c) ** 2 + (b * s) ** 2
  return Math.sqrt(num / den)
}

const errs = []
const TOL_KM = 0.5 // decimal-vs-double trig drift, far tighter than a v1/v2 mixup

for (const g of GOLDEN) {
  const { x, y, z, plane } = coordToXyz(BigInt(`0x${g.hex}`))

  if (plane !== 0n) {
    errs.push(`${g.name}: expected dataspace (plane=0), got plane=${plane}`)
    continue
  }

  const r = Math.hypot(kmFromCenter(x), kmFromCenter(y), kmFromCenter(z))
  const want = expectedRadiusKm(g.lat)
  const delta = Math.abs(r - want)

  const status = delta <= TOL_KM ? 'ok' : 'FAIL'
  console.log(
    `  ${status.padEnd(4)} ${g.name.padEnd(22)} r=${r.toFixed(3).padStart(10)} km  expected=${want.toFixed(3)} km  Δ=${delta.toFixed(4)} km`,
  )

  if (delta > TOL_KM) errs.push(`${g.name}: radius ${r} km, expected ~${want} km (Δ ${delta} km)`)
}

if (errs.length) {
  console.error(`\ngolden vector check FAILED (${errs.length} issues):`)
  for (const e of errs) console.error(`- ${e}`)
  console.error(
    '\nA radius near 0.000136 km means the axis scale reverted to the Cyberspace v1\n' +
      'constant 96056. The correct value derives from units_per_km = 1000 * 2^33.',
  )
  process.exit(1)
}

console.log(`\ngolden vector check OK (${GOLDEN.length} vectors reproduce WGS84)`)
