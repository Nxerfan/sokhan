/**
 * Payment gateway factory + adapter index.
 *
 * Usage:
 *   import { getGateway } from '@/lib/payments'
 *   const gw = getGateway('zarinpal')
 *   const { authority, gatewayUrl } = await gw.createPayment({ ... })
 */

import type { GatewayName } from './types'
import { ZarinpalAdapter } from './zarinpal'
import { IdpayAdapter } from './idpay'
import { ZarinlinkAdapter } from './zarinlink'

export type { PaymentGateway, GatewayName } from './types'
export { ZarinpalAdapter } from './zarinpal'
export { IdpayAdapter } from './idpay'
export { ZarinlinkAdapter } from './zarinlink'

const ADAPTERS = {
  zarinpal: () => new ZarinpalAdapter(),
  idpay: () => new IdpayAdapter(),
  zarinlink: () => new ZarinlinkAdapter(),
} as const

const VALID_GATEWAYS = new Set<GatewayName>(['zarinpal', 'idpay', 'zarinlink'])

export function isValidGateway(name: string): name is GatewayName {
  return VALID_GATEWAYS.has(name as GatewayName)
}

export function getGateway(name: GatewayName) {
  const factory = ADAPTERS[name]
  if (!factory) throw new Error(`Unknown payment gateway: ${name}`)
  return factory()
}

/** Returns true if all configured gateways are running in test mode. */
export function allGatewaysInTestMode(): boolean {
  return (['zarinpal', 'idpay', 'zarinlink'] as const).every((name) => getGateway(name).testMode)
}
