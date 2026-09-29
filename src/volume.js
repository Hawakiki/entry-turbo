/* exported installEntryVolume */
// Master volume (experimental). Every Entry sound goes through createjs.Sound's WebAudio plugin: the sound's own gain
// (Entry's volume blocks set it per sound), the plugin's gain (Entry sets it back to 1 at each start) and its
// compressor, then the speakers. A gain of our own goes after that compressor, so the project's volume and what its
// volume block reports stay as they are; only what reaches the speakers changes.
// "Loud sounds down" measures the level coming out (RMS over the last ~40 ms, sampled every 100 ms) and, above a
// target, turns our gain down quickly and back up slowly. It never boosts. A rough stand-in for loudness normalization:
// not LUFS (no ear weighting, no long-term integration), a level for sounds that start and stop while playing.
// Defines installEntryVolume(); the extension's main.js calls it.

/**
 * @typedef {object} EntryVolume
 * @property {(percent: number, limit: boolean) => void} set Master volume 0-100 and the loud-sound limiter.
 * @property {boolean} supported The page plays sound through the WebAudio plugin.
 * @property {number} level The master volume, 0-1.
 * @property {number} reduction How much the limiter turns down now, in dB (0 or less).
 */
/** @returns {EntryVolume} the knob main.js turns */
function installEntryVolume() {
  const TARGET_DB = -18 // RMS level the limiter aims at
  let ctx = null
  let out = null
  let analyser = null
  let data = null
  let level = 1
  let limit = false
  let agc = 1
  let timer = 0

  const plugin = () => {
    const S = window.createjs && window.createjs.Sound
    return S && S.activePlugin
  }
  const usable = p => Boolean(p && p.context && p.dynamicsCompressorNode && typeof p.context.createGain === 'function')

  // compressor -> our gain -> speakers; the analyser listens before our gain, so the slider does not move the level it
  // measures
  function install() {
    const p = plugin()
    if (!usable(p))
      return false
    ctx = p.context
    out = ctx.createGain()
    analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    data = new Float32Array(analyser.fftSize)
    const last = p.dynamicsCompressorNode
    last.disconnect()
    last.connect(out)
    last.connect(analyser)
    out.connect(ctx.destination)
    return true
  }
  function applyGain() {
    if (out)
      out.gain.setTargetAtTime(level * agc, ctx.currentTime, 0.03)
  }
  function measure() {
    analyser.getFloatTimeDomainData(data)
    let sum = 0
    for (const x of data)
      sum += x * x
    const rms = Math.sqrt(sum / data.length)
    const want = rms > 1e-6 && 20 * Math.log10(rms) > TARGET_DB ? 10 ** ((TARGET_DB - 20 * Math.log10(rms)) / 20) : 1
    // down fast (a loud sound starting), up slowly (so a pause does not bring the next one in at full blast)
    agc += (want - agc) * (want < agc ? 0.6 : 0.05)
    applyGain()
  }

  function set(percent, lim) {
    const n = Number(percent)
    level = Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : 1
    limit = Boolean(lim)
    // untouched until asked for: at 100% without the limiter the page's audio stays exactly as it was
    if (!out && (level !== 1 || limit) && !install())
      return // the plugin is not there yet; main.js asks again
    if (!out)
      return
    if (limit && !timer)
      timer = setInterval(measure, 100)
    if (!limit && timer) {
      clearInterval(timer)
      timer = 0
      agc = 1
    }
    applyGain()
  }
  return {
    set,
    get supported() {
      return usable(plugin())
    },
    get level() {
      return level
    },
    get reduction() {
      return limit ? 20 * Math.log10(Math.max(agc, 1e-6)) : 0
    },
  }
}
