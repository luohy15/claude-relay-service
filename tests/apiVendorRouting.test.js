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

jest.mock('../src/services/relay/claudeRelayService', () => ({}))
jest.mock('../src/services/relay/claudeConsoleRelayService', () => ({}))
jest.mock('../src/services/relay/bedrockRelayService', () => ({}))
jest.mock('../src/services/relay/ccrRelayService', () => ({}))
jest.mock('../src/services/account/bedrockAccountService', () => ({}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn()
}))
jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: jest.fn((_req, _res, next) => next())
}))
jest.mock('../src/utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  start: jest.fn()
}))
jest.mock('../src/utils/sessionHelper', () => ({}))
jest.mock('../src/utils/rateLimitHelper', () => ({ updateRateLimitCounters: jest.fn() }))
jest.mock('../src/services/claudeRelayConfigService', () => ({
  extractOriginalSessionId: jest.fn(),
  validateNewSession: jest.fn(),
  getConfig: jest.fn()
}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({}))
jest.mock('../src/utils/warmupInterceptor', () => ({
  isWarmupRequest: jest.fn(() => false),
  buildMockWarmupResponse: jest.fn(),
  sendMockWarmupStream: jest.fn()
}))
jest.mock('../src/utils/errorSanitizer', () => ({ sanitizeUpstreamError: jest.fn() }))
jest.mock('../src/utils/anthropicRequestDump', () => ({ dumpAnthropicMessagesRequest: jest.fn() }))
jest.mock('../src/utils/requestDetailHelper', () => ({ createRequestDetailMeta: jest.fn() }))
jest.mock('../src/utils/sseHeartbeat', () => ({ attachHeartbeat: jest.fn() }))
jest.mock('../src/services/anthropicGeminiBridgeService', () => ({
  handleAnthropicMessagesToGemini: jest.fn(),
  handleAnthropicCountTokensToGemini: jest.fn()
}))
jest.mock('../src/services/anthropicToResponses', () => ({
  handleAnthropicToResponses: jest.fn(async (_req, res) => res.status(200).json({ ok: true })),
  estimateInputTokens: jest.fn(() => 1),
  buildErrorEnvelope: jest.fn((status, { message }) => ({
    type: 'error',
    error: { type: 'error', message }
  }))
}))
jest.mock('../src/routes/openaiRoutes', () => ({
  handleResponses: jest.fn(async (_req, res) => res.status(200).json({ ok: true }))
}))

const apiKeyService = require('../src/services/apiKeyService')
const {
  handleAnthropicToResponses,
  estimateInputTokens
} = require('../src/services/anthropicToResponses')
const openaiRoutes = require('../src/routes/openaiRoutes')
const claudeRelayConfigService = require('../src/services/claudeRelayConfigService')
const { handleMessagesRequest } = require('../src/routes/api')

// Captured once at module-load time: jest.clearAllMocks() in beforeEach wipes
// mockRouter.post's recorded calls, and route registration only runs on require.
const countTokensHandler = (() => {
  const call = mockRouter.post.mock.calls.find((c) => c[0] === '/v1/messages/count_tokens')
  return call[call.length - 1]
})()

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

function createRequest({ baseUrl, model, anthropicVendor, permissions = [] }) {
  return {
    baseUrl,
    body: { model },
    apiKey: { permissions, restrictedModels: [] },
    _anthropicVendor: anthropicVendor
  }
}

describe('handleMessagesRequest vendor routing on the unified /api mount', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rule 1: a slash id takes the openai-responses (OpenRouter) branch', async () => {
    const req = createRequest({ baseUrl: '/api', model: 'moonshotai/kimi-k3' })
    const res = createResponse()

    await handleMessagesRequest(req, res)

    expect(openaiRoutes.handleResponses).toHaveBeenCalledWith(req, res)
    expect(handleAnthropicToResponses).not.toHaveBeenCalled()
    expect(req._fromUnifiedEndpoint).toBe(true)
  })

  it('rule 2: gpt-* takes the codex bridge branch', async () => {
    const req = createRequest({ baseUrl: '/api', model: 'gpt-5.6-sol' })
    const res = createResponse()

    await handleMessagesRequest(req, res)

    expect(handleAnthropicToResponses).toHaveBeenCalledWith(req, res, 'codex')
    expect(openaiRoutes.handleResponses).not.toHaveBeenCalled()
  })

  it('rule 3: grok-* takes the grok bridge branch', async () => {
    const req = createRequest({ baseUrl: '/api', model: 'grok-4.5' })
    const res = createResponse()

    await handleMessagesRequest(req, res)

    expect(handleAnthropicToResponses).toHaveBeenCalledWith(req, res, 'grok')
    expect(openaiRoutes.handleResponses).not.toHaveBeenCalled()
  })

  it('rule 4: claude-* takes neither bridge branch (falls to the native Claude permission check)', async () => {
    const req = createRequest({ baseUrl: '/api', model: 'claude-opus-4-5-20251101' })
    const res = createResponse()
    apiKeyService.hasPermission.mockReturnValue(false)

    await handleMessagesRequest(req, res)

    expect(openaiRoutes.handleResponses).not.toHaveBeenCalled()
    expect(handleAnthropicToResponses).not.toHaveBeenCalled()
    expect(apiKeyService.hasPermission).toHaveBeenCalledWith([], 'claude')
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.body.error.message).toBe('此 API Key 无权访问 Claude 服务')
  })

  it('/codex/api + grok-4.5: the path-forced vendor override wins over the model id', async () => {
    const req = createRequest({
      baseUrl: '/codex/api',
      model: 'grok-4.5',
      anthropicVendor: 'codex'
    })
    const res = createResponse()

    await handleMessagesRequest(req, res)

    expect(handleAnthropicToResponses).toHaveBeenCalledWith(req, res, 'codex')
  })
})

describe('count_tokens vendor routing on the unified /api mount', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('gpt-* with an openai-only key returns a local estimate instead of a 403', async () => {
    const handler = countTokensHandler
    apiKeyService.hasPermission.mockImplementation((_permissions, service) => service === 'openai')
    estimateInputTokens.mockReturnValue(42)

    const req = createRequest({ baseUrl: '/api', model: 'gpt-5.6-sol', permissions: ['openai'] })
    const res = createResponse()

    await handler(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.body).toEqual({ input_tokens: 42 })
  })

  it('claude-* still takes the Claude count_tokens path unchanged', async () => {
    const handler = countTokensHandler
    apiKeyService.hasPermission.mockImplementation((_permissions, service) => service === 'claude')
    claudeRelayConfigService.extractOriginalSessionId.mockReturnValue('session-1')
    claudeRelayConfigService.validateNewSession.mockResolvedValue({
      valid: false,
      code: 'test',
      error: 'session binding failed'
    })

    const req = createRequest({
      baseUrl: '/api',
      model: 'claude-opus-4-5-20251101',
      permissions: ['claude']
    })
    const res = createResponse()

    await handler(req, res)

    expect(claudeRelayConfigService.extractOriginalSessionId).toHaveBeenCalledWith(req.body)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.body.error.type).toBe('session_binding_error')
  })
})
