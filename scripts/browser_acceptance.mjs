import fs from 'node:fs'
import path from 'node:path'

const cdpPort = Number(process.argv[2] || 9222)
const appUrl = process.argv[3] || 'http://127.0.0.1:5173/'
const ownerId = process.argv[4] || 'e2e00000-0000-4000-8000-000000000001'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function pause(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function createTarget() {
  const endpoint = `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent('about:blank')}`
  const response = await fetch(endpoint, { method: 'PUT' })
  assert(response.ok, `cannot create browser target: HTTP ${response.status}`)
  return response.json()
}

class Cdp {
  constructor(url) {
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    this.socket = new WebSocket(url)
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', reject, { once: true })
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id) {
        const waiter = this.pending.get(message.id)
        if (!waiter) return
        this.pending.delete(message.id)
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
        else waiter.resolve(message.result)
        return
      }
      this.events.push(message)
    })
  }

  call(method, params = {}) {
    const id = this.nextId++
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  close() {
    this.socket.close()
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'browser evaluation failed')
  }
  return result.result.value
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return
    await pause(500)
  }
  throw new Error(`timeout waiting for ${label}`)
}

async function main() {
  const target = await createTarget()
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.open()
  try {
    await Promise.all([
      cdp.call('Page.enable'),
      cdp.call('Runtime.enable'),
      cdp.call('Network.enable'),
    ])
    await cdp.call('Page.navigate', { url: appUrl })
    await waitFor(cdp, "document.readyState === 'complete'", 15_000, 'initial page load')
    await evaluate(
      cdp,
      `localStorage.setItem('interecagent.anonymousUserId', ${JSON.stringify(ownerId)}); location.reload(); true`,
    )
    await waitFor(
      cdp,
      "Boolean(document.querySelector('textarea[aria-label=\"描述购物需求\"]'))",
      15_000,
      'shopping composer',
    )

    const initial = await evaluate(
      cdp,
      `({ title: document.title, body: document.body.innerText, url: location.href })`,
    )
    assert(initial.body.includes('开始选购'), 'home page did not render the shopping entry point')

    await evaluate(
      cdp,
      `(() => {
        const input = document.querySelector('textarea[aria-label="描述购物需求"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, '通勤降噪耳机，预算 4000 元，优先续航');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.closest('form').requestSubmit();
        return true;
      })()`,
    )
    await waitFor(cdp, "location.pathname.startsWith('/missions/')", 20_000, 'mission navigation')
    await waitFor(
      cdp,
      "document.querySelectorAll('.product-card').length > 0 || document.body.innerText.includes('需要确认')",
      180_000,
      'recommendation or explicit clarification',
    )

    const result = await evaluate(
      cdp,
      `({
        url: location.href,
        missionId: location.pathname.split('/')[2],
        body: document.body.innerText,
        products: [...document.querySelectorAll('.product-card .product-title')].map((node) => node.textContent.trim()),
        cards: document.querySelectorAll('.product-card').length,
      })`,
    )
    assert(!result.body.includes('创建选购失败'), 'UI reported mission creation failure')
    assert(!result.body.includes('打不开这笔选购'), 'UI could not reopen the created mission')
    assert(result.cards > 0, 'real browser flow produced no product candidate cards')
    assert(result.products.every(Boolean), 'a candidate card has no product title')

    const protocolFailures = cdp.events.filter(
      (event) => event.method === 'Network.loadingFailed' && !event.params?.canceled,
    )
    const exceptions = cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown')
    assert(protocolFailures.length === 0, `network failures: ${JSON.stringify(protocolFailures)}`)
    assert(exceptions.length === 0, `browser exceptions: ${JSON.stringify(exceptions)}`)

    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' })
    const artifactDir = path.resolve('.artifacts')
    fs.mkdirSync(artifactDir, { recursive: true })
    const screenshotPath = path.join(artifactDir, 'browser-acceptance.png')
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))

    console.log(JSON.stringify({
      status: 'PASS',
      ownerId,
      missionId: result.missionId,
      cards: result.cards,
      products: result.products,
      screenshot: screenshotPath,
    }, null, 2))
  } finally {
    cdp.close()
  }
}

main().catch((error) => {
  console.error(error.stack || String(error))
  process.exitCode = 1
})
