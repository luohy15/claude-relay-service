/**
 * Model Helper Utility
 *
 * Provides utilities for parsing vendor-prefixed model names.
 * Supports parsing model strings like "ccr,model_name" to extract vendor type and base model.
 */

// config/config.js 可能在某些环境不存在（详见 featureFlags.js 的同款容错处理）
let config = {}
try {
  // eslint-disable-next-line global-require
  config = require('../../config/config')
} catch (error) {
  config = {}
}

// logger 内部会 require config/config，所以同样需要容错，避免在 config 缺失的环境
// （如本仓库当前 checkout）里连带炸掉所有直接引用 modelHelper 的测试
let logger
try {
  // eslint-disable-next-line global-require
  logger = require('./logger')
} catch (error) {
  logger = { warn: () => {} }
}

// 仅保留原仓库既有的模型前缀：CCR 路由
// Gemini/Antigravity 采用“路径分流”，避免在 model 字段里混入 vendor 前缀造成混乱
const SUPPORTED_VENDOR_PREFIXES = ['ccr']

/**
 * Parse vendor-prefixed model string
 * @param {string} modelStr - Model string, potentially with vendor prefix (e.g., "ccr,gemini-2.5-pro")
 * @returns {{vendor: string|null, baseModel: string}} - Parsed vendor and base model
 */
function parseVendorPrefixedModel(modelStr) {
  if (!modelStr || typeof modelStr !== 'string') {
    return { vendor: null, baseModel: modelStr || '' }
  }

  // Trim whitespace and convert to lowercase for comparison
  const trimmed = modelStr.trim()
  const lowerTrimmed = trimmed.toLowerCase()

  for (const vendorPrefix of SUPPORTED_VENDOR_PREFIXES) {
    if (!lowerTrimmed.startsWith(`${vendorPrefix},`)) {
      continue
    }

    const parts = trimmed.split(',')
    if (parts.length < 2) {
      break
    }

    // Extract base model (everything after the first comma, rejoined in case model name contains commas)
    const baseModel = parts.slice(1).join(',').trim()
    return {
      vendor: vendorPrefix,
      baseModel
    }
  }

  // No recognized vendor prefix found
  return {
    vendor: null,
    baseModel: trimmed
  }
}

/**
 * Check if a model string has a vendor prefix
 * @param {string} modelStr - Model string to check
 * @returns {boolean} - True if the model has a vendor prefix
 */
function hasVendorPrefix(modelStr) {
  const { vendor } = parseVendorPrefixedModel(modelStr)
  return vendor !== null
}

/**
 * Get the effective model name for scheduling and processing
 * This removes vendor prefixes to get the actual model name used for API calls
 * @param {string} modelStr - Original model string
 * @returns {string} - Effective model name without vendor prefix
 */
function getEffectiveModel(modelStr) {
  const { baseModel } = parseVendorPrefixedModel(modelStr)
  return baseModel
}

/**
 * Get the vendor type from a model string
 * @param {string} modelStr - Model string to parse
 * @returns {string|null} - Vendor type ('ccr') or null if no prefix
 */
function getVendorType(modelStr) {
  const { vendor } = parseVendorPrefixedModel(modelStr)
  return vendor
}

/**
 * Check if the model is Opus 4.5 or newer.
 *
 * VERSION LOGIC (as of 2025-12-05):
 * - Opus 4.5+ (including 5.0, 6.0, etc.) → returns true (Pro account eligible)
 * - Opus 4.4 and below (including 3.x, 4.0, 4.1) → returns false (Max account only)
 *
 * Supported naming formats:
 *   - New format: claude-opus-{major}[-{minor}][-date], e.g., claude-opus-4-5-20251101
 *   - New format: claude-opus-{major}.{minor}, e.g., claude-opus-4.5
 *   - Old format: claude-{version}-opus[-date], e.g., claude-3-opus-20240229
 *   - Special: opus-latest, claude-opus-latest → always returns true
 *
 * @param {string} modelName - Model name
 * @returns {boolean} - Whether the model is Opus 4.5 or newer
 */
function isOpus45OrNewer(modelName) {
  if (!modelName) {
    return false
  }

  const lowerModel = modelName.toLowerCase()
  if (!lowerModel.includes('opus')) {
    return false
  }

  // Handle 'latest' special case
  if (lowerModel.includes('opus-latest') || lowerModel.includes('opus_latest')) {
    return true
  }

  // Old format: claude-{version}-opus (version before opus)
  // e.g., claude-3-opus-20240229, claude-3.5-opus
  const oldFormatMatch = lowerModel.match(/claude[- ](\d+)(?:[.-](\d+))?[- ]opus/)
  if (oldFormatMatch) {
    const majorVersion = parseInt(oldFormatMatch[1], 10)
    const minorVersion = oldFormatMatch[2] ? parseInt(oldFormatMatch[2], 10) : 0

    // Old format version refers to Claude major version
    // majorVersion > 4: 5.x, 6.x, ... → true
    // majorVersion === 4 && minorVersion >= 5: 4.5, 4.6, ... → true
    // Others (3.x, 4.0-4.4): → false
    if (majorVersion > 4) {
      return true
    }
    if (majorVersion === 4 && minorVersion >= 5) {
      return true
    }
    return false
  }

  // New format 1: opus-{major}.{minor} (dot-separated)
  // e.g., claude-opus-4.5, opus-4.5
  const dotFormatMatch = lowerModel.match(/opus[- ]?(\d+)\.(\d+)/)
  if (dotFormatMatch) {
    const majorVersion = parseInt(dotFormatMatch[1], 10)
    const minorVersion = parseInt(dotFormatMatch[2], 10)

    // Same version logic as old format
    // opus-5.0, opus-6.0 → true
    // opus-4.5, opus-4.6 → true
    // opus-4.0, opus-4.4 → false
    if (majorVersion > 4) {
      return true
    }
    if (majorVersion === 4 && minorVersion >= 5) {
      return true
    }
    return false
  }

  // New format 2: opus-{major}[-{minor}][-date] (hyphen-separated)
  // e.g., claude-opus-4-5-20251101, claude-opus-4-20250514, claude-opus-4-1-20250805
  // If opus-{major} is followed by 8-digit date, there's no minor version

  // Extract content after 'opus'
  const opusIndex = lowerModel.indexOf('opus')
  const afterOpus = lowerModel.substring(opusIndex + 4)

  // Match: -{major}-{minor}-{date} or -{major}-{date} or -{major}
  // IMPORTANT: Minor version regex is (\d{1,2}) not (\d+)
  // This prevents matching 8-digit dates as minor version
  // Example: opus-4-20250514 → major=4, minor=undefined (not 20250514)
  // Example: opus-4-5-20251101 → major=4, minor=5
  // Future-proof: Supports up to 2-digit minor versions (0-99)
  const versionMatch = afterOpus.match(/^[- ](\d+)(?:[- ](\d{1,2})(?=[- ]\d{8}|$))?/)

  if (versionMatch) {
    const majorVersion = parseInt(versionMatch[1], 10)
    const minorVersion = versionMatch[2] ? parseInt(versionMatch[2], 10) : 0

    // Same version logic: >= 4.5 returns true
    // opus-5-0-date, opus-6-date → true
    // opus-4-5-date, opus-4-10-date → true (supports 2-digit minor)
    // opus-4-date (no minor, treated as 4.0) → false
    // opus-4-1-date, opus-4-4-date → false
    if (majorVersion > 4) {
      return true
    }
    if (majorVersion === 4 && minorVersion >= 5) {
      return true
    }
    return false
  }

  // Other cases containing 'opus' but cannot parse version, assume legacy
  return false
}

/**
 * 判断某个 model 名称是否属于 Anthropic Claude 系列模型。
 *
 * 用于 API Key 维度的限额/统计（Claude 周费用）。这里刻意覆盖以下命名：
 * - 标准 Anthropic 模型：claude-*，包括 claude-3-opus、claude-sonnet-*、claude-haiku-* 等
 * - Bedrock 模型：{region}.anthropic.claude-... / anthropic.claude-...
 * - 少数情况下 model 字段可能只包含家族关键词（sonnet/haiku/opus），也视为 Claude 系列
 *
 * 注意：会先去掉支持的 vendor 前缀（例如 "ccr,"）。
 */
function isClaudeFamilyModel(modelName) {
  if (!modelName || typeof modelName !== 'string') {
    return false
  }

  const { baseModel } = parseVendorPrefixedModel(modelName)
  const m = (baseModel || '').trim().toLowerCase()
  if (!m) {
    return false
  }

  // Bedrock 模型格式
  if (
    m.includes('.anthropic.claude-') ||
    m.startsWith('anthropic.claude-') ||
    m.includes('.claude-')
  ) {
    return true
  }

  // 标准 Anthropic 模型 ID
  if (m.startsWith('claude-') || m.includes('claude-')) {
    return true
  }

  // 兜底：某些下游链路里 model 字段可能不带 "claude-" 前缀，但仍包含家族关键词。
  if (m.includes('opus') || m.includes('sonnet') || m.includes('haiku')) {
    return true
  }

  return false
}

/**
 * 参与「按模型独立限流」的模型家族。
 *
 * Anthropic 对这些模型分别下发独立的（通常是周级）限额：命中其中一个的 429，
 * 只代表该模型不可用，不代表整个账号耗尽配额。因此必须记入该家族专属的限流桶，
 * 而不能改写为账号级限流（那会把账号上的其它模型一并停掉）。
 */
const RATE_LIMITED_MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable']

/**
 * 解析模型名所属的限流家族（会先去除 vendor 前缀）。
 * @param {string} modelName - 模型名，如 claude-sonnet-4-5
 * @returns {string|null} - 'opus' | 'sonnet' | 'haiku' | 'fable'，无法识别时返回 null
 */
function getRateLimitModelFamily(modelName) {
  if (!modelName || typeof modelName !== 'string') {
    return null
  }

  const baseModel = (getEffectiveModel(modelName) || '').toLowerCase()
  if (!baseModel) {
    return null
  }

  return RATE_LIMITED_MODEL_FAMILIES.find((family) => baseModel.includes(family)) || null
}

/**
 * Claude Code 的客户端能力后缀：`<model>[1m]` 表示"客户端按 1M 上下文预算跑这个模型"
 * （opus[1m] / sonnet[1m] 同款约定）。它是**客户端**的窗口声明，不是上游模型 id 的一部分。
 */
const CLIENT_CAPABILITY_SUFFIX_PATTERN = /\[1m\]$/i

/**
 * 剥掉客户端能力后缀，得到上游真实模型 id。
 *
 * 必须在 vendor 路由、模型黑名单比较、上游请求体之前调用；回给客户端的响应仍然回显
 * 带后缀的原始请求模型，保持 Claude Code 的请求/响应模型一致（plan 2989 设计决策 1-3）。
 *
 * @param {string} modelStr - 客户端请求的模型 id，如 'gpt-5.6-sol[1m]'
 * @returns {string} - 上游真实模型 id，如 'gpt-5.6-sol'；没有该后缀时原样返回
 */
function stripModelCapabilitySuffix(modelStr) {
  if (typeof modelStr !== 'string' || !modelStr) {
    return ''
  }

  const stripped = modelStr.replace(CLIENT_CAPABILITY_SUFFIX_PATTERN, '')
  // 只有后缀没有模型名（'[1m]'）时原样返回：那不是能力后缀，交给下游按未知模型处理
  return stripped || modelStr
}

/**
 * 判断模型 id 是否为原生前缀（claude-/gemini-/gpt-）。
 *
 * 用于路径分流：原生前缀走对应的原生后端（Claude/Gemini/OpenAI），非原生前缀
 * （如 OpenRouter 的 anthropic/claude-sonnet-4.6、x-ai/grok-4.3）走 openai-responses 后端。
 *
 * @param {string} modelName - Model name
 * @returns {boolean} - Whether the model id has a native prefix
 */
function isNativeModelPrefix(modelName) {
  if (!modelName) {
    return false
  }

  const model = modelName.toLowerCase()
  return model.startsWith('claude-') || model.startsWith('gemini-') || model.startsWith('gpt-')
}

/**
 * /api（Anthropic Messages）按模型 id 前缀分流到订阅桥接的内置默认规则。
 * 仅用于挑选“转换器”（codex / grok 桥接），账户仍然由 API Key 决定。
 */
const DEFAULT_MODEL_VENDOR_ROUTES = [
  { prefix: 'gpt-', vendor: 'codex' },
  { prefix: 'grok-', vendor: 'grok' }
]

// handleAnthropicToResponses 只认识这两种桥接 vendor，环境变量里配的其它值一律丢弃
const SUPPORTED_MODEL_VENDORS = ['codex', 'grok']

/**
 * 解析 `MODEL_VENDOR_ROUTES` 格式的字符串：'<prefix>:<vendor>,<prefix>:<vendor>'
 * 未知 vendor 会被丢弃并打印 warn，而不是静默产生一个没有分支处理的 vendor。
 * @param {string} rawValue
 * @returns {{prefix: string, vendor: string}[]}
 */
function parseModelVendorRoutes(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') {
    return DEFAULT_MODEL_VENDOR_ROUTES
  }

  const routes = rawValue
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [prefix, vendor] = entry.split(':').map((part) => (part || '').trim().toLowerCase())
      return { prefix, vendor }
    })
    .filter(({ prefix, vendor }) => {
      if (!prefix || !vendor) {
        return false
      }
      if (!SUPPORTED_MODEL_VENDORS.includes(vendor)) {
        logger.warn(`⚠️ Unknown vendor "${vendor}" in MODEL_VENDOR_ROUTES, dropping "${prefix}"`)
        return false
      }
      return true
    })

  return routes.length > 0 ? routes : DEFAULT_MODEL_VENDOR_ROUTES
}

const rawModelVendorRoutes =
  (process.env.MODEL_VENDOR_ROUTES !== undefined && process.env.MODEL_VENDOR_ROUTES !== ''
    ? process.env.MODEL_VENDOR_ROUTES
    : config?.modelRouting?.vendorRoutes) || ''

const MODEL_VENDOR_ROUTES = parseModelVendorRoutes(rawModelVendorRoutes)

/**
 * 从模型 id 解析出应该走哪个订阅桥接 vendor（codex / grok），仅用于挑选转换器。
 *
 * 带 '/' 的 id（如 OpenRouter 的 x-ai/grok-4）永远返回 null：这是计费路径的区分点，
 * 必须显式排除，不能靠“不以 grok- 开头”隐式保证。
 *
 * @param {string} modelName - Model id, e.g. 'gpt-5.6-sol' / 'grok-4.5'
 * @returns {'codex'|'grok'|null}
 */
function resolveVendorFromModel(modelName) {
  if (!modelName || typeof modelName !== 'string') {
    return null
  }
  if (modelName.includes('/')) {
    return null
  }

  const lowerModel = modelName.toLowerCase()
  const route = MODEL_VENDOR_ROUTES.find(({ prefix }) => lowerModel.startsWith(prefix))
  return route ? route.vendor : null
}

module.exports = {
  parseVendorPrefixedModel,
  hasVendorPrefix,
  getEffectiveModel,
  getVendorType,
  isOpus45OrNewer,
  isClaudeFamilyModel,
  RATE_LIMITED_MODEL_FAMILIES,
  getRateLimitModelFamily,
  stripModelCapabilitySuffix,
  isNativeModelPrefix,
  DEFAULT_MODEL_VENDOR_ROUTES,
  resolveVendorFromModel
}
