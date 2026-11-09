jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAccount: jest.fn(),
  _createProxyAgent: jest.fn()
}))

jest.mock('../config/config', () => ({}), {
  virtual: true
})
jest.mock('../src/models/redis', () => ({}))

jest.mock('../src/utils/testPayloadHelper', () => ({
  createClaudeTestPayload: jest.fn(),
  sendStreamTestRequest: jest.fn()
}))

const claudeConsoleRelayService = require('../src/services/relay/claudeConsoleRelayService')
const claudeConsoleAccountService = require('../src/services/account/claudeConsoleAccountService')
const { createClaudeTestPayload, sendStreamTestRequest } = require('../src/utils/testPayloadHelper')

const originalDisableFlag = process.env.DISABLE_ANTHROPIC_MODELS

describe('claudeConsoleRelayService.testAccountConnection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // 这两个用例测的是开关关闭后的请求形状。默认开关是开的，会在发请求前拦住。
    process.env.DISABLE_ANTHROPIC_MODELS = 'false'
  })

  afterEach(() => {
    if (originalDisableFlag === undefined) {
      delete process.env.DISABLE_ANTHROPIC_MODELS
    } else {
      process.env.DISABLE_ANTHROPIC_MODELS = originalDisableFlag
    }
  })

  it('passes selected model stream payload and bearer auth for non sk-ant key', async () => {
    claudeConsoleAccountService.getAccount.mockResolvedValue({
      name: 'Console A1',
      apiUrl: 'https://console.example.com',
      apiKey: 'test-key',
      proxy: null,
      userAgent: null
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)

    const payload = {
      model: 'claude-sonnet-4-6',
      stream: true
    }
    createClaudeTestPayload.mockReturnValue(payload)
    sendStreamTestRequest.mockResolvedValue(undefined)

    const res = {}
    await claudeConsoleRelayService.testAccountConnection('a1', res, 'claude-sonnet-4-6')

    expect(createClaudeTestPayload).toHaveBeenCalledWith('claude-sonnet-4-6', { stream: true })
    expect(sendStreamTestRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload,
        authorization: 'Bearer test-key'
      })
    )
  })

  it('passes selected model stream payload and x-api-key for sk-ant key', async () => {
    claudeConsoleAccountService.getAccount.mockResolvedValue({
      name: 'Console A1',
      apiUrl: 'https://console.example.com',
      apiKey: 'sk-ant-test-key',
      proxy: null,
      userAgent: null
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)

    const payload = {
      model: 'claude-sonnet-4-6',
      stream: true
    }
    createClaudeTestPayload.mockReturnValue(payload)
    sendStreamTestRequest.mockResolvedValue(undefined)

    const res = {}
    await claudeConsoleRelayService.testAccountConnection('a1', res, 'claude-sonnet-4-6')

    expect(createClaudeTestPayload).toHaveBeenCalledWith('claude-sonnet-4-6', { stream: true })
    const requestOptions = sendStreamTestRequest.mock.calls[0][0]
    expect(requestOptions).toEqual(
      expect.objectContaining({
        payload,
        extraHeaders: expect.objectContaining({
          'x-api-key': 'sk-ant-test-key'
        })
      })
    )
    expect(requestOptions).not.toHaveProperty('authorization')
  })

  it('does not call upstream when the disable flag is on', async () => {
    delete process.env.DISABLE_ANTHROPIC_MODELS
    const chunks = []
    const res = {
      headersSent: false,
      writeHead: jest.fn(),
      write: jest.fn((chunk) => {
        chunks.push(chunk)
        return true
      }),
      end: jest.fn()
    }

    await claudeConsoleRelayService.testAccountConnection('a1', res, 'claude-sonnet-4-6')

    expect(createClaudeTestPayload).not.toHaveBeenCalled()
    expect(sendStreamTestRequest).not.toHaveBeenCalled()
    expect(claudeConsoleAccountService.getAccount).not.toHaveBeenCalled()
    expect(chunks.join('')).toContain('disabled')
    expect(res.end).toHaveBeenCalled()
  })
})
