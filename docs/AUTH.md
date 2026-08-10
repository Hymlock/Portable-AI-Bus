# Provider authentication

Provider login belongs to the provider, not to a Bus seat. A seat uses an ordered chain of
providers, and the **default** chains cross vendor boundaries, so one subscription running out
does not stop a seat that is using a default chain.

> **This is not enforced, and the gap matters.** `brains/agent-seat.js` validates that a chain
> contains at least two *distinct provider kinds* — not two distinct vendors or billing
> accounts. `PORTABLE_AI_BUS_PROVIDER_CHAIN=oauth,api` passes that check and is **entirely
> Anthropic**, so exhausting one account stops the seat. If you override the chain, cross a
> vendor boundary yourself, and confirm it with `servedBy` in `brain-<seat>.log`.

## No-key routes

| Provider | One-time interactive login | Non-interactive brain route |
|---|---|---|
| Claude Code | `claude auth login` | `cli` provider uses the logged-in Claude CLI |
| Codex | `codex login` | `codex` provider uses the logged-in Codex CLI |
| Grok | `grok login` | `grok` provider uses the logged-in Grok CLI |
| Anthropic SDK OAuth | `ant auth login` | `oauth` provider uses the SDK's **default credential chain** |

`ant auth login` stores profile configuration and OAuth credentials beneath
`ANTHROPIC_CONFIG_DIR`, or `%APPDATA%\Anthropic` on Windows and `~/.config/anthropic` elsewhere.
The Anthropic SDK can load and refresh this profile without a TTY.

**The `oauth` provider does not guarantee it uses that profile.** `resolveAnthropicOAuth()`
exists in `src/brain/auth/anthropic.ts` but no production code calls it; `providers.ts`
constructs a plain `new Anthropic({})`, so the SDK's default precedence applies and an ambient
`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` silently shadows the profile you selected. To be
sure which credential is in play, unset both variables and set `ANTHROPIC_PROFILE`. Neither of
the two rows above was executed during the audit that produced this note — `ant` is not
installed on the development machine, so its behaviour here is documented from the vendor's
own documentation rather than observed. Claude Code's `~/.claude`
credential is a separate store and cannot substitute for an `ant` SDK profile.
The SDK and its runtime dependencies are included in the VSIX and staged workspace runtime; no
workspace `npm install` is needed.

OpenAI and xAI document API-key authentication for their SDKs, not SDK reuse of coding-CLI OAuth.
Their no-key Bus route is therefore the authenticated `codex` or `grok` CLI. API-key environment
variables remain optional operator-selected fallbacks; the default chain does not require them.

By default Claude leads with its CLI, Codex leads with Codex, and Grok leads with Grok; every
chain immediately crosses to another vendor. Set
`PORTABLE_AI_BUS_PROVIDER_CHAIN=codex,grok,cli,oauth,api` to override the order for every seat.
At least two distinct entries are required by the packaged agent brain.
