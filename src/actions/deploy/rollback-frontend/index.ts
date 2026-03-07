/**
 * Frontend Rollback Action
 *
 * Rolls back a frontend to the previous version.
 * Lists versions in artifact bucket, sorted by semver, deploys the second one.
 */

import { run } from "./logic.js";

run();
