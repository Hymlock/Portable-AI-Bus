# Brain authentication

API keys are optional fallbacks, never the default requirement.

## Anthropic

`ant auth login` performs the one-time interactive browser login. It writes a
non-secret profile config to `configs/<profile>.json` and the OAuth credential to
`credentials/<profile>.json` beneath `ANTHROPIC_CONFIG_DIR`, or the OS config
directory (`%APPDATA%/Anthropic` on Windows and `~/.config/anthropic` by default
elsewhere). `active_config` selects the default profile.

The Anthropic TypeScript SDK can consume that `user_oauth` profile from a detached,
non-interactive process and refresh an expired access token from the stored refresh
token. Pass `{ profile, apiKey: null, authToken: null }` so ambient API-key variables
cannot shadow the chosen OAuth profile. `resolveAnthropicOAuth()` verifies that the
profile is present and shaped correctly without exposing its token.

Claude Code's `claude auth login` is separate consumer authentication (stored under
`~/.claude` on this machine). It does not create an Anthropic SDK profile. This host
has Claude Code authentication but no `ant` command or `%APPDATA%/Anthropic` profile,
so the current local SDK-OAuth probe correctly fails closed until `ant auth login` is
run.

## Other vendors

OpenAI and xAI officially document API-key authentication for their API SDKs; neither
documents loading the OAuth state of its coding CLI into the SDK. Their honest no-key
route is therefore an OAuth-authenticated CLI provider (`codex` or `grok`), with the
API-key SDK provider retained only as an optional fallback.
