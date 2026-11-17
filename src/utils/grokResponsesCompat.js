// Native grok Responses compatibility; other providers retain their wire shapes.
const { StringDecoder } = require('string_decoder')

const GROK_CLIENT_VERSION = '1.0.46'
const GROK_CLIENT_IDENTIFIER = 'grok-shell'

function grokNativeHeaders() {
  return {
    'x-grok-client-version': GROK_CLIENT_VERSION,
    'x-grok-client-identifier': GROK_CLIENT_IDENTIFIER
  }
}

function emptyResult(body) {
  return {
    body,
    droppedNamespaceTools: 0,
    strippedExternalWebAccess: 0,
    strippedNullReasoningContent: 0,
    translatedCustomToolNames: [],
    droppedUnsupportedTools: []
  }
}

function stripExternalWebAccess(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool) || tool.type !== 'web_search') {
    return { tool, stripped: false }
  }
  if (!Object.prototype.hasOwnProperty.call(tool, 'external_web_access')) {
    return { tool, stripped: false }
  }
  const next = { ...tool }
  delete next.external_web_access
  return { tool: next, stripped: true }
}

function normalizeReasoningInput(input) {
  if (!Array.isArray(input)) {
    return { input, strippedNullReasoningContent: 0, changed: false }
  }

  let strippedNullReasoningContent = 0
  const next = []
  for (const item of input) {
    if (
      item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      item.type === 'reasoning' &&
      Object.prototype.hasOwnProperty.call(item, 'content') &&
      item.content === null
    ) {
      const copy = { ...item }
      delete copy.content
      next.push(copy)
      strippedNullReasoningContent += 1
      continue
    }
    next.push(item)
  }

  if (strippedNullReasoningContent === 0) {
    return { input, strippedNullReasoningContent: 0, changed: false }
  }

  return { input: next, strippedNullReasoningContent, changed: true }
}

const SUPPORTED_TOOLS = new Set([
  'function',
  'web_search',
  'x_search',
  'image_generation',
  'collections_search',
  'file_search',
  'code_execution',
  'code_interpreter',
  'mcp',
  'shell',
  'tool_search'
])

function normalizeGrokResponsesBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return emptyResult(body)
  }
  const result = emptyResult(body)
  const reasoning = normalizeReasoningInput(body.input)
  result.strippedNullReasoningContent = reasoning.strippedNullReasoningContent
  const next = { ...body }
  if (Array.isArray(body.tools)) {
    next.tools = []
    for (const tool of body.tools) {
      if (tool?.execution === 'client') {
        result.droppedUnsupportedTools.push({
          provider: 'grok',
          type: tool.type,
          name: tool.name,
          execution: tool.execution,
          reason: 'client-executed tools are unsupported'
        })
        continue
      }
      if (tool?.type === 'custom') {
        result.translatedCustomToolNames.push(tool.name)
        const grammar = tool.format?.type === 'grammar' ? tool.format.definition : null
        next.tools.push({
          type: 'function',
          name: tool.name,
          description: [tool.description, 'Pass the raw tool input as the input string.', grammar]
            .filter(Boolean)
            .join('\n\n'),
          parameters: {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
            additionalProperties: false
          }
        })
      } else if (!SUPPORTED_TOOLS.has(tool?.type)) {
        if (tool?.type === 'namespace') {
          result.droppedNamespaceTools += 1
        }
        result.droppedUnsupportedTools.push({
          provider: 'grok',
          type: tool?.type,
          name: tool?.name
        })
      } else {
        const stripped = stripExternalWebAccess(tool)
        if (stripped.stripped) {
          result.strippedExternalWebAccess += 1
        }
        next.tools.push(stripped.tool)
      }
    }
  }
  if (Array.isArray(reasoning.input)) {
    next.input = reasoning.input.map((item) => {
      if (item?.type === 'custom_tool_call') {
        const { input, ...rest } = item
        return { ...rest, type: 'function_call', arguments: JSON.stringify({ input }) }
      }
      if (item?.type === 'custom_tool_call_output') {
        return { ...item, type: 'function_call_output' }
      }
      return item
    })
  }
  const choice = body.tool_choice
  if (choice && typeof choice === 'object') {
    if (choice.type === 'custom' && result.translatedCustomToolNames.includes(choice.name)) {
      next.tool_choice = { ...choice, type: 'function' }
    } else if (
      result.droppedUnsupportedTools.some((tool) =>
        choice.name ? tool.name === choice.name : tool.type === choice.type
      )
    ) {
      next.tool_choice = 'auto'
    }
  }
  result.body = next
  return result
}

function rawInput(argumentsText) {
  try {
    const parsed = JSON.parse(argumentsText)
    if (typeof parsed.input === 'string') {
      return parsed.input
    }
  } catch (_) {
    // Preserve malformed or non-JSON arguments for the custom tool to diagnose.
  }
  return argumentsText || ''
}

function rewriteItem(item, names) {
  if (item?.type !== 'function_call' || !names.has(item.name)) {
    return item
  }
  const { arguments: args, ...rest } = item
  return { ...rest, type: 'custom_tool_call', input: rawInput(args) }
}

function rewriteGrokResponseBody(body, translatedCustomToolNames) {
  const names = new Set(translatedCustomToolNames)
  if (!body || !Array.isArray(body.output) || names.size === 0) {
    return body
  }
  const output = body.output.map((item) => rewriteItem(item, names))
  return output.some((item, index) => item !== body.output[index]) ? { ...body, output } : body
}

// SSE framing and UTF-8 decoding must survive arbitrary upstream chunk boundaries.
function createGrokResponseStreamRewriter(translatedCustomToolNames) {
  const names = new Set(translatedCustomToolNames)
  const calls = new Map()
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  const key = (event) => event.item_id || event.item?.id || `index:${event.output_index}`
  const encode = (event, newline) => `event: ${event.type}${newline}data: ${JSON.stringify(event)}`

  function rewriteFrame(frame, separator) {
    const newline = frame.includes('\r\n') ? '\r\n' : '\n'
    const lines = frame.split(/\r?\n/)
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    let event
    try {
      event = JSON.parse(data)
    } catch (_) {
      return frame + separator
    }
    if (!event || typeof event !== 'object') {
      return frame + separator
    }
    let rewritten = event
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      const item = rewriteItem(event.item, names)
      if (item !== event.item) {
        if (event.type === 'response.output_item.added') {
          calls.set(key(event), '')
        }
        rewritten = { ...event, item }
      }
    } else if (event.type === 'response.function_call_arguments.delta' && calls.has(key(event))) {
      // A partial JSON string cannot be sent as raw custom input. Decode at done.
      calls.set(key(event), calls.get(key(event)) + event.delta)
      return ''
    } else if (event.type === 'response.function_call_arguments.done' && calls.has(key(event))) {
      const input = rawInput(event.arguments ?? calls.get(key(event)))
      calls.delete(key(event))
      const { arguments: _, ...rest } = event
      const delta = { ...rest, type: 'response.custom_tool_call_input.delta', delta: input }
      const done = { ...rest, type: 'response.custom_tool_call_input.done', input }
      return encode(delta, newline) + newline + newline + encode(done, newline) + separator
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const response = rewriteGrokResponseBody(event.response, names)
      if (response !== event.response) {
        rewritten = { ...event, response }
      }
    }
    if (rewritten === event) {
      return frame + separator
    }
    let wroteData = false
    return (
      lines
        .map((line) => {
          if (line.startsWith('event:')) {
            return `event: ${rewritten.type}`
          }
          if (line.startsWith('data:')) {
            if (wroteData) {
              return null
            }
            wroteData = true
            return `data: ${JSON.stringify(rewritten)}`
          }
          return line
        })
        .filter((line) => line !== null)
        .join(newline) + separator
    )
  }

  function drain(final) {
    let output = ''
    let match
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      output += rewriteFrame(buffer.slice(0, match.index), match[0])
      buffer = buffer.slice(match.index + match[0].length)
    }
    if (final && buffer) {
      output += rewriteFrame(buffer, '')
      buffer = ''
    }
    return output
  }
  return {
    write(chunk) {
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      return drain(false)
    },
    end() {
      buffer += decoder.end()
      return drain(true)
    }
  }
}

module.exports = {
  grokNativeHeaders,
  normalizeGrokResponsesBody,
  rewriteGrokResponseBody,
  createGrokResponseStreamRewriter
}
