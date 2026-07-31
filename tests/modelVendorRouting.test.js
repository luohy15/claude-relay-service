const {
  resolveVendorFromModel,
  stripModelCapabilitySuffix,
  DEFAULT_MODEL_VENDOR_ROUTES
} = require('../src/utils/modelHelper')

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

describe('stripModelCapabilitySuffix', () => {
  it('strips the trailing [1m] client capability suffix', () => {
    expect(stripModelCapabilitySuffix('gpt-5.6-sol[1m]')).toBe('gpt-5.6-sol')
    expect(stripModelCapabilitySuffix('claude-opus-4-5-20251101[1m]')).toBe(
      'claude-opus-4-5-20251101'
    )
  })

  it('is case-insensitive on the suffix', () => {
    expect(stripModelCapabilitySuffix('gpt-5.6-sol[1M]')).toBe('gpt-5.6-sol')
  })

  it('leaves model ids without the suffix untouched', () => {
    expect(stripModelCapabilitySuffix('gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(stripModelCapabilitySuffix('grok-4.5')).toBe('grok-4.5')
    expect(stripModelCapabilitySuffix('x-ai/grok-4')).toBe('x-ai/grok-4')
  })

  it('leaves unrelated bracket forms untouched', () => {
    // 只认结尾的 [1m]：其它括号内容、非结尾位置、别的窗口标记都不是这个能力后缀
    expect(stripModelCapabilitySuffix('gpt-5.6-sol[200k]')).toBe('gpt-5.6-sol[200k]')
    expect(stripModelCapabilitySuffix('gpt-5.6-sol[1m]-preview')).toBe('gpt-5.6-sol[1m]-preview')
    expect(stripModelCapabilitySuffix('gpt-5.6-sol[1m][1m]')).toBe('gpt-5.6-sol[1m]')
    expect(stripModelCapabilitySuffix('gpt-1m')).toBe('gpt-1m')
    expect(stripModelCapabilitySuffix('[1m]')).toBe('[1m]')
  })

  it('returns an empty string for empty/invalid input', () => {
    expect(stripModelCapabilitySuffix('')).toBe('')
    expect(stripModelCapabilitySuffix(null)).toBe('')
    expect(stripModelCapabilitySuffix(123)).toBe('')
  })

  it('feeds vendor routing the real upstream model', () => {
    expect(resolveVendorFromModel(stripModelCapabilitySuffix('gpt-5.6-sol[1m]'))).toBe('codex')
    expect(resolveVendorFromModel(stripModelCapabilitySuffix('grok-4.5[1m]'))).toBe('grok')
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
