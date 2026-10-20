/**
 * Shared auth cookie constants (PR #11).
 *
 * Lives in `src/lib/auth/` (not in the route file) so that:
 *   - the `/api/auth/switch-workspace` route can set the cookie,
 *   - the NextAuth `jwt` callback in `src/lib/auth/options.ts` can read +
 *     clear the cookie,
 *
 * without either file importing from the other (which would be a circular
 * dependency: the route file imports `authOptions` from the options file).
 */

/** Cookie carrying the target workspaceId for an in-progress switch. */
export const SWITCH_COOKIE = '__sukhan_switch_target'

/** Max age (seconds) for the switch cookie. Short — just long enough for one
 * page reload to trigger the jwt callback. */
export const SWITCH_COOKIE_MAX_AGE_SECONDS = 60
