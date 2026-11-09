/**
 * 在调度和上游调用之前拒绝 Claude/Anthropic 模型。
 * 不依赖 logger。config/config.js 缺失时退回环境变量，默认开启禁用。
 */

const { isBlockedModel } = require('../utils/modelHelper')

const ANTHROPIC_MODELS_DISABLED_MESSAGE = 'Claude/Anthropic models are disabled on this service'

const ANTHROPIC_MODELS_DISABLED_BODY = {
  error: {
    type: 'invalid_request_error',
    message: ANTHROPIC_MODELS_DISABLED_MESSAGE
  }
}

const MISSING_MODEL_BODY = {
  error: {
    type: 'invalid_request_error',
    message: 'model is required'
  }
}

const INFERENCE_PATHS = [
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/responses',
  '/responses',
  '/claude/v1/messages'
]

let cachedConfig
let configLoadAttempted = false

function readConfigDisableFlag() {
  if (!configLoadAttempted) {
    configLoadAttempted = true
    try {
      // eslint-disable-next-line global-require
      cachedConfig = require('../../config/config')
    } catch (error) {
      cachedConfig = null
    }
  }

  const security = cachedConfig && cachedConfig.security
  if (!security || !Object.prototype.hasOwnProperty.call(security, 'disableAnthropicModels')) {
    return undefined
  }

  return parseDisabledFlag(security.disableAnthropicModels)
}

function parseDisabledFlag(value) {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value !== 0
  }
  if (typeof value !== 'string') {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return undefined
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false
  }
  return true
}

/**
 * 禁用开关。config.security.disableAnthropicModels 优先，否则读
 * DISABLE_ANTHROPIC_MODELS。两者都没设时默认禁用（true）。
 * @returns {boolean}
 */
function areAnthropicModelsDisabled() {
  const fromConfig = readConfigDisableFlag()
  if (fromConfig !== undefined) {
    return fromConfig
  }

  const fromEnv = parseDisabledFlag(process.env.DISABLE_ANTHROPIC_MODELS)
  if (fromEnv !== undefined) {
    return fromEnv
  }
  return true
}

function normalizeRequestPath(value) {
  if (typeof value !== 'string' || !value) {
    return ''
  }
  const pathOnly = value.split('?')[0]
  if (pathOnly.length > 1 && pathOnly.endsWith('/')) {
    return pathOnly.slice(0, -1)
  }
  return pathOnly
}

function isInferencePath(req) {
  if (!req || req.method !== 'POST') {
    return false
  }
  const candidates = [normalizeRequestPath(req.path), normalizeRequestPath(req.originalUrl)]
  return candidates.some(
    (candidate) =>
      candidate &&
      INFERENCE_PATHS.some(
        (inferencePath) => candidate === inferencePath || candidate.endsWith(inferencePath)
      )
  )
}

function requestModel(req) {
  const body = req && req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ''
  }
  return typeof body.model === 'string' ? body.model.trim() : ''
}

function anthropicModelGuard(req, res, next) {
  if (!areAnthropicModelsDisabled()) {
    return next()
  }

  const model = requestModel(req)
  if (!model) {
    if (isInferencePath(req)) {
      return res.status(400).json(MISSING_MODEL_BODY)
    }
    return next()
  }

  if (isBlockedModel(model)) {
    return res.status(403).json(ANTHROPIC_MODELS_DISABLED_BODY)
  }
  return next()
}

function writeDisabledTestStream(res) {
  if (!res) {
    return
  }
  if (!res.headersSent && typeof res.writeHead === 'function') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache'
    })
  }
  if (typeof res.write === 'function') {
    res.write(
      `data: ${JSON.stringify({
        type: 'test_complete',
        success: false,
        error: ANTHROPIC_MODELS_DISABLED_MESSAGE
      })}\n\n`
    )
  }
  if (typeof res.end === 'function') {
    res.end()
  }
}

module.exports = {
  ANTHROPIC_MODELS_DISABLED_MESSAGE,
  ANTHROPIC_MODELS_DISABLED_BODY,
  MISSING_MODEL_BODY,
  areAnthropicModelsDisabled,
  anthropicModelGuard,
  writeDisabledTestStream
}
