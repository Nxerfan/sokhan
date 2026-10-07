/**
 * App-side realtime token helpers.
 *
 * Delegates to the shared pure module (`realtime-token-shared.ts`) which is
 * also used by the Vercel realtime function and the Docker realtime service.
 * This avoids three drifting copies of the verification logic.
 *
 * App code uses these wrappers which automatically read the secret from
 * `getAuthSecret()` (NEXTAUTH_SECRET via env-check).
 */

import { signToken as signWithSecret, verifyToken as verifyWithSecret } from './realtime-token-shared'
import { getAuthSecret } from './env-check'

export type {
  AgentTokenPayload,
  VisitorTokenPayload,
  RealtimeTokenPayload,
} from './realtime-token-shared'
export { DEFAULT_TOKEN_TTL_SECONDS } from './realtime-token-shared'

const SECRET = getAuthSecret()

/** Sign a realtime token using the app's NEXTAUTH_SECRET. */
export function signToken(payload: Parameters<typeof signWithSecret>[0]): string {
  return signWithSecret(payload, SECRET)
}

/** Verify a realtime token using the app's NEXTAUTH_SECRET. */
export function verifyToken(token: string) {
  return verifyWithSecret(token, SECRET)
}
