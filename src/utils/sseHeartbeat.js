/**
 * SSE Heartbeat Utility
 *
 * Keeps long-running SSE connections alive when the upstream stays silent
 * (e.g. Claude thinking >120s) so intermediaries like Cloudflare don't
 * close the connection with 524.
 *
 * Pattern mirrors src/handlers/geminiHandlers.js (HEARTBEAT_INTERVAL=15000
 * + lastDataTime + setInterval).
 */

const DEFAULT_INTERVAL = 15000
const KEEPALIVE_PAYLOAD = ': heartbeat\n\n'

/**
 * Attach an SSE keepalive heartbeat to a writable response stream.
 *
 * @param {import('http').ServerResponse} res
 * @param {Object} [options]
 * @param {number} [options.interval=15000] - Idle threshold in ms; also the timer cadence.
 * @param {Object} [options.logger] - Logger with .info/.warn methods.
 * @param {string} [options.label] - Optional label included in the keepalive log line.
 * @returns {{ markData: () => void, stop: () => void }}
 */
function attachHeartbeat(res, options = {}) {
  const interval = options.interval || DEFAULT_INTERVAL
  const log = options.logger
  const label = options.label ? ` [${options.label}]` : ''

  let lastDataTime = Date.now()
  let timer = null

  const isWritable = () => {
    if (!res || res.destroyed || res.writableEnded) {
      return false
    }
    if (res.socket && res.socket.destroyed) {
      return false
    }
    return true
  }

  const tick = () => {
    if (!isWritable()) {
      stop()
      return
    }
    const gap = Date.now() - lastDataTime
    if (gap < interval) {
      return
    }
    try {
      res.write(KEEPALIVE_PAYLOAD)
      lastDataTime = Date.now()
      if (log && typeof log.info === 'function') {
        log.info(`💓 Sent SSE keepalive${label} (gap: ${(gap / 1000).toFixed(1)}s)`)
      }
    } catch (err) {
      if (log && typeof log.warn === 'function') {
        log.warn(`⚠️ Failed to send SSE keepalive${label}: ${err.message}`)
      }
      stop()
    }
  }

  const markData = () => {
    lastDataTime = Date.now()
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  timer = setInterval(tick, interval)
  if (typeof timer.unref === 'function') {
    timer.unref()
  }

  return { markData, stop }
}

module.exports = {
  attachHeartbeat,
  DEFAULT_INTERVAL,
  KEEPALIVE_PAYLOAD
}
