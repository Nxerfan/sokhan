import { experimental_upgradeWebSocket } from '@vercel/functions'
import type { WebSocket } from 'ws'

/**
 * Minimal App Router WebSocket probe — verifies that Vercel's
 * experimental_upgradeWebSocket API works for Next.js App Router.
 *
 * Pattern from: https://vercel.com/docs/functions/websockets
 *
 * The route handles the HTTP GET request that upgrades to a WebSocket
 * connection. The handler receives a raw `ws` WebSocket instance.
 */
export function GET() {
  return experimental_upgradeWebSocket((ws: WebSocket) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket probe connected' }))
    })

    ws.on('message', (data) => {
      const text = data.toString()
      // Echo the message back
      ws.send(JSON.stringify({ type: 'echo', message: text }))
    })

    ws.on('close', () => {
      // Connection closed
    })

    ws.on('error', () => {
      // Error occurred
    })
  })
}
