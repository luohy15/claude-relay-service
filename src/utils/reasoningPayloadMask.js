/**
 * 上游 reasoning 的不透明载荷（grok encrypted_content / 桥接封装 crsr1.）遮蔽规则（todo 3733）
 * 独立成不依赖 config 的小工具，供 logger.safeStringify 和 anthropicToResponses 的诊断日志共用一份规则，
 * 挡住「载荷嵌在一段更长的字符串里」的情况（例如上游把请求体原样带回错误信息）
 */

// \\* 允许 0 或多个反斜杠：上游响应体被 JSON.stringify 后塞进一条错误消息时，引号会变成 \"
// （review round 2 残留项）。值部分在遇到第一个未转义或转义的引号/反斜杠就停：真正的
// encrypted_content 载荷本身不含引号或反斜杠，所以这不会截断真实值
const ENCRYPTED_CONTENT_INLINE_PATTERN = /(\\*"encrypted_content\\*"\s*:\s*\\*")([^"\\]*)/g
const REASONING_ENVELOPE_INLINE_PATTERN = /crsr1\.[^\s"'`\\]*/g

function maskReasoningPayload(text) {
  if (typeof text !== 'string') {
    return text
  }
  return text
    .replace(
      ENCRYPTED_CONTENT_INLINE_PATTERN,
      (match, prefix, secret) => `${prefix}[redacted ${secret.length} chars]`
    )
    .replace(REASONING_ENVELOPE_INLINE_PATTERN, (match) => `[redacted ${match.length} chars]`)
}

// 一个值整体就是载荷的情况（字段名是 encrypted_content，或值本身以 crsr1. 开头）：直接整段
// 遮掉，不只遮内嵌片段。两条调用点（safeStringify 的字符串分支、console 元数据里的原始值）
// 共用同一策略，避免其中一处只做了 maskReasoningPayload 而漏了这条整体规则（review round 3）
const REDACTED_STRING_KEYS = new Set(['encrypted_content'])
const REDACTED_STRING_PREFIX = 'crsr1.'

function sanitizeStringValue(key, value) {
  const str = String(value)
  if (REDACTED_STRING_KEYS.has(key) || str.startsWith(REDACTED_STRING_PREFIX)) {
    return `[redacted ${str.length} chars]`
  }
  return maskReasoningPayload(str)
}

module.exports = {
  maskReasoningPayload,
  sanitizeStringValue,
  REDACTED_STRING_KEYS,
  REDACTED_STRING_PREFIX
}
