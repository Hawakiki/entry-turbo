// Where does turbo's time go? Micro-costs of Entry's variable / list writes, and the loop bench with the
// stage views switched off (upper bound for deferring view updates). Needs the editor from bench/run.js
// (connects, does not restart).  node bench/profile.js
import fs from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'
import { benchProject, ENTRY_TEST } from './projects.js'

const require = createRequire(import.meta.url)
const { EntryLive } = require(`${ENTRY_TEST}/src/live`)
const TURBO_SRC = fs.readFileSync(new URL('../src/turbo.js', import.meta.url), 'utf8')

const MICRO = `(() => {
  const V = Entry.variableContainer.variables_.find((v) => v.name_ === '합')
  const L = Entry.variableContainer.lists_.find((l) => l.name_ === 'L')
  const N = 100000
  const time = (fn) => { const t = performance.now(); for (let i = 0; i < N; i++) fn(i); return ((performance.now() - t) * 1000 / N).toFixed(3) }
  return {
    'value_ 대입': time((i) => { V.value_ = i }),
    'setValue': time((i) => V.setValue(i)),
    '변수 updateView': time(() => V.updateView()),
    'replaceValue': time((i) => L.replaceValue((i % 100) + 1, i)),
    '리스트 updateView': time(() => L.updateView()),
    'getArray()[k].data': time((i) => L.getArray()[i % 100].data),
    '숨김 변수 view_ 있음': Boolean(V.view_),
  }
})()`

const RUN = `async ({ n, noView }) => {
  const V = (name) => Entry.variableContainer.variables_.find((v) => v.name_ === name)
  const L = Entry.variableContainer.lists_.find((l) => l.name_ === 'L')
  const protos = [Entry.Variable.prototype, Object.getPrototypeOf(L)]
  const saved = protos.map((p) => Object.getOwnPropertyDescriptor(p, 'updateView'))
  if (noView) protos.forEach((p) => { p.updateView = function () {} })
  V('N').setValue(n)
  Entry.isTurbo = true
  const t0 = performance.now()
  Entry.engine.toggleRun()
  await new Promise((resolve) => { const iv = setInterval(() => { if (String(V('완료').getValue()) === '1' || Entry.engine.state !== 'run') { clearInterval(iv); resolve() } }, 1) })
  const ms = performance.now() - t0
  const state = [V('합').getValue(), V('i').getValue(), V('t').getValue(), L.getArray().map((x) => x.data).join(',')].join('|')
  if (Entry.engine.state === 'run') Entry.engine.toggleStop()
  protos.forEach((p, i) => { if (saved[i]) Object.defineProperty(p, 'updateView', saved[i]); else delete p.updateView })
  return { ms, state: state.length + ':' + state.slice(0, 40) }
}`

async function main() {
  const live = await EntryLive.connect()
  await live.loadProject(benchProject({ unroll: 1 }))
  await live.eval(TURBO_SRC)
  console.log('호출 하나 µs (10만 번 평균):', await live.eval(MICRO))
  const n = 30000
  for (const [label, mode, noView] of [['entry', 'EntryTurbo.disable()', false], ['turbo', 'EntryTurbo.enable()', false], ['turbo, 화면 갱신 끔', 'EntryTurbo.enable()', true], ['entry, 화면 갱신 끔', 'EntryTurbo.disable()', true]]) {
    await live.eval(mode)
    const out = await live.eval(`(${RUN})(${JSON.stringify({ n, noView })})`)
    console.log(`${label.padEnd(16)} ${out.ms.toFixed(0).padStart(6)}ms  반복당 ${(out.ms * 1000 / n).toFixed(1)}µs  ${out.state}`)
    await live.settle(300)
  }
  await live.eval('EntryTurbo.disable()')
  live.conn.close()
}

main().then(() => process.exit(0), (e) => {
  console.error(e)
  process.exit(1)
})
