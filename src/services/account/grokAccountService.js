const redisClient = require('../../models/redis')
const { v4: uuidv4 } = require('uuid')
const axios = require('axios')
const ProxyHelper = require('../../utils/proxyHelper')
const config = require('../../../config/config')
const logger = require('../../utils/logger')
const {
  logRefreshStart,
  logRefreshSuccess,
  logRefreshError,
  logRefreshSkipped
} = require('../../utils/tokenRefreshLogger')
const tokenRefreshService = require('../tokenRefreshService')
const { createEncryptor } = require('../../utils/commonHelper')

// 使用 commonHelper 的加密器
const encryptor = createEncryptor('grok-account-salt')
const { encrypt, decrypt } = encryptor

// Grok (grok.com subscription OAuth) 账户键前缀
const GROK_ACCOUNT_KEY_PREFIX = 'grok:account:'
const SHARED_GROK_ACCOUNTS_KEY = 'shared_grok_accounts'
const ACCOUNT_SESSION_MAPPING_PREFIX = 'grok_session_account_mapping:'

// grok.com 订阅代理（CLI chat proxy），Grok Build 请求的固定上游目标
const GROK_PROXY_BASE_API = 'https://cli-chat-proxy.grok.com/v1'

// grok CLI 的客户端指纹头部（x-grok-client-version / x-grok-client-identifier）
// grok-build 客户端自带，非 grok 客户端（如 Claude Code 走 /grok/api 桥接）需由服务端注入
const GROK_CLI_CLIENT_VERSION = '0.2.101'
const GROK_CLI_CLIENT_IDENTIFIER = 'grok-shell'

// grok.com OIDC（auth.x.ai）公开客户端 ID，与 grok CLI 使用同一 client_id
const GROK_OIDC_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const GROK_OIDC_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token'

// 🧹 定期清理缓存（每10分钟），unref 避免在测试/脚本中阻塞进程退出
const cacheCleanupTimer = setInterval(
  () => {
    encryptor.clearCache()
    logger.info('🧹 Grok decrypt cache cleanup completed', encryptor.getStats())
  },
  10 * 60 * 1000
)
cacheCleanupTimer.unref?.()

// 解析 access token（JWT）中的非敏感元信息（tier/team），仅用于展示，解析失败不影响主流程
function decodeAccessTokenClaims(accessToken) {
  try {
    const parts = accessToken.split('.')
    if (parts.length !== 3) {
      return {}
    }
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    return {
      tier: payload.tier !== undefined ? String(payload.tier) : '',
      teamId: payload.team_id || '',
      principalId: payload.principal_id || ''
    }
  } catch (e) {
    return {}
  }
}

// 刷新访问令牌（grok.com OIDC，通过 auth.x.ai 的 refresh_token 授权）
async function refreshAccessToken(refreshToken, proxy = null) {
  try {
    const requestData = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GROK_OIDC_CLIENT_ID,
      refresh_token: refreshToken
    }).toString()

    const requestOptions = {
      method: 'POST',
      url: GROK_OIDC_TOKEN_ENDPOINT,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': requestData.length
      },
      data: requestData,
      timeout: config.requestTimeout || 600000
    }

    const proxyAgent = ProxyHelper.createProxyAgent(proxy)
    if (proxyAgent) {
      requestOptions.httpAgent = proxyAgent
      requestOptions.httpsAgent = proxyAgent
      requestOptions.proxy = false
      logger.info(
        `🌐 Using proxy for Grok token refresh: ${ProxyHelper.getProxyDescription(proxy)}`
      )
    } else {
      logger.debug('🌐 No proxy configured for Grok token refresh')
    }

    const response = await axios(requestOptions)

    if (response.status === 200 && response.data) {
      const result = response.data
      logger.info('✅ Successfully refreshed Grok token')

      return {
        access_token: result.access_token,
        // auth.x.ai 会在每次刷新时轮换 refresh_token，必须持久化新值
        refresh_token: result.refresh_token || refreshToken,
        expires_in: result.expires_in || 21600,
        expiry_date: Date.now() + (result.expires_in || 21600) * 1000
      }
    } else {
      throw new Error(`Failed to refresh token: ${response.status} ${response.statusText}`)
    }
  } catch (error) {
    if (error.response) {
      const errorData = error.response.data || {}
      logger.error('Grok token refresh failed:', {
        status: error.response.status,
        data: errorData,
        headers: error.response.headers
      })

      let errorMessage = `Grok 服务器返回错误 (${error.response.status})`
      if (error.response.status === 400) {
        if (errorData.error === 'invalid_grant') {
          errorMessage = 'Refresh Token 无效或已过期，请重新登录 grok.com 后获取新凭证'
        } else {
          errorMessage = `请求错误：${errorData.error_description || errorData.error || '未知错误'}`
        }
      } else if (error.response.status === 401) {
        errorMessage = '认证失败：Refresh Token 无效'
      } else if (error.response.status === 429) {
        errorMessage = '请求过于频繁，请稍后重试'
      } else if (error.response.status >= 500) {
        errorMessage = 'Grok 服务器内部错误，请稍后重试'
      } else if (errorData.error_description) {
        errorMessage = errorData.error_description
      } else if (errorData.error) {
        errorMessage = errorData.error
      }

      const fullError = new Error(errorMessage)
      fullError.status = error.response.status
      fullError.details = errorData
      throw fullError
    } else if (error.request) {
      logger.error('Grok token refresh no response:', error.message)
      let errorMessage = '无法连接到 Grok 认证服务器 (auth.x.ai)'
      if (proxy) {
        errorMessage += `（代理: ${ProxyHelper.getProxyDescription(proxy)}）`
      }
      if (error.message) {
        errorMessage += ` - ${error.message}`
      }
      const fullError = new Error(errorMessage)
      fullError.code = error.code
      throw fullError
    } else {
      logger.error('Grok token refresh error:', error.message)
      const fullError = new Error(`请求设置错误: ${error.message}`)
      fullError.originalError = error
      throw fullError
    }
  }
}

// 检查 token 是否过期
function isTokenExpired(account) {
  if (!account.expiresAt) {
    return false
  }
  return new Date(account.expiresAt) <= new Date()
}

// 刷新账户的 access token（带分布式锁）
async function refreshAccountToken(accountId) {
  let lockAcquired = false
  let account = null
  let accountName = accountId

  try {
    account = await getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    accountName = account.name || accountId

    const refreshToken = account.refreshToken || null
    if (!refreshToken) {
      logRefreshSkipped(accountId, accountName, 'grok', 'No refresh token available')
      throw new Error('No refresh token available')
    }

    lockAcquired = await tokenRefreshService.acquireRefreshLock(accountId, 'grok')

    if (!lockAcquired) {
      logger.info(
        `🔒 Token refresh already in progress for Grok account: ${accountName} (${accountId})`
      )
      logRefreshSkipped(accountId, accountName, 'grok', 'already_locked')

      await new Promise((resolve) => setTimeout(resolve, 2000))

      const updatedAccount = await getAccount(accountId)
      if (updatedAccount && !isTokenExpired(updatedAccount)) {
        return {
          access_token: updatedAccount.accessToken,
          refresh_token: updatedAccount.refreshToken,
          expires_in: 21600,
          expiry_date: new Date(updatedAccount.expiresAt).getTime()
        }
      }

      throw new Error('Token refresh in progress by another process')
    }

    logRefreshStart(accountId, accountName, 'grok')
    logger.info(`🔄 Starting token refresh for Grok account: ${accountName} (${accountId})`)

    let proxy = null
    if (account.proxy) {
      try {
        proxy = typeof account.proxy === 'string' ? JSON.parse(account.proxy) : account.proxy
      } catch (e) {
        logger.warn(`Failed to parse proxy config for account ${accountId}:`, e)
      }
    }

    const newTokens = await refreshAccessToken(refreshToken, proxy)
    if (!newTokens) {
      throw new Error('Failed to refresh token')
    }

    const claims = decodeAccessTokenClaims(newTokens.access_token)

    const updates = {
      accessToken: newTokens.access_token,
      refreshToken: newTokens.refresh_token,
      expiresAt: new Date(newTokens.expiry_date).toISOString()
    }
    if (claims.tier) {
      updates.tier = claims.tier
    }
    if (claims.teamId) {
      updates.teamId = claims.teamId
    }

    await updateAccount(accountId, updates)

    logRefreshSuccess(accountId, accountName, 'grok', newTokens)
    return newTokens
  } catch (error) {
    logRefreshError(accountId, account?.name || accountName, 'grok', error.message)

    try {
      const webhookNotifier = require('../../utils/webhookNotifier')
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId,
        accountName: account?.name || accountName,
        platform: 'grok',
        status: 'error',
        errorCode: 'GROK_TOKEN_REFRESH_FAILED',
        reason: `Token refresh failed: ${error.message}`,
        timestamp: new Date().toISOString()
      })
    } catch (webhookError) {
      logger.error('Failed to send webhook notification:', webhookError)
    }

    throw error
  } finally {
    if (lockAcquired) {
      await tokenRefreshService.releaseRefreshLock(accountId, 'grok')
      logger.debug(`🔓 Released refresh lock for Grok account ${accountId}`)
    }
  }
}

// 创建账户
async function createAccount(accountData) {
  const accountId = uuidv4()
  const now = new Date().toISOString()

  let oauthData = {}
  if (accountData.grokOauth) {
    oauthData =
      typeof accountData.grokOauth === 'string'
        ? JSON.parse(accountData.grokOauth)
        : accountData.grokOauth
  }

  const claims = oauthData.accessToken ? decodeAccessTokenClaims(oauthData.accessToken) : {}

  const account = {
    id: accountId,
    platform: 'grok',
    name: accountData.name,
    description: accountData.description || '',
    accountType: accountData.accountType || 'shared',
    groupId: accountData.groupId || null,
    priority: accountData.priority || 50,
    rateLimitDuration:
      accountData.rateLimitDuration !== undefined && accountData.rateLimitDuration !== null
        ? accountData.rateLimitDuration
        : 60,
    accessToken:
      oauthData.accessToken && oauthData.accessToken.trim() ? encrypt(oauthData.accessToken) : '',
    refreshToken:
      oauthData.refreshToken && oauthData.refreshToken.trim()
        ? encrypt(oauthData.refreshToken)
        : '',
    tier: claims.tier || '',
    teamId: claims.teamId || '',
    // 过期时间（access token 技术字段，OIDC token 约 6 小时有效期）
    expiresAt: oauthData.expires_in
      ? new Date(Date.now() + oauthData.expires_in * 1000).toISOString()
      : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),

    // ✅ 账户订阅到期时间（业务字段，手动管理）
    subscriptionExpiresAt: accountData.subscriptionExpiresAt || null,

    isActive: accountData.isActive !== false ? 'true' : 'false',
    status: 'active',
    schedulable: accountData.schedulable !== false ? 'true' : 'false',
    disableAutoProtection:
      accountData.disableAutoProtection === true || accountData.disableAutoProtection === 'true'
        ? 'true'
        : 'false',
    lastRefresh: now,
    createdAt: now,
    updatedAt: now
  }

  if (accountData.proxy) {
    account.proxy =
      typeof accountData.proxy === 'string' ? accountData.proxy : JSON.stringify(accountData.proxy)
  }

  const client = redisClient.getClientSafe()
  await client.hset(`${GROK_ACCOUNT_KEY_PREFIX}${accountId}`, account)
  await redisClient.addToIndex('grok:account:index', accountId)

  if (account.accountType === 'shared') {
    await client.sadd(SHARED_GROK_ACCOUNTS_KEY, accountId)
  }

  logger.info(`Created Grok account: ${accountId}`)
  return account
}

// 获取账户
async function getAccount(accountId) {
  const client = redisClient.getClientSafe()
  const accountData = await client.hgetall(`${GROK_ACCOUNT_KEY_PREFIX}${accountId}`)

  if (!accountData || Object.keys(accountData).length === 0) {
    return null
  }

  if (accountData.accessToken) {
    accountData.accessToken = decrypt(accountData.accessToken)
  }
  if (accountData.refreshToken) {
    accountData.refreshToken = decrypt(accountData.refreshToken)
  }

  if (accountData.proxy && typeof accountData.proxy === 'string') {
    try {
      accountData.proxy = JSON.parse(accountData.proxy)
    } catch (e) {
      accountData.proxy = null
    }
  }

  // 适配 openaiResponsesRelayService 复用所需的字段形态（Bearer 注入 + 固定上游地址）
  accountData.apiKey = accountData.accessToken || ''
  accountData.baseApi = GROK_PROXY_BASE_API
  accountData.providerEndpoint = 'responses'

  return accountData
}

// 更新账户
async function updateAccount(accountId, updates) {
  const existingAccount = await getAccount(accountId)
  if (!existingAccount) {
    throw new Error('Account not found')
  }

  updates.updatedAt = new Date().toISOString()

  if (updates.accessToken) {
    updates.accessToken = encrypt(updates.accessToken)
  }
  if (updates.refreshToken && updates.refreshToken.trim()) {
    updates.refreshToken = encrypt(updates.refreshToken)
  }

  if (updates.proxy) {
    updates.proxy =
      typeof updates.proxy === 'string' ? updates.proxy : JSON.stringify(updates.proxy)
  }

  if (updates.disableAutoProtection !== undefined) {
    updates.disableAutoProtection =
      updates.disableAutoProtection === true || updates.disableAutoProtection === 'true'
        ? 'true'
        : 'false'
  }

  const client = redisClient.getClientSafe()
  if (updates.accountType && updates.accountType !== existingAccount.accountType) {
    if (updates.accountType === 'shared') {
      await client.sadd(SHARED_GROK_ACCOUNTS_KEY, accountId)
    } else {
      await client.srem(SHARED_GROK_ACCOUNTS_KEY, accountId)
    }
  }

  // 避免把 relay 适配字段（apiKey/baseApi/providerEndpoint）误写回 Redis
  const persistableUpdates = { ...updates }
  delete persistableUpdates.apiKey
  delete persistableUpdates.baseApi
  delete persistableUpdates.providerEndpoint

  await client.hset(`${GROK_ACCOUNT_KEY_PREFIX}${accountId}`, persistableUpdates)

  logger.info(`Updated Grok account: ${accountId}`)

  const updatedAccount = { ...existingAccount, ...updates }
  if (updatedAccount.proxy && typeof updatedAccount.proxy === 'string') {
    try {
      updatedAccount.proxy = JSON.parse(updatedAccount.proxy)
    } catch (e) {
      updatedAccount.proxy = null
    }
  }

  return updatedAccount
}

// 删除账户
async function deleteAccount(accountId) {
  const account = await getAccount(accountId)
  if (!account) {
    throw new Error('Account not found')
  }

  const client = redisClient.getClientSafe()
  await client.del(`${GROK_ACCOUNT_KEY_PREFIX}${accountId}`)
  await redisClient.removeFromIndex('grok:account:index', accountId)

  if (account.accountType === 'shared') {
    await client.srem(SHARED_GROK_ACCOUNTS_KEY, accountId)
  }

  const sessionHashes = await client.smembers(`grok_account_sessions:${accountId}`)
  if (sessionHashes.length > 0) {
    const pipeline = client.pipeline()
    sessionHashes.forEach((hash) => pipeline.del(`${ACCOUNT_SESSION_MAPPING_PREFIX}${hash}`))
    pipeline.del(`grok_account_sessions:${accountId}`)
    await pipeline.exec()
  }

  logger.info(`Deleted Grok account: ${accountId}`)
  return true
}

// 获取所有账户
async function getAllAccounts() {
  const accountIds = await redisClient.getAllIdsByIndex(
    'grok:account:index',
    `${GROK_ACCOUNT_KEY_PREFIX}*`,
    /^grok:account:(.+)$/
  )
  const keys = accountIds.map((id) => `${GROK_ACCOUNT_KEY_PREFIX}${id}`)
  const accounts = []
  const dataList = await redisClient.batchHgetallChunked(keys)

  for (let i = 0; i < keys.length; i++) {
    const accountData = dataList[i]
    if (accountData && Object.keys(accountData).length > 0) {
      const maskedAccessToken = accountData.accessToken ? '[ENCRYPTED]' : ''
      const maskedRefreshToken = accountData.refreshToken ? '[ENCRYPTED]' : ''
      const hasRefreshTokenFlag = !!accountData.refreshToken

      delete accountData.accessToken
      delete accountData.refreshToken

      const rateLimitInfo = await getAccountRateLimitInfo(accountData.id)

      if (accountData.proxy) {
        try {
          accountData.proxy = JSON.parse(accountData.proxy)
        } catch (e) {
          accountData.proxy = null
        }
      }

      const tokenExpiresAt = accountData.expiresAt || null
      const subscriptionExpiresAt =
        accountData.subscriptionExpiresAt && accountData.subscriptionExpiresAt !== ''
          ? accountData.subscriptionExpiresAt
          : null

      accounts.push({
        ...accountData,
        isActive: accountData.isActive === 'true',
        schedulable: accountData.schedulable !== 'false',
        accessToken: maskedAccessToken,
        refreshToken: maskedRefreshToken,
        tokenExpiresAt,
        subscriptionExpiresAt,
        expiresAt: subscriptionExpiresAt,
        hasRefreshToken: hasRefreshTokenFlag,
        rateLimitStatus: rateLimitInfo
          ? {
              status: rateLimitInfo.status,
              isRateLimited: rateLimitInfo.isRateLimited,
              rateLimitedAt: rateLimitInfo.rateLimitedAt,
              rateLimitResetAt: rateLimitInfo.rateLimitResetAt,
              minutesRemaining: rateLimitInfo.minutesRemaining
            }
          : {
              status: 'normal',
              isRateLimited: false,
              rateLimitedAt: null,
              rateLimitResetAt: null,
              minutesRemaining: 0
            }
      })
    }
  }

  return accounts
}

// 检查账户是否被限流
function isRateLimited(account) {
  if (account.rateLimitStatus === 'limited' && account.rateLimitedAt) {
    const limitedAt = new Date(account.rateLimitedAt).getTime()
    const now = Date.now()
    const limitDuration = 60 * 60 * 1000 // 1小时
    return now < limitedAt + limitDuration
  }
  return false
}

// 设置账户限流状态
async function setAccountRateLimited(accountId, isLimited, resetsInSeconds = null) {
  if (isLimited) {
    const account = await getAccount(accountId)
    if (
      account &&
      (account.disableAutoProtection === true || account.disableAutoProtection === 'true')
    ) {
      logger.info(
        `🛡️ Account ${accountId} has auto-protection disabled, skipping setAccountRateLimited`
      )
      return
    }
  }

  const updates = {
    rateLimitStatus: isLimited ? 'limited' : 'normal',
    rateLimitedAt: isLimited ? new Date().toISOString() : null,
    schedulable: isLimited ? 'false' : 'true'
  }

  if (isLimited && resetsInSeconds !== null && resetsInSeconds > 0) {
    const resetTime = new Date(Date.now() + resetsInSeconds * 1000).toISOString()
    updates.rateLimitResetAt = resetTime
  } else if (isLimited) {
    const defaultResetSeconds = 60 * 60
    updates.rateLimitResetAt = new Date(Date.now() + defaultResetSeconds * 1000).toISOString()
  } else {
    updates.rateLimitResetAt = null
  }

  await updateAccount(accountId, updates)
  logger.info(
    `Set rate limit status for Grok account ${accountId}: ${updates.rateLimitStatus}, schedulable: ${updates.schedulable}`
  )

  if (isLimited) {
    try {
      const account = await getAccount(accountId)
      const webhookNotifier = require('../../utils/webhookNotifier')
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId,
        accountName: account.name || accountId,
        platform: 'grok',
        status: 'blocked',
        errorCode: 'GROK_RATE_LIMITED',
        reason: resetsInSeconds
          ? `Account rate limited (429 error). Reset in ${Math.ceil(resetsInSeconds / 60)} minutes`
          : 'Account rate limited (429 error). Estimated reset in 1 hour',
        timestamp: new Date().toISOString()
      })
    } catch (webhookError) {
      logger.error('Failed to send rate limit webhook notification:', webhookError)
    }
  }
}

// 🚫 标记账户为未授权状态（401错误）
async function markAccountUnauthorized(accountId, reason = 'Grok账号认证失败（401错误）') {
  const account = await getAccount(accountId)
  if (!account) {
    throw new Error('Account not found')
  }

  if (account.disableAutoProtection === true || account.disableAutoProtection === 'true') {
    logger.info(
      `🛡️ Account ${accountId} has auto-protection disabled, skipping markAccountUnauthorized`
    )
    return
  }

  const now = new Date().toISOString()
  const currentCount = parseInt(account.unauthorizedCount || '0', 10)
  const unauthorizedCount = Number.isFinite(currentCount) ? currentCount + 1 : 1

  const updates = {
    status: 'unauthorized',
    schedulable: 'false',
    errorMessage: reason,
    unauthorizedAt: now,
    unauthorizedCount: unauthorizedCount.toString()
  }

  await updateAccount(accountId, updates)
  logger.warn(
    `🚫 Marked Grok account ${account.name || accountId} as unauthorized due to 401 error`
  )

  try {
    const webhookNotifier = require('../../utils/webhookNotifier')
    await webhookNotifier.sendAccountAnomalyNotification({
      accountId,
      accountName: account.name || accountId,
      platform: 'grok',
      status: 'unauthorized',
      errorCode: 'GROK_UNAUTHORIZED',
      reason,
      timestamp: now
    })
  } catch (webhookError) {
    logger.error('Failed to send unauthorized webhook notification:', webhookError)
  }
}

// 🔄 重置账户所有异常状态
async function resetAccountStatus(accountId) {
  const account = await getAccount(accountId)
  if (!account) {
    throw new Error('Account not found')
  }

  const updates = {
    status: account.accessToken ? 'active' : 'created',
    schedulable: 'true',
    errorMessage: null,
    rateLimitedAt: null,
    rateLimitStatus: 'normal',
    rateLimitResetAt: null
  }

  await updateAccount(accountId, updates)
  logger.info(`✅ Reset all error status for Grok account ${accountId}`)

  try {
    const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
    await upstreamErrorHelper.clearTempUnavailable(accountId, 'grok').catch(() => {})
  } catch (e) {
    // upstreamErrorHelper 不可用时忽略
  }

  try {
    const webhookNotifier = require('../../utils/webhookNotifier')
    await webhookNotifier.sendAccountAnomalyNotification({
      accountId,
      accountName: account.name || accountId,
      platform: 'grok',
      status: 'recovered',
      errorCode: 'STATUS_RESET',
      reason: 'Account status manually reset',
      timestamp: new Date().toISOString()
    })
  } catch (webhookError) {
    logger.error('Failed to send status reset webhook notification:', webhookError)
  }

  return { success: true, message: 'Account status reset successfully' }
}

// 切换账户调度状态
async function toggleSchedulable(accountId) {
  const account = await getAccount(accountId)
  if (!account) {
    throw new Error('Account not found')
  }

  const newSchedulable = account.schedulable === 'false' ? 'true' : 'false'
  await updateAccount(accountId, { schedulable: newSchedulable })

  logger.info(`Toggled schedulable status for Grok account ${accountId}: ${newSchedulable}`)

  return {
    success: true,
    schedulable: newSchedulable === 'true'
  }
}

// 获取账户限流信息
async function getAccountRateLimitInfo(accountId) {
  const account = await getAccount(accountId)
  if (!account) {
    return null
  }

  const status = account.rateLimitStatus || 'normal'
  const rateLimitedAt = account.rateLimitedAt || null
  const rateLimitResetAt = account.rateLimitResetAt || null

  if (status === 'limited') {
    const now = Date.now()
    let remainingTime = 0

    if (rateLimitResetAt) {
      const resetAt = new Date(rateLimitResetAt).getTime()
      remainingTime = Math.max(0, resetAt - now)
    } else if (rateLimitedAt) {
      const limitedAt = new Date(rateLimitedAt).getTime()
      const limitDuration = 60 * 60 * 1000
      remainingTime = Math.max(0, limitedAt + limitDuration - now)
    }

    const minutesRemaining = remainingTime > 0 ? Math.ceil(remainingTime / (60 * 1000)) : 0

    return {
      status,
      isRateLimited: minutesRemaining > 0,
      rateLimitedAt,
      rateLimitResetAt,
      minutesRemaining
    }
  }

  return {
    status,
    isRateLimited: false,
    rateLimitedAt,
    rateLimitResetAt,
    minutesRemaining: 0
  }
}

// 更新账户使用统计（tokens参数可选，默认为0，仅更新最后使用时间）
async function updateAccountUsage(accountId, tokens = 0) {
  const account = await getAccount(accountId)
  if (!account) {
    return
  }

  const updates = {
    lastUsedAt: new Date().toISOString()
  }

  if (tokens > 0) {
    const totalUsage = parseInt(account.totalUsage || 0) + tokens
    updates.totalUsage = totalUsage.toString()
  }

  await updateAccount(accountId, updates)
}

// 为了兼容性，保留recordUsage作为updateAccountUsage的别名
const recordUsage = updateAccountUsage

// 🔒 清理账户对象中的敏感/内部字段，供 admin 路由在返回响应前调用
// 剥离解密后的 accessToken/refreshToken、relay 适配字段 apiKey/baseApi/providerEndpoint，
// 避免通过 create/update 响应把 grok.com 订阅 Bearer token 泄露给浏览器/日志
function sanitizeAccountForResponse(account) {
  if (!account || typeof account !== 'object') {
    return account
  }

  const hasRefreshToken = !!account.refreshToken
  const sanitized = { ...account }
  delete sanitized.accessToken
  delete sanitized.refreshToken
  delete sanitized.apiKey
  delete sanitized.baseApi
  delete sanitized.providerEndpoint
  sanitized.hasRefreshToken = hasRefreshToken

  return sanitized
}

module.exports = {
  GROK_PROXY_BASE_API,
  GROK_CLI_CLIENT_VERSION,
  GROK_CLI_CLIENT_IDENTIFIER,
  createAccount,
  getAccount,
  updateAccount,
  deleteAccount,
  getAllAccounts,
  refreshAccountToken,
  isTokenExpired,
  isRateLimited,
  setAccountRateLimited,
  markAccountUnauthorized,
  resetAccountStatus,
  toggleSchedulable,
  getAccountRateLimitInfo,
  updateAccountUsage,
  recordUsage,
  sanitizeAccountForResponse,
  encrypt,
  decrypt,
  encryptor
}
