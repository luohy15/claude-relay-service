/**
 * grokRelayService tests
 *
 * grokRelayService reuses openaiResponsesRelayService's Responses-API relay logic
 * (same request/response/usage-parsing code path as openai-responses) via an
 * injectable accountService/accountType, plus one Grok-specific header
 * (X-XAI-Token-Auth) that cli-chat-proxy.grok.com requires but the grok-build
 * client itself does not send when pointed at a custom base_url (verified live
 * against the real grok-build CLI on 2026-07-14).
 */

jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 1000
  }),
  { virtual: true }
)

jest.mock('axios')

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  recordUsage: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  markAccountRateLimited: jest.fn(),
  _deleteSessionMapping: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn().mockResolvedValue(undefined),
  parseRetryAfter: jest.fn(),
  sanitizeErrorForClient: jest.fn((data) => data)
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  updateAccount: jest.fn()
}))

jest.mock('../src/services/account/grokAccountService', () => ({
  getAccount: jest.fn(),
  updateAccount: jest.fn(),
  GROK_PROXY_BASE_API: 'https://cli-chat-proxy.grok.com/v1'
}))

const axios = require('axios')
const grokAccountService = require('../src/services/account/grokAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const grokRelayService = require('../src/services/relay/grokRelayService')
const openaiResponsesRelayService = require('../src/services/relay/openaiResponsesRelayService')

const createFakeReqRes = (body = { model: 'grok-4.5', stream: false }) => {
  const req = {
    headers: { 'user-agent': 'grok-shell/0.2.101' },
    body,
    path: '/v1/responses',
    method: 'POST',
    once: jest.fn(),
    removeListener: jest.fn()
  }
  const res = {
    once: jest.fn(),
    removeListener: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis()
  }
  return { req, res }
}

describe('grokRelayService', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('is bound to grokAccountService with accountType "grok"', () => {
    expect(grokRelayService).toBeInstanceOf(openaiResponsesRelayService.OpenAIResponsesRelayService)
    expect(grokRelayService.accountService).toBe(grokAccountService)
    expect(grokRelayService.accountType).toBe('grok')
  })

  it('injects X-XAI-Token-Auth and targets cli-chat-proxy.grok.com when relaying', async () => {
    grokAccountService.getAccount.mockResolvedValue({
      id: 'grok-acc-1',
      name: 'Grok Account',
      apiKey: 'decrypted-grok-access-token',
      baseApi: 'https://cli-chat-proxy.grok.com/v1',
      providerEndpoint: 'responses',
      proxy: null
    })

    axios.mockResolvedValue({
      status: 200,
      data: { model: 'grok-4.5-build', usage: null },
      headers: {}
    })

    const { req, res } = createFakeReqRes()
    await grokRelayService.handleRequest(
      req,
      res,
      { id: 'grok-acc-1', name: 'Grok Account' },
      {
        id: 'key-1'
      }
    )

    expect(axios).toHaveBeenCalledTimes(1)
    const requestOptions = axios.mock.calls[0][0]
    expect(requestOptions.url).toBe('https://cli-chat-proxy.grok.com/v1/responses')
    expect(requestOptions.headers.Authorization).toBe('Bearer decrypted-grok-access-token')
    expect(requestOptions.headers['X-XAI-Token-Auth']).toBe('xai-grok-cli')
  })

  it('does not inject X-XAI-Token-Auth for the default openai-responses relay instance', async () => {
    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'resp-acc-1',
      name: 'Responses Account',
      apiKey: 'decrypted-openai-key',
      baseApi: 'https://api.example.com/v1',
      providerEndpoint: 'responses',
      proxy: null
    })

    axios.mockResolvedValue({
      status: 200,
      data: { model: 'gpt-4o-mini', usage: null },
      headers: {}
    })

    const { req, res } = createFakeReqRes({ model: 'gpt-4o-mini', stream: false })
    await openaiResponsesRelayService.handleRequest(
      req,
      res,
      { id: 'resp-acc-1', name: 'Responses Account' },
      { id: 'key-1' }
    )

    const requestOptions = axios.mock.calls[0][0]
    expect(requestOptions.headers['X-XAI-Token-Auth']).toBeUndefined()
  })
})
