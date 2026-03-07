/**
 * Sync Branches Action Configuration
 */

import { defineAction } from "../../../core/action-config.js";
import { GIT } from "../../../core/constants.js";

export const config = defineAction({
  name: "Sync Branches",
  description: "Syncs branches with force-sync or merge strategies",
  inputs: {
    source_branch: {
      description: "Source branch to sync from",
      default: "develop",
    },
    target_branches: {
      description: "Comma-separated list of target branches",
      required: true,
    },
    mode: {
      description: "Sync mode: 'force-sync' (reset to source) or 'merge' (merge source into target)",
      default: "force-sync",
    },
    conflict_strategy: {
      description: "Merge conflict strategy: 'fail' (abort on conflicts) or 'theirs' (accept source branch changes)",
      default: "fail",
    },
    create_if_missing: {
      description: "Create target branch from source if it doesn't exist",
      default: "true",
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
      description: "Dry run mode (do not actually sync)",
      default: "false",
    },
  },
  outputs: {
    synced_branches: {
      description: "Comma-separated list of branches that were synced",
    },
    synced_count: {
      description: "Number of branches synced",
    },
  },
  runs: {
    using: "node24",
    main: "dist/index.js",
  },
});

export type SyncBranchesConfig = typeof config;
