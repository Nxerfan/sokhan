/**
 * ZarinLink payment adapter.
 *
 * ZarinLink is a simplified ZarinPal product: the merchant creates a
 * "ZarinLink" in the ZarinPal dashboard and gets a static payment URL. The
 * customer is redirected to that URL with the amount pre-filled (or fixed in
 * the link). There is no API call to create a payment — just a redirect.
 *
 * Verification works the same way as ZarinPal: the gateway redirects back
 * with an Authority + Status query param, and we verify by querying the
 * ZarinPal verify endpoint. For simplicity in test mode, we just simulate
 * success.
 *
 * Env: `ZARINLINK_URL` — the base URL of the ZarinLink (e.g.
 *   https://zarinp.al/xxxxx). If not set, test mode is used.
 *
 * Env: `ZARINPAL_MERCHANT_ID` — used for verify (ZarinLink uses the same
 * verification API as ZarinPal). If not set, verify also runs in test mode.
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

export interface ZarinlinkOptions {
  /** The base ZarinLink URL (e.g. https://zarinp.al/abc123). */
  url?: string
  /** Merchant id for verify (uses ZarinPal's verify endpoint). */
  merchantId?: string
  testMode?: boolean
}

export class ZarinlinkAdapter implements PaymentGateway {
  name: GatewayName = 'zarinlink'
  testMode: boolean
  private url: string | null
  private merchantId: string | null

  constructor(opts: ZarinlinkOptions = {}) {
    const envUrl = process.env.ZARINLINK_URL
    const envMerchant = process.env.ZARINPAL_MERCHANT_ID

    this.url = opts.url ?? envUrl ?? null
    this.merchantId = opts.merchantId ?? envMerchant ?? null
    // testMode if no ZarinLink URL is configured.
    this.testMode = opts.testMode ?? !envUrl
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (this.testMode || !this.url) {
      const fakeAuthority = `TEST-ZL-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      return {
        authority: fakeAuthority,
        gatewayUrl: `${START_PAY_BASE_FAKE}/${fakeAuthority}?test=1&amount=${input.amount}`,
      }
    }

    // Real ZarinLink: the URL already encodes the merchant + amount (or is
    // amount-flexible). We just redirect to it and pass our callback as a
    // query param so the return URL is honoured.
    const authority = `zl-${Date.now()}`
    const sep = this.url.includes('?') ? '&' : '?'
    const gatewayUrl = `${this.url}${sep}authority=${authority}&callback=${encodeURIComponent(input.callbackUrl)}`

    return { authority, gatewayUrl }
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    if (this.testMode || !this.merchantId) {
      return {
        success: true,
        refId: `TEST-ZL-REF-${Date.now()}`,
        message: 'test mode: simulated success',
      }
    }

    // Real ZarinLink verify uses the same endpoint as ZarinPal.
    const body = {
      merchant_id: this.merchantId,
      amount: input.amount,
      authority: input.authority,
    }

    const res = await fetch('https://api.zarinpal.com/pg/v4/payment/verify.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const json = await res.json()
    const data = json?.data
    if (data && (data.code === 100 || data.code === 101)) {
      return {
        success: true,
        refId: data.ref_id ? String(data.ref_id) : input.authority,
      }
    }

    return {
      success: false,
      message: json?.errors?.message || `ZarinLink verify failed (code ${data?.code ?? 'n/a'})`,
    }
  }

  /**
   * Parse the ZarinLink callback query string.
   *   status=fail | status=cancel -> user cancelled.
   *   pid/authority present         -> success_candidate (must verify).
   *   Otherwise                     -> invalid.
   */
  parseCallback(query: URLSearchParams): CallbackResult {
    const status = query.get('status')
    if (status && ['fail', 'cancel'].includes(status)) {
      return { kind: 'canceled' }
    }
    const authority = query.get('authority') ?? query.get('pid')
    if (!status && !authority) {
      return { kind: 'invalid', reasonCode: 'missing_status_and_pid' }
    }
    return { kind: 'success_candidate', authority: authority ?? undefined }
  }
}

const START_PAY_BASE_FAKE = 'https://zarinp.al/test'
