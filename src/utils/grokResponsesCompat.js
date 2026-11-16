// Native /openai Responses requests from the codex CLI are not grok-shaped.
// The grok account path injects the CLI fingerprint and drops the two tool
// shapes grok rejects. tool_choice is left unchanged: this relay does not see
// a namespace tool_choice, and rewriting one would be a guess.

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
    strippedExternalWebAccess: 0
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

function normalizeGrokResponsesBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.tools)) {
    return emptyResult(body)
  }

  let droppedNamespaceTools = 0
  let strippedExternalWebAccess = 0
  let changed = false
  const tools = []

  for (const tool of body.tools) {
    if (tool && typeof tool === 'object' && !Array.isArray(tool) && tool.type === 'namespace') {
      droppedNamespaceTools += 1
      changed = true
      continue
    }
    const stripped = stripExternalWebAccess(tool)
    if (stripped.stripped) {
      strippedExternalWebAccess += 1
      changed = true
    }
    tools.push(stripped.tool)
  }

  if (!changed) {
    return emptyResult(body)
  }

  return {
    body: { ...body, tools },
    droppedNamespaceTools,
    strippedExternalWebAccess
  }
}

module.exports = {
  grokNativeHeaders,
  normalizeGrokResponsesBody
}
