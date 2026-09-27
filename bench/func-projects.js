// Test project for user functions: parameters, local variables, value-returning functions, recursion, nested calls.
// Built with the block DSL from entry-test (omok/dsl.js). One text-box object, no assets.
// Every case is its own `when_run_button_click` script with its own variables and log list: a script the compiler
// refuses runs on Entry's executor without taking the other cases with it, and a mismatch points at one behaviour.
// A clock script (first thread) counts ticks, so each log line carries the tick it was written in (`...@3`).
// The expected values follow ref/functions-spec.md (§ and H numbers there); ticks count from 1.
import { createRequire } from 'node:module'
import { benchProject, ENTRY_TEST } from './projects.js'

const require = createRequire(import.meta.url)
const D = require(`${ENTRY_TEST}/omok/dsl.js`)
const Blocks = require(`${ENTRY_TEST}/src/blocks.js`)

const mk = (type, params = [], statements = []) => Blocks.block(type, params, statements)
// nested "join": J(a, b, c) = a + (b + c)
const J = (...parts) => (parts.length === 1 ? D.wrap(parts[0]) : D.JOIN(parts[0], J(...parts.slice(1))))
// append "parts@tick" to a log list
const LOG = (list, ...parts) => D.PUSH(list, J(...parts, '@', D.V('틱')))
const FALSE = () => mk('False', [null])
const STOP_REPEAT = () => mk('stop_repeat', [null])
const CONTINUE_REPEAT = () => mk('continue_repeat', [null])

// A user function as Entry stores it (class/function.js generateWsBlock, block_func.js):
// - definition `function_create` (params [field chain, Indicator]) or `function_create_value` (params [field chain,
//   Indicator, LineBreak, VALUE]); the field chain is function_field_label -> function_field_string / _boolean linked
//   through params[1], each parameter field holding its read block `stringParam_<hash>` / `booleanParam_<hash>`
// - paramMap[<read block type>] = position among the parameter fields
// - call `func_<id>`: params = the argument blocks, plus a trailing null (the Indicator) for a normal function
// - localVariables [{ name, value, id: '<funcId>_<hash>' }], read/written by get_func_variable / set_func_variable
function fn(name, { type = 'normal', params = [], locals = [] } = {}) {
  const id = D.reg.id('func', name)
  const paramType = Object.fromEntries(params.map(([p, kind], i) => [p, `${kind}Param_${id}${i}`]))
  const localId = Object.fromEntries(locals.map(([l], i) => [l, `${id}_l${i}`]))
  const f = {
    id,
    name,
    type,
    params,
    paramMap: Object.fromEntries(params.map(([p], i) => [paramType[p], i])),
    localVariables: locals.map(([l, value]) => ({ name: l, value, id: localId[l] })),
    body: [],
    value: null,
    arg: p => mk(paramType[p], []),
    get: l => mk('get_func_variable', [localId[l], null]),
    set: (l, v) => mk('set_func_variable', [localId[l], D.wrap(v), null]),
    call: (...args) => mk(`func_${id}`, type === 'value' ? args.map(D.wrap) : [...args.map(D.wrap), null]),
  }
  f.definition = () => {
    let chain = null
    for (let i = params.length - 1; i >= 0; i--) {
      const [p, kind] = params[i]
      chain = mk(`function_field_${kind}`, [mk(paramType[p], []), chain])
    }
    const label = mk('function_field_label', [name, chain])
    label.copyable = false
    const create = type === 'value'
      ? Blocks.hatBlock('function_create_value', [label, null, null, D.wrap(f.value)], 50, 30)
      : Blocks.hatBlock('function_create', [label, null], 50, 30)
    create.statements = [f.body]
    create.deletable = false
    create.copyable = false
    return create
  }
  return f
}

// Each case: build() -> { functions, stack } (fresh blocks), its variables and lists, and what Entry should leave
// there when 완료 = 1: vars / lists / templates (local-variable templates by function name, never written, H17), and
// `ends`, the tick in which the case's script finishes.
const CASES = [
  {
    // §2, §3, H1: arguments are evaluated again on every resume (h1_cnt goes up each tick) but the callee keeps the
    // first values; a boolean parameter holds whatever the argument returned (true, the text "0"); locals start from
    // the template (B = 5) in each call
    name: 'h1',
    vars: ['h1_cnt'],
    build() {
      const next = fn('h1_다음', { type: 'value' })
      next.body = [D.ADD('h1_cnt', 1)]
      next.value = D.V('h1_cnt')
      const f = fn('h1_F', { params: [['s', 'string'], ['b', 'boolean']], locals: [['A', 0], ['B', 5]] })
      f.body = [
        f.set('A', f.arg('s')),
        f.set('B', D.PLUS(f.get('B'), 1)),
        D.REPEAT(3, [
          LOG('h1', 'F ', f.arg('s'), ',', f.arg('b'), ',', f.get('A'), ',', f.get('B')),
          f.set('B', D.PLUS(f.get('B'), 1)),
        ]),
        D.IFELSE(f.arg('b'), [LOG('h1', '참 ', f.arg('s'))], [LOG('h1', '거짓 ', f.arg('s'))]),
      ]
      const stack = [
        LOG('h1', '시작'),
        f.call(J('a', next.call()), D.LT(D.V('h1_cnt'), 2)),
        LOG('h1', '중간'),
        f.call(D.TXT('b'), D.NUM(0)),
        LOG('h1', '끝'),
      ]
      return { functions: [next, f], stack }
    },
    expect: {
      vars: { h1_cnt: 4 },
      lists: { h1: ['시작@1', 'F a1,true,a1,6@1', 'F a1,true,a1,7@2', 'F a1,true,a1,8@3', '참 a1@4', '중간@4', 'F b,0,b,6@4', 'F b,0,b,7@5', 'F b,0,b,8@6', '거짓 b@7', '끝@7'] },
      templates: { h1_다음: [], h1_F: [0, 5] },
      ends: 7,
    },
  },
  {
    // H18: G1(q) -> G2(r), both yield. On each resume the outer call's arguments are evaluated first (o..), then the
    // inner call's (i..); once G2 is done only the outer ones. A parameter read in a nested call's arguments is the
    // caller's (r = q + "-" + ...). The value function 기록 with a parameter logs each evaluation.
    name: 'h18',
    vars: ['h18_cnt'],
    build() {
      const rec = fn('h18_기록', { type: 'value', params: [['tag', 'string']] })
      rec.body = [D.ADD('h18_cnt', 1), D.PUSH('h18', J(rec.arg('tag'), D.V('h18_cnt')))]
      rec.value = D.V('h18_cnt')
      const g2 = fn('h18_G2', { params: [['r', 'string']] })
      g2.body = [D.REPEAT(2, [LOG('h18', 'G2 r=', g2.arg('r'))]), LOG('h18', 'G2 끝')]
      const g1 = fn('h18_G1', { params: [['q', 'string']] })
      g1.body = [
        LOG('h18', 'G1 q=', g1.arg('q')),
        g2.call(J(g1.arg('q'), '-', rec.call('i'))),
        D.REPEAT(1, [LOG('h18', 'G1 반복 q=', g1.arg('q'))]),
        LOG('h18', 'G1 끝'),
      ]
      const stack = [g1.call(rec.call('o')), LOG('h18', 'B 끝')]
      return { functions: [rec, g2, g1], stack }
    },
    expect: {
      vars: { h18_cnt: 7 },
      lists: { h18: ['o1', 'G1 q=1@1', 'i2', 'G2 r=1-2@1', 'o3', 'i4', 'G2 r=1-2@2', 'o5', 'i6', 'G2 끝@3', 'G1 반복 q=1@3', 'o7', 'G1 끝@4', 'B 끝@4'] },
      templates: { h18_기록: [], h18_G2: [], h18_G1: [] },
      ends: 4,
    },
  },
  {
    // H10: recursive value function with a parameter and per-call locals, inside arithmetic: 10 + sum(5) * 2.
    // acc is read after the recursive call (shared locals would give another sum); depth starts at the template (100)
    // in every call; VALUE is evaluated after the body.
    name: 'h10',
    vars: ['h10_합'],
    build() {
      const sum = fn('h10_합계', { type: 'value', params: [['n', 'string']], locals: [['acc', 0], ['depth', 100]] })
      sum.body = [
        sum.set('acc', sum.arg('n')),
        sum.set('depth', D.PLUS(sum.get('depth'), sum.arg('n'))),
        D.PUSH('h10', J(sum.arg('n'), ',', sum.get('depth'))),
        D.IF(D.GT(sum.arg('n'), 0), [sum.set('acc', D.PLUS(sum.call(D.MINUS(sum.arg('n'), 1)), sum.get('acc')))]),
      ]
      sum.value = sum.get('acc')
      const stack = [D.SET('h10_합', D.PLUS(10, D.MUL(sum.call(5), 2))), LOG('h10', '합 ', D.V('h10_합'))]
      return { functions: [sum], stack }
    },
    expect: {
      vars: { h10_합: 40 },
      lists: { h10: ['5,105', '4,104', '3,103', '2,102', '1,101', '0,100', '합 40@1'] },
      templates: { h10_합계: [0, 100] },
      ends: 1,
    },
  },
  {
    // §6 + §2: a recursive normal function that yields (a call cycle of generators). Every level keeps its own
    // parameter and local (m) across the yields, and on each resume every level still inside a call evaluates that
    // call's arguments again (rec_cnt: 2 at the first tick, then 2, then 1)
    name: 'rec',
    vars: ['rec_cnt'],
    build() {
      const one = fn('rec_하나', { type: 'value' })
      one.body = [D.ADD('rec_cnt', 1)]
      one.value = D.NUM(1)
      const down = fn('rec_내려가기', { params: [['n', 'string']], locals: [['m', 0]] })
      down.body = [
        down.set('m', down.arg('n')),
        LOG('rec', '들어감 ', down.arg('n')),
        D.IF(D.GT(down.arg('n'), 0), [down.call(D.MINUS(down.arg('n'), one.call()))]),
        D.REPEAT(1, [LOG('rec', '나옴 ', down.get('m'))]),
      ]
      const stack = [down.call(2), LOG('rec', '끝')]
      return { functions: [one, down], stack }
    },
    expect: {
      vars: { rec_cnt: 5 },
      lists: { rec: ['들어감 2@1', '들어감 1@1', '들어감 0@1', '나옴 0@1', '나옴 1@2', '나옴 2@3', '끝@4'] },
      templates: { rec_하나: [], rec_내려가기: [0] },
      ends: 4,
    },
  },
  {
    // §4, H4, H12: a local set to '' or false reads as 0, an unset local reads its template (7); a local of another
    // function reads 0 and another function's parameter block reads undefined (not in this function's paramMap)
    name: 'h4',
    vars: ['h4_cnt'],
    build() {
      const zero = fn('h4_영', { type: 'value', params: [['p', 'string']], locals: [['A', 7], ['B', 7], ['C', 7]] })
      zero.body = [zero.set('A', zero.arg('p')), zero.set('B', FALSE())]
      zero.value = J(zero.get('A'), '/', zero.get('B'), '/', zero.get('C'))
      const other = fn('h4_남의', { type: 'value' })
      other.body = [D.ADD('h4_cnt', 1)]
      other.value = J(zero.get('A'), '/', zero.arg('p'))
      const stack = [
        D.PUSH('h4', zero.call(D.TXT(''))),
        D.PUSH('h4', zero.call(5)),
        D.PUSH('h4', other.call()),
        LOG('h4', 'D 끝'),
      ]
      return { functions: [zero, other], stack }
    },
    expect: {
      vars: { h4_cnt: 1 },
      lists: { h4: ['0/0/7', '5/0/7', '0/undefined', 'D 끝@1'] },
      templates: { h4_영: [7, 7, 7], h4_남의: [] },
      ends: 1,
    },
  },
  {
    // H14: a value function whose body has `repeat 0` never reaches a loop end, so it is synchronous
    name: 'h14',
    vars: ['h14_값'],
    build() {
      const f = fn('h14_반복0', { type: 'value', params: [['p', 'string']], locals: [['L', 0]] })
      f.body = [D.REPEAT(0, [f.set('L', 99)]), f.set('L', D.MUL(f.arg('p'), 2))]
      f.value = f.get('L')
      const stack = [LOG('h14', '전'), D.SET('h14_값', f.call(3)), LOG('h14', '후 ', D.V('h14_값'))]
      return { functions: [f], stack }
    },
    expect: {
      vars: { h14_값: 6 },
      lists: { h14: ['전@1', '후 6@1'] },
      templates: { h14_반복0: [0] },
      ends: 1,
    },
  },
  {
    // H15: a value call as a repeat count is evaluated at every re-entry of the loop: 3 times for 2 iterations
    name: 'h15',
    vars: ['h15_cnt'],
    build() {
      const count = fn('h15_횟수', { type: 'value' })
      count.body = [D.ADD('h15_cnt', 1)]
      count.value = D.NUM(2)
      const stack = [D.REPEAT(count.call(), [LOG('h15', 'F 반복')]), LOG('h15', 'F 끝 ', D.V('h15_cnt'))]
      return { functions: [count], stack }
    },
    expect: {
      vars: { h15_cnt: 3 },
      lists: { h15: ['F 반복@1', 'F 반복@2', 'F 끝 3@3'] },
      templates: { h15_횟수: [] },
      ends: 3,
    },
  },
  {
    // H19 (boost off): a yielding call in a top-level loop. The callee finishes on the tick after it starts, then the
    // loop end yields, so each iteration takes two ticks; each iteration's call is a new call (new arguments)
    name: 'h19',
    vars: [],
    build() {
      const once = fn('h19_한번', { params: [['k', 'string']] })
      once.body = [D.REPEAT(1, [LOG('h19', 'G 안 ', once.arg('k'))])]
      const stack = [D.REPEAT(2, [once.call(J('k', D.V('틱')))]), LOG('h19', 'G 끝')]
      return { functions: [once], stack }
    },
    expect: {
      vars: {},
      lists: { h19: ['G 안 k1@1', 'G 안 k3@3', 'G 끝@5'] },
      templates: { h19_한번: [] },
      ends: 5,
    },
  },
  {
    // H11: an empty normal function yields once. H2: stop_repeat outside any loop (inside an if) returns from the
    // function at once. H3: continue_repeat outside any loop yields once, then returns (the rest never runs)
    name: 'h2',
    vars: [],
    build() {
      const empty = fn('h2_빈함수')
      const stop = fn('h2_멈춤')
      stop.body = [LOG('h2', 'a'), D.IF(D.EQ(1, 1), [STOP_REPEAT()]), LOG('h2', 'b')]
      const cont = fn('h2_계속')
      cont.body = [LOG('h2', 'c'), D.IF(D.EQ(1, 1), [CONTINUE_REPEAT()]), LOG('h2', 'd')]
      const stack = [
        LOG('h2', 'H 전'),
        empty.call(),
        LOG('h2', 'H 빈 뒤'),
        stop.call(),
        LOG('h2', 'H 멈춤 뒤'),
        cont.call(),
        LOG('h2', 'H 계속 뒤'),
      ]
      return { functions: [empty, stop, cont], stack }
    },
    expect: {
      vars: {},
      lists: { h2: ['H 전@1', 'H 빈 뒤@2', 'a@2', 'H 멈춤 뒤@2', 'c@2', 'H 계속 뒤@3'] },
      templates: { h2_빈함수: [], h2_멈춤: [], h2_계속: [] },
      ends: 3,
    },
  },
  {
    // H17 and §9.9: a function without parameters that writes a local. Two calls, each starts from the template (0),
    // the template is not written. (turbo's old fallback gave such a function no locals: set_func_variable threw.)
    name: 'h17',
    vars: [],
    build() {
      const twice = fn('h17_두번', { locals: [['K', 0]] })
      twice.body = [twice.set('K', D.PLUS(twice.get('K'), 1)), LOG('h17', 'K=', twice.get('K'))]
      const stack = [twice.call(), twice.call(), LOG('h17', 'I 끝')]
      return { functions: [twice], stack }
    },
    expect: {
      vars: {},
      lists: { h17: ['K=1@1', 'K=1@1', 'I 끝@1'] },
      templates: { h17_두번: [0] },
      ends: 1,
    },
  },
]

export const CASE_NAMES = CASES.map(c => c.name)

// give every block an id of its own, the same on every build
function renumber(stacksList) {
  let n = 0
  for (const stacks of stacksList)
    Blocks.walk(stacks, (b) => { b.id = `b${(n++).toString(36).padStart(3, '0')}` })
}

// The project plus what the checker needs: the function list (id, name, type, paramMap, localVariables), the case
// order of the scripts (after the clock), and the expected final state from ref/functions-spec.md.
export function functionsTest({ cases = CASE_NAMES } = {}) {
  const chosen = CASES.filter(c => cases.includes(c.name))
  const functions = []
  const stacks = [[D.HAT_RUN(50, 30), D.SET('틱', 0), D.FOREVER([D.ADD('틱', 1)])]]
  chosen.forEach((c, i) => {
    const built = c.build()
    functions.push(...built.functions)
    stacks.push([D.HAT_RUN(50 + 300 * ((i + 1) % 4), 30 + 400 * Math.floor((i + 1) / 4)), ...built.stack, D.ADD('끝난수', 1)])
  })
  // 완료 = 1 in the tick the last case finishes (this is the last thread)
  stacks.push([D.HAT_RUN(50, 30 + 400 * Math.ceil((chosen.length + 1) / 4)), D.WHILE(D.NE(D.V('끝난수'), chosen.length), [D.ADD('대기', 1)]), D.SET('완료', 1)])
  const definitions = functions.map(f => [[f.definition()]])
  renumber([stacks, ...definitions])

  const p = benchProject()
  p.name = 'turbo-functions'
  p.objects[0].script = D.script(...stacks)
  p.variables = [
    ...['완료', '틱', '끝난수', '대기', ...chosen.flatMap(c => c.vars)].map(n => D.variable(n)),
    ...chosen.map(c => D.list(c.name, [])),
  ]
  p.functions = functions.map((f, i) => ({
    id: f.id,
    type: f.type,
    localVariables: f.localVariables.map(v => ({ ...v })),
    useLocalVariables: f.localVariables.length > 0,
    content: JSON.stringify(definitions[i]),
  }))

  const last = Math.max(...chosen.map(c => c.expect.ends))
  const byName = Object.fromEntries(functions.map(f => [f.name, f.id]))
  const expected = {
    ticks: last,
    variables: { 완료: 1, 틱: last, 끝난수: chosen.length, 대기: last - 1, ...Object.assign({}, ...chosen.map(c => c.expect.vars)) },
    lists: Object.assign({}, ...chosen.map(c => c.expect.lists)),
    templates: Object.fromEntries(chosen.flatMap(c => Object.entries(c.expect.templates).map(([name, v]) => [byName[name], v]))),
  }
  return {
    project: p,
    functions: functions.map(f => ({ id: f.id, name: f.name, type: f.type, params: f.params.length, paramMap: f.paramMap, localVariables: f.localVariables })),
    scripts: ['clock', ...chosen.map(c => c.name), 'finish'],
    expected,
  }
}

export function functionsProject(opts) {
  return functionsTest(opts).project
}
