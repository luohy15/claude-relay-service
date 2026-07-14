const { OpenAIResponsesRelayService } = require('./openaiResponsesRelayService')
const grokAccountService = require('../account/grokAccountService')

// Grok Build (grok.com 订阅 OAuth) 请求走与 openai-responses 完全相同的协议
// （Responses API + Bearer + response.completed 里的 usage），因此直接复用
// OpenAIResponsesRelayService，只替换账户存取服务与记录到 usage 的 accountType。
module.exports = new OpenAIResponsesRelayService({
  accountService: grokAccountService,
  accountType: 'grok'
})
