import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import Decimal from 'decimal.js'

const AXIS_BITS = 85n
const AXIS_UNITS = 1n << AXIS_BITS
const AXIS_MAX = AXIS_UNITS - 1n
const AXIS_CENTER = 1n << (AXIS_BITS - 1n)
const DATASPACE_AXIS_KM = new Decimal('96056')

function coordToXyz(coord) {
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

function axisU85ToKmFromCenter(u85) {
  if (u85 < 0n || u85 > AXIS_MAX) throw new Error('axis value out of range')
  const delta = u85 - AXIS_CENTER
  return new Decimal(delta.toString()).mul(DATASPACE_AXIS_KM).div(AXIS_UNITS.toString()).toNumber()
}

function approxEq(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps
}

function main() {
  const specPath = path.resolve(process.cwd(), 'scripts', '../../cyberspace-spec/visualization_vectors.json')
  const raw = fs.readFileSync(specPath, 'utf8')
  const data = JSON.parse(raw)

  if (!data || !Array.isArray(data.vectors)) throw new Error('invalid vectors JSON')

  const errs = []

  for (const v of data.vectors) {
    const coordHex = String(v.coord_hex)
    const coord = BigInt(`0x${coordHex}`)

    const got = coordToXyz(coord)

    const wantX = BigInt(v.x_u85)
    const wantY = BigInt(v.y_u85)
    const wantZ = BigInt(v.z_u85)
    const wantPlane = BigInt(v.plane)

    if (got.x !== wantX || got.y !== wantY || got.z !== wantZ || got.plane !== wantPlane) {
      errs.push(
        `${v.name}: xyz/plane mismatch got=(${got.x},${got.y},${got.z},${got.plane}) want=(${wantX},${wantY},${wantZ},${wantPlane})`,
      )
      continue
    }

    const kx = axisU85ToKmFromCenter(got.x)
    const ky = axisU85ToKmFromCenter(got.y)
    const kz = axisU85ToKmFromCenter(got.z)

    if (!approxEq(kx, Number(v.x_km_from_center), 1e-3)) errs.push(`${v.name}: x_km mismatch got=${kx} want=${v.x_km_from_center}`)
    if (!approxEq(ky, Number(v.y_km_from_center), 1e-3)) errs.push(`${v.name}: y_km mismatch got=${ky} want=${v.y_km_from_center}`)
    if (!approxEq(kz, Number(v.z_km_from_center), 1e-3)) errs.push(`${v.name}: z_km mismatch got=${kz} want=${v.z_km_from_center}`)
  }

  if (errs.length) {
    console.error(`visualization vectors check FAILED (${errs.length} issues):`)
    for (const e of errs) console.error(`- ${e}`)
    process.exit(1)
  }

  console.log(`visualization vectors check OK (${data.vectors.length} vectors)`)
}

main()
