// The published 진짜 리눅스 6.1 on playentry.org, with the extension's page scripts (src/turbo.js + src/main.js,
// injected into every frame at document start the way the extension does) and without them: time from ▶ to
// "ready" and to the prompt after dmesg, and the console lines at the prompt must match between the runs.
//   node bench/web-linux.js [--modes turbo-boost,turbo,entry-boost]      (debug Chrome on port 9333)
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ENTRY_TEST } from './projects.js'

const require = createRequire(import.meta.url)
const cdp = require(`${ENTRY_TEST}/src/cdp`)
const args = process.argv.slice(2)
const MODES = (args.includes('--modes') ? args[args.indexOf('--modes') + 1] : 'turbo-boost,turbo,entry-boost').split(',')
const PAGE = 'https://playentry.org/project/6ab8a912e74f73da0867850c'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PROFILE = path.join(os.tmpdir(), 'entry-bench-chrome')
const INJECT = ['../src/turbo.js', '../src/osd.js', '../src/smooth.js', '../src/main.js'].map(f => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n;\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// the player frame's window, from the top page (same origin)
const FRAME = `[...document.querySelectorAll('iframe')].map((f) => f.contentWindow).find((w) => { try { return w.Entry && w.Entry.engine } catch (e) { return false } })`
// scratch list: slot 1 = stage (3 = ready), slot 113 = the console's current line
const READ = `(() => {
  const w = ${FRAME}
  if (!w) return null
  const L = (n) => (w.Entry.variableContainer.getListByName(n)?.array_ || []).map((x) => x.data)
  const s = L('스크래치')
  return { stage: Number(s[0]), line: String(s[112]), lines: L('콘솔줄'), state: w.Entry.engine.state, turbo: w.EntryTurbo ? { compiling: w.EntryTurbo.compiling, deferring: w.EntryTurbo.deferring, stats: JSON.parse(JSON.stringify(w.EntryTurbo.stats)), engine: w.EntryTurbo.engine() } : null }
})()`

async function run(c, mode) {
  const scripts = []
  if (mode.startsWith('turbo'))
    scripts.push((await c.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT })).identifier)
  await c.send('Page.navigate', { url: PAGE })
  let r = null
  for (const dl = Date.now() + 60000; Date.now() < dl && !(r && r.lines.length); r = await c.evaluate(READ)) await sleep(500)
  await sleep(2000)
  await c.send('Page.bringToFront')
  const boost = mode.endsWith('boost')
  await c.evaluate(`(() => { const w = ${FRAME}; w.Entry.isTurbo = ${boost}; w.Entry.engine.toggleRun(); return true })()`)
  const t0 = Date.now()
  let ready = null
  let prompt = null
  for (const dl = Date.now() + 15 * 60000; Date.now() < dl; await sleep(250)) {
    r = await c.evaluate(READ)
    if (!r || r.state !== 'run')
      break
    if (ready === null && r.stage === 3)
      ready = (Date.now() - t0) / 1000
    if (ready !== null && r.line === '~ # ' && r.lines.length > 40) {
      prompt = (Date.now() - t0) / 1000
      break
    }
  }
  await c.evaluate(`(() => { const w = ${FRAME}; if (w.Entry.engine.state !== 'stop') w.Entry.engine.toggleStop(); return true })()`)
  for (const id of scripts) await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id })
  const text = r ? r.lines.join('\n') : ''
  let h = 0
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return { mode, ready, prompt, lines: r ? r.lines.length : 0, hash: h.toString(16), last: r ? r.lines.slice(-2) : [], turbo: r && r.turbo }
}

async function main() {
  if (!(await cdp.isUp(9333))) {
    require('node:child_process').spawn(CHROME, ['--remote-debugging-port=9333', `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', 'about:blank'], { detached: true, stdio: 'ignore' }).unref()
    if (!(await cdp.waitUntilUp(9333, 40000)))
      throw new Error('크롬이 디버깅 포트를 열지 않았습니다')
  }
  const ts = await cdp.targets(9333)
  const c = await cdp.attach(ts.find(t => t.type === 'page').webSocketDebuggerUrl)
  await c.send('Page.enable')
  const results = []
  for (const mode of MODES) {
    const r = await run(c, mode)
    results.push(r)
    console.log(`${mode.padEnd(12)} 준비 ${r.ready === null ? '-' : `${r.ready.toFixed(1)}초`} · 프롬프트 ${r.prompt === null ? '안 돌아옴' : `${r.prompt.toFixed(1)}초`} · 콘솔 ${r.lines}줄 ${r.hash}${r.turbo ? ` · 컴파일 ${r.turbo.stats.compiled}/${r.turbo.stats.fallback} 함수 ${r.turbo.stats.functions} 재귀 ${r.turbo.stats.recursive ?? 0}(최대 깊이 ${r.turbo.stats.maxDepth ?? 0}) 엔진 ${r.turbo.engine.coreKnown ? '확인됨' : '모름'} ${JSON.stringify(r.turbo.stats.reasons)}` : ''}`)
    console.log(`             끝 줄 ${JSON.stringify(r.last)}`)
  }
  const hashes = new Set(results.filter(r => r.prompt !== null).map(r => r.hash))
  console.log(`\n프롬프트까지 간 판의 콘솔 내용 일치: ${hashes.size === 1 ? 'PASS' : `FAIL (${[...hashes].join(', ')})`}`)
  c.close()
}

main().then(() => process.exit(0), (e) => {
  console.error(e)
  process.exit(1)
})
