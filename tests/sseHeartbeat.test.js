const { attachHeartbeat, KEEPALIVE_PAYLOAD } = require('../src/utils/sseHeartbeat')

describe('attachHeartbeat', () => {
  let res
  let writes

  beforeEach(() => {
    jest.useFakeTimers()
    writes = []
    res = {
      destroyed: false,
      writableEnded: false,
      socket: { destroyed: false },
      write: jest.fn((payload) => {
        writes.push(payload)
        return true
      })
    }
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('writes a keepalive comment when upstream is silent past the interval', () => {
    const handle = attachHeartbeat(res, { interval: 1000 })

    jest.advanceTimersByTime(999)
    expect(res.write).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1)
    expect(res.write).toHaveBeenCalledTimes(1)
    expect(writes[0]).toBe(KEEPALIVE_PAYLOAD)

    jest.advanceTimersByTime(1000)
    expect(res.write).toHaveBeenCalledTimes(2)
    expect(writes[1]).toBe(KEEPALIVE_PAYLOAD)

    handle.stop()
  })

  it('does not write a keepalive when markData() was called recently', () => {
    const handle = attachHeartbeat(res, { interval: 1000 })

    jest.advanceTimersByTime(900)
    handle.markData() // upstream activity, reset idle window

    jest.advanceTimersByTime(900)
    expect(res.write).not.toHaveBeenCalled()

    jest.advanceTimersByTime(200) // total 1100ms since markData → keepalive fires
    expect(res.write).toHaveBeenCalledTimes(1)
    expect(writes[0]).toBe(KEEPALIVE_PAYLOAD)

    handle.stop()
  })

  it('stops sending keepalives after stop()', () => {
    const handle = attachHeartbeat(res, { interval: 1000 })

    jest.advanceTimersByTime(1000)
    expect(res.write).toHaveBeenCalledTimes(1)

    handle.stop()
    jest.advanceTimersByTime(5000)
    expect(res.write).toHaveBeenCalledTimes(1)
  })

  it('is idempotent when stop() is called multiple times', () => {
    // W1: the same handle is armed early (api.js) and handed into the relay, so
    // stop() can fire from several exit paths (res 'close' + relay end/error/abort).
    // Redundant stop() calls must be safe no-ops and never resurrect the timer.
    const handle = attachHeartbeat(res, { interval: 1000 })

    jest.advanceTimersByTime(1000)
    expect(res.write).toHaveBeenCalledTimes(1)

    handle.stop()
    handle.stop()
    handle.stop()

    jest.advanceTimersByTime(5000)
    expect(res.write).toHaveBeenCalledTimes(1)
  })

  it('skips writes once the response is destroyed', () => {
    const handle = attachHeartbeat(res, { interval: 1000 })

    res.destroyed = true
    jest.advanceTimersByTime(2000)
    expect(res.write).not.toHaveBeenCalled()

    handle.stop()
  })

  it('skips writes once the underlying socket is destroyed', () => {
    const handle = attachHeartbeat(res, { interval: 1000 })

    res.socket.destroyed = true
    jest.advanceTimersByTime(2000)
    expect(res.write).not.toHaveBeenCalled()

    handle.stop()
  })

  it('logs each keepalive when a logger is supplied', () => {
    const logger = { info: jest.fn(), warn: jest.fn() }
    const handle = attachHeartbeat(res, { interval: 1000, logger, label: 'test' })

    jest.advanceTimersByTime(1000)
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info.mock.calls[0][0]).toMatch(/💓 Sent SSE keepalive \[test\]/)

    handle.stop()
  })

  it('stops itself if res.write throws', () => {
    const logger = { info: jest.fn(), warn: jest.fn() }
    res.write = jest.fn(() => {
      throw new Error('socket closed')
    })
    const handle = attachHeartbeat(res, { interval: 1000, logger })

    jest.advanceTimersByTime(1000)
    expect(res.write).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(5000)
    expect(res.write).toHaveBeenCalledTimes(1) // no further writes after stop

    handle.stop()
  })
})
