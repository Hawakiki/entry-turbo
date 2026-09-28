// Build dist/ and pack it as release/entry-turbo-v<release version>.zip (scripts/version.js) with its SHA-256. The zip is reproducible: files in a
// fixed order with a fixed timestamp, so anyone who builds the same commit gets the same bytes and the same hash.
//   node scripts/release.js
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { readReleaseVersion } from './version.js'

const root = new URL('../', import.meta.url)
execFileSync(process.execPath, [fileURLToPath(new URL('scripts/build.js', root))], { stdio: 'inherit' })
const { label: version } = readReleaseVersion(root)

function files(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory()
    ? files(new URL(`${d.name}/`, dir), `${base}${d.name}/`)
    : [[`${base}${d.name}`, fs.readFileSync(new URL(d.name, dir))]]))
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++)
    c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xFFFFFFFF
  for (const b of buf)
    c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

// DOS time 00:00, date 2026-01-01
const TIME = 0
const DATE = ((2026 - 1980) << 9) | (1 << 5) | 1
function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const packed = zlib.deflateRawSync(data, { level: 9 })
    const crc = crc32(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034B50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6) // UTF-8 names
    head.writeUInt16LE(8, 8) // deflate
    head.writeUInt16LE(TIME, 10)
    head.writeUInt16LE(DATE, 12)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(packed.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(nameBuf.length, 26)
    locals.push(head, nameBuf, packed)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014B50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(8, 10)
    cen.writeUInt16LE(TIME, 12)
    cen.writeUInt16LE(DATE, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(packed.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    centrals.push(cen, nameBuf)
    offset += head.length + nameBuf.length + packed.length
  }
  const size = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

const entries = files(new URL('dist/', root)).sort(([a], [b]) => (a < b ? -1 : 1))
const out = new URL(`release/entry-turbo-v${version}.zip`, root)
fs.mkdirSync(new URL('release/', root), { recursive: true })
const buf = zip(entries)
fs.writeFileSync(out, buf)
const sha = crypto.createHash('sha256').update(buf).digest('hex')
fs.writeFileSync(new URL(`release/entry-turbo-v${version}.zip.sha256`, root), `${sha}  entry-turbo-v${version}.zip\n`)
process.stdout.write(`release/entry-turbo-v${version}.zip (${entries.length}개 파일, ${buf.length.toLocaleString()} B)\nSHA-256 ${sha}\n`)
