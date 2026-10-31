/**
 * Direct DeepSeek on the Anthropic Messages endpoint.
 * Official compatibility (retrieved 2026-10-17):
 * https://api-docs.deepseek.com/guides/anthropic_api
 * Current ids are deepseek-flash and deepseek-v4-pro. Documented v4-flash
 * names are temporary aliases of Flash. deepseek-chat / deepseek-reasoner are
 * not aliases.
 */

const DEFAULT_API_URL = 'https://api.deepseek.com/anthropic'
const CANONICAL_MODELS = ['deepseek-flash', 'deepseek-v4-pro']
const FLASH_ALIASES = ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']

const UNSUPPORTED_BLOCK_TYPES = new Set([
  'document',
  'search_result',
  'redacted_thinking',
  'mcp_tool_use',
  'mcp_tool_result',
  'container_upload',
  'code_execution_tool_result',
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result'
])

const PEAK_PER_MILLION = {
  'deepseek-flash': { input: 0.3, cacheRead: 0.006, output: 1.2 },
  'deepseek-v4-pro': { input: 1.32, cacheRead: 0.044, output: 3.96 }
}

function badRequest(message) {
  const error = new Error(message)
  error.statusCode = 400
  error.httpStatus = 400
  error.code = 'DEEPSEEK_INVALID_CONFIG'
  return error
}

function stripCapabilitySuffix(model) {
  if (typeof model !== 'string' || !model) {
    return ''
  }
  const stripped = model.trim().replace(/\[1m\]$/i, '')
  return stripped || model.trim()
}

function isNativeDeepSeekId(model) {
  const stripped = stripCapabilitySuffix(model)
  if (!stripped || stripped.includes('/')) {
    return false
  }
  return stripped.toLowerCase().startsWith('deepseek-')
}

function canonicalDeepSeekModel(model) {
  const stripped = stripCapabilitySuffix(model)
  if (!stripped || stripped.includes('/')) {
    return null
  }
  const lower = stripped.toLowerCase()
  if (CANONICAL_MODELS.includes(lower)) {
    return lower
  }
  if (FLASH_ALIASES.includes(lower)) {
    return 'deepseek-flash'
  }
  return null
}

function isUnqualifiedUnknownDeepSeek(model) {
  return isNativeDeepSeekId(model) && !canonicalDeepSeekModel(model)
}

function normalizeProvider(provider) {
  if (provider === undefined || provider === null || provider === '') {
    return ''
  }
  if (provider === 'deepseek') {
    return 'deepseek'
  }
  throw badRequest('Invalid provider. Supported values: deepseek')
}

function assertDeepSeekApiUrl(apiUrl) {
  let parsed
  try {
    parsed = new URL(apiUrl)
  } catch (error) {
    throw badRequest(
      'DeepSeek API URL must be the official https://api.deepseek.com/anthropic endpoint'
    )
  }

  const path = parsed.pathname.replace(/\/+$/, '')
  const officialPath = path === '/anthropic' || path === '/anthropic/v1/messages'
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'api.deepseek.com' ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !officialPath
  ) {
    throw badRequest(
      'DeepSeek API URL must be https://api.deepseek.com/anthropic or https://api.deepseek.com/anthropic/v1/messages'
    )
  }

  return path === '/anthropic/v1/messages'
    ? 'https://api.deepseek.com/anthropic/v1/messages'
    : DEFAULT_API_URL
}

function defaultModelMapping() {
  return {
    'deepseek-flash': 'deepseek-flash',
    'deepseek-v4-pro': 'deepseek-v4-pro'
  }
}

function canonicalModelId(modelId, label) {
  const canonical = canonicalDeepSeekModel(modelId)
  if (!canonical) {
    throw badRequest(`DeepSeek account model allowlist has an unsupported ${label}: ${modelId}`)
  }
  return canonical
}

function normalizeSupportedModels(supportedModels) {
  if (
    supportedModels === undefined ||
    supportedModels === null ||
    supportedModels === '' ||
    (Array.isArray(supportedModels) && supportedModels.length === 0) ||
    (typeof supportedModels === 'object' &&
      !Array.isArray(supportedModels) &&
      Object.keys(supportedModels).length === 0)
  ) {
    return defaultModelMapping()
  }

  const mapping = {}
  if (Array.isArray(supportedModels)) {
    supportedModels.forEach((modelId) => {
      const canonical = canonicalModelId(modelId, 'model')
      mapping[canonical] = canonical
    })
    return mapping
  }

  if (typeof supportedModels === 'object') {
    Object.entries(supportedModels).forEach(([from, to]) => {
      const canonicalFrom = canonicalModelId(from, 'model')
      const canonicalTo = canonicalModelId(to, 'upstream model')
      mapping[canonicalFrom] = canonicalTo
    })
    return mapping
  }

  throw badRequest('DeepSeek supportedModels must be a list or mapping of current model ids')
}

function normalizeAccountConfig({ provider, apiUrl, supportedModels }) {
  const normalizedProvider = normalizeProvider(provider)
  if (normalizedProvider !== 'deepseek') {
    return {
      provider: '',
      apiUrl,
      supportedModels
    }
  }

  const trimmedUrl = typeof apiUrl === 'string' ? apiUrl.trim() : ''
  return {
    provider: 'deepseek',
    apiUrl: trimmedUrl ? assertDeepSeekApiUrl(trimmedUrl) : DEFAULT_API_URL,
    supportedModels: normalizeSupportedModels(supportedModels)
  }
}

function unsupportedToolType(tool) {
  if (!tool || typeof tool !== 'object') {
    return null
  }
  const type = typeof tool.type === 'string' ? tool.type.toLowerCase() : ''
  if (!type || type === 'custom' || type === 'function') {
    return null
  }
  if (
    type.includes('web_search') ||
    type.includes('web_fetch') ||
    type.includes('code_execution') ||
    type.includes('mcp') ||
    type.includes('server_tool') ||
    type.includes('bash') ||
    type.includes('text_editor')
  ) {
    return `Unsupported tool type: ${tool.type}`
  }
  return null
}

function findUnsupportedContent(content) {
  if (typeof content === 'string' || content === undefined || content === null) {
    return null
  }
  if (!Array.isArray(content)) {
    return null
  }
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue
    }
    if (UNSUPPORTED_BLOCK_TYPES.has(block.type)) {
      return `Unsupported content block: ${block.type}`
    }
    if (block.type === 'image' && block.source && block.source.type === 'file') {
      return 'Unsupported file-backed image'
    }
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      const nested = findUnsupportedContent(block.content)
      if (nested) {
        return nested
      }
    }
  }
  return null
}

function findUnsupportedRequest(body) {
  if (!body || typeof body !== 'object') {
    return 'Invalid request body'
  }
  const systemProblem = findUnsupportedContent(body.system)
  if (systemProblem) {
    return systemProblem
  }
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const problem = findUnsupportedContent(message && message.content)
      if (problem) {
        return problem
      }
    }
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const problem = unsupportedToolType(tool)
      if (problem) {
        return problem
      }
    }
  }
  return null
}

function prepareDeepSeekBody(body) {
  const problem = findUnsupportedRequest(body)
  if (problem) {
    const error = new Error(problem)
    error.statusCode = 400
    error.httpStatus = 400
    error.code = 'DEEPSEEK_UNSUPPORTED_CONTENT'
    error.errorPayload = {
      error: {
        type: 'invalid_request_error',
        message: problem
      }
    }
    throw error
  }

  const canonical = canonicalDeepSeekModel(body && body.model)
  if (!canonical) {
    const error = new Error(`Unsupported DeepSeek model: ${body && body.model}`)
    error.statusCode = 400
    error.httpStatus = 400
    error.code = 'DEEPSEEK_MODEL_UNSUPPORTED'
    error.errorPayload = {
      error: {
        type: 'invalid_request_error',
        message: error.message
      }
    }
    throw error
  }

  return {
    ...body,
    model: canonical
  }
}

// Never retain upstream Error objects: messages, stacks and nested fields can contain credentials.
function safeError(original, accountId) {
  const messages = {
    ECONNRESET: 'Connection reset by upstream',
    ECONNREFUSED: 'Connection refused by upstream',
    ETIMEDOUT: 'Upstream timeout',
    ENOTFOUND: 'Unable to resolve upstream hostname',
    ECONNABORTED: 'Client disconnected',
    ERR_CANCELED: 'Client disconnected',
    CONSOLE_ACCOUNT_CONCURRENCY_FULL: 'Console account concurrency limit reached',
    DEEPSEEK_UNSUPPORTED_CONTENT: 'Unsupported DeepSeek request content',
    DEEPSEEK_MODEL_UNSUPPORTED: 'Unsupported DeepSeek model',
    DEEPSEEK_INVALID_CONFIG: 'Invalid DeepSeek configuration'
  }
  const code = Object.hasOwn(messages, original?.code) ? original.code : null
  const error = new Error(code ? messages[code] : 'Upstream request failed')
  if (code) {
    error.code = code
  }
  if (code === 'CONSOLE_ACCOUNT_CONCURRENCY_FULL') {
    error.accountId = accountId
  }
  if (code?.startsWith('DEEPSEEK_')) {
    error.httpStatus = 400
    error.statusCode = 400
    error.errorPayload = { error: { type: 'invalid_request_error', message: error.message } }
  }
  return error
}

function safeErrorPayload() {
  return { type: 'error', error: { type: 'api_error', message: 'Upstream request failed' } }
}

// Buffer complete frames before trusting their type, including multiline/escaped JSON.
function createSafeEventStream() {
  const { Transform } = require('stream')
  const { StringDecoder } = require('string_decoder')
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        buffer += decoder.write(chunk)
        let boundary
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index)
          const complete = buffer.slice(0, boundary.index + boundary[0].length)
          buffer = buffer.slice(complete.length)
          const lines = frame.split(/\r?\n/)
          const event = lines
            .find((line) => line.startsWith('event:'))
            ?.slice(6)
            .trim()
          const data = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          if (event === 'error') {
            throw safeError()
          }
          if (data && data !== '[DONE]') {
            const parsed = JSON.parse(data)
            if (parsed?.type === 'error') {
              throw safeError()
            }
          }
          this.push(complete)
        }
        callback()
      } catch {
        callback(safeError())
      }
    },
    flush(callback) {
      buffer += decoder.end()
      callback(buffer.trim() ? safeError() : null)
    }
  })
}

function perToken(perMillion) {
  return perMillion / 1000000
}

function peakPricing(canonical) {
  const rates = PEAK_PER_MILLION[canonical]
  if (!rates) {
    return null
  }
  return {
    input_cost_per_token: perToken(rates.input),
    cache_read_input_token_cost: perToken(rates.cacheRead),
    output_cost_per_token: perToken(rates.output),
    litellm_provider: 'deepseek',
    provider_specific_entry: { fast: 1 },
    mode: 'chat'
  }
}

function redactAuthHeaders(headers) {
  const copy = { ...(headers || {}) }
  Object.keys(copy).forEach((key) => {
    const lower = key.toLowerCase()
    if (lower === 'x-api-key' || lower === 'authorization' || lower === 'x-cr-api-key') {
      copy[key] = '[redacted]'
    }
  })
  return copy
}

function redactSecret(value, secret) {
  if (!secret || value === undefined || value === null) {
    return value
  }
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  if (!raw || !raw.includes(secret)) {
    return value
  }
  return raw.split(secret).join('[redacted]')
}

function officialFirstModel(model) {
  return ['deepseek/deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4.1-flash'].includes(
    stripCapabilitySuffix(model)
  )
    ? 'deepseek-flash'
    : null
}

function attemptFailure({ status, code, headers, committed = false }) {
  const transient = status
    ? [408, 429, 500, 502, 503, 504, 529].includes(status)
    : ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED'].includes(code)
  const retryAfter = headers?.['retry-after']
  const seconds = Number(retryAfter)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()
  return {
    fallback: !committed && transient,
    committed,
    statusCode: status || 502,
    retryAfterMs:
      status === 429 && Number.isFinite(delay) ? Math.max(0, Math.min(delay, 10000)) : 1000
  }
}

module.exports = {
  officialFirstModel,
  attemptFailure,
  findUnsupportedRequest,
  DEFAULT_API_URL,
  CANONICAL_MODELS,
  FLASH_ALIASES,
  stripCapabilitySuffix,
  isNativeDeepSeekId,
  canonicalDeepSeekModel,
  isUnqualifiedUnknownDeepSeek,
  normalizeProvider,
  assertDeepSeekApiUrl,
  normalizeSupportedModels,
  normalizeAccountConfig,
  prepareDeepSeekBody,
  peakPricing,
  safeError,
  safeErrorPayload,
  createSafeEventStream,
  redactAuthHeaders,
  redactSecret
}
