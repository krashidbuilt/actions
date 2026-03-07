/**
 * Git utilities
 */

import { exec } from "@actions/exec";

export interface GitIdentityOptions {
  silent?: boolean;
}

export async function configureGitIdentity(
  userName: string,
  userEmail: string,
  options: GitIdentityOptions = {},
): Promise<void> {
  const { silent = true } = options;
  await exec("git", ["config", "user.name", userName], { silent });
  await exec("git", ["config", "user.email", userEmail], { silent });
}

export async function execGit(args: string[], options: GitIdentityOptions = {}): Promise<string> {
  const { silent = true } = options;
  let output = "";

  await exec("git", args, {
    listeners: {
      stdout: (data) => {
        output += data.toString();
      },
    },
    silent,
  });

  return output.trim();
}
