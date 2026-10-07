/**
 * IDPay payment gateway adapter.
 *
 * Production endpoints:
 *   create:  POST https://api.idpay.ir/v1.4/payment
 *   verify:  POST https://api.idpay.ir/v1.4/payment/verify
 *   redirect: https://idpay.ir/p/{id}
 *
 * The API key comes from env: `IDPAY_API_KEY`. If not set, the adapter falls
 * back to a fully simulated test mode (no real API calls).
 *
 * IDPay returns:
 *   create → { id, link, ... } where `id` is the invoice id (we store as
 *            authority) and `link` is the redirect URL.
 *   verify → { status, track_id, ... } where status 100 = verified.
 */

import type {
  PaymentGateway,
  CreatePaymentInput,
  CreatePaymentResult,
  VerifyPaymentInput,
  VerifyPaymentResult,
  GatewayName,
  CallbackResult,
} from './types'

const API_BASE = 'https://api.idpay.ir/v1.4'
const START_PAY_BASE = 'https://idpay.ir/p'

export interface IdpayOptions {
  apiKey?: string
  sandbox?: boolean
  testMode?: boolean
}

export class IdpayAdapter implements PaymentGateway {
  name: GatewayName = 'idpay'
  testMode: boolean
  private apiKey: string
  private sandbox: boolean

  constructor(opts: IdpayOptions = {}) {
    const envKey = process.env.IDPAY_API_KEY
    const envSandbox = process.env.IDPAY_SANDBOX === 'true' ? true : undefined

    this.apiKey = opts.apiKey ?? envKey ?? ''
    this.sandbox = opts.sandbox ?? envSandbox ?? !envKey
    this.testMode = opts.testMode ?? !envKey
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (this.testMode) {
      const fakeId = `TEST-IDP-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      return {
        authority: fakeId,
        gatewayUrl: `${START_PAY_BASE}/${fakeId}?test=1`,
      }
    }

    const body = {
      order_id: input.orderId ?? `order-${Date.now()}`,
      amount: input.amount,
      name: undefined,
      phone: input.mobile,
      mail: undefined,
      desc: input.description,
      callback: input.callbackUrl,
      ...(this.sandbox ? { sandbox: true } : {}),
    }

    const res = await fetch(`${API_BASE}/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': this.apiKey,
        'X-SANDBOX': this.sandbox ? '1' : '0',
      },
      body: JSON.stringify(body),
    })

    const json = await res.json()
    if (!json?.id || !json?.link) {
      throw new Error(`IDPay createPayment failed: ${JSON.stringify(json)}`)
    }

    return {
      authority: String(json.id),
      gatewayUrl: String(json.link),
    }
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    if (this.testMode) {
      return {
        success: true,
        refId: `TEST-IDP-REF-${Date.now()}`,
        message: 'test mode: simulated success',
      }
    }

    const res = await fetch(`${API_BASE}/payment/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': this.apiKey,
        'X-SANDBOX': this.sandbox ? '1' : '0',
      },
      body: JSON.stringify({
        id: input.authority,
        order_id: `order-${input.authority}`,
      }),
    })

    const json = await res.json()
    // status 100 = verified
    if (json?.status === 100 || json?.status === 101) {
      return {
        success: true,
        refId: json.track_id ? String(json.track_id) : input.authority,
      }
    }

    return {
      success: false,
      message: json?.error_message || `IDPay verify failed (status ${json?.status ?? 'n/a'})`,
    }
  }

  /**
   * Parse the IDPay callback query string.
   *   status=10 -> user cancelled.
   *   id (authority) present -> success_candidate (must verify).
   *   Otherwise -> invalid.
   */
  parseCallback(query: URLSearchParams): CallbackResult {
    const status = query.get('status')
    if (status === '10') {
      return { kind: 'canceled' }
    }
    const id = query.get('id') ?? query.get('track_id')
    if (!id && !status) {
      return { kind: 'invalid', reasonCode: 'missing_id_and_status' }
    }
    return { kind: 'success_candidate', authority: id ?? undefined }
  }
}
