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
// Every copied rule is guarded by a fingerprint of the Entry function it copies (see KNOWN): on a build that was not
// read and checked, that part runs on Entry's own code instead.
// Loaded into the page as a classic script. Installs at once when Entry is there, otherwise leaves
// installEntryTurbo() for the extension to call; exposes globalThis.EntryTurbo.

/**
 * What EntryTurbo.enable() takes; a missing key takes its default (true, except deepRecursion).
 * @typedef {object} TurboOptions
 * @property {boolean} [compile] Replace Executor#execute with compiled scripts (needs a checked core).
 * @property {boolean} [inline] Write checked value / statement blocks as JS instead of calling their func.
 * @property {boolean} [functions] Compile Entry functions; off calls them through Entry's own path.
 * @property {boolean} [deferViews] Replace Variable#setValue with the once-per-tick view update.
 * @property {boolean} [deepRecursion] Experimental: let recursive functions go RECURSION_DEEP calls deep instead of
 *   RECURSION_LIMIT (Entry itself stops at a few thousand, where the browser's stack runs out).
 */
/**
 * Counts since the last reset (every run from stop).
 * @typedef {object} TurboStats
 * @property {number} compiled Scripts running compiled.
 * @property {number} fallback Scripts left to Entry's executor.
 * @property {number} started Scripts started through the compiled executor.
 * @property {number} functions Entry functions compiled.
 * @property {number} generators Of those, the ones that can yield (generator functions).
 * @property {number} functionFallback Call sites that go through Entry's own function path.
 * @property {number} recursive Compiled functions that call themselves (directly or around a cycle): run on a stack of
 *   their own instead of the browser's.
 * @property {number} maxDepth The deepest such recursion reached.
 * @property {Record<string, number>} reasons Why a script or call was not compiled -> how many times.
 */
/**
 * What an unchecked Entry build switched off.
 * @typedef {object} TurboEngine
 * @property {boolean} coreKnown The executor / scope code matches a checked build (else nothing compiles).
 * @property {boolean} deferKnown Variable#setValue matches a checked build (else views are not deferred).
 * @property {string[]} unknown Fingerprint keys this build does not match; those blocks run Entry's way.
 */

function installEntryTurbo() {
  const previous = globalThis.EntryTurbo
  previous?.disable()

  const STATIC = Entry.STATIC
  const proto = Entry.Executor.prototype
  const originalExecute = previous ? previous.originalExecute : proto.execute
  const variableProto = Entry.Variable.prototype
  const originalSetValue = previous ? previous.originalSetValue : variableProto.setValue
  const filterReserved = p => Entry.Scope.prototype.filterReservedKeywords(p)
  const RESULT = Object.freeze({ promises: Object.freeze([]), blocks: Object.freeze([]) })

  // ── engine fingerprints ──
  // FNV-1a of each function's source, compared with the builds whose code the rules were copied from and checked
  // against: offline editor 2.1.35 and playentry.org (workspace and player) as of 2026-09-27.
  // @known-start (written by bench/fingerprints.js)
  const KNOWN = {
    'Code.tick': ['cpjtog', 'xv38wg'],
    'Executor.breakLoop': ['1g2ic3c', '1sknkvg'],
    'Executor.continueLoop': ['14vc9ei', '5c8eb1'],
    'Executor.execute': ['3b3t5q', 'ewwj1r'],
    'Executor.stepInto': ['12hzmzg', '1nkypnz'],
    'Func.getValue': ['pcw62w', 'rcc9fz'],
    'Func.setValue': ['ccrkob', 'kgp12m'],
    'Scope._getParamIndex': ['91a8ok', 'lohgbc'],
    'Scope.getBooleanValue': ['2dtti4', 'hs8q68'],
    'Scope.getField': ['ejrll2', 'vk79qb'],
    'Scope.getNumberValue': ['1yyc83f', '93k4jm'],
    'Scope.getParams': ['1vww9af', 'zimsl9'],
    'Scope.getStringValue': ['3srpan', 'v7c3zi'],
    'Scope.getValue': ['1ao6md7', 'u4cxod'],
    'Scope.run': ['8hb6jr', 'qdq71h'],
    'Variable.setValue': ['1xcx7on', 'zh4969'],
    'block:False': ['1dzevcc', '1edbv35'],
    'block:Talebot_Move': ['117yrkk', 'hrkld5'],
    'block:True': ['1d9glt8', 'h3wfwv'],
    'block:_if': ['14i3ct1', 'smqcrh'],
    'block:add_value_to_list': ['jmnyp7', 'yuqdmu'],
    'block:boolean_and_or': ['19cdo61', '1a1jj9'],
    'block:boolean_basic_operator': ['1pxl00', '4xz3i1'],
    'block:boolean_not': ['16dodrz', '9gdd2x'],
    'block:calc_basic': ['1imd5e5', '1wgt2ub'],
    'block:change_value_list_index': ['23c8kk', 'mhh6pu'],
    'block:change_variable': ['13bdmk', '1s1dxst'],
    'block:char_at': ['1uvljqw', 'ifxaik'],
    'block:combine_something': ['12haxuu', '1pgurn0'],
    'block:continue_repeat': ['1vyfpx6', 'b1efd6'],
    'block:function_create': ['1cklgt0', '1okuh48'],
    'block:function_create_value': ['1cklgt0', '1okuh48'],
    'block:function_general': ['1tntz0p', 'ecqloe'],
    'block:function_param_boolean': ['tdc2qd', 'u88h6q'],
    'block:function_param_string': ['tdc2qd', 'u88h6q'],
    'block:function_value': ['188mhvb', 'v2nhwg'],
    'block:get_func_variable': ['p892pl', 'u9hepo'],
    'block:get_project_timer_value': ['1rjfaed', '1vgq2m2'],
    'block:get_variable': ['1vfewif', 'tl6w5y'],
    'block:if_else': ['1mv9vxh', '7h82wl'],
    'block:index_of_string': ['jqssx7', 'v8hh16'],
    'block:is_press_some_key': ['1eqrrnx', '7dhqzd'],
    'block:length_of_list': ['16uhpj2', '6duprr'],
    'block:length_of_string': ['1cq9sj5', 'f5t5w7'],
    'block:number': ['1fuq782', '1imlaz4'],
    'block:quotient_and_mod': ['12ef9t3', '1a6ykhn'],
    'block:remove_value_from_list': ['wnuqyr', 'y71dym'],
    'block:repeat_basic': ['1jln2cp', '3ua9p1'],
    'block:repeat_inf': ['11ilb7f', '11x2z5l'],
    'block:repeat_while_true': ['1cfzz7v', '68x0ts'],
    'block:replace_string': ['52es5p', '6bg1ju'],
    'block:set_func_variable': ['1cjp3eg', 'x8jzo3'],
    'block:set_variable': ['11waqzg', '17dg5rk'],
    'block:stop_object': ['14tmija', '1b2gex3'],
    'block:stop_repeat': ['1a2olq', '68go7o'],
    'block:substring': ['1v0gnsz', 'mr2nzl'],
    'block:text': ['9ihhwl', 'wzxql5'],
    'block:value_of_index_from_list': ['d5cnji', 'h0ba4m'],
    'block:when_run_button_click': ['19m6n4e', 'rbkazb'],
    'block:when_scene_start': ['19m6n4e', 'rbkazb'],
    'block:when_some_key_pressed': ['19m6n4e', 'rbkazb'],
  }
  // @known-end
  const hash = (fn) => {
    const s = String(fn)
    let h = 0x811C9DC5
    for (let i = 0; i < s.length; i++)
      h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
    return (h >>> 0).toString(36)
  }
  // Entry's own functions whose behaviour the compiler reproduces (read before anything is patched)
  const CORE = {
    'Executor.execute': originalExecute,
    'Executor.continueLoop': proto.continueLoop,
    'Executor.breakLoop': proto.breakLoop,
    'Executor.stepInto': proto.stepInto,
    'Code.tick': Entry.Code.prototype.tick,
    'Scope.run': Entry.Scope.prototype.run,
    'Scope.getParams': Entry.Scope.prototype.getParams,
    'Scope.getValue': Entry.Scope.prototype.getValue,
    'Scope.getNumberValue': Entry.Scope.prototype.getNumberValue,
    'Scope.getBooleanValue': Entry.Scope.prototype.getBooleanValue,
    'Scope.getStringValue': Entry.Scope.prototype.getStringValue,
    'Scope.getField': Entry.Scope.prototype.getField,
    'Scope._getParamIndex': Entry.Scope.prototype._getParamIndex,
  }
  // blocks with an inline rule or compiled control flow. Function call and parameter blocks inherit their func from
  // one of the FUNC_BASES and are checked under that name.
  const RULE_BLOCKS = ['when_run_button_click', 'when_scene_start', 'when_some_key_pressed', 'number', 'text', 'True', 'False', 'get_variable', 'set_variable', 'change_variable', 'calc_basic', 'quotient_and_mod', 'boolean_basic_operator', 'boolean_and_or', 'boolean_not', 'repeat_basic', 'repeat_inf', 'repeat_while_true', '_if', 'if_else', 'stop_repeat', 'continue_repeat', 'value_of_index_from_list', 'change_value_list_index', 'add_value_to_list', 'remove_value_from_list', 'length_of_list', 'combine_something', 'substring', 'length_of_string', 'char_at', 'index_of_string', 'replace_string', 'is_press_some_key', 'get_project_timer_value', 'Talebot_Move', 'stop_object', 'function_create', 'function_create_value', 'function_general', 'function_value', 'function_param_string', 'function_param_boolean', 'get_func_variable', 'set_func_variable']
  const RULE_SET = new Set(RULE_BLOCKS)
  const FUNC_BASES = ['function_general', 'function_value', 'function_param_string', 'function_param_boolean']
  function baseOf(type) {
    const schema = Entry.block[type]
    if (schema && schema.func) {
      for (const base of FUNC_BASES) {
        if (type !== base && Entry.block[base] && schema.func === Entry.block[base].func)
          return base
      }
    }
    return type
  }
  const funcProto = Entry.Func && Entry.Func.prototype
  const fingerprints = previous ? previous.fingerprints : {}
  // Func#getValue / setValue: the local-variable rules (`value || 0`, first match by id)
  for (const [key, fn] of Object.entries({ ...CORE, 'Variable.setValue': originalSetValue, 'Func.getValue': funcProto && funcProto.getValue, 'Func.setValue': funcProto && funcProto.setValue })) {
    if (!(key in fingerprints))
      fingerprints[key] = hash(fn)
  }
  const unknown = new Set()
  const isKnown = (key) => {
    const ok = (KNOWN[key] || []).includes(fingerprints[key])
    if (!ok)
      unknown.add(key)
    return ok
  }
  // a block's rule may be used: its func is one of the checked builds
  function blockKnown(type) {
    const key = `block:${baseOf(type)}`
    if (!(key in fingerprints)) {
      const schema = Entry.block[type]
      if (!schema || !schema.func)
        return false
      fingerprints[key] = hash(schema.func)
    }
    return isKnown(key)
  }
  const coreKnown = Object.keys(CORE).every(isKnown)
  const deferKnown = isKnown('Variable.setValue')

  // start blocks whose func is `return script.callReturn()`: the script runs from the next block
  const HATS = new Set(['when_run_button_click', 'when_scene_start', 'when_some_key_pressed'])
  // blocks whose control flow the compiler writes itself
  const CONTROL = new Set(['repeat_basic', 'repeat_inf', 'repeat_while_true', '_if', 'if_else', 'stop_repeat', 'continue_repeat', 'Talebot_Move'])
  // run through their own func with a light scope (tier 1). Values: synchronous, no state on the scope. Statements:
  // also return undefined/null (next block) and never touch the executor's call stack. Checked in the editor.
  const TIER1_VALUES = new Set(['number', 'text', 'True', 'False', 'get_variable', 'calc_basic', 'quotient_and_mod', 'calc_operation', 'boolean_basic_operator', 'boolean_and_or', 'boolean_not', 'value_of_index_from_list', 'length_of_list', 'combine_something', 'substring', 'length_of_string', 'char_at', 'index_of_string', 'replace_string', 'is_press_some_key', 'get_project_timer_value'])
  const TIER1_STATEMENTS = new Set(['set_variable', 'change_variable', 'change_value_list_index', 'add_value_to_list', 'remove_value_from_list', 'text_write', 'start_scene', 'restart_project', 'choose_project_timer_action', 'set_visible_project_timer'])
  // params that name a variable / list (field index), so it can be resolved and checked once
  const VAR_FIELD = { get_variable: 0, set_variable: 0, change_variable: 0 }
  const LIST_FIELD = { value_of_index_from_list: 1, length_of_list: 1, change_value_list_index: 0, add_value_to_list: 1, remove_value_from_list: 1 }

  /** @type {Required<TurboOptions>} */
  const DEFAULTS = { compile: true, inline: true, functions: true, deferViews: true, deepRecursion: false }
  const options = { ...DEFAULTS }
  // How deep a recursive compiled function may go. Entry's own recursion ends where the browser's stack does, a few
  // thousand calls (1,500-3,500 in V8, depending on the function); the default stays well above that, so a project
  // never stops earlier than in Entry, and still stops on runaway recursion instead of eating memory.
  const RECURSION_LIMIT = 10_000
  const RECURSION_DEEP = 1_000_000
  /** @returns {TurboStats} all counts at zero */
  const newStats = () => ({ compiled: 0, fallback: 0, started: 0, functions: 0, generators: 0, functionFallback: 0, recursive: 0, maxDepth: 0, reasons: {} })
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
  // the page's own: builds differ (the web one also takes exponents, "1e5")
  const isNumber = Entry.Utils.isNumber
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
  // a value block's own func; only blocks that answer synchronously are compiled
  function call(block, schema, ex, values) {
    if (!schema.func)
      return undefined
    const scope = new FastScope(block, schema, ex, values)
    const r = schema.func.call(scope, ex.entity, scope)
    if (r instanceof Promise)
      throw new Error(`turbo: ${block.type} answered asynchronously`)
    return r
  }
  // the block's schema as it is now: AI and expansion modules replace theirs when they load
  const schemaOf = block => Entry.block[block.type]
  function callStatement(block, schema, ex, values) {
    const scope = new FastScope(block, schema, ex, values)
    const r = schema.func.call(scope, ex.entity, scope)
    if (r !== undefined && r !== null && r !== STATIC.PASS)
      throw new Error(`turbo: ${block.type} returned ${String(r)}`)
  }
  // a statement that only ever answers undefined or null (SYNC_STATEMENTS): its func, with the schema as it is now
  function callSync(block, ex, values) {
    const scope = new FastScope(block, schemaOf(block), ex, null)
    const r = invoke(scope, values)
    if (r !== undefined && r !== null && r !== STATIC.PASS)
      throw new Error(`turbo: ${block.type} returned ${String(r)}`)
  }
  // Scope.run for a statement: a Promise among the params waits for all of them (and the func then runs only if the
  // project still runs); otherwise the func runs at once. A func-less block does nothing.
  function invoke(scope, values) {
    const func = scope._schema && scope._schema.func
    if (!func)
      return undefined
    if (values.some(v => v instanceof Promise)) {
      return Promise.all(values).then((settled) => {
        if (Entry.engine.state === 'stop' || !scope.block)
          return undefined
        scope.values = settled
        return func.call(scope, scope.entity, scope)
      })
    }
    scope.values = values
    return func.call(scope, scope.entity, scope)
  }
  // Executor.execute on a Promise result: the executor pauses (Code.tick skips it); once the Promise settles it moves
  // on, unless it settled to CONTINUE or to the block's own scope (the block then runs again). An AsyncError leaves
  // the executor on the same block.
  function pause(ex, promise, scope) {
    const w = { done: false, again: false, error: null }
    ex.paused = true
    promise.then((v) => {
      ex.paused = false
      // Entry moves on only while the engine runs
      w.again = v === STATIC.CONTINUE || v === scope || !Entry.engine.isState('run')
      w.done = true
    }, (e) => {
      ex.paused = false
      if (e && e.name === 'AsyncError')
        w.again = true
      else
        w.error = e
      w.done = true
    })
    return w
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

  // lodash cloneDeep of a local-variable template (plain { name, value, id } objects)
  function cloneLocals(v) {
    try {
      return structuredClone(v)
    }
    catch {
      return JSON.parse(JSON.stringify(v))
    }
  }
  // A normal function the compiler did not take, run the way function_general's own func does it: a function executor
  // with the call's argument values and a copy of the local variables; while it does not end the caller yields, and on
  // every resume the call's arguments are evaluated again (again()), as Entry re-runs the call block. Its parent scope
  // is the call block's, so an error in the body points at the call.
  // Where Entry's function returns Promises, Entry pauses the caller and goes on a frame at a time; here the caller
  // pauses until they settle and the function goes on at the caller's next tick.
  function* entryFunction(id, ex, ent, callBlock, values, again) {
    stats.functionFallback++
    const func = Entry.variableContainer.getFunction(id)
    const code = func.content
    const fe = code.raiseEvent('funcDef', ent)[0]
    const scope = new Entry.Scope(callBlock, ex)
    scope.values = values
    scope.funcExecutor = fe
    fe.register.params = values
    fe.register.paramMap = func.paramMap
    fe.parentExecutor = ex
    fe.parentScope = scope
    fe.isFuncExecutor = true
    fe.localVariables = cloneLocals(func.localVariables)
    for (;;) {
      const { promises } = fe.execute()
      if (fe.isEnd()) {
        code.removeExecutor(fe)
        return
      }
      if (promises && promises.length) {
        const w = pause(ex, Promise.all(promises), null)
        while (!w.done)
          yield
        if (w.error)
          throw w.error
      }
      else {
        code.removeExecutor(fe)
        yield
      }
      if (again)
        again()
    }
  }

  // ── recursion on a stack of our own ──
  // A compiled function that can call itself (around any cycle of calls) is a generator whose calls into its own cycle
  // are not JS calls: it yields tcall(callee generator, again) and a driver runs the callee on an array stack, sending
  // its return value back into the yield. The browser's stack stays flat however deep the recursion goes; everything
  // else is the same as the nested JS calls it replaces:
  // - a real yield (bare `yield`, the end of the frame) passes out of the driver; on the resume, before the innermost
  //   function goes on, each call on the stack evaluates its arguments again, outermost first (again), the order the
  //   nested `while (!$g.next().done) { yield; again }` loops of plain call sites give;
  // - an error ends every function on the stack, like a JS exception through the nested calls; it is marked as coming
  //   from inside a function (see fail());
  // - past the depth limit it throws the RangeError a JS stack overflow would.
  const tcall = (g, again) => ({ $turboCall: g, again })
  function overflow() {
    const e = new RangeError('Maximum call stack size exceeded')
    e.$turboInFunction = true
    return e
  }
  function* run(first) {
    const stack = [first]
    const agains = [null]
    const limit = options.deepRecursion ? RECURSION_DEEP : RECURSION_LIMIT
    let send
    try {
      for (;;) {
        const r = stack.at(-1).next(send)
        send = undefined
        if (r.done) {
          stack.pop()
          agains.pop()
          if (!stack.length)
            return r.value
          send = r.value
        }
        else if (r.value && r.value.$turboCall) {
          if (stack.length >= limit)
            throw overflow()
          stack.push(r.value.$turboCall)
          agains.push(r.value.again)
          if (stack.length > stats.maxDepth)
            stats.maxDepth = stack.length
        }
        else {
          yield
          for (let i = 1; i < stack.length; i++) {
            if (agains[i])
              agains[i]()
          }
        }
      }
    }
    catch (e) {
      if (e && typeof e === 'object')
        e.$turboInFunction = true
      throw e
    }
  }
  // the driver for a function that never yields (all of its cycle ends in one pass): its return value
  function runSync(first) {
    const d = run(first)
    const r = d.next()
    if (!r.done)
      throw new Error('turbo: a recursive function that never yields yielded')
    return r.value
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
    callSync,
    invoke,
    pause,
    FastScope,
    schemaOf,
    PASS: STATIC.PASS,
    BREAK: STATIC.BREAK,
    weld,
    entryFunction,
    tcall,
    run,
    runSync,
    repeatError: () => Lang.Blocks.FLOW_repeat_basic_errorMsg,
    variable: (id, ent) => Entry.variableContainer.getVariable(id, ent),
    list: (id, ent) => Entry.variableContainer.getList(id, ent),
  }
  const RUNTIME_NAMES = Object.keys(R).join(', ')

  // ── compiler ──
  // c: { blocks, schemas, consts, vars, lists, loops, n, fn (a function body), yields (emitted a yield point) }
  // c.fn: the function being compiled (its plan record), null at the top level of a script. sites: statement calls,
  // left as placeholders until the call graph is solved; valueCalls: callees of value calls (vsites: the value calls,
  // placeholders too); scene: a scene change;
  // arity: parameters read (a0..); locals: local variables used (L0..); temps: the scratch variables the body uses.
  // Scratch variables are one set per function, declared once at its head ($s/$r/$w for a generic statement, $g for a
  // call site, $c<depth> for a repeat counter), never one per statement: V8 does not share slots between sibling
  // blocks, so per-statement declarations would grow every frame with the body and a recursive function would run
  // out of stack long before Entry does (issue #4).
  const context = fn => ({ blocks: [], schemas: [], consts: [], vars: new Map(), lists: new Map(), loops: [], n: 0, fn, yields: false, sites: [], valueCalls: new Set(), vsites: [], scene: false, arity: 0, locals: new Map(), temps: new Set() })
  // the head of a compiled body: the running block's index and the scratch variables
  const head = c => `let ${['$b = -1', ...c.temps].join(', ')};\n`
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
  const stable = p => !isBlock(p) || ['number', 'text', 'True', 'False', 'get_variable', 'get_func_variable'].includes(p.type)
    || ['function_param_string', 'function_param_boolean'].includes(baseOf(p.type))

  // every param evaluated in order, as Scope.getParams does, for a block run through its own func
  function args(c, b) {
    noteRefs(c, b)
    return `[${b.params.map(p => expr(c, p)).join(', ')}]`
  }

  // Blocks run through their own func without a per-block rule ("generic"): no statements of their own and nothing in
  // their source that reaches the executor or the call stack (checked on the page's code, so it holds per build).
  // Value blocks must also answer synchronously.
  const EXECUTOR_TOUCH = /\bexecutor\b|getStatement|stepInto|_callStack|isLooped|iterCount|isCondition|\.register\b|localVariables|parentExecutor|funcExecutor|funcCode|\.key\b/
  const ASYNC_HINT = /Promise|\basync\b|\bawait\b|\.then\(|regenerator|asyncToGenerator/
  const genericCache = new Map()
  // Blocks never taken generically whatever their source looks like: the ones that need a rule, and the value blocks
  // that can answer with a Promise (some look synchronous in the minified code). From ref/classify.json, a reading of
  // every non-hardware block of the web build 2026-09-27.
  // @classify-start
  const NOT_GENERIC = new Set([
    '_if',
    'ai_boolean_and',
    'ai_boolean_distance',
    'ai_if_else',
    'ai_if_else_1',
    'ai_repeat_until_reach',
    'check_block_execution',
    'check_city_finedust',
    'check_city_weather',
    'check_connected_camera',
    'check_cur_finddust',
    'check_cur_weather',
    'check_day_weather',
    'check_disaster_alert',
    'check_finedust',
    'check_language',
    'check_microphone',
    'check_object_property',
    'check_time_weather',
    'check_weather',
    'continue_repeat',
    'count_disaster_alert',
    'count_disaster_behavior',
    'count_disaster_guideline',
    'count_festival',
    'count_lifeSafety_behavior',
    'count_safety_accident_guideline',
    'count_social_disaster_guideline',
    'ebs_if',
    'ebs_if2',
    'function_create',
    'function_create_value',
    'function_general',
    'function_param_boolean',
    'function_param_string',
    'function_value',
    'get_block_count',
    'get_city_weather_data',
    'get_cluster_centriod_index_1',
    'get_cluster_centriod_index_2',
    'get_cluster_centriod_index_3',
    'get_cluster_centriod_index_4',
    'get_cluster_centriod_index_5',
    'get_cluster_centriod_index_6',
    'get_cur_weather',
    'get_cur_weather_data',
    'get_cur_wind',
    'get_current_city_weather_data',
    'get_current_weather_data',
    'get_day_weather',
    'get_day_weather_data',
    'get_disaster_alert',
    'get_disaster_behavior',
    'get_disaster_guideline',
    'get_festival_info',
    'get_func_variable',
    'get_lifeSafety_behavior',
    'get_logistic_regression_probability_1',
    'get_logistic_regression_probability_2',
    'get_logistic_regression_probability_3',
    'get_logistic_regression_probability_4',
    'get_logistic_regression_probability_5',
    'get_logistic_regression_probability_6',
    'get_microphone_volume',
    'get_number_learning_predict_1',
    'get_number_learning_predict_2',
    'get_number_learning_predict_3',
    'get_number_learning_predict_4',
    'get_number_learning_predict_5',
    'get_number_learning_predict_6',
    'get_number_learning_predict_param_1',
    'get_number_learning_predict_param_2',
    'get_number_learning_predict_param_3',
    'get_number_learning_predict_param_4',
    'get_number_learning_predict_param_5',
    'get_number_learning_predict_param_6',
    'get_predict_1',
    'get_predict_2',
    'get_predict_3',
    'get_predict_4',
    'get_predict_5',
    'get_predict_6',
    'get_regression_accuracy',
    'get_regression_predict_1',
    'get_regression_predict_2',
    'get_regression_predict_3',
    'get_regression_predict_4',
    'get_regression_predict_5',
    'get_regression_predict_6',
    'get_result_info',
    'get_safety_accident_guideline',
    'get_social_disaster_guideline',
    'get_time_weather',
    'get_time_weather_data',
    'get_today_city_temperature',
    'get_today_temperature',
    'get_translated_string',
    'get_weather_data',
    'if_else',
    'is_number_learning_group_1',
    'is_number_learning_group_2',
    'is_number_learning_group_3',
    'is_number_learning_group_4',
    'is_number_learning_group_5',
    'is_number_learning_group_6',
    'is_result_1',
    'is_result_2',
    'is_result_3',
    'is_result_4',
    'is_result_5',
    'is_result_6',
    'jr_if_construction',
    'jr_if_speed',
    'jr_repeat',
    'jr_repeat_until_dest',
    'maze_attack_both_side',
    'maze_attack_pepe',
    'maze_attack_peti',
    'maze_attack_yeti',
    'maze_call_function',
    'maze_define_function',
    'maze_repeat_until_1',
    'maze_repeat_until_10',
    'maze_repeat_until_11',
    'maze_repeat_until_12',
    'maze_repeat_until_13',
    'maze_repeat_until_14',
    'maze_repeat_until_15',
    'maze_repeat_until_2',
    'maze_repeat_until_3',
    'maze_repeat_until_4',
    'maze_repeat_until_5',
    'maze_repeat_until_6',
    'maze_repeat_until_7',
    'maze_repeat_until_8',
    'maze_repeat_until_9',
    'maze_repeat_until_beat_monster',
    'maze_repeat_until_goal',
    'maze_step_for',
    'maze_step_if_1',
    'maze_step_if_2',
    'maze_step_if_3',
    'maze_step_if_4',
    'maze_step_if_5',
    'maze_step_if_6',
    'maze_step_if_7',
    'maze_step_if_8',
    'maze_step_if_else',
    'maze_step_if_else_ladder',
    'maze_step_if_else_lupin',
    'maze_step_if_else_mushroom',
    'maze_step_if_else_road',
    'maze_step_if_left_monster',
    'maze_step_if_lupin',
    'maze_step_if_mushroom',
    'maze_step_if_right_monster',
    'maze_step_if_yeti',
    'maze_turn_left',
    'maze_turn_right',
    'media_pipe_motion_value',
    'repeat_basic',
    'repeat_inf',
    'repeat_while_true',
    'set_func_variable',
    'stop_object',
    'stop_repeat',
    'switch_scope',
    'video_body_part_coord',
    'video_detected_face_info',
    'video_face_part_coord',
    'video_is_model_loaded',
    'video_motion_value',
    'video_number_detect',
    'video_object_detected',
  ])
  // @classify-end
  // Statements whose func only ever answers undefined or null (next block): they run without the yield protocol, so
  // functions made of them stay plain JS. Same source.
  // @sync-start
  const SYNC_STATEMENTS = new Set([
    'add_effect_amount',
    'bounce_wall',
    'brush_erase_all',
    'brush_stamp',
    'change_brush_transparency',
    'change_effect_amount',
    'change_object_index',
    'change_opacity',
    'change_scale_percent',
    'change_scale_size',
    'change_thickness',
    'change_to_next_shape',
    'change_to_nth_shape',
    'change_to_some_shape',
    'check_lecture_goal',
    'choose_project_timer_action',
    'close_table_chart',
    'create_clone',
    'delete_row_from_table',
    'dialog',
    'direction_absolute',
    'direction_relative',
    'erase_all_effects',
    'flip_arrow_horizontal',
    'flip_arrow_vertical',
    'flip_x',
    'flip_y',
    'hidden',
    'hidden_if_else',
    'hidden_if_else2',
    'hidden_loop',
    'hidden_loop2',
    'hide',
    'hide_list',
    'hide_variable',
    'locate',
    'locate_to_face',
    'locate_to_hand',
    'locate_to_pose',
    'locate_x',
    'locate_xy',
    'locate_y',
    'message_cast',
    'move_direction',
    'move_to_angle',
    'move_x',
    'move_y',
    'open_table',
    'open_table_chart',
    'open_table_wait',
    'play_bgm',
    'read_text',
    'register_score',
    'remove_all_clones',
    'remove_dialog',
    'reset_project_timer',
    'reset_scale_size',
    'restart_project',
    'rotate_absolute',
    'rotate_by_angle',
    'rotate_by_angle_dropdown',
    'rotate_direction',
    'rotate_relative',
    'run',
    'save_current_table',
    'see_angle',
    'see_angle_direction',
    'see_angle_object',
    'see_direction',
    'set_brush_tranparency',
    'set_color',
    'set_decisiontree_option',
    'set_effect',
    'set_effect_amount',
    'set_effect_volume',
    'set_entity_effect',
    'set_fill_color',
    'set_kernel_option',
    'set_logistic_regression_optimizer',
    'set_logistic_regression_option',
    'set_object_order',
    'set_opacity',
    'set_random_color',
    'set_regression_option',
    'set_scale_percent',
    'set_scale_size',
    'set_svm_option',
    'set_thickness',
    'set_tts_property',
    'set_value_from_cell',
    'set_value_from_table',
    'set_visible_answer',
    'set_visible_project_timer',
    'set_visible_speech_to_text',
    'show',
    'show_list',
    'show_prompt',
    'show_variable',
    'sound_from_to',
    'sound_silent_all',
    'sound_something',
    'sound_something_second',
    'sound_something_second_with_block',
    'sound_something_with_block',
    'sound_speed_change',
    'sound_speed_set',
    'sound_volume_change',
    'sound_volume_set',
    'start_drawing',
    'start_fill',
    'start_neighbor_scene',
    'start_scene',
    'stop_bgm',
    'stop_drawing',
    'stop_fill',
    'stretch_scale_size',
    'test_wrapper',
    'text_append',
    'text_change_bg_color',
    'text_change_effect',
    'text_change_font',
    'text_change_font_color',
    'text_flush',
    'text_prepend',
    'text_write',
  ])
  // @sync-end
  // A block without a func is fine: Entry evaluates its params and moves on (a value is then undefined).
  function generic(type, kind) {
    const key = `${kind}:${type}`
    if (!genericCache.has(key)) {
      const schema = Entry.block[type]
      let ok = Boolean(schema) && !NOT_GENERIC.has(type) && !schema.statementsKeyMap && !(schema.statements && schema.statements.length)
      if (ok && schema.func) {
        const src = String(schema.func)
        ok = !EXECUTOR_TOUCH.test(src) && (kind === 'statement' || !ASYNC_HINT.test(src))
      }
      genericCache.set(key, ok)
    }
    return genericCache.get(key)
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

  // ── parameters, local variables, value calls (ref/functions-spec.md §3-5) ──
  // A parameter block returns the call's argument as it was evaluated, no conversion, looked up by block type in the
  // running function's paramMap (a missing entry gives undefined).
  function paramRead(c, p) {
    if (!c.fn)
      throw new Unsupported('parameter outside a function')
    if (!blockKnown(p.type))
      throw new Unsupported(`unchecked build: ${baseOf(p.type)}`)
    onlyBlocksAt(p, [])
    const i = c.fn.func.paramMap ? c.fn.func.paramMap[p.type] : undefined
    if (!Number.isInteger(i) || i < 0)
      return 'undefined'
    c.arity = Math.max(c.arity, i + 1)
    return `a${i}`
  }
  // a local variable: its index in the running function's template (first match by id), or -1 for another function's
  function localIndex(c, b) {
    if (!c.fn)
      throw new Unsupported('local variable outside a function')
    if (!blockKnown(b.type) || !isKnown('Func.getValue') || !isKnown('Func.setValue'))
      throw new Unsupported(`unchecked build: ${b.type}`)
    const id = field(b, 0)
    if (typeof id !== 'string' || !Entry.variableContainer.getFunction(id.split('_')[0]))
      throw new Unsupported('local variable id')
    const list = c.fn.func.localVariables
    if (!Array.isArray(list) || list.some(v => !v || typeof v !== 'object' || (typeof v.value === 'object' && v.value !== null)))
      throw new Unsupported('local variable list')
    return list.findIndex(v => v.id === id)
  }
  function localRef(c, i) {
    if (!c.locals.has(i))
      c.locals.set(i, `L${i}`)
    return c.locals.get(i)
  }
  // a value call: the callee must end in one pass (never yield), else Entry answers with a Promise (solve() checks)
  function valueCall(c, p) {
    if (!blockKnown(p.type) || !blockKnown('function_create_value'))
      throw new Unsupported('unchecked build: function_value')
    const G = plan(p.type.slice(5), 'value')
    if (G.failed)
      throw new Unsupported(`value function: ${G.reason}`)
    c.valueCalls.add(G)
    // left as a placeholder like a statement call: how it is called depends on the solved call graph (renderValue)
    c.vsites.push({ G, args: p.params.map(q => expr(c, q)) })
    return `\u0002${c.vsites.length - 1}\u0002`
  }

  function expr(c, p) {
    if (!isBlock(p))
      return literal(c, filterReserved(p))
    if (!Entry.block[p.type])
      throw new Unsupported(`unknown ${p.type}`)
    const base = baseOf(p.type)
    if (base === 'function_param_string' || base === 'function_param_boolean')
      return paramRead(c, p)
    if (base === 'function_value')
      return valueCall(c, p)
    if (p.type === 'get_func_variable') {
      onlyBlocksAt(p, [])
      const i = localIndex(c, p)
      // Func#getValue: `value || 0`, and 0 for an id the running function does not have
      return i < 0 ? '0' : `(${localRef(c, i)} || 0)`
    }
    if (options.inline && RULE_SET.has(p.type) && blockKnown(p.type)) {
      const code = inlineExpr(c, p)
      if (code !== null)
        return code
    }
    if (!TIER1_VALUES.has(p.type) && !generic(p.type, 'value'))
      throw new Unsupported(p.type)
    const a = args(c, p)
    const k = ref(c, p)
    return TIER1_VALUES.has(p.type) ? `call(B[${k}], S[${k}], ex, ${a})` : `call(B[${k}], schemaOf(B[${k}]), ex, ${a})`
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
    if (CONTROL.has(b.type) && !blockKnown(b.type))
      throw new Unsupported(`unchecked build: ${b.type}`)
    // a value function must not change scenes (Entry would end the consumer's executor under it)
    if (b.type === 'start_scene' || b.type === 'start_neighbor_scene')
      c.scene = true
    switch (b.type) {
      case 'repeat_basic': {
        onlyBlocksAt(b, [0])
        // a literal count that comes to 0: Entry leaves the loop at once, the body never runs and nothing yields
        const count = b.params[0]
        if (isBlock(count) && (count.type === 'number' || count.type === 'text') && !isBlock(count.params[0])) {
          const v = num(filterReserved(count.params[0]))
          if (v >= 0 && Math.floor(v) === 0)
            return s(at)
        }
        const value = expr(c, b.params[0])
        // Entry evaluates the count again each time it re-enters the loop block; skip that when it cannot matter
        const reEntry = stable(b.params[0]) ? '' : `$b = ${k};\n${value};\n`
        // one counter per nesting depth: loops at the same depth never run at the same time
        const cv = `$c${c.loops.length}`
        c.temps.add(cv)
        const body = loopBody(c, { label: `L${n}`, reEntry }, b, 0)
        return s(`${at}${cv} = num(${value});\nif (${cv} < 0) throw new Error(repeatError());\n${cv} = Math.floor(${cv});\n`
          + `L${n}: while (${cv} !== 0 && !(${cv} < 0)) {\n${cv}--;\n${body}${reEntry}}\n`)
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
        return s(`L${n}: while (true) {\n$b = ${k};\nif (${until ? '' : '!'}bool(${cond})) break;\n${body}}\n`)
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
      // Outside any loop of a normal function the stack unwinds to the definition block: stop_repeat returns from the
      // function, continue_repeat yields once and then returns. At the top level and in value functions: not compiled.
      case 'stop_repeat': {
        const loop = c.loops.at(-1)
        if (loop)
          return s(`break ${loop.label};\n`, false)
        if (c.fn && c.fn.kind === 'normal')
          return s('return;\n', false)
        throw new Unsupported('stop_repeat outside a loop')
      }
      case 'continue_repeat': {
        const loop = c.loops.at(-1)
        c.yields = true
        if (loop)
          return s(`yield;\n${loop.reEntry}continue ${loop.label};\n`, false)
        if (c.fn && c.fn.kind === 'normal')
          return s('yield;\nreturn;\n', false)
        throw new Unsupported('continue_repeat outside a loop')
      }
      case 'Talebot_Move': {
        const slot = b.params[1]
        const loop = c.loops.at(-1)
        if (!isBlock(slot) || slot.type !== 'continue_repeat' || !blockKnown('continue_repeat'))
          throw new Unsupported('Talebot_Move')
        if (!loop)
          throw new Unsupported('weld outside a loop')
        onlyBlocksAt(b, [1])
        onlyBlocksAt(slot, [])
        return s(`${at}if (!weld(B[${k}], S[${k}], ex, ${literal(c, field(b, 0))})) break ${loop.label};\n${loop.reEntry}continue ${loop.label};\n`, false)
      }
    }
    if (baseOf(b.type) === 'function_general') {
      // every param in order, the trailing Indicator too (a stale paramMap index may point at it); on each resume of a
      // yielding callee Entry evaluates them again and drops the results
      const id = b.type.slice(5)
      const argCodes = b.params.map(p => expr(c, p))
      const again = b.params.map((p, i) => (isBlock(p) && !stable(p) ? `${argCodes[i]};\n` : '')).join('')
      const G = options.functions && blockKnown(b.type) && blockKnown('function_create') ? plan(id, 'normal') : null
      c.sites.push({ G, id, k, args: argCodes, again, after })
      return s(`${at}\u0001${c.sites.length - 1}\u0001`)
    }
    if (b.type === 'set_func_variable') {
      onlyBlocksAt(b, [1])
      const value = expr(c, b.params[1])
      const i = localIndex(c, b)
      if (i < 0)
        throw new Unsupported('local variable of another function') // Entry: TypeError
      return s(`${at}${localRef(c, i)} = ${value};\n`)
    }
    if (options.inline && RULE_SET.has(b.type) && blockKnown(b.type)) {
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
    if (TIER1_STATEMENTS.has(b.type))
      return s(`${at}callStatement(B[${k}], S[${k}], ex, ${args(c, b)});\n${after}`)
    if (SYNC_STATEMENTS.has(b.type) && generic(b.type, 'statement'))
      return s(`${at}callSync(B[${k}], ex, ${args(c, b)});\n${after}`)
    // stop_object reads this.executor only for "otherThread", to spare itself; inside a function Entry's executor is
    // the function's own, so that case would differ there. Everything else it does is die() and clearing executors.
    const stopObject = b.type === 'stop_object' && blockKnown(b.type) && !(c.fn && field(b, 0) === 'otherThread')
    if (!stopObject && !generic(b.type, 'statement'))
      throw new Unsupported(b.type)
    // Executor.execute's handling of a block's result, for one execution of this statement: the params are evaluated
    // again on every run, like Scope.run; a thrown AsyncError is a BREAK (yield, run again); die() (the scope loses its
    // block) ends the script, or the function
    // $s/$r/$w are the function's scratch variables (see context): nothing between their uses here runs another
    // statement of this body, only its argument expressions and yields
    c.yields = true
    c.temps.add('$s').add('$r').add('$w')
    const a = args(c, b)
    return s(`${at}$s = new FastScope(B[${k}], schemaOf(B[${k}]), ex, null);\nfor (;;) {\n`
      + `try {\n$r = invoke($s, ${a});\n} catch (e) {\nif (e && e.name === 'AsyncError') { yield; continue; }\nthrow e;\n}\n`
      + `if ($s.block === null) return;\n`
      + `if ($r === undefined || $r === null || $r === PASS) break;\n`
      + `if ($r === $s || $r === BREAK) { yield; continue; }\n`
      + `if ($r instanceof Promise) {\n$w = pause(ex, $r, $s);\nwhile (!$w.done) yield;\nif ($w.error) throw $w.error;\nif ($w.again) continue;\nbreak;\n}\n`
      + `}\n${after}`)
  }

  const errorWrap = (c, body) => `${head(c)}try {\n${body}} catch (e) {\n`
    + `if (e && typeof e === 'object' && !e.$turboBlock) e.$turboBlock = B[$b];\nthrow e;\n}\n`
  const guardOf = (name, kind) => (kind === 'list' ? `!${name} || ${name}.isRealTime_ || ${name}.isCloud_` : `!${name} || ${name}.isRealTime_`)

  // ── statement calls ──
  // Once its callee is solved, a call site becomes: a plain call when the callee never yields; `yield*` when it yields
  // and evaluating the arguments again cannot matter; otherwise a loop that yields and evaluates the arguments again
  // before each resume, as Entry does; entryFunction when the callee is not compiled. A recursive callee (see run) is
  // a generator: from inside its own cycle the call goes on the driver's stack (tcall), from outside through a driver
  // (run, or runSync when the cycle never yields).
  const sameCycle = (c, G) => Boolean(c.fn && c.fn.rec && G.rec && G.scc === c.fn.scc)
  function renderCall(c, site) {
    const { G, id, k, after } = site
    const list = site.args.map(x => render(c, x))
    const again = render(c, site.again)
    // the arguments evaluated again from a closure (entryFunction, the driver): no yield in there, see renderValue
    const againFn = site.again ? `() => {\n${render(c, site.again, true)}}` : ''
    const a = list.length ? `, ${list.join(', ')}` : ''
    if (!G || G.failed)
      return `yield* entryFunction(${JSON.stringify(id)}, ex, ent, B[${k}], [${list.join(', ')}]${againFn ? `, ${againFn}` : ''});\n${after}`
    const callee = `FT.${G.name}(ex, ent${a})`
    if (sameCycle(c, G))
      return `yield tcall(${callee}, ${againFn || 'null'});\n${after}`
    if (!G.gen)
      return `${G.rec ? `runSync(${callee})` : callee};\n${after}`
    const g = G.rec ? `run(${callee})` : callee
    if (!again)
      return `yield* ${g};\n${after}`
    // $g: the function's scratch variable for a call site (see context); only argument expressions run while it is live
    c.temps.add('$g')
    return `$g = ${g};\nwhile (!$g.next().done) {\nyield;\n${again}}\n${after}`
  }
  // a value call: its callee never yields (solve() fails it otherwise), so a recursive one ends in one pass. Inside a
  // closure (inClosure: arguments evaluated again, see renderCall) a call into the own cycle cannot yield to the driver
  // and gets a driver of its own; the same calls happen in the same order.
  function renderValue(c, site, inClosure) {
    const callee = `FT.${site.G.name}(ex, ent${site.args.map(x => `, ${render(c, x, inClosure)}`).join('')})`
    if (sameCycle(c, site.G) && !inClosure)
      return `(yield tcall(${callee}, null))`
    return site.G.rec ? `runSync(${callee})` : callee
  }
  function render(c, code, inClosure = false) {
    // eslint-disable-next-line no-control-regex -- the placeholders statement() and valueCall() leave for calls
    return code.replace(/\u0001(\d+)\u0001|\u0002(\d+)\u0002/g, (_, i, j) => (i === undefined ? renderValue(c, c.vsites[Number(j)], inClosure) : renderCall(c, c.sites[Number(i)])))
  }

  // ── functions: plan, solve, link (ref/functions-spec.md §9.2) ──
  // plan() compiles a function's body once, its statement calls left as placeholders, and records what it needs.
  // solve() decides over the whole call graph which functions can yield, so recursion that never yields stays plain JS
  // recursion, and fails what Entry would run through Promises (a value call whose callee yields). link() writes the
  // call sites and builds each function: FT[name](ex, ent, a0, a1, ...).
  const FIELD_BLOCKS = new Set(['function_field_label', 'function_field_string', 'function_field_boolean'])
  // the definition's field chain: evaluated by Entry on every run of the definition, harmless only if it is all fields
  function fieldsOnly(p) {
    if (!isBlock(p))
      return true
    const base = baseOf(p.type)
    if (!FIELD_BLOCKS.has(p.type) && base !== 'function_param_string' && base !== 'function_param_boolean')
      return false
    return p.params.every(fieldsOnly)
  }
  function plan(id, kind) {
    let F = fns.get(id)
    if (F)
      return F // planned, being planned (a cycle: nothing about it is needed yet) or linked
    F = { id, kind, name: `f${fns.size}`, planning: true, failed: false, reason: '', linked: false, gen: false, scene: false, localYields: false, scc: null, rec: false, func: null, c: null, code: '', decl: '', objs: [], templates: [] }
    fns.set(id, F)
    try {
      const func = Entry.variableContainer.getFunction(id)
      if (!func || !func.content)
        throw new Unsupported('missing function')
      F.func = func
      const defType = kind === 'value' ? 'function_create_value' : 'function_create'
      const def = func.content.getEventMap('funcDef')?.[0]
      const pointer = def && def.pointer()
      if (!def || def.type !== defType || !blockKnown(defType) || pointer.length !== 4 || pointer[3] !== 0)
        throw new Unsupported('function definition')
      if (!fieldsOnly(def.params[0]))
        throw new Unsupported('function fields')
      const c = context(F)
      F.c = c
      const first = firstOf(def, 0)
      if (kind === 'value') {
        if (!first)
          throw new Unsupported('empty value function') // Entry answers with a Promise
        // the body, then VALUE, evaluated after it: it sees the final locals
        F.code = `${chain(c, first).code}return ${expr(c, def.params[3])};\n`
      }
      else if (first) {
        F.code = chain(c, first).code
      }
      else {
        c.yields = true // function_create steps into an empty thread: one yield
        F.code = 'yield;\n'
      }
      F.localYields = c.yields
      F.scene = c.scene
      // global variables and lists only, resolved once
      for (const [what, map] of [['variable', c.vars], ['list', c.lists]]) {
        for (const [vid, name] of map) {
          const o = what === 'list' ? Entry.variableContainer.getList(vid) : Entry.variableContainer.getVariable(vid)
          if (!o || o.isRealTime_ || o.isCloud_ || o.object_)
            throw new Unsupported(`function uses a ${what} that is local, real-time or missing`)
          F.decl += `const ${name} = V[${F.objs.length}];\n`
          F.objs.push(o)
        }
      }
      // each call starts its locals from the template's values (Entry deep-copies the template per call)
      F.templates = func.localVariables || []
    }
    catch (e) {
      F.failed = true
      F.reason = e instanceof Unsupported ? e.message : `error: ${e.message}`
      note(`function: ${F.reason}`)
      if (!(e instanceof Unsupported))
        console.error('[turbo] function failed to compile', e)
    }
    F.planning = false
    return F
  }
  // monotone: gen, scene and failed only ever turn true
  function solve() {
    for (let changed = true; changed;) {
      changed = false
      for (const F of fns.values()) {
        if (F.linked || F.failed || F.planning)
          continue
        const sites = F.c.sites
        const gen = F.localYields || sites.some(s => !s.G || s.G.failed || s.G.gen)
        const scene = F.scene || sites.some(s => !s.G || s.G.failed || s.G.scene)
        let reason = null
        if (F.kind === 'value' && gen)
          reason = 'value function that yields'
        else if (F.kind === 'value' && scene)
          reason = 'value function that changes scene'
        else if ([...F.c.valueCalls].some(G => G.failed || G.gen))
          reason = 'value call to a function that yields'
        if (reason) {
          F.failed = true
          F.reason = reason
          note(`function: ${reason}`)
          changed = true
        }
        else if (gen !== F.gen || scene !== F.scene) {
          F.gen = gen
          F.scene = scene
          changed = true
        }
      }
    }
  }
  // Which functions are recursive: the cycles of the call graph (Tarjan's strongly connected components, without JS
  // recursion) among the functions about to be linked. A cycle's functions are all planned by the same compile, since
  // planning one plans its callees, so they are linked together and never mix with ones linked before.
  function cycles() {
    const nodes = [...fns.values()].filter(F => !F.linked && !F.failed && !F.planning)
    const inGraph = new Set(nodes)
    const callees = F => [...F.c.sites.map(s => s.G), ...F.c.valueCalls].filter(G => G && inGraph.has(G))
    const index = new Map()
    const low = new Map()
    const open = []
    const onOpen = new Set()
    const visit = (F, work) => {
      index.set(F, index.size)
      low.set(F, index.get(F))
      open.push(F)
      onOpen.add(F)
      work.push({ F, out: callees(F), i: 0 })
    }
    for (const root of nodes) {
      if (index.has(root))
        continue
      const work = []
      visit(root, work)
      while (work.length) {
        const top = work.at(-1)
        if (top.i < top.out.length) {
          const G = top.out[top.i++]
          if (!index.has(G))
            visit(G, work)
          else if (onOpen.has(G))
            low.set(top.F, Math.min(low.get(top.F), index.get(G)))
          continue
        }
        work.pop()
        const F = top.F
        if (work.length)
          low.set(work.at(-1).F, Math.min(low.get(work.at(-1).F), low.get(F)))
        if (low.get(F) !== index.get(F))
          continue
        const scc = []
        let G
        do {
          G = open.pop()
          onOpen.delete(G)
          scc.push(G)
        } while (G !== F)
        const rec = scc.length > 1 || top.out.includes(F)
        for (const H of scc) {
          H.scc = scc
          H.rec = rec
        }
      }
    }
  }
  function link() {
    cycles()
    for (const F of fns.values()) {
      if (F.linked || F.failed || F.planning)
        continue
      const c = F.c
      const params = Array.from({ length: c.arity }, (_, i) => `, a${i}`).join('')
      const locals = [...c.locals].map(([i, name]) => `let ${name} = T[${i}].value;\n`).join('')
      const body = render(c, F.code) // before head(c): rendering a call site may add $g
      // an error from inside a function: Entry's function executor catches it first and reports a plain runtime error,
      // never the recursive-call warning its top-level executor adds for a RangeError (Executor.execute), see fail()
      const src = `const { ${RUNTIME_NAMES} } = R;\n${F.decl}return function${F.gen || F.rec ? '*' : ''} (ex, ent${params}) {\n${head(c)}${locals}`
        + `try {\n${body}} catch (e) {\nif (e && typeof e === 'object') e.$turboInFunction = true;\nthrow e;\n}\n};\n`
      // eslint-disable-next-line no-new-func -- the whole point: blocks become JS
      FT[F.name] = new Function('R', 'B', 'S', 'K', 'FT', 'V', 'T', src)(R, c.blocks, c.schemas, c.consts, FT, F.objs, F.templates)
      F.linked = true
      stats.functions++
      if (F.gen)
        stats.generators++
      if (F.rec)
        stats.recursive++
    }
  }

  // a top-level script: a factory (executor, entity) -> generator, resolving variables and lists for that entity
  function generate(hat) {
    const c = context(null)
    const body = chain(c, hat.getNextBlock()).code
    solve()
    if ([...c.valueCalls].some(G => G.failed || G.gen))
      throw new Unsupported('value call to a function that yields')
    link()
    const refs = [...[...c.vars].map(([id, name]) => [id, name, 'variable']), ...[...c.lists].map(([id, name]) => [id, name, 'list'])]
    const decl = refs.map(([id, name, kind]) => `const ${name} = ${kind}(${JSON.stringify(id)}, ent);\n`).join('')
    const guards = refs.map(([, name, kind]) => guardOf(name, kind))
    const src = `const { ${RUNTIME_NAMES} } = R;\nreturn function (ex, ent) {\n${decl}`
      + `${guards.length ? `if (${guards.join(' || ')}) return null;\n` : ''}`
      + `return (function* () {\n${errorWrap(c, render(c, body))}})();\n};\n`
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

  // a start block the compiler takes; the others are noted once each (the popup lists them)
  const seenHats = new WeakSet()
  // any start block whose func is only `return script.callReturn()` (checked on the page's source): the script runs
  // from the next block, exactly as when Entry runs the hat
  const HAT_SOURCE = /^function\s*(?:[\w$]+\s*)?\(\s*(?:[\w$]+\s*)?,\s*([\w$]+)\s*\)\s*\{\s*return\s+\1\.callReturn\(\)\s*(?:;\s*)?\}$/
  const hatCache = new Map()
  function plainHat(type) {
    if (!hatCache.has(type)) {
      const schema = Entry.block[type]
      hatCache.set(type, Boolean(schema && typeof schema.func === 'function' && HAT_SOURCE.test(String(schema.func))))
    }
    return hatCache.get(type)
  }
  function compilableHat(hat) {
    if ((HATS.has(hat.type) && blockKnown(hat.type)) || plainHat(hat.type))
      return true
    if (!seenHats.has(hat)) {
      seenHats.add(hat)
      note(`시작 블록 ${hat.type}`)
    }
    return false
  }

  // ── executor hook ──
  function start(ex) {
    if (ex.isFuncExecutor || ex._callStack.length)
      return null
    const hat = ex.scope && ex.scope.block
    if (!hat || !compilableHat(hat))
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
    if (e && e.name === 'RangeError' && !e.$turboInFunction)
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

  // forget compiled code (blocks may have been edited); stats start over
  function reset() {
    cache = new WeakMap()
    fns = new Map()
    FT = {}
    Object.assign(stats, newStats())
  }

  globalThis.EntryTurbo = {
    originalExecute,
    originalSetValue,
    fingerprints,
    stats,
    /** @returns {TurboEngine} what an unchecked Entry build switched off */
    engine: () => ({ coreKnown, deferKnown, unknown: [...unknown] }),
    /**
     * compile / deferViews ask for; each stays off on a build whose code was not checked
     * @param {TurboOptions} [opts]
     */
    enable(opts = {}) {
      Object.assign(options, DEFAULTS, opts)
      reset()
      proto.execute = options.compile && coreKnown ? turboExecute : originalExecute
      variableProto.setValue = options.deferViews && deferKnown ? deferredSetValue : originalSetValue
    },
    disable() {
      proto.execute = originalExecute
      variableProto.setValue = originalSetValue
      flushViews()
      reset()
    },
    reset,
    get options() {
      return { ...options }
    },
    get enabled() {
      return proto.execute === turboExecute || variableProto.setValue === deferredSetValue
    },
    get compiling() {
      return proto.execute === turboExecute
    },
    get deferring() {
      return variableProto.setValue === deferredSetValue
    },
    // every fingerprint this build has for the checked set (bench/fingerprints.js collects them into KNOWN)
    collectFingerprints() {
      for (const type of RULE_BLOCKS)
        blockKnown(type)
      return { ...fingerprints }
    },
    // compile every script of the loaded project now (normally that happens as each one first runs)
    check() {
      const t = performance.now()
      for (const obj of Entry.container.getAllObjects()) {
        for (const thread of obj.script.getThreads()) {
          const hat = thread.getFirstBlock()
          if (hat && compilableHat(hat) && !cache.has(hat))
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
  return globalThis.EntryTurbo
}

if (globalThis.Entry && globalThis.Entry.Executor)
  installEntryTurbo()
