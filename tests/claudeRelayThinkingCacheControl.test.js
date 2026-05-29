jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock(
  '../config/config',
  () => ({
    claude: {
      apiVersion: '2023-06-01',
      betaHeader: '',
      systemPrompt: ''
    }
  }),
  { virtual: true }
)

jest.mock('../src/models/redis', () => ({}))

const claudeRelayService = require('../src/services/relay/claudeRelayService')

describe('claudeRelayService cache_control helpers never modify thinking blocks', () => {
  it('_stripTtlFromCacheControl leaves thinking/redacted_thinking blocks byte-identical', () => {
    const thinkingBlock = {
      type: 'thinking',
      thinking: 'let me reason',
      signature: 'sig-abc',
      cache_control: { type: 'ephemeral', ttl: '1h' }
    }
    const redactedBlock = {
      type: 'redacted_thinking',
      data: 'opaque',
      cache_control: { type: 'ephemeral', ttl: '5m' }
    }
    const textBlock = {
      type: 'text',
      text: 'hello',
      cache_control: { type: 'ephemeral', ttl: '1h' }
    }

    const body = {
      messages: [
        {
          role: 'assistant',
          content: [thinkingBlock, redactedBlock, textBlock]
        }
      ]
    }

    claudeRelayService._stripTtlFromCacheControl(body)

    // thinking blocks must be untouched (ttl preserved)
    expect(thinkingBlock.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(redactedBlock.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' })
    // non-thinking blocks still get ttl stripped
    expect(textBlock.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('_enforceCacheControlLimit never strips cache_control from thinking blocks and excludes them from the count', () => {
    const thinkingBlock = {
      type: 'thinking',
      thinking: 'reasoning',
      signature: 'sig-xyz',
      cache_control: { type: 'ephemeral' }
    }
    const textBlocks = Array.from({ length: 5 }, (_, i) => ({
      type: 'text',
      text: `block-${i}`,
      cache_control: { type: 'ephemeral' }
    }))

    const body = {
      messages: [
        {
          role: 'assistant',
          content: [thinkingBlock, ...textBlocks]
        }
      ]
    }

    claudeRelayService._enforceCacheControlLimit(body)

    // thinking block keeps its cache_control regardless of the limit
    expect(thinkingBlock.cache_control).toEqual({ type: 'ephemeral' })

    // non-thinking blocks are trimmed down to the 4-breakpoint budget
    const remaining = textBlocks.filter((b) => b.cache_control).length
    expect(remaining).toBe(4)
  })
})
