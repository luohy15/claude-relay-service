/**
 * Admin route regression tests for Grok account credential sanitization.
 *
 * Guards against leaking the decrypted grok.com access/refresh token (or the
 * relay-adapter fields apiKey/baseApi/providerEndpoint) back to the admin UI
 * through create/update responses.
 */

const mockRouter = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn()
}

jest.mock(
  'express',
  () => ({
    Router: () => mockRouter
  }),
  { virtual: true }
)

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: jest.fn((_req, _res, next) => next())
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  success: jest.fn()
}))

jest.mock('../src/utils/webhookNotifier', () => ({
  sendAccountAnomalyNotification: jest.fn()
}))

jest.mock('../src/services/accountGroupService', () => ({
  getAccountGroups: jest.fn().mockResolvedValue([]),
  getGroupMembers: jest.fn().mockResolvedValue([]),
  setAccountGroups: jest.fn(),
  addAccountToGroup: jest.fn(),
  removeAccountFromAllGroups: jest.fn(),
  getAccountGroup: jest.fn(),
  removeAccountFromGroup: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  unbindAccountFromAllKeys: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getAccountUsageStats: jest.fn().mockResolvedValue({ daily: {}, total: {}, monthly: {} })
}))

jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 1000,
    security: { encryptionKey: '12345678901234567890123456789012' }
  }),
  { virtual: true }
)

jest.mock('../src/services/account/grokAccountService', () => ({
  getAllAccounts: jest.fn(),
  createAccount: jest.fn(),
  getAccount: jest.fn(),
  updateAccount: jest.fn(),
  deleteAccount: jest.fn(),
  refreshAccountToken: jest.fn(),
  resetAccountStatus: jest.fn(),
  toggleSchedulable: jest.fn(),
  sanitizeAccountForResponse: jest.requireActual('../src/services/account/grokAccountService')
    .sanitizeAccountForResponse
}))

const grokAccountService = require('../src/services/account/grokAccountService')
require('../src/routes/admin/grokAccounts')

function findHandler(method, path) {
  const route = mockRouter[method].mock.calls.find((call) => call[0] === path)
  return route?.[route.length - 1]
}

function createResponse() {
  const res = {
    statusCode: 200,
    body: null,
    json: jest.fn((payload) => {
      res.body = payload
      return res
    }),
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    })
  }
  return res
}

const CREDENTIAL_FIELDS = ['accessToken', 'refreshToken', 'apiKey', 'baseApi', 'providerEndpoint']

describe('admin grok accounts route - credential sanitization', () => {
  beforeEach(() => {
    // NOTE: don't clearAllMocks() here — it would also wipe mockRouter's recorded
    // .post/.put/.get calls, which are only registered once at module-require time.
    grokAccountService.createAccount.mockReset()
    grokAccountService.getAccount.mockReset()
    grokAccountService.updateAccount.mockReset()
    grokAccountService.refreshAccountToken.mockReset()
    grokAccountService.deleteAccount.mockReset()
  })

  it('does not leak decrypted tokens on create (immediate-refresh verification path)', async () => {
    const handler = findHandler('post', '/')

    const tempAccount = { id: 'grok-1', name: 'Grok Account' }
    grokAccountService.createAccount.mockResolvedValue(tempAccount)
    grokAccountService.refreshAccountToken.mockResolvedValue({})
    grokAccountService.getAccount.mockResolvedValue({
      id: 'grok-1',
      name: 'Grok Account',
      accessToken: 'plaintext-access-token',
      refreshToken: 'plaintext-refresh-token',
      apiKey: 'plaintext-access-token',
      baseApi: 'https://cli-chat-proxy.grok.com/v1',
      providerEndpoint: 'responses',
      isActive: 'true'
    })

    const res = createResponse()
    await handler(
      {
        body: {
          name: 'Grok Account',
          grokOauth: { refreshToken: 'raw-refresh-token' },
          needsImmediateRefresh: true,
          requireRefreshSuccess: true
        }
      },
      res
    )

    expect(res.body.success).toBe(true)
    for (const field of CREDENTIAL_FIELDS) {
      expect(res.body.data).not.toHaveProperty(field)
    }
    expect(JSON.stringify(res.body)).not.toContain('plaintext-access-token')
    expect(JSON.stringify(res.body)).not.toContain('plaintext-refresh-token')
  })

  it('does not leak tokens on create (non-immediate-refresh path)', async () => {
    const handler = findHandler('post', '/')

    grokAccountService.createAccount.mockResolvedValue({
      id: 'grok-2',
      name: 'Grok Account 2',
      accessToken: 'ciphertext-access',
      refreshToken: 'ciphertext-refresh',
      isActive: 'true'
    })

    const res = createResponse()
    await handler(
      {
        body: {
          name: 'Grok Account 2',
          grokOauth: { refreshToken: 'raw-refresh-token' }
        }
      },
      res
    )

    expect(res.body.success).toBe(true)
    for (const field of CREDENTIAL_FIELDS) {
      expect(res.body.data).not.toHaveProperty(field)
    }
  })

  it('does not leak tokens on update', async () => {
    const handler = findHandler('put', '/:id')

    grokAccountService.getAccount.mockResolvedValue({
      id: 'grok-3',
      name: 'Grok Account 3',
      accountType: 'shared',
      isActive: 'true'
    })
    grokAccountService.updateAccount.mockResolvedValue({
      id: 'grok-3',
      name: 'Grok Account 3',
      accessToken: 'plaintext-access-token-after-update',
      refreshToken: 'plaintext-refresh-token-after-update',
      apiKey: 'plaintext-access-token-after-update',
      baseApi: 'https://cli-chat-proxy.grok.com/v1',
      providerEndpoint: 'responses',
      isActive: 'true'
    })

    const res = createResponse()
    await handler(
      {
        params: { id: 'grok-3' },
        body: { priority: 60 }
      },
      res
    )

    expect(res.body.success).toBe(true)
    for (const field of CREDENTIAL_FIELDS) {
      expect(res.body.data).not.toHaveProperty(field)
    }
    expect(JSON.stringify(res.body)).not.toContain('plaintext-access-token-after-update')
    expect(JSON.stringify(res.body)).not.toContain('plaintext-refresh-token-after-update')
  })
})
