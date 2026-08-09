import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AnthropicOAuthResolution } from "./types.js";

interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  profile?: string;
}

interface AnthropicProfileConfig {
  authentication?: {
    type?: string;
    credentials_path?: string;
  };
}

interface AnthropicCredentials {
  type?: string;
  access_token?: string;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validProfile(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

export function anthropicConfigDir(options: ResolveOptions = {}): string {
  const env = options.env ?? process.env;
  const configured = nonEmpty(env.ANTHROPIC_CONFIG_DIR);
  if (configured) return path.resolve(configured);

  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? os.homedir();
  if (platform === "win32") {
    const appData = nonEmpty(env.APPDATA);
    return path.resolve(appData ?? path.join(home, "AppData", "Roaming"), "Anthropic");
  }

  const xdg = nonEmpty(env.XDG_CONFIG_HOME);
  return path.resolve(xdg ?? path.join(home, ".config"), "anthropic");
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

async function activeProfile(configDir: string, options: ResolveOptions): Promise<string> {
  const env = options.env ?? process.env;
  const explicit = nonEmpty(options.profile) ?? nonEmpty(env.ANTHROPIC_PROFILE);
  if (explicit) return explicit;

  try {
    return nonEmpty(await fs.readFile(path.join(configDir, "active_config"), "utf8")) ?? "default";
  } catch {
    return "default";
  }
}

export async function resolveAnthropicOAuth(
  options: ResolveOptions = {},
): Promise<AnthropicOAuthResolution> {
  const configDir = anthropicConfigDir(options);
  const profile = await activeProfile(configDir, options);
  const configPath = path.join(configDir, "configs", `${profile}.json`);
  let credentialsPath = path.join(configDir, "credentials", `${profile}.json`);

  const fail = (detail: string): AnthropicOAuthResolution => ({
    ok: false,
    profile,
    configDir,
    configPath,
    credentialsPath,
    detail,
  });

  if (!validProfile(profile)) {
    return fail(`Invalid Anthropic profile name: ${JSON.stringify(profile)}.`);
  }

  let config: AnthropicProfileConfig;
  try {
    config = await readJson<AnthropicProfileConfig>(configPath);
  } catch {
    return fail(
      `No readable Anthropic SDK profile '${profile}'. Run 'ant auth login --profile ${profile}'. ` +
        "'claude auth login' is Claude Code authentication and does not create this SDK profile.",
    );
  }

  if (config.authentication?.type !== "user_oauth") {
    return fail(`Anthropic profile '${profile}' is not a user_oauth profile.`);
  }

  const customCredentials = nonEmpty(config.authentication.credentials_path);
  if (customCredentials) {
    credentialsPath = path.resolve(configDir, customCredentials);
  }

  let credentials: AnthropicCredentials;
  try {
    credentials = await readJson<AnthropicCredentials>(credentialsPath);
  } catch {
    return fail(`Anthropic OAuth credentials for profile '${profile}' are missing or unreadable.`);
  }

  if (credentials.type !== "oauth_token" || !nonEmpty(credentials.access_token)) {
    return fail(`Anthropic OAuth credentials for profile '${profile}' are malformed.`);
  }

  return {
    ok: true,
    profile,
    configDir,
    configPath,
    credentialsPath,
    sdkOptions: { apiKey: null, authToken: null, profile },
    detail:
      `Anthropic SDK profile '${profile}' is usable without an API key or TTY. ` +
      "The SDK reads and refreshes the stored OAuth credential; this resolver never returns the token.",
  };
}
