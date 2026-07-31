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
  isTokenExpired: jest.fn().mockReturnValue(false),
  sanitizeAccountForResponse: jest.requireActual('../src/services/account/grokAccountService')
    .sanitizeAccountForResponse,
  GROK_CLI_CLIENT_VERSION: jest.requireActual('../src/services/account/grokAccountService')
    .GROK_CLI_CLIENT_VERSION,
  GROK_CLI_CLIENT_IDENTIFIER: jest.requireActual('../src/services/account/grokAccountService')
    .GROK_CLI_CLIENT_IDENTIFIER
}))

jest.mock('axios')

const axios = require('axios')
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
    grokAccountService.isTokenExpired.mockReset().mockReturnValue(false)
    axios.post.mockReset()
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

describe('admin grok accounts route - connectivity test endpoint', () => {
  beforeEach(() => {
    grokAccountService.getAccount.mockReset()
    grokAccountService.refreshAccountToken.mockReset()
    grokAccountService.isTokenExpired.mockReset().mockReturnValue(false)
    axios.post.mockReset()
  })

  it('sends the Grok CLI compatibility headers and never leaks token material', async () => {
    const handler = findHandler('post', '/:accountId/test')

    grokAccountService.getAccount.mockResolvedValue({
      id: 'grok-4',
      name: 'Grok Account 4',
      apiKey: 'plaintext-access-token',
      baseApi: 'https://cli-chat-proxy.grok.com/v1'
    })
    axios.post.mockResolvedValue({
      data: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }] }
    })

    const res = createResponse()
    await handler({ params: { accountId: 'grok-4' }, body: {} }, res)

    expect(axios.post).toHaveBeenCalledTimes(1)
    const [url, , requestConfig] = axios.post.mock.calls[0]
    expect(url).toBe('https://cli-chat-proxy.grok.com/v1/responses')
    expect(requestConfig.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer plaintext-access-token',
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-grok-client-version': '0.2.101',
      'x-grok-client-identifier': 'grok-shell',
      'x-grok-model-override': 'grok-4.5'
    })

    expect(res.body.success).toBe(true)
    expect(res.body.data.responseText).toBe('pong')
    for (const field of CREDENTIAL_FIELDS) {
      expect(res.body.data).not.toHaveProperty(field)
    }
    expect(JSON.stringify(res.body)).not.toContain('plaintext-access-token')
  })

  it('defaults the test model to grok-4.5 (verified subscription-compatible) not grok-4.5-build', async () => {
    const handler = findHandler('post', '/:accountId/test')

    grokAccountService.getAccount.mockResolvedValue({
      id: 'grok-4b',
      name: 'Grok Account 4b',
      apiKey: 'plaintext-access-token',
      baseApi: 'https://cli-chat-proxy.grok.com/v1'
    })
    axios.post.mockResolvedValue({
      data: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }] }
    })

    const res = createResponse()
    await handler({ params: { accountId: 'grok-4b' }, body: {} }, res)

    const [, payload, requestConfig] = axios.post.mock.calls[0]
    expect(payload.model).toBe('grok-4.5')
    expect(requestConfig.headers['x-grok-model-override']).toBe('grok-4.5')
    expect(res.body.data.model).toBe('grok-4.5')
  })

  it('still allows an explicitly requested model to override the default', async () => {
    const handler = findHandler('post', '/:accountId/test')

    grokAccountService.getAccount.mockResolvedValue({
      id: 'grok-4c',
      name: 'Grok Account 4c',
      apiKey: 'plaintext-access-token',
      baseApi: 'https://cli-chat-proxy.grok.com/v1'
    })
    axios.post.mockResolvedValue({
      data: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }] }
    })

    const res = createResponse()
    await handler({ params: { accountId: 'grok-4c' }, body: { model: 'grok-4.5-build' } }, res)

    const [, , requestConfig] = axios.post.mock.calls[0]
    expect(requestConfig.headers['x-grok-model-override']).toBe('grok-4.5-build')
    expect(res.body.data.model).toBe('grok-4.5-build')
  })

  it('refreshes the token first when the access token is expired', async () => {
    const handler = findHandler('post', '/:accountId/test')

    grokAccountService.isTokenExpired.mockReturnValue(true)
    grokAccountService.refreshAccountToken.mockResolvedValue({})
    grokAccountService.getAccount
      .mockResolvedValueOnce({
        id: 'grok-5',
        name: 'Grok Account 5',
        apiKey: 'stale-access-token',
        baseApi: 'https://cli-chat-proxy.grok.com/v1'
      })
      .mockResolvedValueOnce({
        id: 'grok-5',
        name: 'Grok Account 5',
        apiKey: 'refreshed-access-token',
        baseApi: 'https://cli-chat-proxy.grok.com/v1'
      })
    axios.post.mockResolvedValue({ data: { output: [] } })

    const res = createResponse()
    await handler({ params: { accountId: 'grok-5' }, body: {} }, res)

    expect(grokAccountService.refreshAccountToken).toHaveBeenCalledWith('grok-5')
    const [, , requestConfig] = axios.post.mock.calls[0]
    expect(requestConfig.headers.Authorization).toBe('Bearer refreshed-access-token')
    expect(res.body.success).toBe(true)
  })

  it('returns a sanitized error when the upstream request fails', async () => {
    const handler = findHandler('post', '/:accountId/test')

    grokAccountService.getAccount.mockResolvedValue({
      id: 'grok-6',
      name: 'Grok Account 6',
      apiKey: 'plaintext-access-token',
      baseApi: 'https://cli-chat-proxy.grok.com/v1'
    })
    axios.post.mockRejectedValue({
      message: 'Request failed with status code 401',
      response: { data: { error: { message: 'invalid token' } } }
    })

    const res = createResponse()
    await handler({ params: { accountId: 'grok-6' }, body: {} }, res)

    expect(res.statusCode).toBe(500)
    expect(res.body.success).toBe(false)
    expect(res.body.message).toBe('invalid token')
    expect(JSON.stringify(res.body)).not.toContain('plaintext-access-token')
  })
})
