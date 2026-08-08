/**
 * Unified payment gateway interface.
 *
 * All Iran-first gateways (ZarinPal, IDPay, ZarinLink) implement this. Each
 * adapter has a `testMode` flag that, when true, simulates the payment flow
 * without making real HTTP calls — returns a fake authority and a mock gateway
 * URL, and `verifyPayment` always succeeds with a fake refId.
 *
 * Prices are in Toman (IRR). The adapter does NOT convert currencies.
 */

export type GatewayName = 'zarinpal' | 'idpay' | 'zarinlink'

export interface CreatePaymentInput {
  /** Amount in Toman (IRR). */
  amount: number
  description: string
  callbackUrl: string
  /** Optional mobile number (used by ZarinPal + IDPay for SMS receipts). */
  mobile?: string
  /** Optional order id (used by IDPay). */
  orderId?: string
}

export interface CreatePaymentResult {
  /** Gateway token (Authority for ZarinPal, track_id for IDPay, token for ZarinLink). */
  authority: string
  /** URL the client should redirect to in order to complete payment. */
  gatewayUrl: string
}

export interface VerifyPaymentInput {
  authority: string
  /** Amount in Toman — used by the gateway to confirm the amount matches. */
  amount: number
}

export interface VerifyPaymentResult {
  success: boolean
  /** Gateway reference id (refId / transaction_id). Present on success. */
  refId?: string
  message?: string
}

export interface PaymentGateway {
  name: GatewayName
  /** When true, simulate the flow without real HTTP calls. */
  testMode: boolean
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>
  verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult>
}
