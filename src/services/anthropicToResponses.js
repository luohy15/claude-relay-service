/**
 * Anthropic Messages ↔ OpenAI Responses 桥接
 *
 * 服务于 /codex/api/v1/messages 和 /grok/api/v1/messages 两个路径强制分流的挂载点：
 * 客户端（Claude Code）说 Anthropic Messages 协议，上游（ChatGPT Codex 订阅 / grok.com 订阅）
 * 说 OpenAI Responses 协议。本模块只做格式转换，账户调度、OAuth 刷新、代理、限流、
 * usage / 成本统计全部复用 openaiRoutes.handleResponses 既有链路（参考 unified.js 的分层方式）。
 *
 * 两个上游共用同一套 Responses 词汇（function_call / function_call_arguments.delta），
 * 所以只有一个转换器；vendor 只决定请求侧少数字段和 Grok 专属头部。
 *
 * ⚠️ thinking / reasoning：上游的 reasoning summary（Codex 的 response.reasoning_summary_text.*
 * 与 Grok 的同名事件族）一律**丢弃**，不下发 Anthropic thinking block。原因是无法为
 * thinking block 生成合法的 Anthropic signature，而"Claude Code 能容忍无签名 thinking block"
 * 这一假设尚未验证（plan 2972 假设 3）。不发 thinking block 一定是合法的 Anthropic 流，
 * 代价只是客户端看不到上游的思考摘要。
 */

const { StringDecoder } = require('string_decoder')
const logger = require('../utils/logger')
const metadataUserIdHelper = require('../utils/metadataUserIdHelper')
const { stripModelCapabilitySuffix } = require('../utils/modelHelper')
const { removeBillingHeaderFromSystem } = require('../utils/billingHeader')

// 显式 x-session-id 头的保守校验：这个值会原样转发进上游 header（openaiRoutes.js 的
// header 白名单），不能让客户端往上游请求头里塞任意内容
const EXPLICIT_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

// HTTP 状态码 → Anthropic 错误类型
const ANTHROPIC_ERROR_TYPES = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  529: 'overloaded_error'
}

// 上游 reasoning 事件：显式列出以示"已知且有意丢弃"，避免落到 default 分支被误认为未处理
const DROPPED_REASONING_EVENTS = new Set([
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done'
])

// =============================================
// 请求转换: Anthropic Messages → Responses
// =============================================

function extractSystemText(system) {
  system = removeBillingHeaderFromSystem(system)

  if (!system) {
    return ''
  }
  if (typeof system === 'string') {
    return system
  }
  if (Array.isArray(system)) {
    return system
      .filter((part) => part && part.type === 'text' && part.text)
      .map((part) => part.text)
      .join('\n\n')
  }
  return ''
}

function makeTextPart(role, text) {
  return { type: role === 'assistant' ? 'output_text' : 'input_text', text }
}

function makeImagePart(block) {
  const source = block.source || {}
  if (source.type === 'base64' && source.data) {
    return {
      type: 'input_image',
      image_url: `data:${source.media_type || 'image/png'};base64,${source.data}`
    }
  }
  if (source.type === 'url' && source.url) {
    return { type: 'input_image', image_url: source.url }
  }
  return null
}

// tool_result 的内容可能是字符串或 block 数组，Responses 的 function_call_output 只接受字符串
function stringifyToolResult(content) {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    const texts = content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
    if (texts.length > 0) {
      return texts.join('\n')
    }
    return content.map((block) => `[${block?.type || 'unknown'} block omitted]`).join('\n')
  }
  if (content === null || content === undefined) {
    return ''
  }
  return JSON.stringify(content)
}

function buildInputItems(messages) {
  const input = []

  for (const message of messages || []) {
    if (!message || !message.role) {
      continue
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const { content } = message

    if (typeof content === 'string') {
      if (content) {
        input.push({ type: 'message', role, content: [makeTextPart(role, content)] })
      }
      continue
    }

    if (!Array.isArray(content)) {
      continue
    }

    // tool_use / tool_result 在 Responses 里是顶层 item，遇到它们要先把已积累的文本 flush 成 message，
    // 以保持 Anthropic 里的块顺序
    const parts = []
    const flushParts = () => {
      if (parts.length > 0) {
        input.push({ type: 'message', role, content: parts.splice(0) })
      }
    }

    for (const block of content) {
      if (!block || !block.type) {
        continue
      }

      switch (block.type) {
        case 'text':
          if (block.text) {
            parts.push(makeTextPart(role, block.text))
          }
          break

        case 'image': {
          const image = role === 'user' ? makeImagePart(block) : null
          if (image) {
            parts.push(image)
          }
          break
        }

        case 'tool_use':
          flushParts()
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {})
          })
          break

        case 'tool_result':
          flushParts()
          input.push({
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output: stringifyToolResult(block.content)
          })
          break

        default:
          // thinking / redacted_thinking / document 等：Responses 无对应结构，丢弃
          break
      }
    }

    flushParts()
  }

  return input
}

function buildTools(tools) {
  const converted = []
  for (const tool of tools || []) {
    // 只转换自定义工具；Anthropic 服务端工具（web_search 等）没有 input_schema，上游也没有对应定义
    if (!tool || !tool.name || !tool.input_schema) {
      continue
    }
    const fn = { type: 'function', name: tool.name, parameters: tool.input_schema, strict: false }
    if (tool.description) {
      fn.description = tool.description
    }
    converted.push(fn)
  }
  return converted
}

function convertToolChoice(toolChoice) {
  if (!toolChoice || !toolChoice.type) {
    return undefined
  }
  switch (toolChoice.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      return toolChoice.name ? { type: 'function', name: toolChoice.name } : 'required'
    default:
      return 'auto'
  }
}

// Anthropic 的 thinking.budget_tokens → Responses 的 reasoning.effort（无精确对应，按档位近似）
function mapReasoningEffort(body) {
  const thinking = body?.thinking
  if (thinking && thinking.type === 'enabled') {
    const budget = Number(thinking.budget_tokens)
    if (Number.isFinite(budget)) {
      if (budget >= 16000) {
        return 'high'
      }
      if (budget >= 4000) {
        return 'medium'
      }
      return 'low'
    }
    return 'medium'
  }
  if (thinking && thinking.type === 'disabled') {
    return 'low'
  }
  return 'medium'
}

/**
 * Anthropic Messages 请求体 → OpenAI Responses 请求体
 * @param {Object} anthropicBody - Anthropic /v1/messages 请求体
 * @param {Object} [options]
 * @param {string} [options.vendor] - 'codex' | 'grok'
 * @returns {Object} Responses 请求体
 */
function buildResponsesRequestFromAnthropic(anthropicBody = {}, options = {}) {
  const vendor = options.vendor === 'grok' ? 'grok' : 'codex'
  const result = {
    // 上游只认真实模型 id：客户端能力后缀（gpt-5.6-sol[1m]）在这里剥掉，
    // 响应侧仍回显客户端请求的原始模型（见 patchResponseForAnthropic）
    model: stripModelCapabilitySuffix(anthropicBody.model),
    stream: anthropicBody.stream === true
  }

  // system → 顶层 instructions（已验证 chatgpt.com 不对 instructions 做指纹校验，plan 2972 §9 Spike 1）
  const instructions = extractSystemText(anthropicBody.system)
  if (instructions) {
    result.instructions = instructions
  }

  result.input = buildInputItems(anthropicBody.messages)

  const tools = buildTools(anthropicBody.tools)
  if (tools.length > 0) {
    result.tools = tools
  }

  const toolChoice = convertToolChoice(anthropicBody.tool_choice)
  if (toolChoice !== undefined) {
    result.tool_choice = toolChoice
  }

  // 两个上游的默认值不同（Grok 默认 parallel_tool_calls/effort/temperature 都自己兜底），一律显式给出
  result.parallel_tool_calls = anthropicBody.tool_choice?.disable_parallel_tool_use !== true
  result.reasoning = { effort: mapReasoningEffort(anthropicBody), summary: 'auto' }

  if (vendor === 'codex') {
    // chatgpt.com 的 codex 后端不吃 temperature / top_p / max_output_tokens（applyCodexCliAdaptation
    // 对非 Codex CLI 客户端就是把这些字段删掉），桥接路径靠 _fromUnifiedEndpoint 跳过了那段适配，
    // 所以这里自己保持同样的字段纪律，并按 Codex CLI 的请求形状带上 include。
    result.include = ['reasoning.encrypted_content']
  } else {
    if (anthropicBody.max_tokens > 0) {
      result.max_output_tokens = anthropicBody.max_tokens
    }
    if (typeof anthropicBody.temperature === 'number') {
      result.temperature = anthropicBody.temperature
    }
    if (typeof anthropicBody.top_p === 'number') {
      result.top_p = anthropicBody.top_p
    }
  }

  return result
}

// =============================================
// 响应转换: Responses → Anthropic Messages
// =============================================

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function toAnthropicMessageId(responseId) {
  if (typeof responseId === 'string' && responseId) {
    return responseId.startsWith('msg_') ? responseId : `msg_${responseId}`
  }
  return `msg_${Date.now().toString(36)}`
}

// Anthropic 的 input_tokens 不含缓存命中部分，缓存单列 cache_read_input_tokens
function mapUsage(usage) {
  const source = usage || {}
  const cacheRead = source.input_tokens_details?.cached_tokens || 0
  const mapped = {
    input_tokens: Math.max(0, (source.input_tokens || 0) - cacheRead),
    output_tokens: source.output_tokens || 0
  }
  if (cacheRead > 0) {
    mapped.cache_read_input_tokens = cacheRead
  }
  return mapped
}

function mapStopReason(resp, hasToolUse) {
  if (hasToolUse) {
    return 'tool_use'
  }
  if (resp?.status === 'incomplete' && resp.incomplete_details?.reason === 'max_output_tokens') {
    return 'max_tokens'
  }
  return 'end_turn'
}

function extractErrorMessage(data) {
  if (!data) {
    return ''
  }
  if (typeof data === 'string') {
    return data
  }
  if (typeof data.error === 'string') {
    return data.error
  }
  if (data.error?.message) {
    return data.error.message
  }
  if (typeof data.message === 'string') {
    return data.message
  }
  if (data.detail) {
    return typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)
  }
  return ''
}

/**
 * 任意上游错误体 → Anthropic 错误信封 { type: 'error', error: { type, message } }
 */
function buildErrorEnvelope(statusCode, data) {
  const fallbackType = statusCode >= 500 ? 'api_error' : 'invalid_request_error'
  return {
    type: 'error',
    error: {
      type: ANTHROPIC_ERROR_TYPES[statusCode] || fallbackType,
      message: extractErrorMessage(data) || 'Upstream request failed'
    }
  }
}

function createStreamState(model) {
  return {
    model: model || '',
    messageId: '',
    messageStarted: false,
    messageStopped: false,
    blockIndex: -1,
    openBlock: null, // { kind: 'text' | 'tool_use', argsDeltaSeen: boolean }
    toolUseCount: 0
  }
}

function ensureMessageStart(eventData, state, out) {
  if (state.messageStarted) {
    return
  }
  state.messageStarted = true
  state.messageId = toAnthropicMessageId(eventData?.response?.id)
  out.push(
    sse('message_start', {
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        // 回显请求侧的模型名：Grok 会把 model 改写成 grok-4.5-build，不该泄露给客户端
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    })
  )
}

function closeOpenBlock(state, out) {
  if (!state.openBlock) {
    return
  }
  out.push(sse('content_block_stop', { type: 'content_block_stop', index: state.blockIndex }))
  state.openBlock = null
}

function ensureTextBlock(state, out) {
  if (state.openBlock && state.openBlock.kind === 'text') {
    return
  }
  closeOpenBlock(state, out)
  state.blockIndex += 1
  state.openBlock = { kind: 'text' }
  out.push(
    sse('content_block_start', {
      type: 'content_block_start',
      index: state.blockIndex,
      content_block: { type: 'text', text: '' }
    })
  )
}

function openToolUseBlock(item, state, out) {
  state.blockIndex += 1
  state.toolUseCount += 1
  state.openBlock = { kind: 'tool_use', argsDeltaSeen: false }
  out.push(
    sse('content_block_start', {
      type: 'content_block_start',
      index: state.blockIndex,
      content_block: {
        type: 'tool_use',
        id: item.call_id || item.id,
        name: item.name,
        input: {}
      }
    })
  )
}

function emitInputJsonDelta(partialJson, state, out) {
  out.push(
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: state.blockIndex,
      delta: { type: 'input_json_delta', partial_json: partialJson }
    })
  )
}

function emitMessageEnd(resp, state, out) {
  closeOpenBlock(state, out)
  // 一条没有任何内容块的 Anthropic message 不是客户端预期的形状，补一个空 text block
  if (state.blockIndex < 0) {
    ensureTextBlock(state, out)
    closeOpenBlock(state, out)
  }
  out.push(
    sse('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: mapStopReason(resp, state.toolUseCount > 0),
        stop_sequence: null
      },
      usage: mapUsage(resp?.usage)
    })
  )
  out.push(sse('message_stop', { type: 'message_stop' }))
  state.messageStopped = true
}

/**
 * 单个已解析的 Responses SSE 事件 → Anthropic SSE 字符串数组
 * @param {Object} eventData - 已解析的上游事件对象
 * @param {Object} state - createStreamState() 的返回值
 * @returns {string[]}
 */
function convertStreamEvent(eventData, state) {
  const out = []
  const type = eventData?.type
  if (!type || state.messageStopped) {
    return out
  }

  switch (type) {
    case 'response.created':
    case 'response.in_progress':
      ensureMessageStart(eventData, state, out)
      break

    case 'response.output_item.added': {
      const item = eventData.item || {}
      if (item.type === 'function_call') {
        ensureMessageStart(eventData, state, out)
        closeOpenBlock(state, out)
        openToolUseBlock(item, state, out)
      }
      break
    }

    case 'response.output_text.delta': {
      if (!eventData.delta) {
        break
      }
      ensureMessageStart(eventData, state, out)
      ensureTextBlock(state, out)
      out.push(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: state.blockIndex,
          delta: { type: 'text_delta', text: eventData.delta }
        })
      )
      break
    }

    case 'response.function_call_arguments.delta': {
      if (!state.openBlock || state.openBlock.kind !== 'tool_use' || !eventData.delta) {
        break
      }
      state.openBlock.argsDeltaSeen = true
      emitInputJsonDelta(eventData.delta, state, out)
      break
    }

    case 'response.function_call_arguments.done': {
      // Codex 会发很多个 delta，Grok 可能只发一个甚至不发；只在一个 delta 都没收到时用 done 补全
      if (
        !state.openBlock ||
        state.openBlock.kind !== 'tool_use' ||
        state.openBlock.argsDeltaSeen
      ) {
        break
      }
      state.openBlock.argsDeltaSeen = true
      emitInputJsonDelta(eventData.arguments || '{}', state, out)
      break
    }

    case 'response.output_item.done': {
      const item = eventData.item || {}
      if (item.type === 'function_call') {
        if (!state.openBlock || state.openBlock.kind !== 'tool_use') {
          // 兜底：没收到 added 事件时用完整 item 补一个 tool_use block
          ensureMessageStart(eventData, state, out)
          closeOpenBlock(state, out)
          openToolUseBlock(item, state, out)
        }
        if (!state.openBlock.argsDeltaSeen) {
          state.openBlock.argsDeltaSeen = true
          emitInputJsonDelta(item.arguments || '{}', state, out)
        }
        closeOpenBlock(state, out)
      } else if (item.type === 'message') {
        closeOpenBlock(state, out)
      }
      break
    }

    case 'response.completed':
    case 'response.incomplete':
      ensureMessageStart(eventData, state, out)
      emitMessageEnd(eventData.response, state, out)
      break

    case 'response.failed': {
      const failure = eventData.response?.error || {}
      out.push(sse('error', buildErrorEnvelope(500, failure)))
      state.messageStopped = true
      break
    }

    case 'error':
      out.push(sse('error', buildErrorEnvelope(eventData.status || 500, eventData)))
      state.messageStopped = true
      break

    default:
      if (!DROPPED_REASONING_EVENTS.has(type)) {
        logger.debug(`🌉 Anthropic bridge ignoring upstream event: ${type}`)
      }
      break
  }

  return out
}

/**
 * 上游流意外结束（没有 response.completed）时补齐 Anthropic 流的收尾事件
 * @param {Object} state
 * @returns {string[]}
 */
function finalizeStream(state) {
  if (!state.messageStarted || state.messageStopped) {
    return []
  }
  const out = []
  emitMessageEnd(null, state, out)
  return out
}

/**
 * 非流式 Responses 响应 → Anthropic Message
 * @param {Object} responseData - Responses 响应对象，或 { type: 'response.completed', response }
 * @param {Object} [options]
 * @param {string} [options.model] - 请求侧模型名（回显给客户端）
 * @returns {Object} Anthropic Message 或错误信封
 */
function convertResponseToAnthropic(responseData, options = {}) {
  const resp =
    responseData && responseData.type === 'response.completed'
      ? responseData.response
      : responseData

  if (resp?.status === 'failed') {
    return buildErrorEnvelope(500, resp.error)
  }

  const content = []
  for (const item of resp?.output || []) {
    if (!item || !item.type) {
      continue
    }
    if (item.type === 'message') {
      const text = (item.content || [])
        .filter((part) => part && part.type === 'output_text' && part.text)
        .map((part) => part.text)
        .join('')
      if (text) {
        content.push({ type: 'text', text })
      }
    } else if (item.type === 'function_call') {
      let input = {}
      try {
        input = item.arguments ? JSON.parse(item.arguments) : {}
      } catch (error) {
        logger.warn(`⚠️ Anthropic bridge failed to parse tool arguments for ${item.name}`)
        input = {}
      }
      content.push({ type: 'tool_use', id: item.call_id || item.id, name: item.name, input })
    }
    // reasoning item：见文件头注释，不下发 thinking block
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }

  const hasToolUse = content.some((block) => block.type === 'tool_use')

  return {
    id: toAnthropicMessageId(resp?.id),
    type: 'message',
    role: 'assistant',
    model: options.model || resp?.model || '',
    content,
    stop_reason: mapStopReason(resp, hasToolUse),
    stop_sequence: null,
    usage: mapUsage(resp?.usage)
  }
}

/**
 * count_tokens 的本地估算：Codex / Grok 上游都没有 token 计数端点，
 * Claude Code 只用这个数字做上下文预算，返回一个粗估好过 404。
 * 按 4 字符 ≈ 1 token 估算，图片不计入。
 * @param {Object} anthropicBody
 * @returns {number}
 */
function estimateInputTokens(anthropicBody) {
  let chars = extractSystemText(anthropicBody?.system).length

  for (const message of anthropicBody?.messages || []) {
    const { content } = message || {}
    if (typeof content === 'string') {
      chars += content.length
      continue
    }
    for (const block of Array.isArray(content) ? content : []) {
      if (!block || !block.type) {
        continue
      }
      if (block.type === 'text') {
        chars += (block.text || '').length
      } else if (block.type === 'tool_use') {
        chars += (block.name || '').length + JSON.stringify(block.input ?? {}).length
      } else if (block.type === 'tool_result') {
        chars += stringifyToolResult(block.content).length
      } else if (block.type === 'thinking') {
        chars += (block.thinking || '').length
      }
    }
  }

  for (const tool of anthropicBody?.tools || []) {
    if (!tool) {
      continue
    }
    chars += (tool.name || '').length + (tool.description || '').length
    if (tool.input_schema) {
      chars += JSON.stringify(tool.input_schema).length
    }
  }

  return Math.max(1, Math.ceil(chars / 4))
}

// =============================================
// 桥接入口: /codex/api、/grok/api 的 /v1/messages
// =============================================

function applyGrokHeaders(req, model) {
  // grok-build 客户端自带的指纹头部，Claude Code 不会带；X-XAI-Token-Auth 由 relay 侧注入。
  // lazy require：转换逻辑本身不需要账户服务，避免为它拉起 redis 依赖
  const {
    GROK_CLI_CLIENT_VERSION,
    GROK_CLI_CLIENT_IDENTIFIER
  } = require('./account/grokAccountService')
  req.headers['x-grok-client-version'] = GROK_CLI_CLIENT_VERSION
  req.headers['x-grok-client-identifier'] = GROK_CLI_CLIENT_IDENTIFIER
  if (model) {
    req.headers['x-grok-model-override'] = model
  }
}

// 把一段原始上游 SSE 事件文本转成 Anthropic SSE 片段
function convertRawSSEEvent(rawEvent, state) {
  const out = []
  if (!rawEvent.trim()) {
    return out
  }

  for (const line of rawEvent.split('\n')) {
    if (line.startsWith(':')) {
      // SSE 注释（心跳保活）原样透传
      out.push(`${line}\n\n`)
      continue
    }
    if (!line.startsWith('data:')) {
      continue
    }
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') {
      continue
    }
    let eventData
    try {
      eventData = JSON.parse(payload)
    } catch (error) {
      logger.debug('🌉 Anthropic bridge skipped unparsable SSE payload')
      continue
    }
    out.push(...convertStreamEvent(eventData, state))
  }

  return out
}

function toText(chunk) {
  return (typeof chunk === 'string' ? chunk : chunk.toString()).replace(/\r\n/g, '\n')
}

/**
 * 每个流一个 UTF-8 解码器：上游 chunk 边界由 TLS/TCP 分片决定，多字节字符会被劈开，
 * 逐 chunk 调 Buffer.toString() 会把两半都解成 U+FFFD（正文和 tool 参数都会被静默改写）。
 * StringDecoder 会把不完整的尾部字节留在内部，等下一个 chunk 补齐。
 */
function createChunkDecoder() {
  const decoder = new StringDecoder('utf8')
  return {
    write(chunk) {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
      return text.replace(/\r\n/g, '\n')
    },
    // 冲掉残留字节，避免流结束时丢掉最后一个字符
    end() {
      return decoder.end().replace(/\r\n/g, '\n')
    }
  }
}

// 错误分支（如流式 429）：上游把 OpenAI 错误体写成一个 SSE data 事件或裸 JSON。
// 状态码已经是 4xx/5xx，客户端会把整个 body 当 JSON 解析（而不是走 SSE 解析），
// 所以这里直接写出 Anthropic 错误信封的 JSON，而不是再包一层 SSE 帧。
function convertErrorChunk(chunk, statusCode) {
  const text = toText(chunk)

  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) {
      continue
    }
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') {
      continue
    }
    try {
      return JSON.stringify(buildErrorEnvelope(statusCode, JSON.parse(payload)))
    } catch (error) {
      return JSON.stringify(buildErrorEnvelope(statusCode, payload))
    }
  }

  try {
    return JSON.stringify(buildErrorEnvelope(statusCode, JSON.parse(text)))
  } catch (error) {
    return text
  }
}

/**
 * 劫持 res.json / res.write / res.end，把下游写出的 Responses 格式响应转成 Anthropic 格式
 */
function patchResponseForAnthropic(res, { model, stream }) {
  const originalJson = res.json.bind(res)
  const originalWrite = res.write.bind(res)
  const originalEnd = res.end.bind(res)

  res.json = function (data) {
    if (res.statusCode >= 400) {
      return originalJson(buildErrorEnvelope(res.statusCode, data))
    }
    try {
      return originalJson(convertResponseToAnthropic(data, { model }))
    } catch (error) {
      logger.error('❌ Anthropic bridge response conversion failed:', error)
      return originalJson(buildErrorEnvelope(500, { message: 'Response conversion failed' }))
    }
  }

  if (!stream) {
    return
  }

  const state = createStreamState(model)
  const buffer = { data: '' }
  const chunkDecoder = createChunkDecoder()

  const drainBuffer = () => {
    let idx
    while ((idx = buffer.data.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.data.slice(0, idx)
      buffer.data = buffer.data.slice(idx + 2)
      for (const converted of convertRawSSEEvent(rawEvent, state)) {
        originalWrite(converted)
      }
    }
  }

  res.write = function (chunk, encoding, callback) {
    if (res.statusCode >= 400) {
      return originalWrite(convertErrorChunk(chunk, res.statusCode), encoding, callback)
    }

    buffer.data += chunkDecoder.write(chunk)
    drainBuffer()

    if (typeof callback === 'function') {
      callback()
    }
    return true
  }

  res.end = function (chunk, encoding, callback) {
    if (res.statusCode < 400) {
      if (chunk) {
        buffer.data += chunkDecoder.write(chunk)
        chunk = undefined
      }
      buffer.data += chunkDecoder.end()
      drainBuffer()
      if (buffer.data.trim()) {
        const rawEvent = buffer.data
        buffer.data = ''
        for (const converted of convertRawSSEEvent(rawEvent, state)) {
          originalWrite(converted)
        }
      }
      for (const converted of finalizeStream(state)) {
        originalWrite(converted)
      }
    }
    return originalEnd(chunk, encoding, callback)
  }
}

/**
 * /codex/api/v1/messages、/grok/api/v1/messages 的处理入口
 * 转换请求体后委托给 openaiRoutes.handleResponses，账户调度 / OAuth / usage 全部复用既有链路
 * @param {Object} req
 * @param {Object} res
 * @param {string} vendor - 'codex' | 'grok'
 */
async function handleAnthropicToResponses(req, res, vendor) {
  const anthropicBody = req.body || {}
  const requestedModel = anthropicBody.model || ''
  // 上游请求（含 grok 的模型覆盖头）用真实模型 id，客户端可见的响应仍用 requestedModel
  const upstreamModel = stripModelCapabilitySuffix(requestedModel)
  const isStream = anthropicBody.stream === true

  // 会话身份优先级（高到低），只接受能真正标识会话的来源：
  // 1. 客户端显式提供的 x-session-id 头（如 y-agent 未来通过 ANTHROPIC_CUSTOM_HEADERS
  //    注入、取值为其自己稳定的 chat_id——比 Claude Code 自己的 session 概念更稳，见
  //    pages/plan-3032-cache-key-channel.md）。校验保守字符集+长度上限，见上面
  //    EXPLICIT_SESSION_ID_PATTERN 的注释。
  // 2. 否则 Claude Code 自己发的 metadata.user_id 里的 session id：直接读，不走
  //    sessionHelper.generateSessionHash——那个函数的内容哈希兜底会让不同会话撞成
  //    同一个 key（两个会话共享系统提示词+首条用户消息时），比不注入还糟，且在
  //    dashboard 上看不出来（见 pages/review-3032-prompt-cache-key.md §3.2）。
  //    sessionHelper 本身不改，原生 Claude 粘性路径仍然依赖它的兜底。
  // 两者都没有 → 400：桥接路径没有可用的稳定会话身份，硬发出去只会制造
  // shared-bucket 争用，代价比拒绝更大。
  const rawExplicitSessionId =
    typeof req.headers['x-session-id'] === 'string' ? req.headers['x-session-id'].trim() : ''
  const explicitSessionId = EXPLICIT_SESSION_ID_PATTERN.test(rawExplicitSessionId)
    ? rawExplicitSessionId
    : ''
  const sessionHash =
    explicitSessionId ||
    metadataUserIdHelper.extractSessionId(anthropicBody?.metadata?.user_id) ||
    ''

  if (!sessionHash) {
    logger.warn(
      `🌉 Anthropic→Responses bridge: rejected, no stable session id (vendor=${vendor}, model=${requestedModel})`
    )
    return res.status(400).json(
      buildErrorEnvelope(400, {
        message:
          'Missing stable session id: send an x-session-id header or a Claude Code metadata.user_id'
      })
    )
  }

  req.headers['session_id'] = sessionHash
  req.headers['accept'] = isStream ? 'text/event-stream' : 'application/json'

  if (vendor === 'grok') {
    applyGrokHeaders(req, upstreamModel)
  }

  patchResponseForAnthropic(res, { model: requestedModel, stream: isStream })

  // prompt_cache_key 只在源请求体（客户端的 Anthropic Messages body）里没有这个字段时
  // 才写入——协议目前没有这个字段，这里只是让优先级显式：不覆盖任何客户端自带值。
  const clientPromptCacheKey = anthropicBody.prompt_cache_key
  req.body = buildResponsesRequestFromAnthropic(anthropicBody, { vendor })
  req.body.prompt_cache_key = clientPromptCacheKey || sessionHash
  // 载荷已是 Responses 格式，路径必须与之匹配（req.path 是只读 getter，派生自 req.url）
  req.url = '/v1/responses'
  // 载荷标志：让 isStandardResponsesRoute() 返回 false，从而跳过 applyCodexCliAdaptation，
  // 保住上面写入 instructions 的 Claude Code 系统提示词
  req._fromUnifiedEndpoint = true
  // 桥接路径的 payload 已经是最终形态：不能再被 normalizeGpt5ModelForCodex 静默改写成 gpt-5，
  // 否则 bot 配置 / usage 统计里的模型和实际调用的模型对不上（S6）
  req._skipCodexModelNormalization = true

  logger.api(
    `🌉 Anthropic→Responses bridge: vendor=${vendor}, model=${requestedModel}, upstreamModel=${upstreamModel}, stream=${isStream}`
  )

  const openaiRoutes = require('../routes/openaiRoutes') // lazy require, avoid app.js circular load
  return await openaiRoutes.handleResponses(req, res)
}

module.exports = {
  buildResponsesRequestFromAnthropic,
  createStreamState,
  convertStreamEvent,
  finalizeStream,
  convertResponseToAnthropic,
  buildErrorEnvelope,
  estimateInputTokens,
  handleAnthropicToResponses
}
