/* global Entry, Lang, BigNumber */
// Entry turbo (prototype). Compiles each script's blocks into one JS generator and runs it in place of Entry's
// block-by-block interpreter (Entry.Executor.prototype.execute). The rules are copied from the editor's own
// Executor / Scope / block funcs (offline editor 2.1.35):
//   - yield exactly where Entry yields: the end of a loop iteration (at the top level also set executor.isLooped,
//     which boost mode uses to re-run the script in the same tick), an empty statement body, continue_repeat,
//     a function that yields
//   - values go through the same conversions (getNumberValue, getBooleanValue, isNumber) and the same BigNumber
//     arithmetic; integer fast paths only where the result is provably the same
//   - functions without parameters or local variables become JS functions (generators only if they can yield)
//   - the "weld" (Talebot_Move with continue_repeat in its value slot) re-enters its loop without yielding, as in Entry
//   - blocks without an inline rule run their own func with a light scope ("tier 1")
// A script that uses any block outside the known set stays on Entry's executor, untouched.
// Separately, deferViews makes every variable write (compiled or not) update its stage view once per tick instead of
// on each write: Entry's Variable.setValue redraws the view even for a hidden variable (14 µs a call, measured).
// Loaded into the page as a classic script; exposes globalThis.EntryTurbo.
(() => {
  const previous = globalThis.EntryTurbo
  previous?.disable()

  const STATIC = Entry.STATIC
  const proto = Entry.Executor.prototype
  const originalExecute = previous ? previous.originalExecute : proto.execute
  const variableProto = Entry.Variable.prototype
  const originalSetValue = previous ? previous.originalSetValue : variableProto.setValue
  const filterReserved = p => Entry.Scope.prototype.filterReservedKeywords(p)
  const RESULT = Object.freeze({ promises: Object.freeze([]), blocks: Object.freeze([]) })

  // start blocks whose func is `return script.callReturn()`: the script runs from the next block
  const HATS = new Set(['when_run_button_click', 'when_scene_start', 'when_some_key_pressed'])
  // run through their own func with a light scope (tier 1). Values: synchronous, no state on the scope. Statements:
  // also return undefined/null (next block) and never touch the executor's call stack. Checked in the editor.
  const TIER1_VALUES = new Set(['number', 'text', 'True', 'False', 'get_variable', 'calc_basic', 'quotient_and_mod', 'calc_operation', 'boolean_basic_operator', 'boolean_and_or', 'boolean_not', 'value_of_index_from_list', 'length_of_list', 'combine_something', 'substring', 'length_of_string', 'char_at', 'index_of_string', 'replace_string', 'is_press_some_key', 'get_project_timer_value'])
  const TIER1_STATEMENTS = new Set(['set_variable', 'change_variable', 'change_value_list_index', 'add_value_to_list', 'remove_value_from_list', 'text_write', 'start_scene', 'restart_project', 'choose_project_timer_action', 'set_visible_project_timer'])
  // params that name a variable / list (field index), so it can be resolved and checked once
  const VAR_FIELD = { get_variable: 0, set_variable: 0, change_variable: 0 }
  const LIST_FIELD = { value_of_index_from_list: 1, length_of_list: 1, change_value_list_index: 0, add_value_to_list: 1, remove_value_from_list: 1 }

  const DEFAULTS = { compile: true, inline: true, functions: true, deferViews: true }
  const options = { ...DEFAULTS }
  const newStats = () => ({ compiled: 0, fallback: 0, started: 0, functions: 0, generators: 0, functionFallback: 0, reasons: {} })
  const stats = newStats()
  const note = (reason) => {
    stats.reasons[reason] = (stats.reasons[reason] || 0) + 1
  }
  // per enable(): compiled scripts by hat block, compiled functions by id (entries in FT by name)
  let cache = new WeakMap()
  let fns = new Map()
  let FT = {}

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

  // strings (getStringValue = String(v))
  const concat = (a, b) => `${String(a)}${String(b)}`
  function charAt(a, b) {
    const str = String(a)
    const index = num(b) - 1
    if (index < 0 || index > str.length - 1)
      // eslint-disable-next-line unicorn/error-message -- Entry throws it without a message
      throw new Error()
    return str[index]
  }
  const indexOf = (a, b) => String(a).indexOf(String(b)) + 1
  function substring(a, b, e) {
    const str = String(a)
    const start = num(b) - 1
    const end = num(e) - 1
    const last = str.length - 1
    if (start < 0 || end < 0 || start > last || end > last)
      // eslint-disable-next-line unicorn/error-message -- Entry throws it without a message
      throw new Error()
    return str.substring(Math.min(start, end), Math.max(start, end) + 1)
  }
  const replace = (s, o, n) => String(s).split(String(o)).join(String(n))

  // lists (known not to be real-time or cloud). value_of_index_from_list / change_value_list_index /
  // remove_value_from_list, and the same with an index that is a number literal (isNumber is then known true)
  function item(list, index) {
    if (!isNumber(index))
      index = Entry.getListRealIndex(index, list)
    const array = list.getArray()
    if (!array || !isNumber(index) || index > array.length)
      throw new Error('can not insert value to array')
    return array[index - 1].data
  }
  function itemAt(list, index) {
    const array = list.getArray()
    if (!array || index > array.length)
      throw new Error('can not insert value to array')
    return array[index - 1].data
  }
  function setItem(list, index, data) {
    const array = list.getArray()
    if (!array || !isNumber(index) || index > array.length)
      throw new Error('can not insert value to array')
    list.replaceValue(index, data)
  }
  function setItemAt(list, index, data) {
    const array = list.getArray()
    if (!array || index > array.length)
      throw new Error('can not insert value to array')
    list.replaceValue(index, data)
  }
  function removeItem(list, value) {
    const array = list.getArray()
    if (!array || !isNumber(value) || value > array.length)
      throw new Error('can not remove value from array')
    list.deleteValue(+value)
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
    if (r !== undefined && r !== null && r !== STATIC.PASS)
      throw new Error(`turbo: ${block.type} returned ${String(r)}`)
  }

  // The weld: evaluating the continue_repeat slot runs executor.continueLoop (back to the loop block), then
  // Talebot_Move's func runs. Without the robot it returns its own scope, which the executor ignores, so the loop
  // re-enters at once without yielding (true). Once the robot reports done it returns undefined and the executor moves
  // past the loop block (false).
  function weld(block, schema, ex, direction) {
    const scope = new FastScope(block, schema, ex, [direction, STATIC.BREAK, null])
    const r = schema.func.call(scope, ex.entity, scope)
    if (r === scope || r === STATIC.CONTINUE)
      return true
    if (r === undefined || r === null || r === STATIC.PASS)
      return false
    throw new Error(`turbo: Talebot_Move returned ${String(r)}`)
  }

  // a function the compiler did not take, run the way the function block's own func does it
  function* entryFunction(id, ex, ent) {
    stats.functionFallback++
    const func = Entry.variableContainer.getFunction(id)
    const code = func.content
    const fe = code.raiseEvent('funcDef', ent)[0]
    fe.register.params = [null]
    fe.register.paramMap = func.paramMap
    fe.parentExecutor = ex
    fe.parentScope = ex.scope
    fe.isFuncExecutor = true
    fe.localVariables = []
    for (;;) {
      const { promises } = fe.execute()
      if (fe.isEnd()) {
        code.removeExecutor(fe)
        return
      }
      if (promises && promises.length)
        throw new Error('turbo: asynchronous function')
      code.removeExecutor(fe)
      yield
    }
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
    concat,
    charAt,
    indexOf,
    substring,
    replace,
    item,
    itemAt,
    setItem,
    setItemAt,
    removeItem,
    change,
    call,
    callStatement,
    weld,
    entryFunction,
    repeatError: () => Lang.Blocks.FLOW_repeat_basic_errorMsg,
    variable: (id, ent) => Entry.variableContainer.getVariable(id, ent),
    list: (id, ent) => Entry.variableContainer.getList(id, ent),
  }
  const RUNTIME_NAMES = Object.keys(R).join(', ')

  // ── compiler ──
  // c: { blocks, schemas, consts, vars, lists, loops, n, fn (a function body), yields (emitted a yield point) }
  const context = fn => ({ blocks: [], schemas: [], consts: [], vars: new Map(), lists: new Map(), loops: [], n: 0, fn, yields: false })
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
  // a param that is a number literal Entry's isNumber accepts: its numeric value, else null
  function numberLiteral(p) {
    if (!isBlock(p) || (p.type !== 'number' && p.type !== 'text'))
      return null
    const v = filterReserved(p.params[0])
    return isNumber(v) && Number.isFinite(Number(v)) ? Number(v) : null
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
  // a tier-1 call still needs its variable / list checked
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

  function inlineExpr(c, p) {
    const e = q => expr(c, p.params[q])
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
        return `${fn}(${e(0)}, ${e(2)})`
      }
      case 'quotient_and_mod':
        onlyBlocksAt(p, [1, 3])
        return `${field(p, 5) === 'QUOTIENT' ? 'quotient' : 'mod'}(${e(1)}, ${e(3)})`
      case 'boolean_basic_operator':
        onlyBlocksAt(p, [0, 2])
        return `${CMP[field(p, 1)] || 'noCmp'}(${e(0)}, ${e(2)})`
      case 'boolean_and_or':
        onlyBlocksAt(p, [0, 2])
        return `${field(p, 1) === 'AND' ? 'and' : 'or'}(${e(0)}, ${e(2)})`
      case 'boolean_not':
        onlyBlocksAt(p, [1])
        return `!bool(${e(1)})`
      case 'value_of_index_from_list': {
        onlyBlocksAt(p, [3])
        const list = listRef(c, field(p, 1))
        const at = numberLiteral(p.params[3])
        return at === null ? `item(${list}, ${e(3)})` : `itemAt(${list}, ${at})`
      }
      case 'length_of_list':
        onlyBlocksAt(p, [])
        return `${listRef(c, field(p, 1))}.getArray().length`
      case 'combine_something':
        onlyBlocksAt(p, [1, 3])
        return `concat(${e(1)}, ${e(3)})`
      case 'length_of_string':
        onlyBlocksAt(p, [1])
        return `String(${e(1)}).length`
      case 'char_at':
        onlyBlocksAt(p, [1, 3])
        return `charAt(${e(1)}, ${e(3)})`
      case 'index_of_string':
        onlyBlocksAt(p, [1, 3])
        return `indexOf(${e(1)}, ${e(3)})`
      case 'substring':
        onlyBlocksAt(p, [1, 3, 5])
        return `substring(${e(1)}, ${e(3)}, ${e(5)})`
      case 'replace_string':
        onlyBlocksAt(p, [1, 3, 5])
        return `replace(${e(1)}, ${e(3)}, ${e(5)})`
      case 'is_press_some_key':
        onlyBlocksAt(p, [])
        return `(Entry.pressedKeys.indexOf(${literal(c, Number(field(p, 0)))}) >= 0)`
      case 'get_project_timer_value':
        onlyBlocksAt(p, [])
        return 'Entry.engine.projectTimer.getValue()'
    }
    return null
  }

  function expr(c, p) {
    if (!isBlock(p))
      return literal(c, filterReserved(p))
    if (!Entry.block[p.type])
      throw new Unsupported(`unknown ${p.type}`)
    if (options.inline) {
      const code = inlineExpr(c, p)
      if (code !== null)
        return code
    }
    if (!TIER1_VALUES.has(p.type))
      throw new Unsupported(p.type)
    const [k, args] = tier1(c, p)
    return `call(B[${k}], S[${k}], ex, ${args})`
  }

  // statements return { code, open }: open = control can reach the next statement
  function chain(c, first) {
    let code = ''
    let open = true
    for (let b = first; b && open; b = b.getNextBlock()) {
      const s = statement(c, b)
      code += s.code
      open = s.open
    }
    return { code, open }
  }

  // a loop body ends like Entry's executor: when the end is reachable it yields (and at the top level marks the
  // executor looped), an empty body (stepInto on an empty thread) only yields
  function loopBody(c, loop, b, i) {
    const first = firstOf(b, i)
    if (!first) {
      c.yields = true
      return 'yield;\n'
    }
    c.loops.push(loop)
    const body = chain(c, first)
    c.loops.pop()
    if (!body.open)
      return body.code
    c.yields = true
    return `${body.code}${c.fn ? '' : 'ex.isLooped = true;\n'}yield;\n`
  }
  // an if branch: an empty one yields once (stepInto on an empty thread)
  function branch(c, b, i) {
    const first = firstOf(b, i)
    if (!first) {
      c.yields = true
      return { code: 'yield;\n', open: true }
    }
    return chain(c, first)
  }

  function statement(c, b) {
    const schema = Entry.block[b.type]
    if (!schema)
      throw new Unsupported(`unknown ${b.type}`)
    if (!Entry.skeleton[schema.skeleton].executable)
      return { code: '', open: true }
    const k = ref(c, b)
    const at = `$b = ${k};\n`
    // at the top level a block may end the executor (scene change, stop); Entry checks after every block
    const after = c.fn ? '' : 'if (ex.isEnd()) return;\n'
    const n = c.n++
    const s = (code, open = true) => ({ code, open })
    switch (b.type) {
      case 'repeat_basic': {
        onlyBlocksAt(b, [0])
        const value = expr(c, b.params[0])
        // Entry evaluates the count again each time it re-enters the loop block; skip that when it cannot matter
        const reEntry = stable(b.params[0]) ? '' : `$b = ${k};\n${value};\n`
        const body = loopBody(c, { label: `L${n}`, reEntry }, b, 0)
        return s(`${at}let c${n} = num(${value});\nif (c${n} < 0) throw new Error(repeatError());\nc${n} = Math.floor(c${n});\n`
          + `L${n}: while (c${n} !== 0 && !(c${n} < 0)) {\nc${n}--;\n${body}${reEntry}}\n`)
      }
      case 'repeat_inf': {
        onlyBlocksAt(b, [1])
        const extra = isBlock(b.params[1]) ? `$b = ${k};\n${expr(c, b.params[1])};\n` : ''
        return s(`L${n}: while (true) {\n${extra}${loopBody(c, { label: `L${n}`, reEntry: '' }, b, 0)}}\n`)
      }
      case 'repeat_while_true': {
        onlyBlocksAt(b, [0])
        const until = field(b, 1) === 'until'
        const cond = expr(c, b.params[0])
        const body = loopBody(c, { label: `L${n}`, reEntry: '' }, b, 0)
        return s(`L${n}: while (true) {\n$b = ${k};\nconst w${n} = bool(${cond});\nif (!(${until ? `!w${n}` : `w${n}`})) break;\n${body}}\n`)
      }
      case '_if': {
        onlyBlocksAt(b, [0])
        const cond = expr(c, b.params[0])
        return s(`${at}if (bool(${cond})) {\n${branch(c, b, 0).code}}\n`)
      }
      case 'if_else': {
        onlyBlocksAt(b, [0])
        const cond = expr(c, b.params[0])
        const yes = branch(c, b, 0)
        const no = branch(c, b, 1)
        return s(`${at}if (bool(${cond})) {\n${yes.code}} else {\n${no.code}}\n`, yes.open || no.open)
      }
      case 'stop_repeat': {
        const loop = c.loops.at(-1)
        if (!loop)
          throw new Unsupported('stop_repeat outside a loop')
        return s(`break ${loop.label};\n`, false)
      }
      case 'continue_repeat': {
        const loop = c.loops.at(-1)
        if (!loop)
          throw new Unsupported('continue_repeat outside a loop')
        c.yields = true
        return s(`yield;\n${loop.reEntry}continue ${loop.label};\n`, false)
      }
      case 'Talebot_Move': {
        const slot = b.params[1]
        const loop = c.loops.at(-1)
        if (!isBlock(slot) || slot.type !== 'continue_repeat')
          throw new Unsupported('Talebot_Move')
        if (!loop)
          throw new Unsupported('weld outside a loop')
        onlyBlocksAt(b, [1])
        onlyBlocksAt(slot, [])
        return s(`${at}if (!weld(B[${k}], S[${k}], ex, ${literal(c, field(b, 0))})) break ${loop.label};\n${loop.reEntry}continue ${loop.label};\n`, false)
      }
    }
    if (b.type.startsWith('func_')) {
      onlyBlocksAt(b, [])
      const id = b.type.slice(5)
      const f = options.functions ? compileFunction(id) : null
      if (!f) {
        c.yields = true
        return s(`${at}yield* entryFunction(${JSON.stringify(id)}, ex, ent);\n${after}`)
      }
      if (f.gen)
        c.yields = true
      return s(`${at}${f.gen ? 'yield* ' : ''}FT.${f.name}(ex, ent);\n${after}`)
    }
    if (options.inline) {
      const e = q => expr(c, b.params[q])
      switch (b.type) {
        case 'set_variable':
          onlyBlocksAt(b, [1])
          return s(`${at}${varRef(c, field(b, 0))}.setValue(${e(1)});\n`)
        case 'change_variable':
          onlyBlocksAt(b, [1])
          return s(`${at}change(${varRef(c, field(b, 0))}, ${e(1)});\n`)
        case 'change_value_list_index': {
          onlyBlocksAt(b, [1, 2])
          const list = listRef(c, field(b, 0))
          const idx = numberLiteral(b.params[1])
          return s(idx === null ? `${at}setItem(${list}, ${e(1)}, ${e(2)});\n` : `${at}setItemAt(${list}, ${idx}, ${e(2)});\n`)
        }
        case 'add_value_to_list':
          onlyBlocksAt(b, [0])
          return s(`${at}${listRef(c, field(b, 1))}.appendValue(${e(0)});\n`)
        case 'remove_value_from_list':
          onlyBlocksAt(b, [0])
          return s(`${at}removeItem(${listRef(c, field(b, 1))}, ${e(0)});\n`)
      }
    }
    if (!TIER1_STATEMENTS.has(b.type))
      throw new Unsupported(b.type)
    const [, args] = tier1(c, b)
    return s(`${at}callStatement(B[${k}], S[${k}], ex, ${args});\n${after}`)
  }

  const errorWrap = body => `let $b = -1;\ntry {\n${body}} catch (e) {\n`
    + `if (e && typeof e === 'object' && !e.$turboBlock) e.$turboBlock = B[$b];\nthrow e;\n}\n`
  const guardOf = (name, kind) => (kind === 'list' ? `!${name} || ${name}.isRealTime_ || ${name}.isCloud_` : `!${name} || ${name}.isRealTime_`)

  // a top-level script: a factory (executor, entity) -> generator, resolving variables and lists for that entity
  function generate(hat) {
    const c = context(false)
    const body = chain(c, hat.getNextBlock()).code
    const refs = [...[...c.vars].map(([id, name]) => [id, name, 'variable']), ...[...c.lists].map(([id, name]) => [id, name, 'list'])]
    const decl = refs.map(([id, name, kind]) => `const ${name} = ${kind}(${JSON.stringify(id)}, ent);\n`).join('')
    const guards = refs.map(([, name, kind]) => guardOf(name, kind))
    const src = `const { ${RUNTIME_NAMES} } = R;\nreturn function (ex, ent) {\n${decl}`
      + `${guards.length ? `if (${guards.join(' || ')}) return null;\n` : ''}`
      + `return (function* () {\n${errorWrap(body)}})();\n};\n`
    return { src, c }
  }

  function compile(hat) {
    try {
      const { src, c } = generate(hat)
      // eslint-disable-next-line no-new-func -- the whole point: blocks become JS
      const factory = new Function('R', 'B', 'S', 'K', 'FT', src)(R, c.blocks, c.schemas, c.consts, FT)
      stats.compiled++
      return factory
    }
    catch (e) {
      stats.fallback++
      note(e instanceof Unsupported ? e.message : `error: ${e.message}`)
      if (!(e instanceof Unsupported))
        console.error('[turbo] compile failed', e)
      return null
    }
  }

  // A function becomes FT[name]: a plain JS function, or a generator when it can yield (a loop end, an empty body or
  // branch, a call that yields, or it takes part in a cycle of calls). Its variables and lists must be global, so they
  // resolve once. Returns { name, gen } or null (then callers use entryFunction).
  function compileFunction(id) {
    let f = fns.get(id)
    if (f) {
      if (f.pending) {
        f.forceGen = true // a call cycle: every member becomes a generator, the caller uses yield*
        return { name: f.name, gen: true }
      }
      return f.failed ? null : f
    }
    f = { name: `f${fns.size}`, pending: true, forceGen: false, gen: false, failed: false }
    fns.set(id, f)
    try {
      const func = Entry.variableContainer.getFunction(id)
      if (!func || func.type !== 'normal')
        throw new Unsupported('function type')
      if ((func.localVariables && func.localVariables.length) || Object.keys(func.paramMap || {}).length)
        throw new Unsupported('function with parameters or local variables')
      const def = func.content.getEventMap('funcDef')[0]
      const c = context(true)
      const first = def && firstOf(def, 0)
      let body
      if (first) {
        body = chain(c, first).code
      }
      else {
        c.yields = true // function_create steps into an empty thread: one yield
        body = 'yield;\n'
      }
      const objs = []
      const decl = []
      for (const [kind, map] of [['variable', c.vars], ['list', c.lists]]) {
        for (const [vid, name] of map) {
          const o = kind === 'list' ? Entry.variableContainer.getList(vid) : Entry.variableContainer.getVariable(vid)
          if (!o || o.isRealTime_ || o.isCloud_ || o.object_)
            throw new Unsupported(`function uses a ${kind} that is local, real-time or missing`)
          decl.push(`const ${name} = V[${objs.length}];\n`)
          objs.push(o)
        }
      }
      f.gen = c.yields || f.forceGen
      const src = `const { ${RUNTIME_NAMES} } = R;\n${decl.join('')}return function${f.gen ? '*' : ''} (ex, ent) {\nlet $b = -1;\n${body}};\n`
      // eslint-disable-next-line no-new-func -- the whole point: blocks become JS
      FT[f.name] = new Function('R', 'B', 'S', 'K', 'FT', 'V', src)(R, c.blocks, c.schemas, c.consts, FT, objs)
      stats.functions++
      if (f.gen)
        stats.generators++
    }
    catch (e) {
      if (!(e instanceof Unsupported))
        console.error('[turbo] function compile failed', e)
      note(`function: ${e instanceof Unsupported ? e.message : `error: ${e.message}`}`)
      f.failed = true
      // a caller in the same cycle may already have emitted `yield* FT[name]`
      FT[f.name] = function* (ex, ent) {
        yield* entryFunction(id, ex, ent)
      }
    }
    f.pending = false
    return f.failed ? null : f
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
      if (g.next().done && !this.isEnd())
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
      fns = new Map()
      FT = {}
      Object.assign(stats, newStats())
      proto.execute = options.compile ? turboExecute : originalExecute
      variableProto.setValue = options.deferViews ? deferredSetValue : originalSetValue
    },
    disable() {
      proto.execute = originalExecute
      variableProto.setValue = originalSetValue
      flushViews()
      cache = new WeakMap()
      fns = new Map()
      FT = {}
    },
    get enabled() {
      return proto.execute === turboExecute || variableProto.setValue === deferredSetValue
    },
    // compile every script of the loaded project now (normally that happens as each one first runs)
    check() {
      const t = performance.now()
      for (const obj of Entry.container.getAllObjects()) {
        for (const thread of obj.script.getThreads()) {
          const hat = thread.getFirstBlock()
          if (hat && HATS.has(hat.type) && !cache.has(hat))
            cache.set(hat, compile(hat))
        }
      }
      return { ms: Math.round(performance.now() - t), ...JSON.parse(JSON.stringify(stats)) }
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
