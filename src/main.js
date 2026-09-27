/* global Entry, installEntryTurbo */
// Extension, page side (MAIN world, every playentry.org frame). Waits for Entry in this frame, installs the compiler,
// follows the popup's settings (through bridge.js) and answers status requests.
// Settings change only while the project is stopped: switching the executor mid-run would restart compiled scripts.
(() => {
  const PAGE = 'entry-turbo-page'
  const BRIDGE = 'entry-turbo-bridge'
  let turbo = null
  let wanted = { enabled: true, compile: true, deferViews: true }
  let applied = null

  const key = () => JSON.stringify(wanted)
  function apply() {
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

  const ready = () => window.Entry && Entry.Executor && Entry.Variable && Entry.Scope && Entry.Code && Entry.block && Entry.engine && Entry.engine.toggleRun
  const since = Date.now()
  const wait = setInterval(() => {
    if (!ready()) {
      if (Date.now() - since > 180000)
        clearInterval(wait)
      return
    }
    clearInterval(wait)
    turbo = installEntryTurbo()
    hookRun()
    window.postMessage({ source: PAGE, type: 'ready' }, '*')
    apply()
    setInterval(apply, 500)
  }, 250)
})()
