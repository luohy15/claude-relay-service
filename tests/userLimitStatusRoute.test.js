const mockRouter = { post: jest.fn() }

jest.mock(
  'express',
  () => ({
    Router: () => mockRouter
  }),
  { virtual: true }
)

jest.mock('../src/services/apiKeyService', () => ({
  validateApiKeyForStats: jest.fn()
}))

jest.mock('../src/services/account/claudeAccountService', () => ({
  getAccount: jest.fn(),
  buildClaudeUsageSnapshot: jest.fn(),
  fetchOAuthUsage: jest.fn(),
  updateClaudeUsageSnapshot: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  getAccountOverview: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  security: jest.fn(),
  error: jest.fn()
}))

const apiKeyService = require('../src/services/apiKeyService')
const claudeAccountService = require('../src/services/account/claudeAccountService')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const userLimitStatusRoutes = require('../src/routes/userLimitStatus')
const limitStatusHandler = mockRouter.post.mock.calls.find(
  (call) => call[0] === '/api/user-limit-status'
)?.[1]

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

describe('user limit status route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('rejects an invalid key without looking up provider accounts', async () => {
    apiKeyService.validateApiKeyForStats.mockResolvedValue({ valid: false })
    const res = createResponse()

    await limitStatusHandler({ body: { apiKey: 'invalid' }, ip: '127.0.0.1' }, res)

    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ success: false, error: 'Invalid API key' })
    expect(claudeAccountService.getAccount).not.toHaveBeenCalled()
    expect(openaiAccountService.getAccount).not.toHaveBeenCalled()
  })

  test('does not disclose shared-pool or unbound accounts', async () => {
    apiKeyService.validateApiKeyForStats.mockResolvedValue({
      valid: true,
      keyData: { claudeAccountId: 'shared-claude' }
    })
    claudeAccountService.getAccount.mockResolvedValue({
      id: 'shared-claude',
      accountType: 'shared'
    })
    const res = createResponse()

    await limitStatusHandler({ body: { apiKey: 'cr_test' } }, res)

    expect(res.body).toEqual({
      success: true,
      data: [
        expect.objectContaining({
          backend: 'claude_code',
          availability: 'unavailable',
          error: 'no_stable_account_scope',
          account_id: null,
          account_name: null
        }),
        expect.objectContaining({
          backend: 'codex',
          availability: 'unavailable',
          error: 'no_stable_account_scope'
        })
      ]
    })
    expect(openaiAccountService.getAccount).not.toHaveBeenCalled()
  })

  test('keeps a bound account lookup returning null anonymous', async () => {
    apiKeyService.validateApiKeyForStats.mockResolvedValue({
      valid: true,
      keyData: { openaiAccountId: 'missing-openai' }
    })
    openaiAccountService.getAccount.mockResolvedValue(null)
    const res = createResponse()

    await limitStatusHandler({ body: { apiKey: 'cr_test' } }, res)

    expect(res.body.data[1]).toEqual(
      expect.objectContaining({
        availability: 'unavailable',
        error: 'no_stable_account_scope',
        account_id: null,
        account_name: null
      })
    )
  })

  test('returns setup-token Claude as unavailable without fetching OAuth usage', async () => {
    apiKeyService.validateApiKeyForStats.mockResolvedValue({
      valid: true,
      keyData: { claudeAccountId: 'claude-1' }
    })
    claudeAccountService.getAccount.mockResolvedValue({
      id: 'claude-1',
      name: 'Dedicated Claude',
      accountType: 'dedicated',
      scopes: ''
    })
    const res = createResponse()

    await limitStatusHandler({ body: { apiKey: 'cr_test' } }, res)

    expect(res.body.data[0]).toEqual(
      expect.objectContaining({
        availability: 'unavailable',
        error: 'setup_token_usage_unavailable',
        account_id: 'claude-1',
        account_name: 'Dedicated Claude'
      })
    )
    expect(claudeAccountService.fetchOAuthUsage).not.toHaveBeenCalled()
  })

  test('maps cached Claude OAuth snapshots with malformed values left unknown', async () => {
    apiKeyService.validateApiKeyForStats.mockResolvedValue({
      valid: true,
      keyData: { claudeAccountId: 'claude-1' }
    })
    claudeAccountService.getAccount.mockResolvedValue({
      id: 'claude-1',
      name: 'Dedicated Claude',
      accountType: 'dedicated',
      scopes: 'user:profile user:inference'
    })
    claudeAccountService.buildClaudeUsageSnapshot.mockReturnValue({
      updatedAt: new Date().toISOString(),
      fiveHour: { utilization: '42', resetsAt: '2026-07-10T16:00:00Z' },
      sevenDay: { utilization: 'NaN', resetsAt: 'bad-date' },
      sevenDayOpus: { utilization: 8, resetsAt: '2026-07-17T16:00:00Z' }
    })
    const res = createResponse()

    await limitStatusHandler({ body: { apiKey: 'cr_test' } }, res)

    expect(res.body.data[0]).toEqual(
      expect.objectContaining({
        availability: 'available',
        source: 'anthropic_oauth_usage',
        windows: {
          five_hour: { used_percent: 42, reset_at: '2026-07-10T16:00:00.000Z' },
          one_week: { used_percent: null, reset_at: null }
        },
        extra_windows: {
          one_week_sonnet: { used_percent: 8, reset_at: '2026-07-17T16:00:00.000Z' }
        }
      })
    )
    expect(claudeAccountService.fetchOAuthUsage).not.toHaveBeenCalled()
  })

  test('refreshes a stale Claude OAuth snapshot before returning it', async () => {
    apiKeyService.validateApiKeyForStats.mockResolvedValue({
      valid: true,
      keyData: { claudeAccountId: 'claude-1' }
    })
    claudeAccountService.getAccount
      .mockResolvedValueOnce({
        id: 'claude-1',
        name: 'Dedicated Claude',
        accountType: 'dedicated',
        scopes: 'user:profile user:inference'
      })
      .mockResolvedValueOnce({
        id: 'claude-1',
        name: 'Dedicated Claude',
        accountType: 'dedicated',
        scopes: 'user:profile user:inference'
      })
    claudeAccountService.buildClaudeUsageSnapshot
      .mockReturnValueOnce({ updatedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString() })
      .mockReturnValueOnce({
        updatedAt: new Date().toISOString(),
        fiveHour: { utilization: 42, resetsAt: '2026-07-10T20:00:00Z' },
        sevenDay: { utilization: 18, resetsAt: '2026-07-17T20:00:00Z' }
      })
    claudeAccountService.fetchOAuthUsage.mockResolvedValue({ five_hour: {}, seven_day: {} })
    const res = createResponse()

    await limitStatusHandler({ body: { apiKey: 'cr_test' } }, res)

    expect(claudeAccountService.fetchOAuthUsage).toHaveBeenCalledWith('claude-1')
    expect(claudeAccountService.updateClaudeUsageSnapshot).toHaveBeenCalledWith('claude-1', {
      five_hour: {},
      seven_day: {}
    })
    expect(res.body.data[0].availability).toBe('available')
  })

  test('maps Codex windows by minutes rather than primary-secondary order', async () => {
    apiKeyService.validateApiKeyForStats.mockResolvedValue({
      valid: true,
      keyData: { openaiAccountId: 'openai-1' }
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'Dedicated Codex',
      accountType: 'dedicated'
    })
    openaiAccountService.getAccountOverview.mockResolvedValue({
      codexUsage: {
        updatedAt: '2026-07-10T15:00:00Z',
        primary: { usedPercent: 18, windowMinutes: 10080, resetAt: '2026-07-17T15:00:00Z' },
        secondary: { usedPercent: 42, windowMinutes: 300, resetAt: '2026-07-10T20:00:00Z' }
      }
    })
    const res = createResponse()

    await limitStatusHandler({ body: { apiKey: 'cr_test' } }, res)

    expect(res.body.data[1]).toEqual(
      expect.objectContaining({
        backend: 'codex',
        account_id: 'openai-1',
        source: 'codex_rate_limit_headers',
        windows: {
          five_hour: { used_percent: 42, reset_at: '2026-07-10T20:00:00.000Z' },
          one_week: { used_percent: 18, reset_at: '2026-07-17T15:00:00.000Z' }
        }
      })
    )
    expect(JSON.stringify(res.body)).not.toMatch(
      /accessToken|refreshToken|apiKey|email|proxy|permissions|admin/i
    )
  })

  test('preserves Codex status when Claude lookup fails', async () => {
    apiKeyService.validateApiKeyForStats.mockResolvedValue({
      valid: true,
      keyData: { claudeAccountId: 'claude-1', openaiAccountId: 'openai-1' }
    })
    claudeAccountService.getAccount.mockRejectedValue(new Error('Claude unavailable'))
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'Dedicated Codex',
      accountType: 'dedicated'
    })
    openaiAccountService.getAccountOverview.mockResolvedValue({
      codexUsage: {
        updatedAt: new Date().toISOString(),
        primary: { usedPercent: 42, windowMinutes: 300, resetAt: '2026-07-10T20:00:00Z' }
      }
    })
    const res = createResponse()

    await limitStatusHandler({ body: { apiKey: 'cr_test' } }, res)

    expect(res.statusCode).toBe(200)
    expect(res.body.data[0]).toEqual(
      expect.objectContaining({ availability: 'unavailable', error: 'provider_status_unavailable' })
    )
    expect(res.body.data[1]).toEqual(
      expect.objectContaining({ availability: 'available', account_id: 'openai-1' })
    )
  })

  test('preserves Claude status when Codex lookup fails', async () => {
    apiKeyService.validateApiKeyForStats.mockResolvedValue({
      valid: true,
      keyData: { claudeAccountId: 'claude-1', openaiAccountId: 'openai-1' }
    })
    claudeAccountService.getAccount.mockResolvedValue({
      id: 'claude-1',
      name: 'Dedicated Claude',
      accountType: 'dedicated',
      scopes: 'user:profile user:inference'
    })
    claudeAccountService.buildClaudeUsageSnapshot.mockReturnValue({
      updatedAt: new Date().toISOString(),
      fiveHour: { utilization: 42, resetsAt: '2026-07-10T20:00:00Z' }
    })
    openaiAccountService.getAccount.mockRejectedValue(new Error('Codex unavailable'))
    const res = createResponse()

    await limitStatusHandler({ body: { apiKey: 'cr_test' } }, res)

    expect(res.statusCode).toBe(200)
    expect(res.body.data[0]).toEqual(
      expect.objectContaining({ availability: 'available', account_id: 'claude-1' })
    )
    expect(res.body.data[1]).toEqual(
      expect.objectContaining({ availability: 'unavailable', error: 'provider_status_unavailable' })
    )
  })
})

describe('limit status normalization helpers', () => {
  test.each([false, true, [], {}, '   ', 'NaN', 'Infinity', -Infinity])(
    'rejects malformed percent value %p',
    (value) => {
      expect(userLimitStatusRoutes.toFiniteNumberOrNull(value)).toBeNull()
    }
  )

  test('accepts finite numbers and non-empty numeric strings', () => {
    expect(userLimitStatusRoutes.toFiniteNumberOrNull(42)).toBe(42)
    expect(userLimitStatusRoutes.toFiniteNumberOrNull(' 42.5 ')).toBe(42.5)
  })

  test('keeps malformed Codex percent and reset timestamp unavailable', () => {
    expect(
      userLimitStatusRoutes.normalizeCodexUsage(
        { id: 'openai-1', name: 'Dedicated', accountType: 'dedicated' },
        {
          updatedAt: 'bad',
          primary: { usedPercent: Infinity, windowMinutes: 300, resetAt: 'invalid' }
        }
      )
    ).toEqual(
      expect.objectContaining({
        observed_at: null,
        availability: 'unavailable',
        error: 'usage_snapshot_unavailable',
        windows: {
          five_hour: { used_percent: null, reset_at: null },
          one_week: null
        }
      })
    )
  })

  test('does not treat false as an available Codex percentage', () => {
    expect(
      userLimitStatusRoutes.normalizeCodexUsage(
        { id: 'openai-1', name: 'Dedicated', accountType: 'dedicated' },
        {
          updatedAt: new Date().toISOString(),
          primary: { usedPercent: false, windowMinutes: 300, resetAt: '2026-07-10T20:00:00Z' }
        }
      )
    ).toEqual(
      expect.objectContaining({
        availability: 'unavailable',
        error: 'usage_snapshot_unavailable',
        windows: {
          five_hour: { used_percent: null, reset_at: '2026-07-10T20:00:00.000Z' },
          one_week: null
        }
      })
    )
  })
})
