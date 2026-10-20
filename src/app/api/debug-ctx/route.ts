import { NextResponse } from 'next/server'

export function GET() {
  const SYMBOL = Symbol.for('@vercel/request-context')
  const ctx = (globalThis as any)?.[SYMBOL]?.get?.() ?? null
  
  // Get the exact type and value of upgradeWebSocket
  const wsVal = ctx?.upgradeWebSocket
  const wsType = typeof wsVal
  
  // Get the function platform from headers
  const headers = ctx?.headers || {}
  const platform = headers['x-vercel-function-platform'] || headers['x-vercel-sc-headers'] || ''
  
  return NextResponse.json({
    hasUpgradeWebSocketKey: ctx ? 'upgradeWebSocket' in ctx : false,
    upgradeWebSocketType: wsType,
    upgradeWebSocketValue: wsVal === null ? 'null' : wsVal === undefined ? 'undefined' : String(wsVal).slice(0, 200),
    upgradeWebSocketTruthy: !!wsVal,
    platform: typeof platform === 'string' ? platform.slice(0, 200) : JSON.stringify(platform).slice(0, 200),
    allContextEntries: ctx ? Object.entries(ctx).map(([k, v]) => ({ key: k, type: typeof v, truthy: !!v })) : [],
  })
}
