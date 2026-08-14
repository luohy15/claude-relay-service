const mockRouter = {
  get: jest.fn(),
  post: jest.fn()
}

jest.mock(
  'express',
  () => ({
    Router: () => mockRouter
  }),
  { virtual: true }
)

jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(() => ({})),
  getDateInTimezone: jest.fn(),
  getDateStringInTimezone: jest.fn(),
  getApiKey: jest.fn(),
  getUsageStats: jest.fn(),
  scanAndGetAllChunked: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  validateApiKey: jest.fn()
}))

jest.mock('../src/utils/costCalculator', () => ({
  calculateCost: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  security: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  start: jest.fn()
}))

jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/account/openaiAccountService', () => ({}))
jest.mock('../src/services/serviceRatesService', () => ({}))
jest.mock('../src/utils/testPayloadHelper', () => ({
  createClaudeTestPayload: jest.fn(),
  extractErrorMessage: jest.fn(),
  sanitizeErrorMsg: jest.fn()
}))
jest.mock('../config/models', () => ({
  getModelsByService: jest.fn(() => []),
  getAllModels: jest.fn(() => []),
  CLAUDE_MODELS: [],
  GEMINI_MODELS: [],
  OPENAI_MODELS: [],
  OTHER_MODELS: [],
  PLATFORM_TEST_MODELS: {}
}))
jest.mock('../src/utils/errorSanitizer', () => ({
  getSafeMessage: jest.fn((error) => error?.message || 'error')
}))

const redis = require('../src/models/redis')
const CostCalculator = require('../src/utils/costCalculator')

require('../src/routes/apiStats')

const KEY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function findPostHandler(path) {
  const route = mockRouter.post.mock.calls.find((call) => call[0] === path)
  return route?.[1]
}

function createResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((body) => {
      res.body = body
      return res
    })
  }
  return res
}

function seedKeyLookup() {
  redis.getApiKey.mockResolvedValue({
    name: 'test-key',
    isActive: 'true'
  })
  redis.getUsageStats.mockResolvedValue({ total: { requests: 0 } })
}

describe('POST /api/user-model-stats period=hourly', () => {
  const handler = findPostHandler('/api/user-model-stats')

  beforeEach(() => {
    jest.clearAllMocks()
    redis.getDateStringInTimezone.mockReturnValue('2026-08-14')
    redis.getDateInTimezone.mockReturnValue(new Date('2026-08-14T05:00:00.000Z'))
    CostCalculator.calculateCost.mockImplementation((_usage, model) => ({
      costs: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, real: 0, rated: 0 },
      formatted: { total: '$0.000000' },
      pricing: { model }
    }))
  })

  test('returns one item per (model, hour) with stored real cost and usageDate/hour', async () => {
    seedKeyLookup()
    redis.scanAndGetAllChunked.mockResolvedValue([
      {
        key: `usage:${KEY_ID}:model:hourly:claude-sonnet-4-5-20250929:2026-08-14:09`,
        data: {
          requests: '2',
          inputTokens: '100',
          outputTokens: '50',
          cacheCreateTokens: '10',
          cacheReadTokens: '20',
          allTokens: '180',
          realCostMicro: '1234567',
          ratedCostMicro: '2345678'
        }
      },
      {
        key: `usage:${KEY_ID}:model:hourly:claude-sonnet-4-5-20250929:2026-08-14:10`,
        data: {
          requests: '1',
          inputTokens: '30',
          outputTokens: '40',
          cacheCreateTokens: '0',
          cacheReadTokens: '0',
          allTokens: '70',
          realCostMicro: '500000',
          ratedCostMicro: '600000'
        }
      }
    ])

    const res = createResponse()
    await handler(
      {
        body: {
          apiId: KEY_ID,
          period: 'hourly',
          date: '2026-08-14'
        },
        ip: '127.0.0.1'
      },
      res
    )

    expect(redis.scanAndGetAllChunked).toHaveBeenCalledWith(
      `usage:${KEY_ID}:model:hourly:*:2026-08-14:*`
    )
    expect(res.statusCode).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.period).toBe('hourly')
    expect(res.body.data).toHaveLength(2)

    const byHour = Object.fromEntries(res.body.data.map((item) => [item.hour, item]))
    expect(byHour[9]).toEqual(
      expect.objectContaining({
        model: 'claude-sonnet-4-5-20250929',
        requests: 2,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreateTokens: 10,
        cacheReadTokens: 20,
        allTokens: 180,
        usageDate: '2026-08-14',
        hour: 9,
        isLegacy: false,
        costs: expect.objectContaining({
          real: 1.234567,
          rated: 2.345678
        })
      })
    )
    expect(byHour[10]).toEqual(
      expect.objectContaining({
        model: 'claude-sonnet-4-5-20250929',
        requests: 1,
        allTokens: 70,
        usageDate: '2026-08-14',
        hour: 10,
        costs: expect.objectContaining({
          real: 0.5,
          rated: 0.6
        })
      })
    )
  })

  test('rejects invalid date format with 400', async () => {
    seedKeyLookup()
    const res = createResponse()

    await handler(
      {
        body: {
          apiId: KEY_ID,
          period: 'hourly',
          date: '2026-8-1'
        },
        ip: '127.0.0.1'
      },
      res
    )

    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({
      error: 'Invalid date format',
      message: 'date must be YYYY-MM-DD'
    })
    expect(redis.scanAndGetAllChunked).not.toHaveBeenCalled()
  })

  test('defaults date to relay local today when omitted', async () => {
    seedKeyLookup()
    redis.scanAndGetAllChunked.mockResolvedValue([])

    const res = createResponse()
    await handler(
      {
        body: {
          apiId: KEY_ID,
          period: 'hourly'
        },
        ip: '127.0.0.1'
      },
      res
    )

    expect(redis.getDateStringInTimezone).toHaveBeenCalled()
    expect(redis.scanAndGetAllChunked).toHaveBeenCalledWith(
      `usage:${KEY_ID}:model:hourly:*:2026-08-14:*`
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      success: true,
      data: [],
      period: 'hourly'
    })
  })

  test('treats stored zero cost as authoritative, not legacy fallback', async () => {
    seedKeyLookup()
    CostCalculator.calculateCost.mockImplementation((_usage, model) => ({
      costs: {
        input: 0.1,
        output: 0.2,
        cacheCreate: 0,
        cacheRead: 0,
        total: 0.3,
        real: 0.3,
        rated: 0.3
      },
      formatted: { total: '$0.300000' },
      pricing: { model }
    }))
    redis.scanAndGetAllChunked.mockResolvedValue([
      {
        key: `usage:${KEY_ID}:model:hourly:claude-sonnet-4-5-20250929:2026-08-14:11`,
        data: {
          requests: '1',
          inputTokens: '10',
          outputTokens: '5',
          cacheCreateTokens: '0',
          cacheReadTokens: '0',
          allTokens: '15',
          realCostMicro: '0',
          ratedCostMicro: '0'
        }
      }
    ])

    const res = createResponse()
    await handler(
      {
        body: {
          apiId: KEY_ID,
          period: 'hourly',
          date: '2026-08-14'
        },
        ip: '127.0.0.1'
      },
      res
    )

    expect(res.statusCode).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toEqual(
      expect.objectContaining({
        model: 'claude-sonnet-4-5-20250929',
        hour: 11,
        isLegacy: false,
        costs: expect.objectContaining({
          real: 0,
          rated: 0,
          total: 0
        })
      })
    )
  })
})
