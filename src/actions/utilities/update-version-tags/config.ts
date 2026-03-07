/**
 * Update Version Tags Action Configuration
 */

import { defineAction } from "../../../core/action-config.js";

export const config = defineAction({
  name: "Update Version Tags",
  description: "Updates Git tags for releases (major version tags v1, v2 for stable, beta tag for prereleases)",
  inputs: {
    version: {
      description: "Version to create tags for (e.g., v1.2.3 or 1.2.3-beta.1)",
      required: true,
    },
    tag_type: {
      description: "Tag type to update (auto, major, beta, both)",
      default: "auto",
    },
    dry_run: {
      description: "Dry run mode (do not actually update tags)",
      default: "false",
    },
  },
  outputs: {
    updated_tags: {
      description: "Comma-separated list of updated tags",
    },
    major_tag: {
      description: "Major version tag if updated (e.g., v1)",
    },
    is_beta: {
      description: "Whether this is a beta/prerelease version",
    },
  },
  runs: {
    using: "node24",
    main: "dist/index.js",
  },
});

export type UpdateVersionTagsConfig = typeof config;
