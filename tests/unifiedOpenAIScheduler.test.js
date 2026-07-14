jest.mock('../src/services/account/openaiAccountService', () => ({
  setAccountRateLimited: jest.fn(),
  getAllAccounts: jest.fn().mockResolvedValue([]),
  getAccount: jest.fn(),
  isTokenExpired: jest.fn().mockReturnValue(false)
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  markAccountRateLimited: jest.fn(),
  updateAccount: jest.fn(),
  getAllAccounts: jest.fn().mockResolvedValue([]),
  isSubscriptionExpired: jest.fn().mockReturnValue(false),
  checkAndClearRateLimit: jest.fn().mockResolvedValue(false)
}))

jest.mock('../src/services/account/grokAccountService', () => ({
  getAccount: jest.fn(),
  setAccountRateLimited: jest.fn(),
  markAccountUnauthorized: jest.fn(),
  recordUsage: jest.fn(),
  isTokenExpired: jest.fn().mockReturnValue(false),
  refreshAccountToken: jest.fn(),
  getAllAccounts: jest.fn().mockResolvedValue([])
}))

jest.mock('../src/services/accountGroupService', () => ({
  getGroup: jest.fn(),
  getGroupMembers: jest.fn()
}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}))
jest.mock('../src/utils/commonHelper', () => ({
  isSchedulable: jest.fn((value) => value !== false && value !== 'false'),
  sortAccountsByPriority: jest.fn((accounts) => accounts)
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  isTempUnavailable: jest.fn().mockResolvedValue(false)
}))

const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const grokAccountService = require('../src/services/account/grokAccountService')
const accountGroupService = require('../src/services/accountGroupService')
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')

describe('UnifiedOpenAIScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('markAccountRateLimited', () => {
    it('does not disable scheduling again when OpenAI-Responses auto protection is disabled', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'account-1',
        disableAutoProtection: 'true'
      })

      await unifiedOpenAIScheduler.markAccountRateLimited(
        'account-1',
        'openai-responses',
        null,
        120
      )

      expect(openaiResponsesAccountService.markAccountRateLimited).toHaveBeenCalledWith(
        'account-1',
        2
      )
      expect(openaiResponsesAccountService.updateAccount).not.toHaveBeenCalled()
    })

    it('keeps disabling scheduling for protected OpenAI-Responses accounts', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'account-1',
        disableAutoProtection: 'false'
      })

      await unifiedOpenAIScheduler.markAccountRateLimited(
        'account-1',
        'openai-responses',
        null,
        120
      )

      expect(openaiResponsesAccountService.updateAccount).toHaveBeenCalledWith(
        'account-1',
        expect.objectContaining({
          schedulable: 'false'
        })
      )
    })

    it('routes Grok accounts to grokAccountService.setAccountRateLimited', async () => {
      await unifiedOpenAIScheduler.markAccountRateLimited('grok-account-1', 'grok', null, 90)

      expect(grokAccountService.setAccountRateLimited).toHaveBeenCalledWith(
        'grok-account-1',
        true,
        90
      )
    })
  })

  describe('markAccountUnauthorized', () => {
    it('routes Grok accounts to grokAccountService.markAccountUnauthorized', async () => {
      await unifiedOpenAIScheduler.markAccountUnauthorized(
        'grok-account-1',
        'grok',
        null,
        'invalid token'
      )

      expect(grokAccountService.markAccountUnauthorized).toHaveBeenCalledWith(
        'grok-account-1',
        'invalid token'
      )
    })
  })

  describe('updateAccountLastUsed', () => {
    it('routes Grok accounts to grokAccountService.recordUsage', async () => {
      await unifiedOpenAIScheduler.updateAccountLastUsed('grok-account-1', 'grok')

      expect(grokAccountService.recordUsage).toHaveBeenCalledWith('grok-account-1', 0)
    })
  })

  describe('_getAllAvailableAccounts provider-compatible model filtering', () => {
    const openaiAccount = {
      id: 'openai-1',
      name: 'Codex Account',
      isActive: true,
      status: 'active',
      accountType: 'shared',
      schedulable: 'true',
      refreshToken: 'rt',
      priority: '50'
    }
    const grokAccount = {
      id: 'grok-1',
      name: 'Grok Account',
      isActive: 'true',
      status: 'active',
      accountType: 'shared',
      schedulable: 'true',
      refreshToken: 'rt',
      priority: '50'
    }

    beforeEach(() => {
      openaiAccountService.getAllAccounts.mockResolvedValue([openaiAccount])
      grokAccountService.getAllAccounts.mockResolvedValue([grokAccount])
      openaiResponsesAccountService.getAllAccounts.mockResolvedValue([])
    })

    it('never selects a Grok account for a GPT/OpenAI model', async () => {
      const accounts = await unifiedOpenAIScheduler._getAllAvailableAccounts({}, 'gpt-5')

      expect(accounts.map((a) => a.accountType)).toEqual(['openai'])
    })

    it('never selects an OpenAI/Codex account for a Grok model', async () => {
      const accounts = await unifiedOpenAIScheduler._getAllAvailableAccounts({}, 'grok-4.5-build')

      expect(accounts.map((a) => a.accountType)).toEqual(['grok'])
    })

    it('excludes Grok from the pool when no model is specified', async () => {
      const accounts = await unifiedOpenAIScheduler._getAllAvailableAccounts({}, null)

      expect(accounts.map((a) => a.accountType)).toEqual(['openai'])
    })
  })

  describe('selectAccountFromGroup with a Grok member', () => {
    const grokMember = {
      id: 'grok-group-member',
      name: 'Grok Group Account',
      isActive: 'true',
      status: 'active',
      schedulable: 'true',
      refreshToken: 'rt',
      priority: '50'
    }

    beforeEach(() => {
      accountGroupService.getGroup.mockResolvedValue({
        id: 'group-1',
        name: 'Grok Group',
        platform: 'openai'
      })
      accountGroupService.getGroupMembers.mockResolvedValue(['grok-group-member'])
      openaiAccountService.getAccount.mockResolvedValue(null)
      openaiResponsesAccountService.getAccount.mockResolvedValue(null)
      grokAccountService.getAccount.mockResolvedValue(grokMember)
    })

    it('probes grokAccountService and selects the Grok member for a Grok model request', async () => {
      const result = await unifiedOpenAIScheduler.selectAccountFromGroup(
        'group-1',
        null,
        'grok-4.5-build'
      )

      expect(result).toEqual({
        accountId: 'grok-group-member',
        accountType: 'grok'
      })
    })

    it('refreshes an expired Grok group member before selecting it', async () => {
      grokAccountService.isTokenExpired.mockReturnValueOnce(true)
      grokAccountService.refreshAccountToken.mockResolvedValue({})
      grokAccountService.getAccount
        .mockResolvedValueOnce(grokMember) // initial probe
        .mockResolvedValueOnce({ ...grokMember }) // re-fetch after refresh

      const result = await unifiedOpenAIScheduler.selectAccountFromGroup(
        'group-1',
        null,
        'grok-4.5-build'
      )

      expect(grokAccountService.refreshAccountToken).toHaveBeenCalledWith('grok-group-member')
      expect(result.accountType).toBe('grok')
    })

    it('does not select the Grok member for a non-Grok model request', async () => {
      await expect(
        unifiedOpenAIScheduler.selectAccountFromGroup('group-1', null, 'gpt-5')
      ).rejects.toThrow('No available accounts in group Grok Group')
    })
  })

  describe('_isAccountAvailable sticky-session string isActive handling', () => {
    it('treats a Grok account with isActive "false" (string) as unavailable', async () => {
      grokAccountService.getAccount.mockResolvedValue({
        id: 'grok-disabled',
        isActive: 'false',
        status: 'active',
        schedulable: 'true'
      })

      const available = await unifiedOpenAIScheduler._isAccountAvailable('grok-disabled', 'grok')

      expect(available).toBe(false)
    })

    it('treats a Grok account with isActive "true" (string) as available', async () => {
      grokAccountService.getAccount.mockResolvedValue({
        id: 'grok-enabled',
        isActive: 'true',
        status: 'active',
        schedulable: 'true',
        rateLimitStatus: 'normal'
      })

      const available = await unifiedOpenAIScheduler._isAccountAvailable('grok-enabled', 'grok')

      expect(available).toBe(true)
    })
  })
})
