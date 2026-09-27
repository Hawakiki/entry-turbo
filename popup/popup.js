// Popup: the switches (chrome.storage, read by bridge.js in each playentry.org frame) and what the active tab's
// Entry is doing, refreshed every second.
const DEFAULTS = { enabled: true, compile: true, deferViews: true }
const KEYS = Object.keys(DEFAULTS)
const $ = id => document.getElementById(id)

chrome.storage.local.get(DEFAULTS, (settings) => {
  for (const k of KEYS)
    $(k).checked = settings[k]
  syncSubs()
})
for (const k of KEYS) {
  $(k).addEventListener('change', () => {
    chrome.storage.local.set({ [k]: $(k).checked })
    syncSubs()
  })
}
function syncSubs() {
  for (const k of ['compile', 'deferViews'])
    $(k).disabled = !$('enabled').checked
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}
const row = (name, value) => `<tr><td>${name}</td><td>${value}</td></tr>`

function render(st) {
  const s = st.stats
  const reasons = Object.entries(s.reasons).sort((a, b) => b[1] - a[1])
  const hats = reasons.filter(([r]) => r.startsWith('시작 블록')).reduce((n, [, c]) => n + c, 0)
  const blocks = reasons.filter(([r]) => !r.startsWith('시작 블록'))
  const on = [st.compiling && '컴파일', st.deferring && '표시 모으기'].filter(Boolean)
  const unknown = st.engine.unknown
  let html = '<table>'
  html += row('실행', `${st.state === 'run' ? '실행 중' : st.state === 'pause' ? '일시정지' : '멈춤'} · 부스트 ${st.boost ? '켬' : '꺼짐'}`)
  html += row('적용 중', on.length ? `<span class="ok">${on.join(' · ')}</span>` : '없음 (원래 방식)')
  if (st.pending)
    html += row('', '<span class="warn">바꾼 설정은 멈추면 적용됩니다</span>')
  html += row('엔진', st.engine.coreKnown ? '<span class="ok">확인된 버전</span>' : '<span class="warn">확인 안 된 버전: 컴파일 꺼짐</span>')
  if (unknown.length)
    html += row('', `<span class="warn">확인 안 된 블록 ${unknown.length}개는 원래 방식</span>`)
  if (st.compiling) {
    html += row('스크립트', `컴파일 ${s.compiled} · 원래 방식 ${s.fallback + hats}`)
    html += row('함수', `${s.functions}개${s.generators ? ` (양보하는 것 ${s.generators})` : ''}${s.functionFallback ? ` · 원래 방식 호출 ${s.functionFallback}` : ''}`)
  }
  html += '</table>'
  if (st.compiling && reasons.length) {
    html += '<p class="muted">원래 방식으로 도는 이유 (많은 순)</p><ul>'
    for (const [r, c] of [...blocks.slice(0, 6), ...reasons.filter(([x]) => x.startsWith('시작 블록')).slice(0, 3)])
      html += `<li><code>${escape(r)}</code> ${c}</li>`
    html += '</ul>'
  }
  if (st.compiling && !s.compiled && !s.fallback && !hats)
    html += '<p class="muted">아직 실행 전입니다. 시작하면 집계됩니다.</p>'
  $('status').innerHTML = html
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) {
    return
  }
  chrome.tabs.sendMessage(tab.id, { type: 'status' }, (st) => {
    if (chrome.runtime.lastError || !st) {
      $('status').innerHTML = '<p class="muted">이 탭에서 엔트리를 찾지 못했습니다. playentry.org 작품이나 만들기 화면을 열고, 불러올 때까지 기다려 주세요.</p>'
      return
    }
    render(st)
  })
}
refresh()
setInterval(refresh, 1000)
