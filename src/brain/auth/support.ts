import type { VendorAuthSupport, VendorId } from "./types.js";

const SUPPORT: Record<VendorId, VendorAuthSupport> = {
  anthropic: {
    vendor: "anthropic",
    sdkOAuth: true,
    oauthRoute: "sdk-profile",
    cliCommand: "ant auth login",
    apiKeyEnvironment: "ANTHROPIC_API_KEY",
    detail:
      "The Anthropic SDK can load and refresh an ant user_oauth profile without a TTY. Claude Code login is a separate credential store.",
    evidence: [
      "https://platform.claude.com/docs/en/cli-sdks-libraries/cli/authentication",
      "https://platform.claude.com/docs/en/manage-claude/wif-reference",
      "https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts",
    ],
  },
  openai: {
    vendor: "openai",
    sdkOAuth: false,
    oauthRoute: "cli",
    cliCommand: "codex",
    apiKeyEnvironment: "OPENAI_API_KEY",
    detail:
      "OpenAI documents API-key authentication for the API SDK, not reuse of Codex/ChatGPT OAuth. Use the OAuth-authenticated CLI as the no-key route.",
    evidence: [
      "https://platform.openai.com/docs/api-reference/authentication",
      "https://platform.openai.com/docs/quickstart",
    ],
  },
  xai: {
    vendor: "xai",
    sdkOAuth: false,
    oauthRoute: "cli",
    cliCommand: "grok",
    apiKeyEnvironment: "XAI_API_KEY",
    detail:
      "xAI documents API-key authentication for its SDK/API. Grok CLI OAuth is the documented no-key route; SDK reuse of its OAuth store is not documented.",
    evidence: [
      "https://github.com/xai-org/xai-sdk-python",
      "https://docs.x.ai/developers/rest-api-reference/inference",
      "https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md",
    ],
  },
};

export function vendorAuthSupport(vendor: VendorId): VendorAuthSupport {
  return SUPPORT[vendor];
}

export function allVendorAuthSupport(): readonly VendorAuthSupport[] {
  return Object.values(SUPPORT);
}
