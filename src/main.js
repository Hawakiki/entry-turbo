/* global Entry, installEntryTurbo, installEntryOsd, installEntrySmooth */
// Extension, page side (MAIN world, every playentry.org frame). Waits for Entry in this frame, installs the compiler
// and the on-screen display, follows the popup's settings (through bridge.js) and answers status requests.
// Compiler settings change only while the project is stopped: switching the executor mid-run would restart compiled
// scripts. The display switches at once.

/**
 * The answer to the popup's status request (popup/popup.js renders it). Only `installed` is there before Entry is.
 * @typedef {object} TurboStatus
 * @property {boolean} installed The compiler is installed in this frame.
 * @property {string} [url] This frame's address.
 * @property {string} [type] Entry.type: 'workspace', 'minimize' (player) ...
 * @property {'run' | 'pause' | 'stop'} [state] Entry.engine.state.
 * @property {boolean} [boost] Entry.isTurbo (the site's boost mode).
 * @property {boolean} [compiling] Compiled scripts are running (EntryTurbo.compiling).
 * @property {boolean} [deferring] Variable views are deferred (EntryTurbo.deferring).
 * @property {{on: boolean, supported: boolean} | null} [smooth] Smooth drawing; null when smooth.js is missing.
 * @property {TurboSettings} [wanted] The switches as last received from bridge.js.
 * @property {boolean} [pending] Compiler switches changed and wait for the project to stop.
 * @property {TurboEngine} [engine] What an unchecked build switched off (src/turbo.js).
 * @property {TurboStats} [stats] Counts since the last run from stop (src/turbo.js).
 */

(() => {
  const PAGE = 'entry-turbo-page'
  const BRIDGE = 'entry-turbo-bridge'
  let turbo = null
  let osd = null
  /** @type {EntrySmooth | null} (src/smooth.js) */
  let smooth = null
  /** @type {TurboSettings} (src/bridge.js) */
  let wanted = { enabled: true, compile: true, deferViews: true, osd: true, smooth: false }
  let applied = null

  const key = () => JSON.stringify([wanted.enabled, wanted.compile, wanted.deferViews])
  function apply() {
    if (osd)
      osd.show(Boolean(wanted.osd))
    if (smooth)
      smooth.set(Boolean(wanted.smooth))
    if (!turbo || Entry.engine.state !== 'stop' || key() === applied)
      return
    if (wanted.enabled)
      turbo.enable({ compile: wanted.compile, deferViews: wanted.deferViews })
    else
      turbo.disable()
    applied = key()
  }

  // a run that starts from stop: take pending settings, forget code compiled from blocks that may have been edited
  function hookRun() {
    const engine = Entry.engine
    const toggleRun = engine.toggleRun
    engine.toggleRun = function (...args) {
      if (this.state === 'stop') {
        apply()
        turbo.reset()
      }
      return toggleRun.apply(this, args)
    }
  }

  /** @returns {TurboStatus} what the popup shows for this frame */
  function status() {
    if (!turbo)
      return { installed: false }
    return {
      installed: true,
      url: location.href,
      type: Entry.type,
      state: Entry.engine.state,
      boost: Boolean(Entry.isTurbo),
      compiling: turbo.compiling,
      deferring: turbo.deferring,
      smooth: smooth ? { on: smooth.on, supported: smooth.supported } : null,
      wanted,
      pending: key() !== applied,
      engine: turbo.engine(),
      stats: JSON.parse(JSON.stringify(turbo.stats)),
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== BRIDGE)
      return
    if (e.data.type === 'settings') {
      wanted = { ...wanted, ...e.data.settings }
      apply()
    }
    else if (e.data.type === 'status') {
      window.postMessage({ source: PAGE, type: 'status', id: e.data.id, status: status() }, '*')
    }
  })

  const ready = () => window.Entry && Entry.stage && Entry.container && Entry.Executor && Entry.Variable && Entry.Scope && Entry.Code && Entry.block && Entry.engine && Entry.engine.toggleRun
  const since = Date.now()
  const wait = setInterval(() => {
    if (!ready()) {
      if (Date.now() - since > 180000)
        clearInterval(wait)
      return
    }
    clearInterval(wait)
    turbo = installEntryTurbo()
    osd = typeof installEntryOsd === 'function' ? installEntryOsd() : null
    smooth = typeof installEntrySmooth === 'function' ? installEntrySmooth() : null
    globalThis.EntrySmooth = smooth
    hookRun()
    window.postMessage({ source: PAGE, type: 'ready' }, '*')
    apply()
    setInterval(apply, 500)
  }, 250)
})()
