/**
 * Strip credential-shaped substrings out of text that is about to be shown to a
 * person, or written to a log line we do not control.
 *
 * The rules are deliberately narrow: they match the two shapes this plugin
 * actually carries around — a JWT, and a token passed as a query parameter —
 * rather than trying to guess at "secrets" in general. A redactor that also
 * eats ordinary prose is worse than none: the reader stops believing the
 * message, and the next failure gets pasted into an issue by hand.
 *
 * Shared on purpose. The status route and the automation scheduler both surface
 * upstream failures, and two copies of this logic drifting apart would mean the
 * same account failure reads one way on the card and another in the log.
 *
 * @module dsh-xdpool/redact
 */

/** `eyJ…` header.payload.signature — what an access or refresh token looks like. */
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu

/** `?code=…` / `token=…` in a URL or a request echo. The key is kept, the value is not. */
const QUERY_SECRET = /(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu

export function redactSecrets(text: string): string {
  return text.replace(JWT, '[redacted token]').replace(QUERY_SECRET, '$1[redacted]')
}
