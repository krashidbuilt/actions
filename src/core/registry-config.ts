/**
 * Registry Configuration
 *
 * Functions to create and manage package registry configuration files
 * for npm and bun authentication with npmjs registry.
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ORG, REGISTRY } from "./constants.js";

export interface RegistryConfigResult {
  created: boolean;
  path: string;
  reason?: string;
}

/**
 * Generate .npmrc content for npmjs authentication
 */
export function generateNpmrcContent(scope: string = ORG.SCOPE, registryUrl: string = REGISTRY.URL): string {
  return `${scope}:registry=${registryUrl}
//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}
`;
}

/**
 * Generate bunfig.toml content for npmjs authentication
 */
export function generateBunfigContent(scope: string = ORG.SCOPE, registryUrl: string = REGISTRY.URL): string {
  return `[install.scopes]
"${scope}" = { token = "$BUN_AUTH_TOKEN", url = "${registryUrl}" }
`;
}

export function ensureNpmrc(workingDirectory: string): RegistryConfigResult {
  const npmrcPath = resolve(workingDirectory, ".npmrc");

  if (existsSync(npmrcPath)) {
    return {
      created: false,
      path: npmrcPath,
      reason: ".npmrc already exists",
    };
  }

  writeFileSync(npmrcPath, generateNpmrcContent());

  return {
    created: true,
    path: npmrcPath,
  };
}

export function ensureBunfig(workingDirectory: string): RegistryConfigResult {
  const bunfigPath = resolve(workingDirectory, "bunfig.toml");

  if (existsSync(bunfigPath)) {
    return {
      created: false,
      path: bunfigPath,
      reason: "bunfig.toml already exists",
    };
  }

  writeFileSync(bunfigPath, generateBunfigContent());

  return {
    created: true,
    path: bunfigPath,
  };
}
