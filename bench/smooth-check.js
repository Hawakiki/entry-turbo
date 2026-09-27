// Smooth motion in the offline editor: a text box moves and turns for 180 ticks. With smooth on, how often is the stage
// drawn, do the drawn positions sit between ticks (never further from the real one than one tick's move), and is the
// end state the same as with smooth off? Restarts Entry.exe.   node bench/smooth-check.js
import fs from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'
import { benchProject, ENTRY_TEST } from './projects.js'

const require = createRequire(import.meta.url)
const { EntryLive } = require(`${ENTRY_TEST}/src/live`)
const D = require(`${ENTRY_TEST}/omok/dsl.js`)
const Blocks = require(`${ENTRY_TEST}/src/blocks.js`)
const SRC = ['../src/turbo.js', '../src/osd.js', '../src/smooth.js'].map(f => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n;\n')

function project() {
  const mk = (type, params) => Blocks.block(type, params)
  const p = benchProject()
  p.objects[0].script = D.script([D.HAT_RUN(), D.SET('완료', 0), D.REPEAT(180, [mk('move_direction', [D.NUM(4), null]), mk('rotate_relative', [D.NUM(3), null])]), D.SET('완료', 1)])
  return p
}

const RUN = `async (smoothOn) => {
  const V = (n) => Entry.variableContainer.variables_.find((v) => v.name_ === n)
  const e = Entry.container.getAllObjects()[0].entity
  const o = e.object
  window.__sm = window.__sm || installEntrySmooth()
  __sm.set(smoothOn)
  const samples = []
  const force = Entry.stage.updateForce
  Entry.stage.updateForce = function (...a) { if (Entry.engine.isState('run')) samples.push([performance.now(), o.x, e.getX() * 1]); return force.apply(this, a) }
  let ticks = 0
  const tick = Entry.Code.prototype.tick
  Entry.Code.prototype.tick = function (...a) { ticks++; return tick.apply(this, a) }
  Entry.isTurbo = false
  const t0 = performance.now()
  Entry.engine.toggleRun()
  await new Promise((r) => { const iv = setInterval(() => { if (String(V('완료').getValue()) === '1' || performance.now() - t0 > 20000) { clearInterval(iv); r() } }, 5) })
  const ms = performance.now() - t0
  Entry.stage.updateForce = force
  Entry.Code.prototype.tick = tick
  const end = { x: Math.round(e.getX() * 1000) / 1000, y: Math.round(e.getY() * 1000) / 1000, rotation: Math.round(e.getRotation() * 1000) / 1000 }
  Entry.engine.toggleStop()
  __sm.set(false)
  // drawn vs real x at the moment of drawing (Entry x = object x for a text box on the default stage)
  const off = samples.map(([, drawn, real]) => Math.abs(drawn - real))
  return { ms, ticks, renders: samples.length, between: off.filter((d) => d > 1e-6).length, maxOff: Math.max(0, ...off), end }
}`

async function main() {
  const live = await EntryLive.launch({ fresh: true })
  await live.loadProject(project())
  await live.eval(SRC)
  const hz = await live.eval('new Promise((r) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < 1000) requestAnimationFrame(f); else r(n) }; requestAnimationFrame(f) })')
  console.log(`에디터 창의 애니메이션 프레임: ${hz}/초`)
  const results = {}
  for (const mode of [false, true, false, true]) {
    const r = await live.eval(`(${RUN})(${mode})`)
    const secs = r.ms / 1000
    console.log(`보간 ${mode ? '켬' : '끔'}  ${r.ms.toFixed(0)}ms  틱 ${(r.ticks / secs).toFixed(0)}/초  그림 ${(r.renders / secs).toFixed(0)}/초  틱 사이 위치로 그린 비율 ${r.renders ? Math.round((r.between / r.renders) * 100) : 0}%  최대 차이 ${r.maxOff.toFixed(2)}px  끝 ${JSON.stringify(r.end)}`)
    results[mode] = results[mode] || new Set()
    results[mode].add(JSON.stringify(r.end))
    await live.settle(500)
  }
  live.conn.close()
  const all = new Set([...results.true, ...results.false])
  console.log(`\n끝 상태 일치 (보간 켬/끔): ${all.size === 1 ? 'PASS' : 'FAIL'}`)
  process.exit(all.size === 1 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
