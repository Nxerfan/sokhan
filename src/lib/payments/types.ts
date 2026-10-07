/**
 * Unified payment provider interface.
 *
 * PR: billing-state-machine-hardening
 *
 * All Iran-first gateways (ZarinPal, IDPay, ZarinLink) + the deterministic
 * test MockProvider implement this. Each adapter has a `testMode` flag that,
 * when true, simulates the payment flow without making real HTTP calls.
 *
 * PR #3 (billing hardening) adds `parseCallback` — provider-specific callback
 * query parsing now lives IN the adapter (not scattered in the callback
 * route). The billing core consumes a normalized `CallbackResult`.
 *
 * Prices are in Toman (IRR). The adapter does NOT convert currencies.
 */

export type GatewayName = 'zarinpal' | 'idpay' | 'zarinlink'

/** Broader provider name — includes the test-only 'mock' provider. */
export type ProviderName = GatewayName | 'mock'

export interface CreatePaymentInput {
  /** Amount in Toman (IRR). Must be > 0. */
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

/**
 * Normalized callback kind. The billing core branches on this — never on
 * provider-specific status strings.
 *
 *   success_candidate -> the user came back from the gateway in a state that
 *     MIGHT be a successful payment; the service must verifyPayment() to
 *     confirm. (The service never trusts this alone — verification is
 *     mandatory.)
 *   canceled -> the user explicitly cancelled at the gateway.
 *   invalid -> malformed callback (missing required params). No state
 *     transition; safe reject.
 */
export type CallbackKind = 'success_candidate' | 'canceled' | 'invalid'

export interface CallbackResult {
  kind: CallbackKind
  /**
   * The authority/token the gateway reports in the callback, if any. The
   * service binds this against the STORED invoice authority where the
   * provider protocol supports it (mismatch -> reject, no state change).
   */
  authority?: string
  /** Bounded machine-readable code for invalid/malformed callbacks. */
  reasonCode?: string
}

/**
 * A payment provider. Extends the original PaymentGateway with
 * `parseCallback` so provider-specific query-string parsing lives in the
 * adapter, not the route.
 */
export interface PaymentProvider {
  name: ProviderName
  /** When true, simulate the flow without real HTTP calls. */
  testMode: boolean
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>
  verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult>
  /** Parse the gateway's callback query params into a normalized kind. */
  parseCallback(query: URLSearchParams): CallbackResult
}

/**
 * Legacy alias for backward compatibility with code that imports
 * `PaymentGateway`. Same shape as PaymentProvider (the original methods) —
 * new code should use PaymentProvider (which adds parseCallback).
 */
export type PaymentGateway = PaymentProvider
