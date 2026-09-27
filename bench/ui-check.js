// UI blocks through the generic path: run bench/projects.js uiProject() in the offline editor with Entry's executor
// and with turbo, and compare what is left on the stage (position, rotation, text, speech, clones, variables).
// Restarts Entry.exe.   node bench/ui-check.js [--rounds 2]
import fs from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'
import { ENTRY_TEST, uiProject } from './projects.js'

const require = createRequire(import.meta.url)
const { EntryLive } = require(`${ENTRY_TEST}/src/live`)
const args = process.argv.slice(2)
const ROUNDS = Number(args.includes('--rounds') ? args[args.indexOf('--rounds') + 1] : 2)
const TURBO_SRC = fs.readFileSync(new URL('../src/turbo.js', import.meta.url), 'utf8')

const RUN = `async () => {
  const V = (name) => Entry.variableContainer.variables_.find((v) => v.name_ === name)
  Entry.isTurbo = false
  const t0 = performance.now()
  Entry.engine.toggleRun()
  const limit = t0 + 30000
  await new Promise((resolve) => { const iv = setInterval(() => { if (String(V('완료').getValue()) === '1' || Entry.engine.state !== 'run' || performance.now() > limit) { clearInterval(iv); resolve() } }, 5) })
  const ms = performance.now() - t0
  await new Promise((r) => setTimeout(r, 500))
  const o = Entry.container.getAllObjects()[0]
  const e = o.entity
  const r2 = (v) => Math.round(v * 1000) / 1000
  const state = {
    x: r2(e.getX()), y: r2(e.getY()), rotation: r2(e.getRotation()), direction: r2(e.getDirection()), visible: e.getVisible(),
    text: e.getText(), dialog: e.dialog ? e.dialog.message_ : null,
    clones: o.clonedEntities.map((c) => [r2(c.getX()), r2(c.getY())]),
    vars: Object.fromEntries(['카운트', '신호수', '클론수', '완료'].map((n) => [n, V(n).getValue()])),
  }
  const stats = window.EntryTurbo && EntryTurbo.compiling ? JSON.parse(JSON.stringify(EntryTurbo.stats)) : null
  if (Entry.engine.state !== 'stop') Entry.engine.toggleStop()
  return { ms, state, stats }
}`

async function main() {
  const live = await EntryLive.launch({ fresh: true })
  await live.loadProject(uiProject())
  await live.eval(TURBO_SRC)
  const states = new Set()
  for (let r = 0; r < ROUNDS; r++) {
    for (const mode of r % 2 ? ['turbo', 'entry'] : ['entry', 'turbo']) {
      await live.eval(mode === 'turbo' ? 'EntryTurbo.enable()' : 'EntryTurbo.disable()')
      const out = await live.eval(`(${RUN})()`)
      const json = JSON.stringify(out.state)
      states.add(json)
      console.log(`${mode.padEnd(5)} ${out.ms.toFixed(0).padStart(5)}ms ${json}${out.stats ? `\n      컴파일 ${out.stats.compiled}/${out.stats.fallback} 시작 ${out.stats.started} ${JSON.stringify(out.stats.reasons)}` : ''}`)
      await live.settle(500)
    }
  }
  await live.eval('EntryTurbo.disable()')
  live.conn.close()
  console.log(`\n무대 상태 일치: ${states.size === 1 ? 'PASS' : `FAIL (${states.size}가지)`}`)
  process.exit(states.size === 1 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
