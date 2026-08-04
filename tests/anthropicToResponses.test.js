jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  security: jest.fn()
}))

jest.mock('../src/routes/openaiRoutes', () => ({ handleResponses: jest.fn() }))

// grok 头部常量来自 grokAccountService（redis/config 依赖在单测里不需要真的加载）
jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 600000,
    security: { encryptionKey: '12345678901234567890123456789012' }
  }),
  { virtual: true }
)
jest.mock('../src/models/redis', () => ({}))

const openaiRoutes = require('../src/routes/openaiRoutes')
const {
  buildResponsesRequestFromAnthropic,
  createStreamState,
  convertStreamEvent,
  finalizeStream,
  convertResponseToAnthropic,
  buildErrorEnvelope,
  estimateInputTokens,
  handleAnthropicToResponses
} = require('../src/services/anthropicToResponses')

// 把 convertStreamEvent 输出的 SSE 字符串解析回 { event, data }，方便断言事件序列
function runStream(events, model) {
  const state = createStreamState(model)
  const chunks = []
  for (const event of events) {
    chunks.push(...convertStreamEvent(event, state))
  }
  chunks.push(...finalizeStream(state))

  return chunks.map((chunk) => {
    const [eventLine, dataLine] = chunk.trim().split('\n')
    return {
      event: eventLine.replace('event: ', ''),
      data: JSON.parse(dataLine.replace('data: ', ''))
    }
  })
}

describe('anthropicToResponses request converter', () => {
  test('maps system to top-level instructions and messages to input items', () => {
    const result = buildResponsesRequestFromAnthropic(
      {
        model: 'gpt-5.6-sol',
        stream: true,
        max_tokens: 4096,
        system: [
          { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: 'text', text: '# Tools\nYou have access to Bash.' }
        ],
        messages: [{ role: 'user', content: 'say RELAY-OK' }]
      },
      { vendor: 'codex' }
    )

    expect(result.instructions).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.\n\n# Tools\nYou have access to Bash."
    )
    expect(result.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say RELAY-OK' }] }
    ])
    expect(result.model).toBe('gpt-5.6-sol')
    expect(result.stream).toBe(true)
    expect(result.reasoning).toEqual({ effort: 'medium', summary: 'auto' })
    expect(result.include).toEqual(['reasoning.encrypted_content'])
    // chatgpt.com 的 codex 后端不接受 max_output_tokens / temperature / top_p
    expect(result.max_output_tokens).toBeUndefined()
  })

  test('strips the client [1m] capability suffix from the upstream model id', () => {
    const build = (model, vendor) =>
      buildResponsesRequestFromAnthropic(
        { model, messages: [{ role: 'user', content: 'hi' }] },
        { vendor }
      )

    // Claude Code 用 `<model>[1m]` 声明自己按 1M 上下文预算跑，上游只认真实模型 id
    expect(build('gpt-5.6-sol[1m]', 'codex').model).toBe('gpt-5.6-sol')
    expect(build('grok-4.5[1m]', 'grok').model).toBe('grok-4.5')
    // 不带后缀 / 其它括号形态一律原样透传
    expect(build('gpt-5.6-sol', 'codex').model).toBe('gpt-5.6-sol')
    expect(build('gpt-5.6-sol[200k]', 'codex').model).toBe('gpt-5.6-sol[200k]')
  })

  test('converts a multi-turn tool round-trip into function_call / function_call_output items', () => {
    const result = buildResponsesRequestFromAnthropic(
      {
        model: 'grok-4.5',
        max_tokens: 1024,
        temperature: 1,
        messages: [
          { role: 'user', content: 'run echo RELAY-OK' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'I should use Bash', signature: 'sig-abc' },
              { type: 'text', text: 'Running it.' },
              {
                type: 'tool_use',
                id: 'toolu_01',
                name: 'Bash',
                input: { command: 'echo RELAY-OK' }
              }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_01',
                content: [{ type: 'text', text: 'RELAY-OK\n' }]
              },
              { type: 'text', text: 'what did it print?' }
            ]
          }
        ]
      },
      { vendor: 'grok' }
    )

    expect(result.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'run echo RELAY-OK' }]
      },
      // thinking block 被丢弃，text 先 flush 成 message，再是 function_call，顺序保持
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Running it.' }]
      },
      {
        type: 'function_call',
        call_id: 'toolu_01',
        name: 'Bash',
        arguments: '{"command":"echo RELAY-OK"}'
      },
      { type: 'function_call_output', call_id: 'toolu_01', output: 'RELAY-OK\n' },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'what did it print?' }]
      }
    ])
    // grok 上游接受这些字段，显式给出，避免落到它自己的默认值
    expect(result.max_output_tokens).toBe(1024)
    expect(result.temperature).toBe(1)
    expect(result.include).toBeUndefined()
  })

  test('converts image blocks, tools and tool_choice', () => {
    const result = buildResponsesRequestFromAnthropic({
      model: 'gpt-5.6-sol',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }
            }
          ]
        }
      ],
      tools: [
        {
          name: 'Bash',
          description: 'Executes a bash command',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command']
          }
        },
        { type: 'web_search_20250305', name: 'web_search' }
      ],
      tool_choice: { type: 'tool', name: 'Bash', disable_parallel_tool_use: true }
    })

    expect(result.input[0].content).toEqual([
      { type: 'input_text', text: 'what is this?' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
    ])
    // 服务端工具（无 input_schema）被跳过
    expect(result.tools).toEqual([
      {
        type: 'function',
        name: 'Bash',
        description: 'Executes a bash command',
        strict: false,
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command']
        }
      }
    ])
    expect(result.tool_choice).toEqual({ type: 'function', name: 'Bash' })
    expect(result.parallel_tool_calls).toBe(false)
  })

  test('maps thinking budget to reasoning effort', () => {
    const effortOf = (thinking) =>
      buildResponsesRequestFromAnthropic({ model: 'gpt-5.6-sol', messages: [], thinking }).reasoning
        .effort

    expect(effortOf({ type: 'enabled', budget_tokens: 24000 })).toBe('high')
    expect(effortOf({ type: 'enabled', budget_tokens: 8000 })).toBe('medium')
    expect(effortOf({ type: 'enabled', budget_tokens: 1024 })).toBe('low')
    expect(effortOf({ type: 'disabled' })).toBe('low')
    expect(effortOf(undefined)).toBe('medium')
  })
})

describe('anthropicToResponses stream converter', () => {
  test('converts a Codex-style text stream into a well-formed Anthropic stream', () => {
    const events = runStream(
      [
        { type: 'response.created', response: { id: 'resp_abc', model: 'gpt-5.6-terra' } },
        { type: 'response.in_progress', response: { id: 'resp_abc' } },
        { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1' } },
        { type: 'response.output_text.delta', delta: 'RELAY' },
        { type: 'response.output_text.delta', delta: '-OK' },
        { type: 'response.output_text.done', text: 'RELAY-OK' },
        { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1' } },
        {
          type: 'response.completed',
          response: {
            id: 'resp_abc',
            status: 'completed',
            model: 'gpt-5.6-terra',
            usage: {
              input_tokens: 2503,
              input_tokens_details: { cached_tokens: 1792 },
              output_tokens: 8
            }
          }
        }
      ],
      'gpt-5.6-sol'
    )

    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])

    // 模型名回显请求侧的 id，而不是上游返回的
    expect(events[0].data.message.model).toBe('gpt-5.6-sol')
    expect(events[0].data.message.id).toBe('msg_resp_abc')
    expect(events[1].data.content_block).toEqual({ type: 'text', text: '' })
    expect(
      events
        .map((e) => e.data.delta?.text)
        .filter(Boolean)
        .join('')
    ).toBe('RELAY-OK')
    expect(events[5].data.delta.stop_reason).toBe('end_turn')
    // Anthropic 的 input_tokens 不含缓存命中
    expect(events[5].data.usage).toEqual({
      input_tokens: 711,
      output_tokens: 8,
      cache_read_input_tokens: 1792
    })
  })

  test('reassembles Codex incremental tool arguments byte-identically', () => {
    const argumentChunks = ['{"comm', 'and":"echo ', 'RELAY-OK"', ',"description":"print"}']
    const events = runStream(
      [
        { type: 'response.created', response: { id: 'resp_tool' } },
        {
          type: 'response.output_item.added',
          item: { type: 'function_call', call_id: 'call_YV2a', name: 'Bash' }
        },
        ...argumentChunks.map((delta) => ({
          type: 'response.function_call_arguments.delta',
          delta
        })),
        {
          type: 'response.function_call_arguments.done',
          arguments: argumentChunks.join('')
        },
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'call_YV2a',
            name: 'Bash',
            arguments: argumentChunks.join('')
          }
        },
        {
          type: 'response.completed',
          response: { id: 'resp_tool', status: 'completed', usage: { output_tokens: 28 } }
        }
      ],
      'gpt-5.6-sol'
    )

    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    expect(events[1].data.content_block).toEqual({
      type: 'tool_use',
      id: 'call_YV2a',
      name: 'Bash',
      input: {}
    })

    const partialJson = events
      .filter((e) => e.data.delta?.type === 'input_json_delta')
      .map((e) => e.data.delta.partial_json)
      .join('')
    expect(partialJson).toBe('{"command":"echo RELAY-OK","description":"print"}')
    expect(JSON.parse(partialJson)).toEqual({ command: 'echo RELAY-OK', description: 'print' })
    expect(events[7].data.delta.stop_reason).toBe('tool_use')
  })

  test('handles a Grok-style stream: reasoning summary dropped, single argument delta', () => {
    const events = runStream(
      [
        { type: 'response.created', response: { id: 'resp_grok' } },
        { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1' } },
        { type: 'response.reasoning_summary_part.added', part: { type: 'summary_text' } },
        { type: 'response.reasoning_summary_text.delta', delta: 'The user wants me to run' },
        { type: 'response.reasoning_summary_text.done', text: 'The user wants me to run' },
        { type: 'response.reasoning_summary_part.done', part: { type: 'summary_text' } },
        { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1' } },
        {
          type: 'response.output_item.added',
          item: { type: 'function_call', call_id: 'call-d211', name: 'Bash' }
        },
        {
          type: 'response.function_call_arguments.delta',
          delta: '{"command":"echo RELAY-OK"}'
        },
        {
          type: 'response.function_call_arguments.done',
          arguments: '{"command":"echo RELAY-OK"}'
        },
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'call-d211',
            name: 'Bash',
            arguments: '{"command":"echo RELAY-OK"}'
          }
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp_grok',
            status: 'completed',
            model: 'grok-4.5-build',
            usage: { input_tokens: 214, input_tokens_details: { cached_tokens: 128 } }
          }
        }
      ],
      'grok-4.5'
    )

    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    // 不下发 thinking block（plan 2972 假设 3 未验证）
    expect(events.some((e) => JSON.stringify(e.data).includes('thinking'))).toBe(false)
    // 上游把 model 改写成 grok-4.5-build，客户端仍看到请求侧的 grok-4.5
    expect(events[0].data.message.model).toBe('grok-4.5')
    expect(events[2].data.delta).toEqual({
      type: 'input_json_delta',
      partial_json: '{"command":"echo RELAY-OK"}'
    })
    expect(events[4].data.delta.stop_reason).toBe('tool_use')
  })

  test('falls back to the done event when no argument delta arrives', () => {
    const events = runStream(
      [
        { type: 'response.created', response: { id: 'resp_x' } },
        {
          type: 'response.output_item.added',
          item: { type: 'function_call', call_id: 'call_1', name: 'Bash' }
        },
        { type: 'response.function_call_arguments.done', arguments: '{"command":"ls"}' },
        {
          type: 'response.output_item.done',
          item: { type: 'function_call', call_id: 'call_1', name: 'Bash' }
        },
        { type: 'response.completed', response: { id: 'resp_x', status: 'completed' } }
      ],
      'gpt-5.6-sol'
    )

    const deltas = events.filter((e) => e.event === 'content_block_delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0].data.delta.partial_json).toBe('{"command":"ls"}')
  })

  test('maps incomplete responses to max_tokens and closes an empty stream', () => {
    const events = runStream(
      [
        { type: 'response.created', response: { id: 'resp_i' } },
        {
          type: 'response.incomplete',
          response: {
            id: 'resp_i',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 10, output_tokens: 5 }
          }
        }
      ],
      'gpt-5.6-sol'
    )

    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    expect(events[3].data.delta.stop_reason).toBe('max_tokens')
  })

  test('finalizes a truncated upstream stream with message_stop', () => {
    const events = runStream(
      [
        { type: 'response.created', response: { id: 'resp_cut' } },
        { type: 'response.output_text.delta', delta: 'partial' }
      ],
      'gpt-5.6-sol'
    )

    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    expect(events[4].data.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  test('emits an Anthropic error event on a failed response', () => {
    const events = runStream(
      [
        { type: 'response.created', response: { id: 'resp_f' } },
        {
          type: 'response.failed',
          response: { id: 'resp_f', status: 'failed', error: { message: 'upstream exploded' } }
        },
        { type: 'response.output_text.delta', delta: 'ignored' }
      ],
      'gpt-5.6-sol'
    )

    expect(events.map((e) => e.event)).toEqual(['message_start', 'error'])
    expect(events[1].data).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'upstream exploded' }
    })
  })
})

describe('anthropicToResponses non-stream converter', () => {
  test('converts a response.completed payload into an Anthropic message', () => {
    const message = convertResponseToAnthropic(
      {
        type: 'response.completed',
        response: {
          id: 'resp_ns',
          status: 'completed',
          model: 'grok-4.5-build',
          output: [
            { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking...' }] },
            { type: 'message', content: [{ type: 'output_text', text: 'RELAY-OK' }] },
            {
              type: 'function_call',
              call_id: 'call-1',
              name: 'Bash',
              arguments: '{"command":"echo RELAY-OK"}'
            }
          ],
          usage: {
            input_tokens: 340,
            input_tokens_details: { cached_tokens: 256 },
            output_tokens: 80
          }
        }
      },
      { model: 'grok-4.5' }
    )

    expect(message).toEqual({
      id: 'msg_resp_ns',
      type: 'message',
      role: 'assistant',
      model: 'grok-4.5',
      content: [
        { type: 'text', text: 'RELAY-OK' },
        { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'echo RELAY-OK' } }
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 84, output_tokens: 80, cache_read_input_tokens: 256 }
    })
  })

  test('converts a bare response object and keeps content non-empty', () => {
    const message = convertResponseToAnthropic(
      { object: 'response', id: 'resp_empty', status: 'completed', output: [] },
      { model: 'gpt-5.6-sol' }
    )

    expect(message.content).toEqual([{ type: 'text', text: '' }])
    expect(message.stop_reason).toBe('end_turn')
  })

  test('converts a failed response into an error envelope', () => {
    expect(convertResponseToAnthropic({ status: 'failed', error: { message: 'nope' } })).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'nope' }
    })
  })
})

describe('anthropicToResponses error envelope and token estimate', () => {
  test('maps upstream status codes to Anthropic error types', () => {
    expect(buildErrorEnvelope(403, { error: { message: 'no openai permission' } })).toEqual({
      type: 'error',
      error: { type: 'permission_error', message: 'no openai permission' }
    })
    expect(buildErrorEnvelope(429, { error: { type: 'usage_limit_reached' } }).error.type).toBe(
      'rate_limit_error'
    )
    expect(buildErrorEnvelope(400, { detail: "The 'grok-4.5' model is not supported" })).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: "The 'grok-4.5' model is not supported"
      }
    })
    expect(buildErrorEnvelope(502, null).error).toEqual({
      type: 'api_error',
      message: 'Upstream request failed'
    })
  })

  test('estimates input tokens from system, messages and tools', () => {
    const estimate = estimateInputTokens({
      system: 'a'.repeat(400),
      messages: [
        { role: 'user', content: 'b'.repeat(200) },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'c'.repeat(100) },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }
          ]
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'd'.repeat(40) }]
        }
      ],
      tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }]
    })

    expect(estimate).toBeGreaterThan(180)
    expect(estimateInputTokens({})).toBe(1)
  })
})

describe('anthropicToResponses bridge entry', () => {
  function createFakeRes() {
    const captured = { chunks: [], json: null, ended: false }
    const res = {
      statusCode: 200,
      status(code) {
        res.statusCode = code
        return res
      },
      write(chunk) {
        captured.chunks.push(chunk.toString())
        return true
      },
      end(chunk) {
        if (chunk) {
          captured.chunks.push(chunk.toString())
        }
        captured.ended = true
        return res
      },
      json(data) {
        captured.json = data
        return res
      }
    }
    return { res, captured }
  }

  const DEFAULT_TEST_USER_ID = JSON.stringify({
    device_id: 'device-default',
    account_uuid: 'acc-default',
    session_id: 'session-default'
  })

  // 默认带一个合法的 metadata.user_id，模拟真实 Claude Code 流量；显式 400 场景/
  // 自定义 session id 场景通过传自己的 metadata 覆盖它。
  function createFakeReq(body, headers = {}) {
    return {
      body: { metadata: { user_id: DEFAULT_TEST_USER_ID }, ...body },
      headers: { 'user-agent': 'claude-cli/2.0.0', ...headers }
    }
  }

  function parseSSE(text) {
    return text
      .split('\n\n')
      .filter((block) => block.trim())
      .map((block) => {
        const lines = block.split('\n')
        if (lines[0].startsWith(':')) {
          return { event: 'comment', data: lines[0] }
        }
        return {
          event: lines[0].replace('event: ', ''),
          data: JSON.parse(lines[1].replace('data: ', ''))
        }
      })
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('converts the request, rewrites the route and streams Anthropic SSE back', async () => {
    const upstreamChunks = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      ': heartbeat\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.del',
      'ta","delta":"RELAY-OK"}\n\nevent: response.completed\ndata: {"type":"response.completed",',
      '"response":{"id":"resp_1","status":"completed","usage":{"input_tokens":105,"output_tokens":8}}}\n\n'
    ]
    openaiRoutes.handleResponses.mockImplementation(async (req, res) => {
      for (const chunk of upstreamChunks) {
        res.write(chunk)
      }
      res.end()
    })

    const req = createFakeReq({
      model: 'gpt-5.6-sol',
      stream: true,
      max_tokens: 64,
      system: 'You are Claude Code.',
      messages: [{ role: 'user', content: 'say RELAY-OK' }]
    })
    const { res, captured } = createFakeRes()

    await handleAnthropicToResponses(req, res, 'codex')

    // 请求侧：body 转成 Responses 格式，路径与标志同步改写
    expect(req.url).toBe('/v1/responses')
    expect(req._fromUnifiedEndpoint).toBe(true)
    expect(req._skipCodexModelNormalization).toBe(true)
    expect(req.body.instructions).toBe('You are Claude Code.')
    expect(req.body.input).toHaveLength(1)
    expect(req.headers['accept']).toBe('text/event-stream')
    // 注入 session id（取自 metadata.user_id），恢复 Claude Code 客户端缺失的粘性会话
    expect(req.headers['session_id']).toBe('session-default')
    // 同一个 session id 也写进 body 的 prompt_cache_key，恢复上游缓存路由
    expect(req.body.prompt_cache_key).toBe(req.headers['session_id'])
    expect(req.headers['x-grok-client-version']).toBeUndefined()

    const events = parseSSE(captured.chunks.join(''))
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'comment',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    expect(events[3].data.delta.text).toBe('RELAY-OK')
    expect(events[5].data.usage).toEqual({ input_tokens: 105, output_tokens: 8 })
    expect(captured.ended).toBe(true)
  })

  test('keeps multi-byte characters intact when Buffer chunks split them', async () => {
    // 上游 chunk 边界由 TLS/TCP 分片决定，可能劈开一个 UTF-8 字符；正文和 tool 参数都不能被改写
    const upstream = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_cjk"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好世界"}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"Bash"}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"command\\":\\"echo 你好\\"}"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"Bash"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_cjk","status":"completed","usage":{"input_tokens":10,"output_tokens":4}}}\n\n'
    ].join('')

    const runWith = async (chunks) => {
      openaiRoutes.handleResponses.mockImplementation(async (req, res) => {
        for (const chunk of chunks) {
          res.write(chunk)
        }
        res.end()
      })
      const req = createFakeReq({
        model: 'gpt-5.6-sol',
        stream: true,
        messages: [{ role: 'user', content: '你好' }]
      })
      const { res, captured } = createFakeRes()
      await handleAnthropicToResponses(req, res, 'codex')
      return parseSSE(captured.chunks.join(''))
    }

    const whole = await runWith([upstream])
    // 逐字节 Buffer：每个多字节字符必然跨 chunk
    const byteSplit = await runWith(
      [...Buffer.from(upstream, 'utf8')].map((byte) => Buffer.from([byte]))
    )

    expect(byteSplit).toEqual(whole)
    expect(byteSplit.find((e) => e.data.delta?.type === 'text_delta').data.delta.text).toBe(
      '你好世界'
    )
    const args = byteSplit
      .filter((e) => e.data.delta?.type === 'input_json_delta')
      .map((e) => e.data.delta.partial_json)
      .join('')
    expect(JSON.parse(args)).toEqual({ command: 'echo 你好' })
  })

  test('normalizes [1m] upstream while echoing the requested model in the stream', async () => {
    openaiRoutes.handleResponses.mockImplementation(async (req, res) => {
      res.write(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1m"}}\n\n'
      )
      res.write(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"RELAY-OK"}\n\n'
      )
      res.write(
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1m","status":"completed","usage":{"input_tokens":9,"output_tokens":2}}}\n\n'
      )
      res.end()
    })

    const req = createFakeReq({
      model: 'gpt-5.6-sol[1m]',
      stream: true,
      messages: [{ role: 'user', content: 'say RELAY-OK' }]
    })
    const { res, captured } = createFakeRes()

    await handleAnthropicToResponses(req, res, 'codex')

    // 上游请求 + usage 归属用真实模型（handleResponses 之后读的就是这个 req.body.model）
    expect(req.body.model).toBe('gpt-5.6-sol')

    // 客户端侧仍然是它请求的那个 id，保持 Claude Code 的请求/响应模型一致
    const events = parseSSE(captured.chunks.join(''))
    expect(events[0].event).toBe('message_start')
    expect(events[0].data.message.model).toBe('gpt-5.6-sol[1m]')
  })

  test('normalizes [1m] upstream while echoing the requested model in a non-stream reply', async () => {
    openaiRoutes.handleResponses.mockImplementation(async (req, res) =>
      res.json({
        object: 'response',
        id: 'resp_ns_1m',
        status: 'completed',
        // 上游回显的是它自己的模型名，不能覆盖客户端请求的 id
        model: 'gpt-5.6-sol',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'RELAY-OK' }] }],
        usage: { input_tokens: 12, output_tokens: 3 }
      })
    )

    const req = createFakeReq({
      model: 'gpt-5.6-sol[1m]',
      stream: false,
      messages: [{ role: 'user', content: 'say RELAY-OK' }]
    })
    const { res, captured } = createFakeRes()

    await handleAnthropicToResponses(req, res, 'codex')

    expect(req.body.model).toBe('gpt-5.6-sol')
    expect(captured.json).toMatchObject({
      type: 'message',
      model: 'gpt-5.6-sol[1m]',
      content: [{ type: 'text', text: 'RELAY-OK' }]
    })
  })

  test('injects grok client headers on the grok mount', async () => {
    openaiRoutes.handleResponses.mockImplementation(async (req, res) => res.end())

    const req = createFakeReq({
      model: 'grok-4.5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }]
    })
    const { res } = createFakeRes()

    await handleAnthropicToResponses(req, res, 'grok')

    expect(req.headers['x-grok-client-version']).toBe('0.2.101')
    expect(req.headers['x-grok-client-identifier']).toBe('grok-shell')
    expect(req.headers['x-grok-model-override']).toBe('grok-4.5')
    // grok arm gets prompt_cache_key too, not just codex
    expect(req.body.prompt_cache_key).toBe(req.headers['session_id'])
  })

  test('prompt_cache_key stays stable across a growing conversation in the same Claude Code session', async () => {
    openaiRoutes.handleResponses.mockImplementation(async (req, res) => res.end())
    const userId = JSON.stringify({
      device_id: 'device-1',
      account_uuid: 'acc-1',
      session_id: 'sess-stable-1'
    })

    const turn1 = createFakeReq({
      model: 'gpt-5.6-sol',
      stream: true,
      metadata: { user_id: userId },
      messages: [{ role: 'user', content: 'hi' }]
    })
    const { res: res1 } = createFakeRes()
    await handleAnthropicToResponses(turn1, res1, 'codex')

    const turn2 = createFakeReq({
      model: 'gpt-5.6-sol',
      stream: true,
      metadata: { user_id: userId },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'now with a much longer follow-up message that grows the prefix' }
      ]
    })
    const { res: res2 } = createFakeRes()
    await handleAnthropicToResponses(turn2, res2, 'codex')

    expect(turn1.body.prompt_cache_key).toBe('sess-stable-1')
    expect(turn2.body.prompt_cache_key).toBe('sess-stable-1')
    expect(turn1.body.prompt_cache_key).toBe(turn2.body.prompt_cache_key)
  })

  test('prefers an explicit x-session-id header over the computed session hash', async () => {
    openaiRoutes.handleResponses.mockImplementation(async (req, res) => res.end())

    const req = createFakeReq(
      {
        model: 'grok-4.5',
        stream: true,
        metadata: { user_id: JSON.stringify({ device_id: 'd', session_id: 'from-body' }) },
        messages: [{ role: 'user', content: 'hi' }]
      },
      { 'x-session-id': 'chat-external-id-123' }
    )
    const { res } = createFakeRes()

    await handleAnthropicToResponses(req, res, 'grok')

    expect(req.headers['session_id']).toBe('chat-external-id-123')
    expect(req.body.prompt_cache_key).toBe('chat-external-id-123')
  })

  test('rejects with a 400 Anthropic envelope when neither x-session-id nor metadata.user_id is present', async () => {
    const req = createFakeReq({
      metadata: undefined,
      model: 'gpt-5.6-sol',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }]
    })
    const { res, captured } = createFakeRes()

    await handleAnthropicToResponses(req, res, 'codex')

    expect(openaiRoutes.handleResponses).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(400)
    expect(captured.json).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: expect.stringContaining('Missing stable session id')
      }
    })
  })

  test('rejects with a 400 when metadata.user_id is present but unparseable', async () => {
    const req = createFakeReq({
      metadata: { user_id: 'not-a-recognized-format' },
      model: 'grok-4.5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }]
    })
    const { res, captured } = createFakeRes()

    await handleAnthropicToResponses(req, res, 'grok')

    expect(openaiRoutes.handleResponses).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(400)
    expect(captured.json.error.type).toBe('invalid_request_error')
  })

  test('rejects an explicit x-session-id that does not match the conservative charset/length, falling back to metadata.user_id', async () => {
    const req = createFakeReq(
      {
        model: 'gpt-5.6-sol',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }]
      },
      { 'x-session-id': 'not valid! header value\r\ninjected' }
    )
    const { res } = createFakeRes()
    openaiRoutes.handleResponses.mockImplementation(async (r, s) => s.end())

    await handleAnthropicToResponses(req, res, 'codex')

    // 无效的显式头被忽略，落回 metadata.user_id（本例中是 createFakeReq 的默认值）
    expect(req.headers['session_id']).toBe('session-default')
  })

  test('the grok model override header carries the normalized upstream model', async () => {
    openaiRoutes.handleResponses.mockImplementation(async (req, res) => res.end())

    const req = createFakeReq({
      model: 'grok-4.5[1m]',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }]
    })
    const { res } = createFakeRes()

    await handleAnthropicToResponses(req, res, 'grok')

    expect(req.headers['x-grok-model-override']).toBe('grok-4.5')
    expect(req.body.model).toBe('grok-4.5')
  })

  test('converts a non-stream JSON response into an Anthropic message', async () => {
    openaiRoutes.handleResponses.mockImplementation(async (req, res) =>
      res.json({
        object: 'response',
        id: 'resp_ns',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'RELAY-OK' }] }],
        usage: { input_tokens: 12, output_tokens: 3 }
      })
    )

    const req = createFakeReq({
      model: 'gpt-5.6-sol',
      stream: false,
      messages: [{ role: 'user', content: 'say RELAY-OK' }]
    })
    const { res, captured } = createFakeRes()

    await handleAnthropicToResponses(req, res, 'codex')

    expect(req.body.stream).toBe(false)
    expect(req.headers['accept']).toBe('application/json')
    expect(captured.json).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'gpt-5.6-sol',
      content: [{ type: 'text', text: 'RELAY-OK' }],
      stop_reason: 'end_turn'
    })
  })

  test('wraps upstream errors in the Anthropic error envelope', async () => {
    openaiRoutes.handleResponses.mockImplementation(async (req, res) => {
      res.statusCode = 403
      return res.json({
        error: {
          message: 'This API key does not have permission to access OpenAI',
          type: 'permission_denied'
        }
      })
    })

    const req = createFakeReq({
      model: 'gpt-5.6-sol',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }]
    })
    const { res, captured } = createFakeRes()

    await handleAnthropicToResponses(req, res, 'codex')

    expect(captured.json).toEqual({
      type: 'error',
      error: {
        type: 'permission_error',
        message: 'This API key does not have permission to access OpenAI'
      }
    })
  })

  test('converts a streamed 429 error body into an Anthropic error envelope', async () => {
    openaiRoutes.handleResponses.mockImplementation(async (req, res) => {
      res.statusCode = 429
      res.write(
        'data: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}\n\n'
      )
      res.end()
    })

    const req = createFakeReq({
      model: 'gpt-5.6-sol',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }]
    })
    const { res, captured } = createFakeRes()

    await handleAnthropicToResponses(req, res, 'codex')

    // 状态码非 2xx 时客户端把整个 body 当 JSON 读，所以写裸信封而不是 SSE 帧
    expect(JSON.parse(captured.chunks.join(''))).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'The usage limit has been reached' }
    })
  })

  test('converts a bare JSON error body on a streaming request', async () => {
    openaiRoutes.handleResponses.mockImplementation(async (req, res) => {
      res.statusCode = 400
      res.write('{"detail":"The \'grok-4.5\' model is not supported"}')
      res.end()
    })

    const req = createFakeReq({
      model: 'grok-4.5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }]
    })
    const { res, captured } = createFakeRes()

    await handleAnthropicToResponses(req, res, 'grok')

    expect(JSON.parse(captured.chunks.join(''))).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: "The 'grok-4.5' model is not supported"
      }
    })
  })
})
