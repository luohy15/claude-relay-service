/**
 * Grok pricing resolution test
 *
 * Verifies the resources/model-pricing fallback file has real (non-zero) pricing
 * entries for the Grok Build models, keyed by the actual model string recorded from
 * cli-chat-proxy.grok.com's response.completed event (verified live 2026-07-14:
 * requesting "grok-4.5" records back "grok-4.5-build").
 */

jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  success: jest.fn(),
  database: jest.fn(),
  security: jest.fn()
}))

jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return {
    ...actual,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn(),
    statSync: jest.fn(),
    watchFile: jest.fn(),
    unwatchFile: jest.fn()
  }
})

describe('Grok pricing', () => {
  let pricingService
  let CostCalculator
  const fs = require('fs')
  const path = require('path')

  const realFs = jest.requireActual('fs')
  const primaryPath = path.join(process.cwd(), 'data', 'model_pricing.json')
  const fallbackPath = path.join(
    process.cwd(),
    'resources',
    'model-pricing',
    'model_prices_and_context_window.json'
  )
  const pricingFilePath = realFs.existsSync(primaryPath) ? primaryPath : fallbackPath
  const pricingData = JSON.parse(realFs.readFileSync(pricingFilePath, 'utf8'))

  beforeEach(() => {
    jest.resetModules()

    fs.existsSync.mockReturnValue(true)
    fs.readFileSync.mockReturnValue(JSON.stringify(pricingData))
    fs.statSync.mockReturnValue({ mtime: new Date(), mtimeMs: Date.now() })
    fs.watchFile.mockImplementation(() => {})
    fs.unwatchFile.mockImplementation(() => {})

    pricingService = require('../src/services/pricingService')
    pricingService.pricingData = pricingData
    pricingService.lastUpdated = new Date()

    CostCalculator = require('../src/utils/costCalculator')
  })

  afterEach(() => {
    if (pricingService.cleanup) {
      pricingService.cleanup()
    }
    jest.clearAllMocks()
  })

  it('has a pricing entry for the recorded grok-4.5-build model', () => {
    const pricing = pricingService.getModelPricing('grok-4.5-build')
    expect(pricing).not.toBeNull()
    expect(pricing.input_cost_per_token).toBeGreaterThan(0)
    expect(pricing.output_cost_per_token).toBeGreaterThan(0)
  })

  it('computes a non-zero cost for a grok-4.5-build request', () => {
    const usage = {
      input_tokens: 86,
      output_tokens: 33,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 128
    }

    const result = CostCalculator.calculateCost(usage, 'grok-4.5-build')

    expect(result.costs.total).toBeGreaterThan(0)
    expect(result.costs.input).toBeGreaterThan(0)
    expect(result.costs.output).toBeGreaterThan(0)
    expect(result.costs.cacheRead).toBeGreaterThan(0)
  })

  it('has a pricing entry for the base grok-4.5 and grok-composer-2.5-fast model ids', () => {
    expect(pricingService.getModelPricing('grok-4.5')).not.toBeNull()
    expect(pricingService.getModelPricing('grok-composer-2.5-fast')).not.toBeNull()
    expect(pricingService.getModelPricing('grok-composer-2.5-fast-build')).not.toBeNull()
  })
})
