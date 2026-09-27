// Dump every block's schema and func source from the web (workspace, debug Chrome 9333) and the offline editor, plus
// the executor / scope / function internals, to ref/blocks-web.json and ref/blocks-offline.json — the material for
// deciding which blocks the compiler may run through their own func.
//   node bench/dump-blocks.js [--no-offline] [--no-web]      (restarts Entry.exe)
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
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PROFILE = path.join(os.tmpdir(), 'entry-bench-chrome')
const REF = new URL('../ref/', import.meta.url)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const DUMP = `(() => {
  const src = (f) => (typeof f === 'function' ? f.toString() : null)
  const methods = (o) => Object.fromEntries(Object.getOwnPropertyNames(o).filter((k) => typeof o[k] === 'function' && k !== 'constructor').map((k) => [k, src(o[k])]))
  const blocks = {}
  for (const [type, s] of Object.entries(Entry.block)) {
    if (!s || typeof s !== 'object') continue
    blocks[type] = {
      skeleton: s.skeleton, class: s.class, event: s.event, isNotFor: s.isNotFor,
      params: (s.params || []).map((p) => p && p.type), paramsKeyMap: s.paramsKeyMap, statementsKeyMap: s.statementsKeyMap,
      executable: Boolean(Entry.skeleton[s.skeleton] && Entry.skeleton[s.skeleton].executable),
      func: src(s.func),
    }
  }
  const list = Entry.variableContainer.lists_[0]
  return {
    ua: navigator.userAgent, type: Entry.type, STATIC: { CONTINUE: Entry.STATIC.CONTINUE, BREAK: Entry.STATIC.BREAK, PASS: Entry.STATIC.PASS },
    internals: {
      Executor: methods(Entry.Executor.prototype), Scope: methods(Entry.Scope.prototype), Code: methods(Entry.Code.prototype),
      CodeStatic: methods(Entry.Code), Variable: methods(Entry.Variable.prototype), List: list ? methods(Object.getPrototypeOf(list)) : null,
      Func: Entry.Func ? { ...methods(Entry.Func.prototype), static: methods(Entry.Func) } : null,
      Utils: { isNumber: src(Entry.Utils.isNumber), stopProjectWithToast: src(Entry.Utils.stopProjectWithToast) },
      engine: methods(Object.getPrototypeOf(Entry.engine)),
    },
    blocks,
  }
})()`

async function offline() {
  const live = await EntryLive.launch({ fresh: true })
  await live.loadProject(functionProject())
  const out = await live.eval(DUMP)
  live.conn.close()
  return out
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
  // the linux project's player has functions and lists loaded; its Entry is the same build as the workspace
  await c.send('Page.navigate', { url: 'https://playentry.org/project/6ab8a912e74f73da0867850c' })
  await sleep(15000)
  const out = await c.evaluate(`(() => {
    const w = [...document.querySelectorAll('iframe')].map((f) => f.contentWindow).find((x) => { try { return x.Entry && x.Entry.Executor } catch (e) { return false } })
    return w.eval(${JSON.stringify(DUMP)})
  })()`)
  c.close()
  return out
}

async function main() {
  fs.mkdirSync(REF, { recursive: true })
  for (const [name, fn, skip] of [['web', web, '--no-web'], ['offline', offline, '--no-offline']]) {
    if (args.includes(skip))
      continue
    const out = await fn()
    fs.writeFileSync(new URL(`blocks-${name}.json`, REF), JSON.stringify(out, null, 1))
    const n = Object.keys(out.blocks).length
    const withFunc = Object.values(out.blocks).filter(b => b.func).length
    console.log(`${name}: 블록 ${n}개 (func 있음 ${withFunc}) → ref/blocks-${name}.json`)
  }
}

main().then(() => process.exit(0), (e) => {
  console.error(e)
  process.exit(1)
})
