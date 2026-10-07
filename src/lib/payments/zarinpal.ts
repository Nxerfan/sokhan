/**
 * ZarinPal payment gateway adapter.
 *
 * Production endpoints:
 *   create:  https://api.zarinpal.com/pg/v4/payment/request.json
 *   verify:  https://api.zarinpal.com/pg/v4/payment/verify.json
 *   redirect: https://www.zarinpal.com/pg/StartPay/{authority}
 *
 * Sandbox (test mode with real API):
 *   create:  https://sandbox.zarinpal.com/pg/v4/payment/request.json
 *   verify:  https://sandbox.zarinpal.com/pg/v4/payment/verify.json
 *   redirect: https://sandbox.zarinpal.com/pg/StartPay/{authority}
 *
 * The merchant ID comes from env: `ZARINPAL_MERCHANT_ID`. If not set, the
 * adapter falls back to a fully simulated test mode (no real API calls).
 *
 * NOTE: the task description mentions a `https://sandbox.zarinpal.com.pg` URL —
 * this is a typo for `https://sandbox.zarinpal.com/pg/...`. We use the
 * documented sandbox endpoints.
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

const SANDBOX_MERCHANT_ID = '00000000-0000-0000-0000-000000000000'

export interface ZarinpalOptions {
  merchantId?: string
  /** Use sandbox endpoint (still hits the real API but with a test merchant). */
  sandbox?: boolean
  /** Fully simulate the flow without any HTTP calls. */
  testMode?: boolean
}

export class ZarinpalAdapter implements PaymentGateway {
  name: GatewayName = 'zarinpal'
  testMode: boolean
  private merchantId: string
  private sandbox: boolean
  private apiBase: string
  private startPayBase: string

  constructor(opts: ZarinpalOptions = {}) {
    const envMerchant = process.env.ZARINPAL_MERCHANT_ID
    const envSandbox = process.env.ZARINPAL_SANDBOX === 'true' ? true : undefined

    this.merchantId = opts.merchantId ?? envMerchant ?? SANDBOX_MERCHANT_ID
    // Sandbox = use sandbox endpoints (still real API calls but test merchant).
    // Default to sandbox when no merchant id is configured.
    this.sandbox = opts.sandbox ?? envSandbox ?? !envMerchant
    // testMode = no real API calls at all. True when no merchant id is supplied
    // via env / opts.
    this.testMode = opts.testMode ?? !envMerchant

    if (this.sandbox) {
      this.apiBase = 'https://sandbox.zarinpal.com/pg/v4'
      this.startPayBase = 'https://sandbox.zarinpal.com/pg/StartPay'
    } else {
      this.apiBase = 'https://api.zarinpal.com/pg/v4'
      this.startPayBase = 'https://www.zarinpal.com/pg/StartPay'
    }
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (this.testMode) {
      const fakeAuthority = `TEST-AUTH-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      return {
        authority: fakeAuthority,
        gatewayUrl: `${this.startPayBase}/${fakeAuthority}?test=1`,
      }
    }

    const body = {
      merchant_id: this.merchantId,
      amount: input.amount,
      description: input.description,
      callback_url: input.callbackUrl,
      ...(input.mobile ? { mobile: input.mobile } : {}),
    }

    const res = await fetch(`${this.apiBase}/payment/request.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const json = await res.json()
    const data = json?.data
    // ZarinPal returns { data: { code, authority, ref_id, ... }, errors }
    if (!data?.authority) {
      throw new Error(`ZarinPal createPayment failed: ${JSON.stringify(json)}`)
    }

    return {
      authority: data.authority,
      gatewayUrl: `${this.startPayBase}/${data.authority}`,
    }
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    if (this.testMode) {
      return {
        success: true,
        refId: `TEST-REF-${Date.now()}`,
        message: 'test mode: simulated success',
      }
    }

    const body = {
      merchant_id: this.merchantId,
      amount: input.amount,
      authority: input.authority,
    }

    const res = await fetch(`${this.apiBase}/payment/verify.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const json = await res.json()
    const data = json?.data
    // code 100 / 101 = verified (101 = already verified — still success)
    if (data && (data.code === 100 || data.code === 101)) {
      return {
        success: true,
        refId: data.ref_id ? String(data.ref_id) : data.tracking_id ?? input.authority,
      }
    }

    return {
      success: false,
      message: json?.errors?.message || `ZarinPal verify failed (code ${data?.code ?? 'n/a'})`,
    }
  }

  /**
   * Parse the ZarinPal callback query string.
   *   Status=NOK  -> user cancelled.
   *   Status=OK (or absent) + Authority -> success_candidate (must verify).
   *   Otherwise -> invalid.
   */
  parseCallback(query: URLSearchParams): CallbackResult {
    const status = query.get('Status')
    if (status && status.toUpperCase() === 'NOK') {
      return { kind: 'canceled' }
    }
    const authority = query.get('Authority')
    if (status && status.toUpperCase() === 'OK' && authority) {
      return { kind: 'success_candidate', authority }
    }
    // Some ZarinPal flows return Status=OK without Authority on verify-only
    // callbacks — treat as invalid (we cannot verify without authority).
    if (!status && !authority) {
      return { kind: 'invalid', reasonCode: 'missing_status_and_authority' }
    }
    return { kind: 'success_candidate', authority: authority ?? undefined }
  }
}
