/**
 * Versioning Action Configuration
 */

import { defineAction } from "../../core/action-config.js";
import { GIT } from "../../core/constants.js";

export const config = defineAction({
  name: "Versioning",
  description: "Handles version bumping, git tagging, and GitHub release creation",
  inputs: {
    bump_type: {
      description: "Version bump type (auto, major, minor, patch)",
      default: "auto",
    },
    working_directory: {
      description: "Working directory",
      default: ".",
    },
    create_tag: {
      description: "Create git tag",
      default: "true",
    },
    create_release: {
      description: "Create GitHub release",
      default: "true",
    },
    release_draft: {
      description: "Create release as draft",
      default: "false",
    },
    release_prerelease: {
      description: "Mark release as prerelease",
      default: "false",
    },
    prerelease_identifier: {
      description: "Prerelease identifier (e.g., alpha, beta)",
      default: "alpha",
    },
    generate_changelog: {
      description: "Generate changelog from commits",
      default: "true",
    },
    update_version_file: {
      description: "Update version in package.json (set to false for tag-only mode)",
      default: "true",
    },
    push_changes: {
      description: "Push version changes to remote",
      default: "true",
    },
    github_token: {
      description: "GitHub token for API operations",
      required: true,
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
      description: "Dry run mode (do not actually create tags/releases)",
      default: "false",
    },
    promote_from: {
      description:
        "Promote version by replacing this prerelease identifier (e.g. 'alpha' promotes alpha→target channel)",
      default: "",
    },
  },
  outputs: {
    version: {
      description: "New version number",
    },
    previous_version: {
      description: "Previous version number",
    },
    bump_type: {
      description: "Type of version bump performed",
    },
    tag: {
      description: "Git tag created",
    },
    release_url: {
      description: "URL of the GitHub release",
    },
    is_prerelease: {
      description: "Whether this is a prerelease version",
    },
  },
  runs: {
    using: "node24",
    main: "dist/index.js",
  },
});

export type VersioningConfig = typeof config;
