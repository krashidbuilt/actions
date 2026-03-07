/**
 * Frontend Artifact Deploy Action
 *
 * Deploys a specific version from the artifact bucket to S3/CloudFront.
 * Used for rollbacks and promoting versions between environments.
 */

import { run } from "./logic.js";

run();
