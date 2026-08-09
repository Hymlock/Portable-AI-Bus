export type VendorId = "anthropic" | "openai" | "xai";

export interface VendorAuthSupport {
  vendor: VendorId;
  sdkOAuth: boolean;
  oauthRoute: "sdk-profile" | "cli";
  cliCommand: string;
  apiKeyEnvironment: string;
  detail: string;
  evidence: readonly string[];
}

export interface AnthropicSdkInit {
  apiKey: null;
  authToken: null;
  profile: string;
}

export interface AnthropicOAuthResolution {
  ok: boolean;
  profile: string;
  configDir: string;
  configPath: string;
  credentialsPath: string;
  sdkOptions?: AnthropicSdkInit;
  detail: string;
}
