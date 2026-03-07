/**
 * Configure AWS Logic
 *
 * Configures AWS credentials for a specific environment.
 */

import * as core from "@actions/core";
import {
  aws,
  type Environment,
  exportAwsCredentials,
  getAwsConfig,
  isValidEnvironment,
  Logger,
  VALID_ENVIRONMENTS,
} from "../../../core/index.js";

const logger = new Logger({ prefix: "configure-aws" });

export async function run(): Promise<void> {
  try {
    const environment = core.getInput("environment", { required: true });
    const awsRegion = aws.region();

    if (!isValidEnvironment(environment)) {
      throw new Error(`Invalid environment: ${environment}. Valid values: ${VALID_ENVIRONMENTS.join(", ")}`);
    }

    logger.info("Configuring AWS credentials", {
      environment,
      region: awsRegion,
    });

    const config = await getAwsConfig(environment as Environment, awsRegion);
    exportAwsCredentials(config);

    core.setOutput("region", config.region);
    if (config.credentials.accountId) {
      core.setOutput("account_id", config.credentials.accountId);
    }

    logger.info("AWS credentials configured successfully");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}
