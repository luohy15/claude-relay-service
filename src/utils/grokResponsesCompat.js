// Native /openai Responses requests from the codex CLI are not grok-shaped.
// The grok account path injects the CLI fingerprint, drops the two tool
// shapes grok rejects, and deletes a null content field on replayed reasoning
// items. encrypted_content and every other field stay as sent. A string input
// is not parsed. tool_choice is left unchanged: this relay does not see a
// namespace tool_choice, and rewriting one would be a guess.

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
    strippedNullReasoningContent: 0
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

function normalizeGrokResponsesBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return emptyResult(body)
  }

  const reasoning = normalizeReasoningInput(body.input)

  let droppedNamespaceTools = 0
  let strippedExternalWebAccess = 0
  let toolsChanged = false
  let tools = null

  if (Array.isArray(body.tools)) {
    tools = []
    for (const tool of body.tools) {
      if (tool && typeof tool === 'object' && !Array.isArray(tool) && tool.type === 'namespace') {
        droppedNamespaceTools += 1
        toolsChanged = true
        continue
      }
      const stripped = stripExternalWebAccess(tool)
      if (stripped.stripped) {
        strippedExternalWebAccess += 1
        toolsChanged = true
      }
      tools.push(stripped.tool)
    }
  }

  if (!reasoning.changed && !toolsChanged) {
    return emptyResult(body)
  }

  const nextBody = { ...body }
  if (toolsChanged) {
    nextBody.tools = tools
  }
  if (reasoning.changed) {
    nextBody.input = reasoning.input
  }

  return {
    body: nextBody,
    droppedNamespaceTools,
    strippedExternalWebAccess,
    strippedNullReasoningContent: reasoning.strippedNullReasoningContent
  }
}

module.exports = {
  grokNativeHeaders,
  normalizeGrokResponsesBody
}
