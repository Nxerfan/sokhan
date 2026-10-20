/**
 * Deterministic mock payment provider for behavioral tests.
 *
 * PR: billing-state-machine-hardening
 *
 * Properties:
 *   - Makes ZERO network requests. Everything is in-memory.
 *   - Production MUST NEVER enable this provider. It is only reachable via
 *     dependency injection (BillingDeps.resolveGateway('mock')) in test/CI
 *     code. The production route /api/billing/callback/mock is rejected as
 *     'invalid_gateway' (the production gateway set does not include 'mock').
 *   - Scenarios are set explicitly by the test via `setScenario`. Deterministic
 *     — no randomness, no Date.now()-based authorities (uses a monotonic
 *     counter + the supplied invoice id).
 *
 * Supported scenarios:
 *   create_success       -> createPayment returns a deterministic authority
 *   create_failure        -> createPayment throws (billing-service must
 *                            compensate by canceling the pending checkout)
 *   verify_success        -> verifyPayment returns success + refId
 *   verify_failure        -> verifyPayment returns success=false
 *   verify_throw         -> verifyPayment throws (network error simulation)
 *   callback_success     -> parseCallback returns success_candidate
 *   callback_canceled    -> parseCallback returns canceled
 *   callback_malformed   -> parseCallback returns invalid
 *
 * The mock records every call so tests can assert behavior (e.g. "provider was
 * NOT called for a zero-amount plan").
 */

import type {
  CallbackResult,
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  ProviderName,
  VerifyPaymentInput,
  VerifyPaymentResult,
} from './types'

export type MockScenario =
  | 'create_success'
  | 'create_failure'
  | 'verify_success'
  | 'verify_failure'
  | 'verify_throw'
  | 'callback_success'
  | 'callback_canceled'
  | 'callback_malformed'

export interface MockCall {
  method: 'createPayment' | 'verifyPayment' | 'parseCallback'
  args: unknown
  result?: unknown
  error?: string
  at: number
}

export class MockPaymentProvider implements PaymentProvider {
  name: ProviderName = 'mock'
  testMode = true

  private createScenario: MockScenario = 'create_success'
  private verifyScenario: MockScenario = 'verify_success'
  private callbackScenario: MockScenario = 'callback_success'
  private counter = 0
  private readonly calls: MockCall[] = []

  /** Asserting helper: returns true if a method was ever called. */
  wasCalled(method: MockCall['method']): boolean {
    return this.calls.some((c) => c.method === method)
  }

  /** Count of calls to a method. */
  callCount(method: MockCall['method']): number {
    return this.calls.filter((c) => c.method === method).length
  }

  /** The recorded calls (for test assertions). */
  recordedCalls(): readonly MockCall[] {
    return this.calls
  }

  /** Reset all state — use between tests. */
  reset(): void {
    this.counter = 0
    this.calls.length = 0
    this.createScenario = 'create_success'
    this.verifyScenario = 'verify_success'
    this.callbackScenario = 'callback_success'
  }

  setCreateScenario(s: MockScenario): void {
    this.createScenario = s
  }
  setVerifyScenario(s: MockScenario): void {
    this.verifyScenario = s
  }
  setCallbackScenario(s: MockScenario): void {
    this.callbackScenario = s
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const at = Date.now()
    this.calls.push({ method: 'createPayment', args: { ...input }, at })
    if (this.createScenario === 'create_failure') {
      const err = 'mock: createPayment failed (create_failure scenario)'
      this.calls[this.calls.length - 1].error = err
      throw new Error(err)
    }
    // Deterministic authority — derived from the callback URL's invoiceId if
    // present, else a monotonic counter.
    const invoiceId = extractInvoiceId(input.callbackUrl)
    this.counter += 1
    const authority = `MOCK-AUTH-${invoiceId ?? this.counter}`
    const result: CreatePaymentResult = {
      authority,
      gatewayUrl: `https://mock.pay.local/StartPay/${authority}`,
    }
    this.calls[this.calls.length - 1].result = result
    return result
  }

  async verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const at = Date.now()
    this.calls.push({ method: 'verifyPayment', args: { ...input }, at })
    if (this.verifyScenario === 'verify_throw') {
      const err = 'mock: verifyPayment threw (verify_throw scenario)'
      this.calls[this.calls.length - 1].error = err
      throw new Error(err)
    }
    if (this.verifyScenario === 'verify_failure') {
      const result: VerifyPaymentResult = {
        success: false,
        message: 'mock: verify failed (verify_failure scenario)',
      }
      this.calls[this.calls.length - 1].result = result
      return result
    }
    // verify_success (default)
    const result: VerifyPaymentResult = {
      success: true,
      refId: `MOCK-REF-${input.authority}`,
      message: 'mock: verified',
    }
    this.calls[this.calls.length - 1].result = result
    return result
  }

  parseCallback(query: URLSearchParams): CallbackResult {
    const at = Date.now()
    this.calls.push({ method: 'parseCallback', args: String(query), at })
    let result: CallbackResult
    if (this.callbackScenario === 'callback_malformed') {
      result = { kind: 'invalid', reasonCode: 'malformed_callback' }
    } else if (this.callbackScenario === 'callback_canceled') {
      result = { kind: 'canceled' }
    } else {
      // callback_success (default)
      const authority = query.get('Authority') ?? query.get('authority') ?? undefined
      result = { kind: 'success_candidate', authority: authority ?? undefined }
    }
    this.calls[this.calls.length - 1].result = result
    return result
  }
}

/** Extract the invoiceId from a callback URL's query string (for deterministic authorities). */
function extractInvoiceId(callbackUrl: string): string | undefined {
  try {
    const u = new URL(callbackUrl)
    return u.searchParams.get('invoiceId') ?? undefined
  } catch {
    return undefined
  }
}

/** Create a fresh mock provider instance (for each test). */
export function createMockProvider(): MockPaymentProvider {
  return new MockPaymentProvider()
}
