/**
 * grokAccountService tests
 *
 * Covers the grok.com OIDC (auth.x.ai) refresh flow and the account-shape
 * adapter (apiKey/baseApi) that lets openaiResponsesRelayService reuse its
 * Responses-API relay logic for Grok accounts.
 */

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  success: jest.fn()
}))

jest.mock('../src/utils/tokenRefreshLogger', () => ({
  logRefreshStart: jest.fn(),
  logRefreshSuccess: jest.fn(),
  logRefreshError: jest.fn(),
  logTokenUsage: jest.fn(),
  logRefreshSkipped: jest.fn()
}))

jest.mock('../src/services/tokenRefreshService', () => ({
  acquireRefreshLock: jest.fn().mockResolvedValue(true),
  releaseRefreshLock: jest.fn().mockResolvedValue(true)
}))

jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 600000,
    security: { encryptionKey: '12345678901234567890123456789012' }
  }),
  { virtual: true }
)

jest.mock('axios')

// In-memory fake Redis backing grok:account:<id> hashes + the account index set,
// mirroring just enough of models/redis.js for grokAccountService to round-trip.
jest.mock('../src/models/redis', () => {
  const hashes = new Map()
  const sets = new Map()

  const client = {
    hset: jest.fn(async (key, data) => {
      const existing = hashes.get(key) || {}
      hashes.set(key, { ...existing, ...data })
    }),
    hgetall: jest.fn(async (key) => ({ ...(hashes.get(key) || {}) })),
    del: jest.fn(async (key) => {
      hashes.delete(key)
    }),
    sadd: jest.fn(async (key, id) => {
      const set = sets.get(key) || new Set()
      set.add(id)
      sets.set(key, set)
    }),
    srem: jest.fn(async (key, id) => {
      sets.get(key)?.delete(id)
    }),
    smembers: jest.fn(async (key) => Array.from(sets.get(key) || [])),
    pipeline: jest.fn(() => ({
      del: jest.fn(),
      exec: jest.fn().mockResolvedValue([])
    }))
  }

  return {
    getClientSafe: () => client,
    addToIndex: jest.fn(async (indexKey, id) => {
      const set = sets.get(indexKey) || new Set()
      set.add(id)
      sets.set(indexKey, set)
    }),
    removeFromIndex: jest.fn(async (indexKey, id) => {
      sets.get(indexKey)?.delete(id)
    }),
    getAllIdsByIndex: jest.fn(async (indexKey) => Array.from(sets.get(indexKey) || [])),
    batchHgetallChunked: jest.fn(async (keys) =>
      keys.map((key) => ({ ...(hashes.get(key) || {}) }))
    ),
    __hashes: hashes
  }
})

const axios = require('axios')
const grokAccountService = require('../src/services/account/grokAccountService')

describe('grokAccountService', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('isTokenExpired', () => {
    it('returns false when expiresAt is absent', () => {
      expect(grokAccountService.isTokenExpired({})).toBe(false)
    })

    it('returns true once expiresAt is in the past', () => {
      expect(
        grokAccountService.isTokenExpired({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      ).toBe(true)
    })

    it('returns false while expiresAt is in the future', () => {
      expect(
        grokAccountService.isTokenExpired({ expiresAt: new Date(Date.now() + 60000).toISOString() })
      ).toBe(false)
    })
  })

  describe('createAccount / getAccount adapter', () => {
    it('exposes apiKey/baseApi/providerEndpoint for relay reuse', async () => {
      const account = await grokAccountService.createAccount({
        name: 'Test Grok',
        grokOauth: { accessToken: 'access-1', refreshToken: 'refresh-1', expires_in: 21600 }
      })

      const fetched = await grokAccountService.getAccount(account.id)
      expect(fetched.apiKey).toBe('access-1')
      expect(fetched.accessToken).toBe('access-1')
      expect(fetched.refreshToken).toBe('refresh-1')
      expect(fetched.baseApi).toBe(grokAccountService.GROK_PROXY_BASE_API)
      expect(fetched.providerEndpoint).toBe('responses')
    })
  })

  describe('refreshAccountToken', () => {
    it('posts a refresh_token grant to the auth.x.ai token endpoint and rotates the stored refresh token', async () => {
      const account = await grokAccountService.createAccount({
        name: 'Test Grok',
        grokOauth: { accessToken: 'stale-access', refreshToken: 'refresh-1', expires_in: 21600 }
      })

      axios.mockResolvedValueOnce({
        status: 200,
        data: {
          access_token: 'fresh-access',
          refresh_token: 'rotated-refresh',
          expires_in: 21600,
          token_type: 'Bearer'
        }
      })

      await grokAccountService.refreshAccountToken(account.id)

      expect(axios).toHaveBeenCalledTimes(1)
      const requestOptions = axios.mock.calls[0][0]
      expect(requestOptions.url).toBe('https://auth.x.ai/oauth2/token')
      expect(requestOptions.method).toBe('POST')
      const body = new URLSearchParams(requestOptions.data)
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('refresh_token')).toBe('refresh-1')
      expect(body.get('client_id')).toBeTruthy()

      const refreshed = await grokAccountService.getAccount(account.id)
      expect(refreshed.accessToken).toBe('fresh-access')
      expect(refreshed.refreshToken).toBe('rotated-refresh')
      expect(grokAccountService.isTokenExpired(refreshed)).toBe(false)
    })

    it('throws when no refresh token is stored', async () => {
      const account = await grokAccountService.createAccount({ name: 'No Refresh Token' })
      await expect(grokAccountService.refreshAccountToken(account.id)).rejects.toThrow(
        'No refresh token available'
      )
    })
  })

  describe('setAccountRateLimited', () => {
    it('marks the account rate limited and unschedulable', async () => {
      const account = await grokAccountService.createAccount({
        name: 'Rate Limited',
        grokOauth: { accessToken: 'a', refreshToken: 'r', expires_in: 21600 }
      })

      await grokAccountService.setAccountRateLimited(account.id, true, 120)

      const updated = await grokAccountService.getAccount(account.id)
      expect(updated.rateLimitStatus).toBe('limited')
      expect(updated.schedulable).toBe('false')
    })
  })
})
