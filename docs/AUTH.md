# Provider authentication

Provider login belongs to the provider, not to a Bus seat. A seat may use an ordered chain of
different vendors, so no seat stops merely because one subscription is out of credit.

## No-key routes

| Provider | One-time interactive login | Non-interactive brain route |
|---|---|---|
| Claude Code | `claude auth login` | `cli` provider uses the logged-in Claude CLI |
| Codex | `codex login` | `codex` provider uses the logged-in Codex CLI |
| Grok | `grok login` | `grok` provider uses the logged-in Grok CLI |
| Anthropic SDK OAuth | `ant auth login` | `oauth` provider loads the selected `user_oauth` profile |

`ant auth login` stores profile configuration and OAuth credentials beneath
`ANTHROPIC_CONFIG_DIR`, or `%APPDATA%\Anthropic` on Windows and `~/.config/anthropic` elsewhere.
The Anthropic SDK can load and refresh this profile without a TTY. Claude Code's `~/.claude`
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
