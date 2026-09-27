// Copy the extension's own files into dist/ — the folder to load in chrome://extensions (or zip to share).
import fs from 'node:fs'
import process from 'node:process'

const FILES = ['manifest.json', 'src/turbo.js', 'src/main.js', 'src/bridge.js', 'popup/popup.html', 'popup/popup.css', 'popup/popup.js']
const root = new URL('../', import.meta.url)
const dist = new URL('dist/', root)

fs.rmSync(dist, { recursive: true, force: true })
for (const f of FILES) {
  const to = new URL(f, dist)
  fs.mkdirSync(new URL('./', to), { recursive: true })
  fs.copyFileSync(new URL(f, root), to)
}
const { version } = JSON.parse(fs.readFileSync(new URL('manifest.json', root), 'utf8'))
process.stdout.write(`dist/ ← ${FILES.length}개 파일 (버전 ${version})\n`)
