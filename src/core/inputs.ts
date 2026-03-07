/**
 * Centralized input getters
 */

import * as core from "@actions/core";
import { AWS, BUILD, GIT, REGISTRY, RUNTIME } from "./constants.js";
import { github } from "./env.js";

export const runtime = {
  nodeVersion: () => core.getInput("node_version") || RUNTIME.NODE_VERSION,
  bunVersion: () => core.getInput("bun_version") || RUNTIME.BUN_VERSION,
};

export const aws = {
  region: () => core.getInput("aws_region") || AWS.REGION,
};

export const registry = {
  url: () => core.getInput("registry_url") || REGISTRY.URL,
  scope: () => core.getInput("registry_scope") || REGISTRY.SCOPE,
  authToken: () => core.getInput("registry_auth_token") || github.getToken() || "",
};

export const git = {
  userName: () => core.getInput("git_user_name") || GIT.USER_NAME,
  userEmail: () => core.getInput("git_user_email") || GIT.USER_EMAIL,
};

export const build = {
  directory: () => core.getInput("build_directory") || BUILD.DIRECTORY,
};

export const common = {
  workingDirectory: () => core.getInput("working_directory") || ".",
  githubToken: () => core.getInput("github_token") || github.getToken() || "",
  environment: () => core.getInput("environment") || undefined,
};

export const inputs = {
  runtime,
  aws,
  registry,
  git,
  build,
  common,
} as const;
