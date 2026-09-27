/* global Entry */
/* exported installEntryOsd */
// On-screen display over the corner of the stage, in the style of RivaTuner's OSD (the one MSI Afterburner shows):
// mode, frame rate, engine ticks, script time per tick with a graph, heap, and what turbo compiled.
// It only measures: script time is the time spent in Entry.Code#tick, summed over one engine tick (the objects' ticks
// run back to back inside the engine's timer callback, so a microtask after the first one closes the tick).
// Defines installEntryOsd(); the extension's main.js calls it after installing turbo (turbo fingerprints Code#tick
// before this wraps it).
function installEntryOsd() {
  const HISTORY = 150
  const BUDGET = 1000 / 60
  const ticks = [] // script ms per engine tick, newest last
  let tickOpen = false
  let tickMs = 0
  let tickCount = 0
  let frames = 0
  let visible = false
  let el = null
  let graph = null
  let last = { at: performance.now(), ticks: 0, frames: 0, fps: 0, tps: 0 }

  // ── measuring ──
  const codeProto = Entry.Code.prototype
  const tick = codeProto.tick
  codeProto.tick = function (...args) {
    if (!visible)
      return tick.apply(this, args)
    const t = performance.now()
    try {
      return tick.apply(this, args)
    }
    finally {
      tickMs += performance.now() - t
      if (!tickOpen) {
        tickOpen = true
        queueMicrotask(closeTick)
      }
    }
  }
  function closeTick() {
    ticks.push(tickMs)
    if (ticks.length > HISTORY)
      ticks.shift()
    tickCount++
    tickMs = 0
    tickOpen = false
  }
  function frame() {
    if (!visible)
      return
    frames++
    requestAnimationFrame(frame)
  }

  // ── drawing ──
  const STYLE = `
    #entry-turbo-osd { position: fixed; z-index: 2147483647; pointer-events: none; padding: 5px 8px 6px; transform-origin: 0 0;
      background: rgba(0, 0, 0, 0.6); border-radius: 4px;
      font: bold 12px/1.35 Consolas, 'D2Coding', monospace; color: #fff; white-space: pre;
      text-shadow: 1px 0 #000, -1px 0 #000, 0 1px #000, 0 -1px #000, 1px 1px #000; }
    #entry-turbo-osd .k { color: #ffa726; }
    #entry-turbo-osd .u { color: #c8c8c8; font-weight: normal; }
    #entry-turbo-osd .on { color: #7ee07e; }
    #entry-turbo-osd .off { color: #9e9e9e; }
    #entry-turbo-osd .b { color: #5ad7ff; }
    #entry-turbo-osd .hot { color: #ff6b6b; }
    #entry-turbo-osd canvas { position: static !important; display: block !important; margin: 4px 0 0 !important;
      width: 150px !important; height: 34px !important; transform: none !important; }`
  function build() {
    const style = document.createElement('style')
    style.textContent = STYLE
    document.head.appendChild(style)
    el = document.createElement('div')
    el.id = 'entry-turbo-osd'
    graph = document.createElement('canvas')
    graph.width = HISTORY
    graph.height = 34
    document.body.appendChild(el)
  }
  const pad = (s, n) => String(s).padStart(n)
  function stage() {
    const c = document.getElementById('entryCanvas')
    const r = c && c.getBoundingClientRect()
    return r && r.width > 40 ? r : null
  }
  function render() {
    if (!visible)
      return
    const now = performance.now()
    const dt = (now - last.at) / 1000
    if (dt >= 0.5) {
      last = { at: now, ticks: tickCount, frames, fps: (frames - last.frames) / dt, tps: (tickCount - last.ticks) / dt }
    }
    // in fullscreen only the fullscreen element's subtree is drawn (the player makes Entry's container fullscreen):
    // live inside it then, and back in the body after Esc
    const host = document.fullscreenElement || document.webkitFullscreenElement || document.body
    if (el.parentElement !== host)
      host.appendChild(el)
    const r = stage()
    if (!r) {
      el.style.display = 'none'
      return
    }
    el.style.display = ''
    el.style.left = `${Math.round(r.left + 4)}px`
    el.style.top = `${Math.round(r.top + 4)}px`
    // grows with the stage (fullscreen), up to twice the size
    el.style.transform = `scale(${Math.min(2, Math.max(1, r.width / 900)).toFixed(2)})`

    const running = Entry.engine && Entry.engine.state === 'run'
    const recent = ticks.slice(-30)
    const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0
    const load = Math.round((avg / BUDGET) * 100)
    const turbo = globalThis.EntryTurbo
    const on = turbo && turbo.compiling
    const s = turbo ? turbo.stats : null
    const others = s ? Object.entries(s.reasons).filter(([k]) => k.startsWith('시작 블록')).reduce((n, [, c]) => n + c, 0) : 0
    const heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null
    const lines = [
      `<span class="k">TURBO </span> ${on ? '<span class="on">ON </span>' : '<span class="off">OFF</span>'}${turbo && turbo.deferring ? ' <span class="u">VIEW</span>' : ''}${Entry.isTurbo ? ' <span class="b">BOOST</span>' : ''}`,
      `<span class="k">FPS   </span> ${pad(Math.round(last.fps), 4)}`,
      `<span class="k">TICK  </span> ${pad(running ? Math.round(last.tps) : 0, 4)} <span class="u">/s</span>`,
      `<span class="k">SCRIPT</span> ${pad(avg.toFixed(2), 6)} <span class="u">ms</span> ${load > 100 ? `<span class="hot">${load}%</span>` : `${load}%`}`,
    ]
    if (heap !== null)
      lines.push(`<span class="k">RAM   </span> ${pad(heap, 4)} <span class="u">MB</span>`)
    if (on && s)
      lines.push(`<span class="k">JIT   </span> ${pad(`${s.compiled}/${s.compiled + s.fallback + others}`, 5)} <span class="u">fn</span> ${s.functions}`)
    el.innerHTML = lines.join('\n')
    el.appendChild(graph)
    drawGraph()
  }
  function drawGraph() {
    const g = graph.getContext('2d')
    const w = graph.width
    const h = graph.height
    // two frames' budget, or more when the ticks run longer, so the line never sticks to the top
    const top = Math.max(BUDGET * 2, ...ticks) * 1.1
    g.clearRect(0, 0, w, h)
    g.strokeStyle = 'rgba(255, 255, 255, 0.2)'
    g.strokeRect(0.5, 0.5, w - 1, h - 1)
    g.strokeStyle = 'rgba(255, 255, 255, 0.45)'
    g.setLineDash([3, 3])
    g.beginPath()
    g.moveTo(0, h - (BUDGET / top) * h + 0.5)
    g.lineTo(w, h - (BUDGET / top) * h + 0.5)
    g.stroke()
    g.setLineDash([])
    g.lineWidth = 1.5
    g.strokeStyle = '#ffa726'
    g.beginPath()
    ticks.forEach((ms, i) => {
      const x = w - ticks.length + i
      const y = h - Math.min(ms / top, 1) * h
      if (i)
        g.lineTo(x, y)
      else
        g.moveTo(x, y)
    })
    g.stroke()
  }

  let timer = null
  function show(on) {
    if (on === visible)
      return
    visible = on
    if (on) {
      if (!el) {
        build()
        document.addEventListener('fullscreenchange', render)
        document.addEventListener('webkitfullscreenchange', render)
      }
      el.style.display = ''
      requestAnimationFrame(frame)
      timer = setInterval(render, 250)
      render()
    }
    else {
      clearInterval(timer)
      if (el)
        el.style.display = 'none'
    }
  }
  return { show }
}
