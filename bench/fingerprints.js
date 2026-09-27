// Collect the fingerprints of the Entry functions the compiler copies, from every build it was checked against, and
// write them into src/turbo.js (between @known-start and @known-end). Run after reading a new build's code and
// confirming the rules still hold — this is what lets the extension compile on that build.
//   node bench/fingerprints.js [--no-offline] [--no-web]      (restarts Entry.exe; uses the debug Chrome on 9333)
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ENTRY_TEST, functionProject } from './projects.js'

const require = createRequire(import.meta.url)
const { EntryLive } = require(`${ENTRY_TEST}/src/live`)
const cdp = require(`${ENTRY_TEST}/src/cdp`)

const args = process.argv.slice(2)
const TURBO = new URL('../src/turbo.js', import.meta.url)
const TURBO_SRC = fs.readFileSync(TURBO, 'utf8')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PROFILE = path.join(os.tmpdir(), 'entry-bench-chrome')
const PROJECT_PAGE = 'https://playentry.org/project/6ab8a912e74f73da0867850c' // 진짜 리눅스 6.1: has functions
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function offline() {
  const live = await EntryLive.launch({ fresh: true })
  await live.loadProject(functionProject())
  await live.eval(TURBO_SRC)
  const fp = await live.eval('EntryTurbo.collectFingerprints()')
  live.conn.close()
  return fp
}

async function web() {
  if (!(await cdp.isUp(9333))) {
    require('node:child_process').spawn(CHROME, ['--remote-debugging-port=9333', `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: 'ignore' }).unref()
    if (!(await cdp.waitUntilUp(9333, 40000)))
      throw new Error('크롬이 디버깅 포트를 열지 않았습니다')
  }
  const ts = await cdp.targets(9333)
  const c = await cdp.attach(ts.find(t => t.type === 'page').webSocketDebuggerUrl)
  await c.send('Page.enable')
  const out = {}
  await c.send('Page.navigate', { url: 'https://playentry.org/ws' })
  await sleep(15000)
  await c.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /아니요|아니오|취소/.test(x.textContent)); if (b) b.click() })()`)
  await c.evaluate(TURBO_SRC)
  out.ws = await c.evaluate('EntryTurbo.collectFingerprints()')
  await c.send('Page.navigate', { url: PROJECT_PAGE })
  await sleep(15000)
  out.player = await c.evaluate(`(() => {
    const w = [...document.querySelectorAll('iframe')].map((f) => f.contentWindow).find((x) => { try { return x.Entry && x.Entry.Executor } catch (e) { return false } })
    w.eval(${JSON.stringify(TURBO_SRC)})
    return w.EntryTurbo.collectFingerprints()
  })()`)
  c.close()
  return out
}

async function main() {
  const builds = {}
  if (!args.includes('--no-offline'))
    builds.offline = await offline()
  if (!args.includes('--no-web'))
    Object.assign(builds, await web())
  const known = {}
  const keys = [...new Set(Object.values(builds).flatMap(b => Object.keys(b)))].sort()
  for (const key of keys) {
    const hashes = Object.values(builds).map(b => b[key]).filter(Boolean)
    known[key] = [...new Set(hashes)].sort()
    const per = Object.entries(builds).map(([name, b]) => `${name}=${b[key] || '-'}`).join(' ')
    console.log(`${key.padEnd(36)} ${known[key].length}종  ${per}`)
  }
  const body = Object.entries(known).map(([k, v]) => `    '${k}': [${v.map(h => `'${h}'`).join(', ')}],`).join('\n')
  const src = fs.readFileSync(TURBO, 'utf8')
  const from = src.indexOf('\n', src.indexOf('// @known-start')) + 1
  const to = src.lastIndexOf('\n', src.indexOf('// @known-end')) + 1
  fs.writeFileSync(TURBO, `${src.slice(0, from)}  const KNOWN = {\n${body}\n  }\n${src.slice(to)}`)
  console.log(`\n${keys.length}개 항목 → src/turbo.js KNOWN (빌드 ${Object.keys(builds).join(', ')})`)
}

main().then(() => process.exit(0), (e) => {
  console.error(e)
  process.exit(1)
})
