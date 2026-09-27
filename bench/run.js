// A/B in the offline editor: Entry's own executor vs turbo compile, each with and without deferred variable views.
// Restarts Entry.exe. Each scenario runs every mode `rounds` times in rotating order and checks that the final
// variables and list match across modes (and with boost off, that the tick count matches too).
//   node bench/run.js [--rounds 3] [--source]
import fs from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'
import { benchProject, BLOCKS_PER_BODY, ENTRY_TEST } from './projects.js'

const require = createRequire(import.meta.url)
const { EntryLive } = require(`${ENTRY_TEST}/src/live`)

const args = process.argv.slice(2)
const flag = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const ROUNDS = Number(flag('--rounds', 3))
const TURBO_SRC = fs.readFileSync(new URL('../src/turbo.js', import.meta.url), 'utf8')

const MODES = {
  'entry': 'EntryTurbo.disable()',
  'entry+모으기': 'EntryTurbo.enable({ compile: false })',
  'turbo': 'EntryTurbo.enable({ deferViews: false })',
  'turbo+모으기': 'EntryTurbo.enable()',
}
const SCENARIOS = [
  { name: '반복 (부스트)', unroll: 1, boost: true, n: 100000 },
  { name: '한 틱 무거움 (부스트 끔)', unroll: 50, boost: false, n: 60 },
  { name: '양보 위치 (부스트 끔)', unroll: 1, boost: false, n: 90 },
]

// counts ticks and the time spent inside Code.tick until 완료 becomes 1
const INSTRUMENT = `(() => {
  if (Entry.Code.prototype.__bench) return true
  const orig = Entry.Code.prototype.tick
  Entry.Code.prototype.tick = function () {
    const b = window.__bench
    const t = performance.now()
    const r = orig.call(this)
    if (b && !b.doneTick) {
      b.ticks++
      b.tickMs += performance.now() - t
      if (String(b.done.getValue()) === '1') { b.doneTick = b.ticks; b.doneMs = performance.now() - b.t0 }
    }
    return r
  }
  Entry.Code.prototype.__bench = true
  return true
})()`

const RUN = `async ({ boost, n }) => {
  const V = (name) => Entry.variableContainer.variables_.find((v) => v.name_ === name)
  const L = Entry.variableContainer.lists_.find((l) => l.name_ === 'L')
  V('N').setValue(n)
  Entry.isTurbo = boost
  const b = window.__bench = { ticks: 0, tickMs: 0, doneTick: 0, doneMs: 0, done: V('완료'), t0: performance.now() }
  Entry.engine.toggleRun()
  const limit = performance.now() + 120000
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      if (b.doneTick || Entry.engine.state !== 'run' || performance.now() > limit) { clearInterval(iv); resolve() }
    }, 5)
  })
  const out = {
    ms: b.doneMs, ticks: b.doneTick, tickMs: b.tickMs, stopped: !b.doneTick,
    state: [V('합').getValue(), V('i').getValue(), V('t').getValue(), L.getArray().map((x) => x.data).join(',')].join('|'),
    stats: window.EntryTurbo && EntryTurbo.enabled ? JSON.parse(JSON.stringify(EntryTurbo.stats)) : null,
  }
  if (Entry.engine.state === 'run') Entry.engine.toggleStop()
  window.__bench = null
  return out
}`

function hash(s) {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return h.toString(16).padStart(8, '0')
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

async function measure() {
  const live = await EntryLive.launch({ fresh: true })
  const results = []
  for (const sc of SCENARIOS) {
    await live.loadProject(benchProject({ unroll: sc.unroll }))
    await live.eval(TURBO_SRC)
    await live.eval(INSTRUMENT)
    if (args.includes('--source') && sc === SCENARIOS[0]) {
      const src = await live.eval(`EntryTurbo.source(Entry.container.getAllObjects()[0].script.getThreads().map((t) => t.getFirstBlock()).find((b) => b && b.type === 'when_run_button_click'))`)
      console.log(src)
    }
    const names = Object.keys(MODES)
    for (let r = 0; r < ROUNDS; r++) {
      for (let j = 0; j < names.length; j++) {
        const mode = names[(j + r) % names.length]
        await live.eval(MODES[mode])
        const out = await live.eval(`(${RUN})(${JSON.stringify({ boost: sc.boost, n: sc.n })})`)
        results.push({ scenario: sc.name, mode, ...out, state: hash(out.state) })
        console.log(`${sc.name} ${mode.padEnd(12)} ${out.ms.toFixed(0).padStart(6)}ms  틱 ${String(out.ticks).padStart(5)}  틱 안 ${out.tickMs.toFixed(0).padStart(6)}ms  상태 ${hash(out.state)}${out.stopped ? '  (끝나지 않음)' : ''}${out.stats ? `  컴파일 ${out.stats.compiled}/${out.stats.fallback} ${JSON.stringify(out.stats.reasons)}` : ''}`)
        await live.settle(300)
      }
    }
  }
  await live.eval('EntryTurbo.disable()')
  live.conn.close()
  return results
}

function report(results) {
  console.log(`\n본문 한 번 = 블록 ${BLOCKS_PER_BODY}개`)
  for (const sc of SCENARIOS) {
    const rows = results.filter(x => x.scenario === sc.name)
    const states = new Set(rows.map(x => x.state))
    const ticks = new Set(rows.map(x => x.ticks))
    const base = median(rows.filter(x => x.mode === 'entry').map(x => (sc.boost ? x.ms : x.tickMs)))
    const iters = sc.n * sc.unroll
    console.log(`\n## ${sc.name} — 본문 ${iters.toLocaleString()}회, ${sc.boost ? '끝날 때까지 시간' : '틱 안에서 쓴 시간'}(중앙값)`)
    for (const mode of Object.keys(MODES)) {
      const v = median(rows.filter(x => x.mode === mode).map(x => (sc.boost ? x.ms : x.tickMs)))
      const perBlock = (v * 1000) / (iters * BLOCKS_PER_BODY)
      console.log(`${mode.padEnd(12)} ${v.toFixed(0).padStart(6)}ms  블록당 ${perBlock.toFixed(3)}µs  ×${(base / v).toFixed(1)}`)
    }
    console.log(`결과 일치: ${states.size === 1 ? 'PASS' : `FAIL (${[...states].join(', ')})`}${sc.boost ? '' : `  틱 수 일치: ${ticks.size === 1 ? 'PASS' : `FAIL (${[...ticks].join(', ')})`}`}`)
  }
}

measure().then((results) => {
  report(results)
  process.exit(0)
}, (e) => {
  console.error(e)
  process.exit(1)
})
