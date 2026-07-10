const express = require('express')
const apiKeyService = require('../services/apiKeyService')
const claudeAccountService = require('../services/account/claudeAccountService')
const openaiAccountService = require('../services/account/openaiAccountService')
const logger = require('../utils/logger')

const router = express.Router()

const REQUIRED_WINDOWS = {
  five_hour: null,
  one_week: null
}

function toFiniteNumberOrNull(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  if (!normalized) {
    return null
  }

  const number = Number(normalized)
  return Number.isFinite(number) ? number : null
}

function toIsoTimestampOrNull(value) {
  if (!value || typeof value !== 'string') {
    return null
  }

  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString()
}

function isDedicatedAccount(account) {
  return account?.accountType === 'dedicated'
}

function isClaudeOAuthAccount(account) {
  const scopes = account?.scopes && account.scopes.trim() ? account.scopes.split(' ') : []
  return scopes.includes('user:profile') && scopes.includes('user:inference')
}

function emptyWindows() {
  return { ...REQUIRED_WINDOWS }
}

function hasUsableRequiredWindow(windows) {
  return Object.values(windows).some(
    (window) => window && window.used_percent !== null && window.used_percent !== undefined
  )
}

function unavailableAccount({
  backend,
  provider,
  source,
  error,
  accountId = null,
  accountName = null
}) {
  return {
    backend,
    provider,
    account_id: accountId,
    account_name: accountName,
    observed_at: null,
    source,
    availability: 'unavailable',
    error,
    windows: emptyWindows(),
    extra_windows: {}
  }
}

function normalizeClaudeUsage(account, snapshot) {
  const windows = {
    five_hour: {
      used_percent: toFiniteNumberOrNull(snapshot?.fiveHour?.utilization),
      reset_at: toIsoTimestampOrNull(snapshot?.fiveHour?.resetsAt)
    },
    one_week: {
      used_percent: toFiniteNumberOrNull(snapshot?.sevenDay?.utilization),
      reset_at: toIsoTimestampOrNull(snapshot?.sevenDay?.resetsAt)
    }
  }
  const sevenDayOpus = snapshot?.sevenDayOpus
  const extraWindows = sevenDayOpus
    ? {
        one_week_sonnet: {
          used_percent: toFiniteNumberOrNull(sevenDayOpus.utilization),
          reset_at: toIsoTimestampOrNull(sevenDayOpus.resetsAt)
        }
      }
    : {}
  const observedAt = toIsoTimestampOrNull(snapshot?.updatedAt)
  const available = !!observedAt && hasUsableRequiredWindow(windows)

  return {
    backend: 'claude_code',
    provider: 'anthropic',
    account_id: account.id || null,
    account_name: account.name || null,
    observed_at: observedAt,
    source: 'anthropic_oauth_usage',
    availability: available ? 'available' : 'unavailable',
    error: available ? null : 'usage_snapshot_unavailable',
    windows,
    extra_windows: extraWindows
  }
}

function normalizeCodexUsage(account, snapshot) {
  const windows = emptyWindows()
  for (const item of [snapshot?.primary, snapshot?.secondary]) {
    const windowMinutes = toFiniteNumberOrNull(item?.windowMinutes)
    const kind = windowMinutes === 300 ? 'five_hour' : windowMinutes === 10080 ? 'one_week' : null
    if (!kind) {
      continue
    }

    windows[kind] = {
      used_percent: toFiniteNumberOrNull(item?.usedPercent),
      reset_at: toIsoTimestampOrNull(item?.resetAt)
    }
  }
  const observedAt = toIsoTimestampOrNull(snapshot?.updatedAt)
  const available = !!observedAt && hasUsableRequiredWindow(windows)

  return {
    backend: 'codex',
    provider: 'openai',
    account_id: account.id || null,
    account_name: account.name || null,
    observed_at: observedAt,
    source: 'codex_rate_limit_headers',
    availability: available ? 'available' : 'unavailable',
    error: available ? null : 'usage_snapshot_unavailable',
    windows,
    extra_windows: {}
  }
}

async function getClaudeLimitStatus(accountId) {
  const account = await claudeAccountService.getAccount(accountId)
  if (!isDedicatedAccount(account)) {
    return unavailableAccount({
      backend: 'claude_code',
      provider: 'anthropic',
      source: 'anthropic_oauth_usage',
      error: 'no_stable_account_scope'
    })
  }

  if (!isClaudeOAuthAccount(account)) {
    return unavailableAccount({
      backend: 'claude_code',
      provider: 'anthropic',
      source: 'anthropic_oauth_usage',
      error: 'setup_token_usage_unavailable',
      accountId: account.id || null,
      accountName: account.name || null
    })
  }

  let snapshot = claudeAccountService.buildClaudeUsageSnapshot(account)
  const observedAt = Date.parse(snapshot?.updatedAt)
  if (!snapshot?.updatedAt || Number.isNaN(observedAt) || Date.now() - observedAt > 60 * 1000) {
    const usage = await claudeAccountService.fetchOAuthUsage(accountId)
    if (usage) {
      await claudeAccountService.updateClaudeUsageSnapshot(accountId, usage)
      const refreshedAccount = await claudeAccountService.getAccount(accountId)
      snapshot = claudeAccountService.buildClaudeUsageSnapshot(refreshedAccount || account)
    }
  }

  if (!snapshot) {
    return unavailableAccount({
      backend: 'claude_code',
      provider: 'anthropic',
      source: 'anthropic_oauth_usage',
      error: 'usage_snapshot_unavailable',
      accountId: account.id || null,
      accountName: account.name || null
    })
  }

  return normalizeClaudeUsage(account, snapshot)
}

async function getCodexLimitStatus(accountId) {
  const account = await openaiAccountService.getAccount(accountId)
  if (!isDedicatedAccount(account)) {
    return unavailableAccount({
      backend: 'codex',
      provider: 'openai',
      source: 'codex_rate_limit_headers',
      error: 'no_stable_account_scope'
    })
  }

  const overview = await openaiAccountService.getAccountOverview(accountId)
  const snapshot = overview?.codexUsage
  if (!snapshot) {
    return unavailableAccount({
      backend: 'codex',
      provider: 'openai',
      source: 'codex_rate_limit_headers',
      error: 'usage_snapshot_unavailable',
      accountId: account.id || null,
      accountName: account.name || null
    })
  }

  return normalizeCodexUsage(account, snapshot)
}

function providerFailureStatus(backend, provider, source) {
  return unavailableAccount({
    backend,
    provider,
    source,
    error: 'provider_status_unavailable'
  })
}

router.post('/api/user-limit-status', async (req, res) => {
  try {
    const { apiKey } = req.body || {}
    const validation = await apiKeyService.validateApiKeyForStats(apiKey)
    if (!validation.valid) {
      logger.security(`Invalid API key in limit-status query from ${req.ip || 'unknown'}`)
      return res.status(401).json({ success: false, error: 'Invalid API key' })
    }

    const { keyData } = validation
    const [claudeResult, codexResult] = await Promise.allSettled([
      keyData.claudeAccountId
        ? getClaudeLimitStatus(keyData.claudeAccountId)
        : Promise.resolve(
            unavailableAccount({
              backend: 'claude_code',
              provider: 'anthropic',
              source: 'anthropic_oauth_usage',
              error: 'no_stable_account_scope'
            })
          ),
      keyData.openaiAccountId
        ? getCodexLimitStatus(keyData.openaiAccountId)
        : Promise.resolve(
            unavailableAccount({
              backend: 'codex',
              provider: 'openai',
              source: 'codex_rate_limit_headers',
              error: 'no_stable_account_scope'
            })
          )
    ])
    const data = [
      claudeResult.status === 'fulfilled'
        ? claudeResult.value
        : providerFailureStatus('claude_code', 'anthropic', 'anthropic_oauth_usage'),
      codexResult.status === 'fulfilled'
        ? codexResult.value
        : providerFailureStatus('codex', 'openai', 'codex_rate_limit_headers')
    ]

    return res.json({ success: true, data })
  } catch (error) {
    logger.error('Failed to get API key limit status:', error)
    return res.status(500).json({ success: false, error: 'Unable to retrieve limit status' })
  }
})

module.exports = router
module.exports.normalizeClaudeUsage = normalizeClaudeUsage
module.exports.normalizeCodexUsage = normalizeCodexUsage
module.exports.toFiniteNumberOrNull = toFiniteNumberOrNull
