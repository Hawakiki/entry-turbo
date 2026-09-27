/* global Entry, Lang, BigNumber */
// Entry turbo (prototype). Compiles each script's blocks into one JS generator and runs it in place of Entry's
// block-by-block interpreter (Entry.Executor.prototype.execute). The rules are copied from the editor's own
// Executor / Scope / block funcs (offline editor 2.1.35):
//   - yield exactly where Entry yields: the end of a loop iteration (and set executor.isLooped, which boost mode
//     uses to re-run the script in the same tick), an empty statement body, continue_repeat
//   - values go through the same conversions (getNumberValue, getBooleanValue, isNumber) and the same BigNumber
//     arithmetic; integer fast paths only where the result is provably the same
//   - blocks without an inline rule run their own func with a light scope ("tier 1")
// A script that uses any block outside the known set stays on Entry's executor, untouched.
// Separately, deferViews makes every variable write (compiled or not) update its stage view once per tick instead of
// on each write: Entry's Variable.setValue redraws the view even for a hidden variable (14 µs a call, measured).
// Loaded into the page as a classic script; exposes globalThis.EntryTurbo.
(() => {
  const previous = globalThis.EntryTurbo
  previous?.disable()

  const proto = Entry.Executor.prototype
  const originalExecute = previous ? previous.originalExecute : proto.execute
  const variableProto = Entry.Variable.prototype
  const originalSetValue = previous ? previous.originalSetValue : variableProto.setValue
  const filterReserved = p => Entry.Scope.prototype.filterReservedKeywords(p)
  const RESULT = Object.freeze({ promises: Object.freeze([]), blocks: Object.freeze([]) })
  const HATS = new Set(['when_run_button_click'])

  // blocks whose own func is safe to call with a light scope: synchronous, keeps no state on the scope, never yields
  const TIER1_VALUES = new Set(['number', 'text', 'True', 'False', 'get_variable', 'calc_basic', 'quotient_and_mod', 'calc_operation', 'boolean_basic_operator', 'boolean_and_or', 'boolean_not', 'value_of_index_from_list', 'length_of_list', 'combine_something'])
  const TIER1_STATEMENTS = new Set(['set_variable', 'change_variable', 'change_value_list_index', 'add_value_to_list'])
  // params that name a variable / list (field index), so the prelude can resolve and check them
  const VAR_FIELD = { get_variable: 0, set_variable: 0, change_variable: 0 }
  const LIST_FIELD = { value_of_index_from_list: 1, length_of_list: 1, change_value_list_index: 0, add_value_to_list: 1 }

  let cache = new WeakMap()
  const DEFAULTS = { compile: true, inline: true, deferViews: true }
  const options = { ...DEFAULTS }
  const stats = { compiled: 0, fallback: 0, started: 0, reasons: {} }

  class Unsupported extends Error {}

  // ── runtime: same rules as Entry.Scope, Entry.Utils and the block funcs ──
  // Entry.Utils.isNumber uses /^-?\d+\.?\d*$/; this accepts the same strings without the backtracking
  const NUMBER_RE = /^-?\d+(?:\.\d*)?$/
  const isNumber = v => typeof v === 'number' || (typeof v === 'string' && NUMBER_RE.test(v))
  // Scope.getNumberValue = parseFloat(v) || 0; for a number that is v itself except NaN and -0 (both become 0)
  const num = v => (typeof v === 'number' ? v || 0 : Number.parseFloat(v) || 0)
  // Scope.getBooleanValue
  const bool = (v) => {
    if (v === undefined)
      return false
    const n = Number(v)
    return Number.isNaN(n) ? true : n
  }
  const safe = Number.isSafeInteger

  // calc_basic. Integer fast paths: safe integer operands and a safe, non-zero result are exact in both
  // BigNumber and doubles (zero is left to BigNumber so the sign of zero cannot differ).
  function plus(a, b) {
    let l = num(a)
    let r = num(b)
    if (!isNumber(a))
      l = a
    if (!isNumber(b))
      r = b
    if (typeof l === 'number' && typeof r === 'number') {
      if (safe(l) && safe(r)) {
        const s = l + r
        if (s !== 0 && safe(s))
          return s
      }
      return new BigNumber(l).plus(r).toNumber()
    }
    return l + r
  }
  function minus(a, b) {
    const l = num(a)
    const r = num(b)
    if (safe(l) && safe(r)) {
      const s = l - r
      if (s !== 0 && safe(s))
        return s
    }
    return new BigNumber(l).minus(r).toNumber()
  }
  function times(a, b) {
    const l = num(a)
    const r = num(b)
    if (safe(l) && safe(r)) {
      const s = l * r
      if (s !== 0 && safe(s))
        return s
    }
    return new BigNumber(l).times(r).toNumber()
  }
  function divide(a, b) {
    const l = num(a)
    const r = num(b)
    if (safe(l) && safe(r) && r !== 0 && l % r === 0) {
      const q = l / r
      if (q !== 0 && safe(q))
        return q
    }
    return new BigNumber(l).dividedBy(r).toNumber()
  }
  // quotient_and_mod (plain doubles in Entry too)
  function quotient(a, b) {
    return Math.floor(num(a) / num(b))
  }
  function mod(a, b) {
    const l = num(a)
    const r = num(b)
    return l - r * Math.floor(l / r)
  }
  // boolean_basic_operator: non-empty numeric strings become numbers, then plain JS comparison
  const norm = (v) => {
    if (typeof v === 'string' && v.length) {
      const n = Number(v)
      if (!Number.isNaN(n))
        return n
    }
    return v
  }
  const eq = (a, b) => norm(a) === norm(b)
  // eslint-disable-next-line eqeqeq -- Entry's NOT_EQUAL is the loose !=
  const ne = (a, b) => norm(a) != norm(b)
  const gt = (a, b) => norm(a) > norm(b)
  const lt = (a, b) => norm(a) < norm(b)
  const ge = (a, b) => norm(a) >= norm(b)
  const le = (a, b) => norm(a) <= norm(b)
  const noCmp = () => undefined
  const CMP = { EQUAL: 'eq', NOT_EQUAL: 'ne', GREATER: 'gt', LESS: 'lt', GREATER_OR_EQUAL: 'ge', LESS_OR_EQUAL: 'le' }
  const and = (a, b) => Boolean(a) && Boolean(b)
  const or = (a, b) => Boolean(a) || Boolean(b)

  // value_of_index_from_list
  function item(list, index) {
    if (!isNumber(index))
      index = Entry.getListRealIndex(index, list)
    const array = list.getArray()
    if (!array || !isNumber(index) || index > array.length)
      throw new Error('can not insert value to array')
    return array[index - 1].data
  }
  // change_value_list_index (the list is known not to be real-time)
  function setItem(list, index, data) {
    const array = list.getArray()
    if (!array || !isNumber(index) || index > array.length)
      throw new Error('can not insert value to array')
    list.replaceValue(index, data)
  }
  // change_variable (the variable is known not to be real-time). The sum is stored as a toFixed string, like Entry.
  function change(variable, value) {
    if (value === false)
      throw new Error('Type is not correct')
    let current = variable.getValue()
    let sum
    if (isNumber(value) && variable.isNumber()) {
      value = Entry.parseNumber(value)
      current = Entry.parseNumber(current)
      const fixed = Entry.getMaxFloatPoint([value, variable.getValue()])
      sum = new BigNumber(value).plus(current).toNumber().toFixed(fixed)
    }
    else {
      sum = `${current}${value}`
    }
    variable.setValue(sum)
  }

  // tier 1: the block's own func with a scope that already holds the evaluated params
  function FastScope(block, schema, executor, values) {
    this.block = block
    this.type = block.type
    this._schema = schema
    this.executor = executor
    this.entity = executor.entity
    this.values = values
  }
  FastScope.prototype = Object.create(Entry.Scope.prototype)
  function call(block, schema, ex, values) {
    const scope = new FastScope(block, schema, ex, values)
    return schema.func.call(scope, ex.entity, scope)
  }
  function callStatement(block, schema, ex, values) {
    const r = call(block, schema, ex, values)
    if (r !== undefined && r !== null && r !== Entry.STATIC.PASS)
      throw new Error(`turbo: ${block.type} returned ${String(r)}`)
  }

  const R = {
    num,
    bool,
    plus,
    minus,
    times,
    divide,
    quotient,
    mod,
    eq,
    ne,
    gt,
    lt,
    ge,
    le,
    noCmp,
    and,
    or,
    item,
    setItem,
    change,
    call,
    callStatement,
    repeatError: () => Lang.Blocks.FLOW_repeat_basic_errorMsg,
    variable: (id, ent) => Entry.variableContainer.getVariable(id, ent),
    list: (id, ent) => Entry.variableContainer.getList(id, ent),
  }
  const RUNTIME_NAMES = Object.keys(R).join(', ')

  // ── compiler ──
  const isBlock = p => p instanceof Entry.Block
  function field(b, i) {
    if (isBlock(b.params[i]))
      throw new Unsupported(`${b.type}: block in field ${i}`)
    return filterReserved(b.params[i])
  }
  // Entry evaluates every Block param before the func runs; inline rules only evaluate the ones they use
  function onlyBlocksAt(b, used) {
    b.params.forEach((p, i) => {
      if (isBlock(p) && !used.includes(i))
        throw new Unsupported(`${b.type}: unexpected block param ${i}`)
    })
  }
  const firstOf = (b, i) => {
    const t = b.statements && b.statements[i]
    return (t && t.getFirstBlock()) || null
  }

  function literal(c, v) {
    if (typeof v === 'string')
      return JSON.stringify(v)
    if (typeof v === 'number' && Number.isFinite(v) && !Object.is(v, -0))
      return String(v)
    if (v === null || v === undefined || typeof v === 'boolean')
      return String(v)
    c.consts.push(v)
    return `K[${c.consts.length - 1}]`
  }
  function ref(c, b) {
    c.blocks.push(b)
    c.schemas.push(Entry.block[b.type])
    return c.blocks.length - 1
  }
  function varRef(c, id) {
    if (!c.vars.has(id))
      c.vars.set(id, `v${c.vars.size}`)
    return c.vars.get(id)
  }
  function listRef(c, id) {
    if (!c.lists.has(id))
      c.lists.set(id, `l${c.lists.size}`)
    return c.lists.get(id)
  }
  // a tier-1 call still needs its variable / list checked in the prelude
  function noteRefs(c, b) {
    if (b.type in VAR_FIELD)
      varRef(c, field(b, VAR_FIELD[b.type]))
    if (b.type in LIST_FIELD)
      listRef(c, field(b, LIST_FIELD[b.type]))
  }
  // re-evaluating it has no effect and cannot throw
  const stable = p => !isBlock(p) || ['number', 'text', 'True', 'False', 'get_variable'].includes(p.type)

  function tier1(c, b) {
    noteRefs(c, b)
    const k = ref(c, b)
    return [k, `[${b.params.map(p => expr(c, p)).join(', ')}]`]
  }

  function expr(c, p) {
    if (!isBlock(p))
      return literal(c, filterReserved(p))
    if (!Entry.block[p.type])
      throw new Unsupported(`unknown ${p.type}`)
    if (options.inline) {
      switch (p.type) {
        case 'number':
        case 'text':
          onlyBlocksAt(p, [])
          return literal(c, field(p, 0))
        case 'True':
          return 'true'
        case 'False':
          return 'false'
        case 'get_variable':
          onlyBlocksAt(p, [])
          return `${varRef(c, field(p, 0))}.getValue()`
        case 'calc_basic': {
          onlyBlocksAt(p, [0, 2])
          const op = field(p, 1)
          const fn = op === 'PLUS' ? 'plus' : op === 'MINUS' ? 'minus' : op === 'MULTI' ? 'times' : 'divide'
          return `${fn}(${expr(c, p.params[0])}, ${expr(c, p.params[2])})`
        }
        case 'quotient_and_mod':
          onlyBlocksAt(p, [1, 3])
          return `${field(p, 5) === 'QUOTIENT' ? 'quotient' : 'mod'}(${expr(c, p.params[1])}, ${expr(c, p.params[3])})`
        case 'boolean_basic_operator':
          onlyBlocksAt(p, [0, 2])
          return `${CMP[field(p, 1)] || 'noCmp'}(${expr(c, p.params[0])}, ${expr(c, p.params[2])})`
        case 'boolean_and_or':
          onlyBlocksAt(p, [0, 2])
          return `${field(p, 1) === 'AND' ? 'and' : 'or'}(${expr(c, p.params[0])}, ${expr(c, p.params[2])})`
        case 'boolean_not':
          onlyBlocksAt(p, [1])
          return `!bool(${expr(c, p.params[1])})`
        case 'value_of_index_from_list':
          onlyBlocksAt(p, [3])
          return `item(${listRef(c, field(p, 1))}, ${expr(c, p.params[3])})`
        case 'length_of_list':
          onlyBlocksAt(p, [])
          return `${listRef(c, field(p, 1))}.getArray().length`
      }
    }
    if (!TIER1_VALUES.has(p.type))
      throw new Unsupported(p.type)
    const [k, args] = tier1(c, p)
    return `call(B[${k}], S[${k}], ex, ${args})`
  }

  function chain(c, first) {
    let out = ''
    for (let b = first; b; b = b.getNextBlock())
      out += statement(c, b)
    return out
  }

  // loop bodies end like Entry's executor: a non-empty body marks the executor looped and yields, an empty one
  // (stepInto on an empty thread) only yields
  function loopBody(c, loop, b, i) {
    const first = firstOf(b, i)
    c.loops.push(loop)
    const body = first ? chain(c, first) : ''
    c.loops.pop()
    return `${body}${first ? 'ex.isLooped = true;\n' : ''}yield;\n`
  }

  function statement(c, b) {
    const schema = Entry.block[b.type]
    if (!schema)
      throw new Unsupported(`unknown ${b.type}`)
    if (!Entry.skeleton[schema.skeleton].executable)
      return ''
    const k = ref(c, b)
    const at = `$b = ${k};\n`
    const n = c.n++
    switch (b.type) {
      case 'repeat_basic': {
        onlyBlocksAt(b, [0])
        const value = expr(c, b.params[0])
        // Entry evaluates the count again each time it re-enters the loop block; skip that when it cannot matter
        const reEntry = stable(b.params[0]) ? '' : `$b = ${k};\n${value};\n`
        const body = loopBody(c, { label: `L${n}`, reEntry }, b, 0)
        return `${at}let c${n} = num(${value});\nif (c${n} < 0) throw new Error(repeatError());\nc${n} = Math.floor(c${n});\n`
          + `L${n}: while (c${n} !== 0 && !(c${n} < 0)) {\nc${n}--;\n${body}${reEntry}}\n`
      }
      case 'repeat_inf': {
        onlyBlocksAt(b, [1])
        const extra = isBlock(b.params[1]) ? `$b = ${k};\n${expr(c, b.params[1])};\n` : ''
        return `L${n}: while (true) {\n${extra}${loopBody(c, { label: `L${n}`, reEntry: '' }, b, 0)}}\n`
      }
      case 'repeat_while_true': {
        onlyBlocksAt(b, [0])
        const until = field(b, 1) === 'until'
        const cond = expr(c, b.params[0])
        const body = loopBody(c, { label: `L${n}`, reEntry: '' }, b, 0)
        return `L${n}: while (true) {\n$b = ${k};\nconst w${n} = bool(${cond});\nif (!(${until ? `!w${n}` : `w${n}`})) break;\n${body}}\n`
      }
      case '_if': {
        onlyBlocksAt(b, [0])
        const cond = expr(c, b.params[0])
        const first = firstOf(b, 0)
        return `${at}if (bool(${cond})) {\n${first ? chain(c, first) : 'yield;\n'}}\n`
      }
      case 'if_else': {
        onlyBlocksAt(b, [0])
        const cond = expr(c, b.params[0])
        const a = firstOf(b, 0)
        const e = firstOf(b, 1)
        return `${at}if (bool(${cond})) {\n${a ? chain(c, a) : 'yield;\n'}} else {\n${e ? chain(c, e) : 'yield;\n'}}\n`
      }
      case 'stop_repeat': {
        const loop = c.loops.at(-1)
        if (!loop)
          throw new Unsupported('stop_repeat outside a loop')
        return `break ${loop.label};\n`
      }
      case 'continue_repeat': {
        const loop = c.loops.at(-1)
        if (!loop)
          throw new Unsupported('continue_repeat outside a loop')
        return `yield;\n${loop.reEntry}continue ${loop.label};\n`
      }
    }
    if (options.inline) {
      switch (b.type) {
        case 'set_variable':
          onlyBlocksAt(b, [1])
          return `${at}${varRef(c, field(b, 0))}.setValue(${expr(c, b.params[1])});\n`
        case 'change_variable':
          onlyBlocksAt(b, [1])
          return `${at}change(${varRef(c, field(b, 0))}, ${expr(c, b.params[1])});\n`
        case 'change_value_list_index':
          onlyBlocksAt(b, [1, 2])
          return `${at}setItem(${listRef(c, field(b, 0))}, ${expr(c, b.params[1])}, ${expr(c, b.params[2])});\n`
        case 'add_value_to_list':
          onlyBlocksAt(b, [0])
          return `${at}${listRef(c, field(b, 1))}.appendValue(${expr(c, b.params[0])});\n`
      }
    }
    if (!TIER1_STATEMENTS.has(b.type))
      throw new Unsupported(b.type)
    const [, args] = tier1(c, b)
    return `${at}callStatement(B[${k}], S[${k}], ex, ${args});\n`
  }

  function generate(hat) {
    const c = { blocks: [], schemas: [], consts: [], vars: new Map(), lists: new Map(), loops: [], n: 0 }
    const body = chain(c, hat.getNextBlock())
    const decl = [
      ...[...c.vars].map(([id, name]) => `const ${name} = variable(${JSON.stringify(id)}, ent);\n`),
      ...[...c.lists].map(([id, name]) => `const ${name} = list(${JSON.stringify(id)}, ent);\n`),
    ].join('')
    const guards = [
      ...[...c.vars.values()].map(v => `!${v} || ${v}.isRealTime_`),
      ...[...c.lists.values()].map(l => `!${l} || ${l}.isRealTime_ || ${l}.isCloud_`),
    ]
    const src = `const { ${RUNTIME_NAMES} } = R;\nreturn function (ex, ent) {\n${decl}`
      + `${guards.length ? `if (${guards.join(' || ')}) return null;\n` : ''}`
      + `return (function* () {\nlet $b = -1;\ntry {\n${body}} catch (e) {\n`
      + `if (e && typeof e === 'object' && !e.$turboBlock) e.$turboBlock = B[$b];\nthrow e;\n}\n})();\n};\n`
    return { src, c }
  }

  function compile(hat) {
    try {
      const { src, c } = generate(hat)
      // eslint-disable-next-line no-new-func -- the whole point: blocks become JS
      const factory = new Function('R', 'B', 'S', 'K', src)(R, c.blocks, c.schemas, c.consts)
      stats.compiled++
      return factory
    }
    catch (e) {
      stats.fallback++
      const reason = e instanceof Unsupported ? e.message : `error: ${e.message}`
      stats.reasons[reason] = (stats.reasons[reason] || 0) + 1
      if (!(e instanceof Unsupported))
        console.error('[turbo] compile failed', e)
      return null
    }
  }

  // ── executor hook ──
  function start(ex) {
    if (ex.isFuncExecutor || ex._callStack.length)
      return null
    const hat = ex.scope && ex.scope.block
    if (!hat || !HATS.has(hat.type))
      return null
    let factory = cache.get(hat)
    if (factory === undefined) {
      factory = compile(hat)
      cache.set(hat, factory)
    }
    if (!factory)
      return null
    try {
      const g = factory(ex, ex.entity)
      if (g)
        stats.started++
      return g
    }
    catch {
      return null
    }
  }

  // same reporting as Entry's execute, pointed at the statement that was running
  function fail(ex, e) {
    if (e && e.$turboBlock)
      ex.scope = new Entry.Scope(e.$turboBlock, ex)
    if (e && e.name === 'IncompatibleError') {
      Entry.Utils.stopProjectWithToast(ex.scope, 'IncompatibleError', e)
      return
    }
    if (e && e.name === 'RangeError')
      Entry.toast.alert(Lang.Workspace.RecursiveCallWarningTitle, Lang.Workspace.RecursiveCallWarningContent)
    Entry.Utils.stopProjectWithToast(ex.scope, undefined, e)
  }

  function turboExecute(isFromOrigin) {
    let g = this.$turbo
    if (g === undefined)
      g = this.$turbo = start(this)
    if (g === null)
      return originalExecute.call(this, isFromOrigin)
    if (Entry.isTurbo && !this.isUpdateTime)
      this.isUpdateTime = performance.now()
    if (this.isEnd())
      return
    if (isFromOrigin)
      Entry.callStackLength = 0
    try {
      if (g.next().done)
        this.scope = new Entry.Scope(null, this)
    }
    catch (e) {
      fail(this, e)
    }
    return RESULT
  }

  // ── deferred variable views ──
  // Same as Variable.setValue except updateView, which runs once per tick for each written variable (a microtask
  // after the engine's tick, before the next frame is drawn). Real-time (cloud) variables keep the original path.
  const dirty = new Set()
  let flushQueued = false
  function flushViews() {
    flushQueued = false
    for (const v of dirty)
      v.updateView()
    dirty.clear()
  }
  function deferredSetValue(value) {
    if (this.isRealTime_)
      return originalSetValue.call(this, value)
    this.value_ = value
    this._valueWidth = null
    Entry.requestUpdateTwice = true
    dirty.add(this)
    if (!flushQueued) {
      flushQueued = true
      queueMicrotask(flushViews)
    }
  }

  globalThis.EntryTurbo = {
    originalExecute,
    originalSetValue,
    stats,
    enable(opts = {}) {
      Object.assign(options, DEFAULTS, opts)
      cache = new WeakMap()
      Object.assign(stats, { compiled: 0, fallback: 0, started: 0, reasons: {} })
      proto.execute = options.compile ? turboExecute : originalExecute
      variableProto.setValue = options.deferViews ? deferredSetValue : originalSetValue
    },
    disable() {
      proto.execute = originalExecute
      variableProto.setValue = originalSetValue
      flushViews()
      cache = new WeakMap()
    },
    get enabled() {
      return proto.execute === turboExecute || variableProto.setValue === deferredSetValue
    },
    // generated source for a hat block, for reading
    source(hat) {
      try {
        return generate(hat).src
      }
      catch (e) {
        return `// not compiled: ${e.message}`
      }
    },
  }
})()
