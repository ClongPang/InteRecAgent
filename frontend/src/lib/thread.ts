import type { ThreadMessage } from '../api/types'

export type ThreadBlock =
  | { key: string; kind: 'single'; message: ThreadMessage }
  | { key: string; kind: 'changes'; messages: ThreadMessage[] }

export function groupThread(messages: ThreadMessage[]): ThreadBlock[] {
  const blocks: ThreadBlock[] = []
  let pending: ThreadMessage[] | null = null
  for (const message of messages) {
    if (message.kind === 'change') {
      pending ??= []
      pending.push(message)
      continue
    }
    if (pending) {
      blocks.push({ key: `changes-${pending[0].sequence}`, kind: 'changes', messages: pending })
      pending = null
    }
    blocks.push({ key: `${message.kind}-${message.sequence}`, kind: 'single', message })
  }
  if (pending) blocks.push({ key: `changes-${pending[0].sequence}`, kind: 'changes', messages: pending })
  return blocks
}

export function lastUndoableChange(messages: ThreadMessage[]): ThreadMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.kind === 'change' && message.change_kind === 'constraints') return message
  }
  return null
}
