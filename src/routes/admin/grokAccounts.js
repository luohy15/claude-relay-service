/**
 * Admin Routes - Grok（grok.com 订阅 OAuth）账户管理
 * 处理 Grok 账户的 CRUD 操作。凭证通过手动粘贴 access/refresh token 获取
 * （从已登录 grok CLI 的机器上的 ~/.grok/auth.json 复制），没有服务端发起的
 * OAuth 授权码流程。
 */

const express = require('express')
const axios = require('axios')
const grokAccountService = require('../../services/account/grokAccountService')
const accountGroupService = require('../../services/accountGroupService')
const apiKeyService = require('../../services/apiKeyService')
const redis = require('../../models/redis')
const { authenticateAdmin } = require('../../middleware/auth')
const logger = require('../../utils/logger')
const webhookNotifier = require('../../utils/webhookNotifier')
const { formatAccountExpiry, mapExpiryField } = require('./utils')
const { createOpenAITestPayload, extractErrorMessage } = require('../../utils/testPayloadHelper')
const ProxyHelper = require('../../utils/proxyHelper')

const router = express.Router()
const GROK_CLI_CLIENT_VERSION = '0.2.101'
const GROK_CLI_CLIENT_IDENTIFIER = 'grok-shell'

// 获取所有 Grok 账户
router.get('/', authenticateAdmin, async (req, res) => {
  try {
    const { platform, groupId } = req.query
    let accounts = await grokAccountService.getAllAccounts()

    if (platform && platform !== 'all' && platform !== 'grok') {
      accounts = []
    }

    const accountGroupCache = new Map()
    const fetchAccountGroups = async (accountId) => {
      if (!accountGroupCache.has(accountId)) {
        const groups = await accountGroupService.getAccountGroups(accountId)
        accountGroupCache.set(accountId, groups || [])
      }
      return accountGroupCache.get(accountId)
    }

    if (groupId && groupId !== 'all') {
      if (groupId === 'ungrouped') {
        const filteredAccounts = []
        for (const account of accounts) {
          const groups = await fetchAccountGroups(account.id)
          if (!groups || groups.length === 0) {
            filteredAccounts.push(account)
          }
        }
        accounts = filteredAccounts
      } else {
        const groupMembers = await accountGroupService.getGroupMembers(groupId)
        accounts = accounts.filter((account) => groupMembers.includes(account.id))
      }
    }

    const accountsWithStats = await Promise.all(
      accounts.map(async (account) => {
        try {
          const usageStats = await redis.getAccountUsageStats(account.id, 'grok')
          const groupInfos = await fetchAccountGroups(account.id)
          const formattedAccount = formatAccountExpiry(account)
          return {
            ...formattedAccount,
            groupInfos,
            usage: {
              daily: usageStats.daily,
              total: usageStats.total,
              monthly: usageStats.monthly
            }
          }
        } catch (error) {
          logger.debug(`Failed to get usage stats for Grok account ${account.id}:`, error)
          const groupInfos = await fetchAccountGroups(account.id)
          const formattedAccount = formatAccountExpiry(account)
          return {
            ...formattedAccount,
            groupInfos,
            usage: {
              daily: { requests: 0, tokens: 0, allTokens: 0 },
              total: { requests: 0, tokens: 0, allTokens: 0 },
              monthly: { requests: 0, tokens: 0, allTokens: 0 }
            }
          }
        }
      })
    )

    logger.info(`获取 Grok 账户列表: ${accountsWithStats.length} 个账户`)

    return res.json({
      success: true,
      data: accountsWithStats
    })
  } catch (error) {
    logger.error('获取 Grok 账户列表失败:', error)
    return res.status(500).json({
      success: false,
      message: '获取账户列表失败',
      error: error.message
    })
  }
})

// 创建 Grok 账户
router.post('/', authenticateAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      grokOauth,
      proxy,
      accountType,
      groupId,
      groupIds,
      priority,
      subscriptionExpiresAt,
      needsImmediateRefresh,
      requireRefreshSuccess
    } = req.body

    if (!name) {
      return res.status(400).json({
        success: false,
        message: '账户名称不能为空'
      })
    }

    if (!grokOauth || !grokOauth.refreshToken || !grokOauth.refreshToken.trim()) {
      return res.status(400).json({
        success: false,
        message: '请填写 Refresh Token'
      })
    }

    const accountData = {
      name,
      description: description || '',
      accountType: accountType || 'shared',
      priority: priority || 50,
      grokOauth,
      proxy: proxy || null,
      subscriptionExpiresAt: subscriptionExpiresAt || null,
      isActive: true,
      schedulable: true
    }

    if (needsImmediateRefresh && requireRefreshSuccess) {
      // 先创建临时账户以测试刷新（校验 refresh token 是否有效）
      const tempAccount = await grokAccountService.createAccount(accountData)

      try {
        logger.info('🔄 测试刷新 Grok 账户以验证 Refresh Token')
        await grokAccountService.refreshAccountToken(tempAccount.id)

        const refreshedAccount = await grokAccountService.getAccount(tempAccount.id)

        if (accountType === 'group') {
          if (groupIds && groupIds.length > 0) {
            await accountGroupService.setAccountGroups(tempAccount.id, groupIds, 'openai')
          } else if (groupId) {
            await accountGroupService.addAccountToGroup(tempAccount.id, groupId, 'openai')
          }
        }

        logger.success(`创建并验证 Grok 账户成功: ${name} (ID: ${tempAccount.id})`)

        return res.json({
          success: true,
          data: grokAccountService.sanitizeAccountForResponse(refreshedAccount),
          message: '账户创建成功，并已验证 Token 可用'
        })
      } catch (refreshError) {
        logger.warn(`❌ 刷新失败，删除临时账户: ${refreshError.message}`)
        await grokAccountService.deleteAccount(tempAccount.id)

        const errorResponse = {
          success: false,
          message: '账户创建失败',
          error: refreshError.message
        }
        if (refreshError.status) {
          errorResponse.errorCode = refreshError.status
        }
        if (refreshError.details) {
          errorResponse.errorDetails = refreshError.details
        }
        if (refreshError.message.includes('Refresh Token 无效')) {
          errorResponse.suggestion =
            '请重新登录 grok.com（grok login）后，从 ~/.grok/auth.json 复制最新凭证'
        } else if (refreshError.message.includes('代理')) {
          errorResponse.suggestion = '请检查代理配置是否正确，包括地址、端口和认证信息'
        }

        return res.status(400).json(errorResponse)
      }
    }

    const createdAccount = await grokAccountService.createAccount(accountData)

    if (accountType === 'group') {
      if (groupIds && groupIds.length > 0) {
        await accountGroupService.setAccountGroups(createdAccount.id, groupIds, 'openai')
      } else if (groupId) {
        await accountGroupService.addAccountToGroup(createdAccount.id, groupId, 'openai')
      }
    }

    logger.success(`创建 Grok 账户成功: ${name} (ID: ${createdAccount.id})`)

    return res.json({
      success: true,
      data: grokAccountService.sanitizeAccountForResponse(createdAccount)
    })
  } catch (error) {
    logger.error('创建 Grok 账户失败:', error)
    return res.status(500).json({
      success: false,
      message: '创建账户失败',
      error: error.message
    })
  }
})

// 更新 Grok 账户
router.put('/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params
    const updates = req.body

    const mappedUpdates = mapExpiryField(updates, 'Grok', id)

    if (
      mappedUpdates.accountType &&
      !['shared', 'dedicated', 'group'].includes(mappedUpdates.accountType)
    ) {
      return res
        .status(400)
        .json({ error: 'Invalid account type. Must be "shared", "dedicated" or "group"' })
    }

    if (
      mappedUpdates.accountType === 'group' &&
      !mappedUpdates.groupId &&
      (!mappedUpdates.groupIds || mappedUpdates.groupIds.length === 0)
    ) {
      return res
        .status(400)
        .json({ error: 'Group ID or Group IDs are required for group type accounts' })
    }

    const currentAccount = await grokAccountService.getAccount(id)
    if (!currentAccount) {
      return res.status(404).json({ error: 'Account not found' })
    }

    if (mappedUpdates.accountType !== undefined) {
      if (currentAccount.accountType === 'group') {
        await accountGroupService.removeAccountFromAllGroups(id)
      }
      if (mappedUpdates.accountType === 'group') {
        if (Object.prototype.hasOwnProperty.call(mappedUpdates, 'groupIds')) {
          if (mappedUpdates.groupIds && mappedUpdates.groupIds.length > 0) {
            await accountGroupService.setAccountGroups(id, mappedUpdates.groupIds, 'openai')
          } else {
            await accountGroupService.removeAccountFromAllGroups(id)
          }
        } else if (mappedUpdates.groupId) {
          await accountGroupService.addAccountToGroup(id, mappedUpdates.groupId, 'openai')
        }
      }
    }

    const updateData = { ...mappedUpdates }

    if (mappedUpdates.grokOauth) {
      if (mappedUpdates.grokOauth.accessToken) {
        updateData.accessToken = mappedUpdates.grokOauth.accessToken
      }
      if (mappedUpdates.grokOauth.refreshToken) {
        updateData.refreshToken = mappedUpdates.grokOauth.refreshToken
      }
      if (mappedUpdates.grokOauth.expires_in) {
        updateData.expiresAt = new Date(
          Date.now() + mappedUpdates.grokOauth.expires_in * 1000
        ).toISOString()
      }
      delete updateData.grokOauth
    }

    const updatedAccount = await grokAccountService.updateAccount(id, updateData)

    logger.success(`📝 Admin updated Grok account: ${id}`)
    return res.json({
      success: true,
      data: grokAccountService.sanitizeAccountForResponse(updatedAccount)
    })
  } catch (error) {
    logger.error('❌ Failed to update Grok account:', error)
    return res.status(500).json({ error: 'Failed to update account', message: error.message })
  }
})

// 删除 Grok 账户
router.delete('/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params

    const account = await grokAccountService.getAccount(id)
    if (!account) {
      return res.status(404).json({
        success: false,
        message: '账户不存在'
      })
    }

    const unboundCount = await apiKeyService.unbindAccountFromAllKeys(id, 'grok')

    if (account.accountType === 'group') {
      const group = await accountGroupService.getAccountGroup(id)
      if (group) {
        await accountGroupService.removeAccountFromGroup(id, group.id)
      }
    }

    await grokAccountService.deleteAccount(id)

    let message = 'Grok账号已成功删除'
    if (unboundCount > 0) {
      message += `，${unboundCount} 个 API Key 已切换为共享池模式`
    }

    logger.success(
      `✅ 删除 Grok 账户成功: ${account.name} (ID: ${id}), unbound ${unboundCount} keys`
    )

    return res.json({
      success: true,
      message,
      unboundKeys: unboundCount
    })
  } catch (error) {
    logger.error('删除 Grok 账户失败:', error)
    return res.status(500).json({
      success: false,
      message: '删除账户失败',
      error: error.message
    })
  }
})

// 重置 Grok 账户状态（清除所有异常状态）
router.post('/:accountId/reset-status', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params

    const result = await grokAccountService.resetAccountStatus(accountId)

    logger.success(`Admin reset status for Grok account: ${accountId}`)
    return res.json({ success: true, data: result })
  } catch (error) {
    logger.error('❌ Failed to reset Grok account status:', error)
    return res.status(500).json({ error: 'Failed to reset status', message: error.message })
  }
})

// 切换 Grok 账户调度状态
router.put('/:accountId/toggle-schedulable', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params

    const result = await grokAccountService.toggleSchedulable(accountId)

    if (!result.schedulable) {
      const account = await grokAccountService.getAccount(accountId)
      if (account) {
        await webhookNotifier.sendAccountAnomalyNotification({
          accountId: account.id,
          accountName: account.name || 'Grok Account',
          platform: 'grok',
          status: 'disabled',
          errorCode: 'GROK_MANUALLY_DISABLED',
          reason: '账号已被管理员手动禁用调度',
          timestamp: new Date().toISOString()
        })
      }
    }

    return res.json({
      success: result.success,
      schedulable: result.schedulable,
      message: result.schedulable ? '已启用调度' : '已禁用调度'
    })
  } catch (error) {
    logger.error('切换 Grok 账户调度状态失败:', error)
    return res.status(500).json({
      success: false,
      message: '切换调度状态失败',
      error: error.message
    })
  }
})

// 切换 Grok 账户激活状态
router.put('/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params

    const account = await grokAccountService.getAccount(id)
    if (!account) {
      return res.status(404).json({
        success: false,
        message: '账户不存在'
      })
    }

    const newActiveStatus = account.isActive === 'true' ? 'false' : 'true'
    await grokAccountService.updateAccount(id, {
      isActive: newActiveStatus
    })

    return res.json({
      success: true,
      isActive: newActiveStatus === 'true'
    })
  } catch (error) {
    logger.error('切换 Grok 账户状态失败:', error)
    return res.status(500).json({
      success: false,
      message: '切换账户状态失败',
      error: error.message
    })
  }
})

// 测试 Grok 账户连通性
router.post('/:accountId/test', authenticateAdmin, async (req, res) => {
  const { accountId } = req.params
  // grok-4.5 is the default: verified accessible to subscription accounts, unlike
  // grok-4.5-build which requires separate team entitlement.
  const { model = 'grok-4.5' } = req.body
  const startTime = Date.now()

  try {
    let account = await grokAccountService.getAccount(accountId)
    if (!account) {
      return res.status(404).json({ error: 'Account not found' })
    }

    if (grokAccountService.isTokenExpired(account)) {
      await grokAccountService.refreshAccountToken(accountId)
      account = await grokAccountService.getAccount(accountId)
    }

    if (!account.apiKey) {
      return res.status(401).json({ error: 'Access Token not found or decryption failed' })
    }

    const apiUrl = `${account.baseApi}/responses`
    const payload = createOpenAITestPayload(model, { stream: false })

    const requestConfig = {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${account.apiKey}`,
        'X-XAI-Token-Auth': 'xai-grok-cli',
        'x-grok-client-version': GROK_CLI_CLIENT_VERSION,
        'x-grok-client-identifier': GROK_CLI_CLIENT_IDENTIFIER,
        'x-grok-model-override': model
      },
      timeout: 30000
    }

    if (account.proxy) {
      const agent = ProxyHelper.createProxyAgent(account.proxy)
      if (agent) {
        requestConfig.httpsAgent = agent
        requestConfig.httpAgent = agent
      }
    }

    const response = await axios.post(apiUrl, payload, requestConfig)
    const latency = Date.now() - startTime

    // 提取响应文本（Responses API 格式）
    let responseText = ''
    const output = response.data?.output
    if (Array.isArray(output)) {
      for (const item of output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const block of item.content) {
            if (block.type === 'output_text' && block.text) {
              responseText += block.text
            }
          }
        }
      }
    }

    logger.success(
      `✅ Grok account test passed: ${account.name} (${accountId}), latency: ${latency}ms`
    )

    return res.json({
      success: true,
      data: {
        accountId,
        accountName: account.name,
        model,
        latency,
        responseText: responseText.substring(0, 200)
      }
    })
  } catch (error) {
    const latency = Date.now() - startTime
    logger.error(`❌ Grok account test failed: ${accountId}`, error.message)

    return res.status(500).json({
      success: false,
      error: 'Test failed',
      message: extractErrorMessage(error.response?.data, error.message),
      latency
    })
  }
})

module.exports = router
