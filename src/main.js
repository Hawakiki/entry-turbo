/* global Entry, installEntryTurbo, installEntryOsd, installEntrySmooth */
// Extension, page side (MAIN world, every playentry.org frame). Waits for Entry in this frame, installs the compiler
// and the on-screen display, follows the popup's settings (through bridge.js) and answers status requests.
// Compiler settings change only while the project is stopped: switching the executor mid-run would restart compiled
// scripts. The display switches at once.
(() => {
  const PAGE = 'entry-turbo-page'
  const BRIDGE = 'entry-turbo-bridge'
  let turbo = null
  let osd = null
  let smooth = null
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
