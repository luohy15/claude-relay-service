const { resolveVendorFromModel, DEFAULT_MODEL_VENDOR_ROUTES } = require('../src/utils/modelHelper')

describe('resolveVendorFromModel', () => {
  it('maps gpt-* ids to the codex bridge', () => {
    expect(resolveVendorFromModel('gpt-5.6-sol')).toBe('codex')
    expect(resolveVendorFromModel('gpt-5')).toBe('codex')
  })

  it('maps grok-* ids to the grok bridge', () => {
    expect(resolveVendorFromModel('grok-4.5')).toBe('grok')
  })

  it('is case-insensitive', () => {
    expect(resolveVendorFromModel('GPT-5.6-SOL')).toBe('codex')
    expect(resolveVendorFromModel('Grok-4.5')).toBe('grok')
  })

  it('returns null for slash ids, even if they contain a bridge prefix', () => {
    expect(resolveVendorFromModel('x-ai/grok-4')).toBeNull()
    expect(resolveVendorFromModel('openai/gpt-5')).toBeNull()
    expect(resolveVendorFromModel('moonshotai/kimi-k3')).toBeNull()
  })

  it('returns null for native claude ids', () => {
    expect(resolveVendorFromModel('claude-opus-4-5-20251101')).toBeNull()
  })

  it('returns null for empty/invalid input', () => {
    expect(resolveVendorFromModel('')).toBeNull()
    expect(resolveVendorFromModel(null)).toBeNull()
    expect(resolveVendorFromModel(123)).toBeNull()
  })

  it('exposes the built-in default routes', () => {
    expect(DEFAULT_MODEL_VENDOR_ROUTES).toEqual([
      { prefix: 'gpt-', vendor: 'codex' },
      { prefix: 'grok-', vendor: 'grok' }
    ])
  })
})

describe('resolveVendorFromModel with MODEL_VENDOR_ROUTES override', () => {
  const ORIGINAL_ENV = process.env.MODEL_VENDOR_ROUTES

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.MODEL_VENDOR_ROUTES
    } else {
      process.env.MODEL_VENDOR_ROUTES = ORIGINAL_ENV
    }
    jest.resetModules()
  })

  it('drops an unknown vendor while honoring the rest', () => {
    process.env.MODEL_VENDOR_ROUTES = 'gpt-:codex,grok-:grok,foo-:bar'
    jest.resetModules()
    // eslint-disable-next-line global-require
    const { resolveVendorFromModel: resolve } = require('../src/utils/modelHelper')

    expect(resolve('gpt-5')).toBe('codex')
    expect(resolve('grok-4.5')).toBe('grok')
    expect(resolve('foo-bar')).toBeNull()
  })
})
