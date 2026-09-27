// User functions through turbo: run bench/func-projects.js in the offline editor with Entry's executor and with turbo
// (boost off), and compare every variable, list and local-variable template in the tick 완료 becomes 1, and that tick.
// Before the runs it checks that Entry loaded the functions as built (paramMap, localVariables, call schemas, and the
// project JSON coming back unchanged from Entry.exportProject), and after them that Entry's own runs give the values
// ref/functions-spec.md predicts. Restarts Entry.exe.
//   node bench/func-check.js [--rounds 2] [--skip h17,h2] [--only h1,h18] [--turbo other/turbo.js] [--show]
// --turbo runs another copy of turbo.js (e.g. dist/src/turbo.js, the last build); --show prints Entry's final lists.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { CASE_NAMES, functionsTest } from './func-projects.js'
import { ENTRY_TEST } from './projects.js'

const require = createRequire(import.meta.url)
const { EntryLive } = require(`${ENTRY_TEST}/src/live`)
const args = process.argv.slice(2)
const flag = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const ROUNDS = Number(flag('--rounds', 2))
const only = flag('--only', '').split(',').filter(Boolean)
const skip = flag('--skip', '').split(',').filter(Boolean)
const TURBO_SRC = fs.readFileSync(args.includes('--turbo') ? path.resolve(flag('--turbo')) : new URL('../src/turbo.js', import.meta.url), 'utf8')

for (const name of [...only, ...skip]) {
  if (!CASE_NAMES.includes(name))
    throw new Error(`없는 케이스: ${name} (있는 것: ${CASE_NAMES.join(', ')})`)
}
const test = functionsTest({ cases: CASE_NAMES.filter(n => (!only.length || only.includes(n)) && !skip.includes(n)) })

// how Entry built each function: paramMap, template, call schema, definition
const STRUCTURE = `(() => {
  const vc = Entry.variableContainer
  return Object.fromEntries(Object.values(vc.functions_).map((f) => {
    const call = Entry.block['func_' + f.id]
    const base = ['function_general', 'function_value'].find((t) => call && Object.getPrototypeOf(call) === Entry.block[t]) || null
    const def = f.content.getEventMap('funcDef')[0]
    return [f.id, {
      type: f.type, paramMap: { ...f.paramMap }, localVariables: JSON.parse(JSON.stringify(f.localVariables)),
      base, callParams: call ? call.params.map((p) => p.type) : null, def: def ? def.type : null,
    }]
  }))
})()`

// counts ticks (Code.tick, one object = one per engine tick) and keeps the state after each until 완료 = 1; records
// runtime errors (Entry's and turbo's both end in stopProjectWithToast). Installed after src/turbo.js, like bench/run.js.
const INSTRUMENT = `(() => {
  if (Entry.Code.prototype.__funcCheck) return true
  const snapshot = () => {
    const vc = Entry.variableContainer
    return {
      variables: Object.fromEntries(vc.variables_.map((v) => [v.name_, v.getValue()])),
      lists: Object.fromEntries(vc.lists_.map((l) => [l.name_, l.getArray().map((x) => x.data)])),
      templates: Object.fromEntries(Object.values(vc.functions_).map((f) => [f.id, (f.localVariables || []).map((v) => v.value)])),
    }
  }
  const tick = Entry.Code.prototype.tick
  Entry.Code.prototype.tick = function () {
    const r = tick.call(this)
    const fc = window.__funcCheck
    if (fc && !fc.doneTick) {
      fc.ticks++
      fc.state = snapshot()
      if (String(fc.state.variables['완료']) === '1') fc.doneTick = fc.ticks
    }
    return r
  }
  const stop = Entry.Utils.stopProjectWithToast
  Entry.Utils.stopProjectWithToast = function (scope, type, e) {
    const fc = window.__funcCheck
    if (fc) fc.errors.push((scope && scope.block ? scope.block.type : '?') + ': ' + (e && e.message))
    return stop.apply(this, arguments)
  }
  Entry.Code.prototype.__funcCheck = true
  return true
})()`

const RUN = `async () => {
  const fc = window.__funcCheck = { ticks: 0, doneTick: 0, state: null, errors: [] }
  Entry.isTurbo = false
  Entry.engine.toggleRun()
  const until = (test, ms) => new Promise((resolve) => {
    const limit = performance.now() + ms
    const iv = setInterval(() => { if (test() || performance.now() > limit) { clearInterval(iv); resolve() } }, 5)
  })
  await until(() => fc.doneTick || Entry.engine.state !== 'run', 30000)
  window.__funcCheck = null
  const out = {
    ticks: fc.doneTick || fc.ticks, done: !!fc.doneTick, engine: Entry.engine.state, state: fc.state, errors: fc.errors,
    stats: window.EntryTurbo && EntryTurbo.compiling ? JSON.parse(JSON.stringify(EntryTurbo.stats)) : null,
  }
  if (Entry.engine.state === 'run') Entry.engine.toggleStop()
  await until(() => Entry.engine.state === 'stop', 5000)
  return out
}`

// which case scripts turbo compiles (EntryTurbo.source gives "// not compiled: <reason>" otherwise)
const COMPILED = `(() => {
  if (typeof EntryTurbo.source !== 'function') return null
  EntryTurbo.enable()
  const hats = Entry.container.getAllObjects()[0].script.getThreads().map((t) => t.getFirstBlock())
  const out = hats.map((h) => { const s = EntryTurbo.source(h); return s.startsWith('// not compiled') ? s.slice(3) : 'compiled' })
  EntryTurbo.disable()
  return out
})()`

// a block tree without ids, positions and flags: type and params (literals as they are), statements
function shape(b) {
  if (!b || typeof b !== 'object')
    return b === undefined ? null : b
  return { type: b.type, params: (b.params || []).map(shape), statements: (b.statements || []).map(s => s.map(shape)) }
}
// a param Entry fills in (a trailing Indicator the DSL leaves out) comes back as null: missing = null
function firstDiff(a, b, at = '') {
  if ((a ?? null) === null && (b ?? null) === null)
    return null
  if (JSON.stringify(a) === JSON.stringify(b))
    return null
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], `${at}.${k}`)
      if (d)
        return d
    }
    return null
  }
  return `${at || '.'}: 넣은 것 ${JSON.stringify(a)} / 나온 것 ${JSON.stringify(b)}`
}

function checkStructure(live, exported) {
  const problems = []
  for (const f of test.functions) {
    const got = live[f.id]
    if (!got) {
      problems.push(`${f.name}: 로드되지 않음`)
      continue
    }
    const want = {
      type: f.type,
      paramMap: f.paramMap,
      localVariables: f.localVariables,
      base: f.type === 'value' ? 'function_value' : 'function_general',
      callParams: [...Array.from({ length: f.params }).fill('Block'), ...(f.type === 'value' ? [] : ['Indicator'])],
      def: f.type === 'value' ? 'function_create_value' : 'function_create',
    }
    const d = firstDiff(want, got)
    if (d)
      problems.push(`${f.name}${d}`)
  }
  // the JSON as Entry writes it back: same functions, same block trees
  const sent = test.project
  for (const f of sent.functions) {
    const back = exported.functions.find(g => g.id === f.id)
    const name = test.functions.find(g => g.id === f.id).name
    if (!back) {
      problems.push(`${name}: 내보내기에 없음`)
      continue
    }
    const d = firstDiff(
      { type: f.type, localVariables: f.localVariables, useLocalVariables: f.useLocalVariables, content: JSON.parse(f.content).map(s => s.map(shape)) },
      { type: back.type, localVariables: back.localVariables, useLocalVariables: back.useLocalVariables, content: JSON.parse(back.content).map(s => s.map(shape)) },
    )
    if (d)
      problems.push(`${name} 내보내기${d}`)
  }
  const script = exported.objects[0].script
  const d = firstDiff(JSON.parse(sent.objects[0].script).map(s => s.map(shape)), (typeof script === 'string' ? JSON.parse(script) : script).map(s => s.map(shape)))
  if (d)
    problems.push(`스크립트 내보내기${d}`)
  return problems
}

// every key of the final state, flattened: variables.x, lists.x, templates.<function name>
function flatten(state) {
  const names = Object.fromEntries(test.functions.map(f => [f.id, f.name]))
  const out = {}
  if (!state)
    return out
  for (const [k, v] of Object.entries(state.variables)) out[`변수 ${k}`] = v
  for (const [k, v] of Object.entries(state.lists)) out[`리스트 ${k}`] = v
  for (const [k, v] of Object.entries(state.templates)) out[`지역변수 틀 ${names[k] || k}`] = v
  return out
}

// the expected values are compared as text for variables (Entry may keep a number or a string) and exactly otherwise
function specDiffs(state) {
  const got = flatten(state)
  const want = flatten(test.expected)
  const out = []
  for (const [k, v] of Object.entries(want)) {
    const same = k.startsWith('변수 ') ? String(got[k]) === String(v) : JSON.stringify(got[k]) === JSON.stringify(v)
    if (!same)
      out.push(`  ${k}: 예상 ${JSON.stringify(v)} / 엔트리 ${JSON.stringify(got[k])}`)
  }
  return out
}

async function main() {
  const live = await EntryLive.launch({ fresh: true })
  await live.loadProject(test.project)
  const structure = await live.eval(STRUCTURE)
  const exported = await live.exportProject()
  const problems = checkStructure(structure, exported)
  console.log(`케이스 ${test.scripts.slice(1, -1).join(' ')} · 함수 ${test.functions.length}개`)
  console.log(`구조 (paramMap·지역변수·호출 스키마·내보내기): ${problems.length ? `FAIL\n  ${problems.join('\n  ')}` : 'PASS'}`)

  await live.eval(TURBO_SRC)
  await live.eval(INSTRUMENT)
  const runs = []
  for (let r = 0; r < ROUNDS; r++) {
    for (const mode of r % 2 ? ['turbo', 'entry'] : ['entry', 'turbo']) {
      await live.eval(mode === 'turbo' ? 'EntryTurbo.enable()' : 'EntryTurbo.disable()')
      const out = await live.eval(`(${RUN})()`)
      runs.push({ mode, ...out })
      const s = out.stats
      console.log(`${mode.padEnd(5)} 틱 ${String(out.ticks).padStart(3)}${out.done ? '' : `  (완료 안 됨, 엔진 ${out.engine})`}${out.errors.length ? `  오류 ${JSON.stringify(out.errors)}` : ''}`
        + `${s ? `\n      스크립트 컴파일 ${s.compiled}/대체 ${s.fallback} · 함수 ${s.functions} (생성기 ${s.generators}) · 함수 대체 실행 ${s.functionFallback} · ${JSON.stringify(s.reasons)}` : ''}`)
      await live.settle(300)
    }
  }
  const compiled = await live.eval(COMPILED)
  live.conn.close()
  if (compiled)
    console.log(`\nturbo 가 컴파일하는 스크립트:\n${test.scripts.map((n, i) => `  ${n.padEnd(6)} ${compiled[i]}`).join('\n')}`)

  const states = new Set(runs.map(x => JSON.stringify(x.state)))
  const ticks = new Set(runs.map(x => x.ticks))
  const allDone = runs.every(x => x.done && !x.errors.length)
  // keys whose value differs between runs, with each run's value
  if (states.size > 1) {
    const flat = runs.map(x => flatten(x.state))
    const keys = [...new Set(flat.flatMap(f => Object.keys(f)))]
    console.log('\n다른 값:')
    for (const k of keys) {
      const vals = flat.map(f => JSON.stringify(f[k]))
      if (new Set(vals).size > 1)
        console.log(`  ${k}\n${runs.map((x, i) => `    ${x.mode} ${vals[i]}`).join('\n')}`)
    }
  }
  const entry = runs.find(x => x.mode === 'entry')
  if (args.includes('--show') && entry.state)
    console.log(`\n엔트리 최종 상태:\n${Object.entries(flatten(entry.state)).map(([k, v]) => `  ${k} ${JSON.stringify(v)}`).join('\n')}`)
  const spec = [...specDiffs(entry.state), ...(entry.ticks === test.expected.ticks ? [] : [`  완료 틱: 예상 ${test.expected.ticks} / 엔트리 ${entry.ticks}`])]

  console.log('')
  console.log(`구조: ${problems.length ? 'FAIL' : 'PASS'}`)
  console.log(`엔트리 결과 = 명세 예상: ${spec.length ? `FAIL\n${spec.join('\n')}` : 'PASS'}`)
  console.log(`모든 실행이 오류 없이 완료: ${allDone ? 'PASS' : 'FAIL'}`)
  console.log(`최종 상태 일치: ${states.size === 1 ? 'PASS' : `FAIL (${states.size}가지)`}`)
  console.log(`틱 수 일치: ${ticks.size === 1 ? 'PASS' : `FAIL (${[...ticks].join(', ')})`}`)
  const ok = !problems.length && !spec.length && allDone && states.size === 1 && ticks.size === 1
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
