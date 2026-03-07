/**
 * Commit Artifacts Action Configuration
 */

import { defineAction } from "../../../core/action-config.js";
import { GIT } from "../../../core/constants.js";

export const config = defineAction({
  name: "Commit Artifacts",
  description: "Commits bundled artifacts to the repository with force-add support and rebasing",
  inputs: {
    paths: {
      description: "Paths to add and commit (space-separated)",
      required: true,
    },
    message: {
      description: "Commit message",
      default: "chore: bundle artifacts",
    },
    git_user_name: {
      description: "Git user name for commits",
      default: GIT.USER_NAME,
    },
    git_user_email: {
      description: "Git user email for commits",
      default: GIT.USER_EMAIL,
    },
    dry_run: {
      description: "Dry run mode (do not actually commit)",
      default: "false",
    },
  },
  outputs: {
    committed: {
      description: "Whether changes were committed (true/false)",
    },
    sha: {
      description: "Commit SHA if changes were committed",
    },
  },
  runs: {
    using: "node24",
    main: "dist/index.js",
  },
});

export type CommitArtifactsConfig = typeof config;
