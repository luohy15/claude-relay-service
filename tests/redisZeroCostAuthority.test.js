jest.mock(
  '../config/config',
  () => ({
    system: {
      timezoneOffset: 8,
      metricsWindow: 5
    }
  }),
  { virtual: true }
)

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

const redis = require('../src/models/redis')

function createPipeline() {
  const calls = []
  const pipeline = {
    hincrby: jest.fn((key, field, value) => {
      calls.push(['hincrby', key, field, value])
      return pipeline
    }),
    expire: jest.fn(() => pipeline),
    sadd: jest.fn(() => pipeline),
    del: jest.fn(() => pipeline),
    exec: jest.fn(async () => [])
  }
  return { pipeline, calls }
}

describe('redis zero-cost authority writes', () => {
  afterEach(() => {
    redis.client = null
  })

  test('writes realCostMicro/ratedCostMicro for daily and hourly even when zero', async () => {
    const { pipeline, calls } = createPipeline()
    redis.client = { pipeline: jest.fn(() => pipeline) }

    await redis.incrementTokenUsage(
      'key-1',
      10,
      6,
      4,
      0,
      0,
      'claude-sonnet-4-5-20250929',
      0,
      0,
      false,
      0,
      0
    )

    const costWrites = calls.filter(
      ([op, key, field]) =>
        op === 'hincrby' &&
        (field === 'realCostMicro' || field === 'ratedCostMicro') &&
        (key.includes(':model:daily:') || key.includes(':model:hourly:'))
    )

    const dailyReal = costWrites.find(
      ([, key, field]) => key.includes(':model:daily:') && field === 'realCostMicro'
    )
    const dailyRated = costWrites.find(
      ([, key, field]) => key.includes(':model:daily:') && field === 'ratedCostMicro'
    )
    const hourlyReal = costWrites.find(
      ([, key, field]) => key.includes(':model:hourly:') && field === 'realCostMicro'
    )
    const hourlyRated = costWrites.find(
      ([, key, field]) => key.includes(':model:hourly:') && field === 'ratedCostMicro'
    )

    expect(dailyReal).toEqual([
      'hincrby',
      expect.stringContaining(':model:daily:'),
      'realCostMicro',
      0
    ])
    expect(dailyRated).toEqual([
      'hincrby',
      expect.stringContaining(':model:daily:'),
      'ratedCostMicro',
      0
    ])
    expect(hourlyReal).toEqual([
      'hincrby',
      expect.stringContaining(':model:hourly:'),
      'realCostMicro',
      0
    ])
    expect(hourlyRated).toEqual([
      'hincrby',
      expect.stringContaining(':model:hourly:'),
      'ratedCostMicro',
      0
    ])
    expect(pipeline.exec).toHaveBeenCalled()
  })

  test('still writes positive micro-dollar costs for daily and hourly', async () => {
    const { pipeline, calls } = createPipeline()
    redis.client = { pipeline: jest.fn(() => pipeline) }

    await redis.incrementTokenUsage(
      'key-1',
      10,
      6,
      4,
      0,
      0,
      'claude-sonnet-4-5-20250929',
      0,
      0,
      false,
      0.001234,
      0.002345
    )

    const costWrites = calls.filter(
      ([op, , field]) =>
        op === 'hincrby' && (field === 'realCostMicro' || field === 'ratedCostMicro')
    )

    expect(costWrites).toEqual(
      expect.arrayContaining([
        ['hincrby', expect.stringContaining(':model:daily:'), 'realCostMicro', 1234],
        ['hincrby', expect.stringContaining(':model:daily:'), 'ratedCostMicro', 2345],
        ['hincrby', expect.stringContaining(':model:hourly:'), 'realCostMicro', 1234],
        ['hincrby', expect.stringContaining(':model:hourly:'), 'ratedCostMicro', 2345]
      ])
    )
  })
})
