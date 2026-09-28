// Copy the extension's own files into dist/ — the folder to load in chrome://extensions (or zip to share).
import fs from 'node:fs'
import process from 'node:process'
import { readReleaseVersion } from './version.js'

const FILES = ['manifest.json', 'src/turbo.js', 'src/osd.js', 'src/smooth.js', 'src/seed.js', 'src/main.js', 'src/bridge.js', 'popup/popup.html', 'popup/popup.css', 'popup/popup.js']
const root = new URL('../', import.meta.url)
const dist = new URL('dist/', root)
// checked first: a manifest whose version and version_name disagree is not built
const { label, prerelease } = readReleaseVersion(root)

fs.rmSync(dist, { recursive: true, force: true })
for (const f of FILES) {
  const to = new URL(f, dist)
  fs.mkdirSync(new URL('./', to), { recursive: true })
  fs.copyFileSync(new URL(f, root), to)
}
process.stdout.write(`dist/ ← ${FILES.length}개 파일 (버전 ${label}${prerelease ? ', 시험판' : ''})\n`)
