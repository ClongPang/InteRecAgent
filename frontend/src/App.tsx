import { AuthScreen } from './components/AuthScreen'
import { ConversationPane } from './components/ConversationPane'
import { QuotePane } from './components/QuotePane'
import { useQuoteConversation } from './conversation/use-quote-conversation'
import './styles.css'

export default function App() {
  const conversation = useQuoteConversation()
  const { token, tokenDraft, quote, running } = conversation

  if (!token) {
    return (
      <AuthScreen
        tokenDraft={tokenDraft}
        onTokenDraftChange={conversation.setTokenDraft}
        onConnect={conversation.connect}
      />
    )
  }

  return (
    <main className="app-shell quote-app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">BQ</span>
          <div>
            <b>BuyWhere 报价助手</b>
            <small>新加坡 · 已知型号 · 报价线索</small>
          </div>
        </div>
        <div className="top-actions">
          <span className="connection-dot">已连接</span>
          <button onClick={conversation.startNew}>新对话</button>
        </div>
      </header>

      <section className="quote-scope-bar" aria-label="服务边界">
        <span className="goal-label">固定范围</span>
        <span className="condition-chip">新加坡市场</span>
        <span className="condition-chip">准确型号</span>
        <span className="condition-chip">报价线索 + 商家页确认</span>
        {quote?.target && (
          <span className="condition-chip target-chip">{quote.target.canonicalModel}</span>
        )}
        {quote?.pendingTargetConfirmation && (
          <button
            className="condition-chip pending"
            disabled={running}
            onClick={() => void conversation.sendMessage(
              `确认，准确型号是 ${quote.pendingTargetConfirmation!.proposal.proposedModel}。`,
            )}
          >
            确认型号：{quote.pendingTargetConfirmation.proposal.proposedModel}
          </button>
        )}
      </section>

      <div className="workspace">
        <ConversationPane conversation={conversation} />
        <QuotePane conversation={conversation} />
      </div>
    </main>
  )
}
