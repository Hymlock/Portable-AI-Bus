# Provider authentication

Provider login belongs to the provider represented by the Bus seat. Identity and billing are
enforced together: `grok` may use only xAI, `codex` only OpenAI, and `claude` only Anthropic.
A missing, signed-out, or exhausted vendor stops that seat visibly. It is illegal for a named
brain to fall through to another vendor and spend that vendor's credits under the wrong name.

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
variables remain optional same-vendor authentication routes; the defaults do not require them.

Claude may order `cli`, `oauth`, and `api`, because all three are Anthropic routes. Codex accepts
only `codex`; Grok accepts only `grok`. `PORTABLE_AI_BUS_PROVIDER_CHAIN` may reorder or narrow a
seat's same-vendor routes, but a cross-vendor entry is rejected before the brain starts.
