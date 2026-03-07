import { describe, expect, it, type Mock, vi } from "vitest";

const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(async () => 0) as Mock,
}));

vi.mock("@actions/exec", () => ({
  exec: mockExec,
}));

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
  group: vi.fn(),
  isDebug: vi.fn(() => false),
}));

import {
  awsCli,
  checkArtifactVersionExists,
  findApplicationBucket,
  findArtifactBucket,
  findDistributionId,
  invalidateCloudFront,
  listArtifactVersions,
  syncFromArtifact,
} from "./s3-cloudfront.js";

/** Helper to make mockExec simulate stdout output */
function mockAwsOutput(output: string) {
  mockExec.mockImplementation(
    async (_cmd: string, _args: string[], options?: { listeners?: { stdout?: (data: Buffer) => void } }) => {
      options?.listeners?.stdout?.(Buffer.from(output));
      return 0;
    },
  );
}

describe("awsCli", () => {
  it("executes aws command and returns trimmed stdout", async () => {
    mockAwsOutput("  output data  \n");
    const result = await awsCli(["s3", "ls"]);
    expect(result).toBe("output data");
    expect(mockExec).toHaveBeenCalledWith(
      "aws",
      ["s3", "ls"],
      expect.objectContaining({ listeners: expect.any(Object) }),
    );
  });

  it("concatenates multiple stdout chunks", async () => {
    mockExec.mockImplementation(
      async (_cmd: string, _args: string[], options?: { listeners?: { stdout?: (data: Buffer) => void } }) => {
        options?.listeners?.stdout?.(Buffer.from("chunk1"));
        options?.listeners?.stdout?.(Buffer.from("chunk2"));
        return 0;
      },
    );
    const result = await awsCli(["s3", "ls"]);
    expect(result).toBe("chunk1chunk2");
  });

  it("propagates exec errors", async () => {
    mockExec.mockRejectedValueOnce(new Error("aws failed"));
    await expect(awsCli(["s3", "ls"])).rejects.toThrow("aws failed");
  });
});

describe("findArtifactBucket", () => {
  it("finds artifact.krashidbuilt.com bucket", async () => {
    mockAwsOutput("2024-01-01 00:00:00 artifact.krashidbuilt.com\n2024-01-01 00:00:00 ctrl.krashidbuilt.com\n");
    const result = await findArtifactBucket();
    expect(result).toBe("artifact.krashidbuilt.com");
  });

  it("finds artifact.alpha.krashidbuilt.com bucket", async () => {
    mockAwsOutput("2024-01-01 00:00:00 artifact.alpha.krashidbuilt.com\n");
    const result = await findArtifactBucket();
    expect(result).toBe("artifact.alpha.krashidbuilt.com");
  });

  it("throws when no artifact bucket is found", async () => {
    mockAwsOutput("2024-01-01 00:00:00 other-bucket\n2024-01-01 00:00:00 my-bucket\n");
    await expect(findArtifactBucket()).rejects.toThrow("Could not find artifact bucket");
  });

  it("handles empty bucket list", async () => {
    mockAwsOutput("");
    await expect(findArtifactBucket()).rejects.toThrow("Could not find artifact bucket");
  });
});

describe("findApplicationBucket", () => {
  it("finds production bucket", async () => {
    mockAwsOutput("2024-01-01 00:00:00 ctrl.krashidbuilt.com\n2024-01-01 00:00:00 artifact.krashidbuilt.com\n");
    const result = await findApplicationBucket("ctrl", "production");
    expect(result).toBe("ctrl.krashidbuilt.com");
  });

  it("finds alpha bucket", async () => {
    mockAwsOutput("2024-01-01 00:00:00 ctrl.alpha.krashidbuilt.com\n");
    const result = await findApplicationBucket("ctrl", "alpha");
    expect(result).toBe("ctrl.alpha.krashidbuilt.com");
  });

  it("finds beta bucket", async () => {
    mockAwsOutput("2024-01-01 00:00:00 ctrl.beta.krashidbuilt.com\n");
    const result = await findApplicationBucket("ctrl", "beta");
    expect(result).toBe("ctrl.beta.krashidbuilt.com");
  });

  it("uses first part of appName when dotted", async () => {
    mockAwsOutput("2024-01-01 00:00:00 ctrl.alpha.krashidbuilt.com\n");
    const result = await findApplicationBucket("ctrl.something", "alpha");
    expect(result).toBe("ctrl.alpha.krashidbuilt.com");
  });

  it("throws when application bucket does not exist", async () => {
    mockAwsOutput("2024-01-01 00:00:00 other.krashidbuilt.com\n");
    await expect(findApplicationBucket("ctrl", "production")).rejects.toThrow(
      "Application bucket does not exist: ctrl.krashidbuilt.com",
    );
  });
});

describe("findDistributionId", () => {
  it("finds distribution ID by alias match", async () => {
    const distributions = {
      DistributionList: {
        Items: [
          { Id: "DIST123", Aliases: { Items: ["ctrl.krashidbuilt.com"] } },
          { Id: "DIST456", Aliases: { Items: ["other.krashidbuilt.com"] } },
        ],
      },
    };
    mockAwsOutput(JSON.stringify(distributions));
    const result = await findDistributionId("ctrl.krashidbuilt.com");
    expect(result).toBe("DIST123");
  });

  it("matches partial alias (includes check)", async () => {
    const distributions = {
      DistributionList: {
        Items: [{ Id: "DIST789", Aliases: { Items: ["ctrl.alpha.krashidbuilt.com"] } }],
      },
    };
    mockAwsOutput(JSON.stringify(distributions));
    const result = await findDistributionId("ctrl.alpha.krashidbuilt.com");
    expect(result).toBe("DIST789");
  });

  it("throws when no matching distribution is found", async () => {
    const distributions = {
      DistributionList: {
        Items: [{ Id: "DIST123", Aliases: { Items: ["other.krashidbuilt.com"] } }],
      },
    };
    mockAwsOutput(JSON.stringify(distributions));
    await expect(findDistributionId("ctrl.krashidbuilt.com")).rejects.toThrow(
      "Could not find CloudFront distribution for ctrl.krashidbuilt.com",
    );
  });

  it("handles empty distribution list", async () => {
    mockAwsOutput(JSON.stringify({ DistributionList: { Items: [] } }));
    await expect(findDistributionId("ctrl.krashidbuilt.com")).rejects.toThrow(
      "Could not find CloudFront distribution for ctrl.krashidbuilt.com",
    );
  });

  it("handles missing DistributionList.Items", async () => {
    mockAwsOutput(JSON.stringify({ DistributionList: {} }));
    await expect(findDistributionId("ctrl.krashidbuilt.com")).rejects.toThrow(
      "Could not find CloudFront distribution for ctrl.krashidbuilt.com",
    );
  });

  it("handles distribution with no aliases", async () => {
    const distributions = {
      DistributionList: {
        Items: [{ Id: "DIST123", Aliases: {} }],
      },
    };
    mockAwsOutput(JSON.stringify(distributions));
    await expect(findDistributionId("ctrl.krashidbuilt.com")).rejects.toThrow(
      "Could not find CloudFront distribution for ctrl.krashidbuilt.com",
    );
  });
});

describe("invalidateCloudFront", () => {
  it("creates invalidation and waits for completion", async () => {
    let callCount = 0;
    mockExec.mockImplementation(
      async (_cmd: string, _args: string[], options?: { listeners?: { stdout?: (data: Buffer) => void } }) => {
        callCount++;
        if (callCount === 1) {
          // create-invalidation call
          const response = { Invalidation: { Id: "INV123" } };
          options?.listeners?.stdout?.(Buffer.from(JSON.stringify(response)));
        }
        // second call is wait — no stdout needed
        return 0;
      },
    );

    const result = await invalidateCloudFront("DIST123");
    expect(result).toBe("INV123");

    // Verify create-invalidation call
    expect(mockExec).toHaveBeenCalledWith(
      "aws",
      ["cloudfront", "create-invalidation", "--distribution-id", "DIST123", "--paths", "/*"],
      expect.any(Object),
    );

    // Verify wait call
    expect(mockExec).toHaveBeenCalledWith("aws", [
      "cloudfront",
      "wait",
      "invalidation-completed",
      "--distribution-id",
      "DIST123",
      "--id",
      "INV123",
    ]);
  });

  it("uses custom paths", async () => {
    let callCount = 0;
    mockExec.mockImplementation(
      async (_cmd: string, _args: string[], options?: { listeners?: { stdout?: (data: Buffer) => void } }) => {
        callCount++;
        if (callCount === 1) {
          const response = { Invalidation: { Id: "INV456" } };
          options?.listeners?.stdout?.(Buffer.from(JSON.stringify(response)));
        }
        return 0;
      },
    );

    await invalidateCloudFront("DIST123", ["/index.html", "/assets/*"]);

    expect(mockExec).toHaveBeenCalledWith(
      "aws",
      ["cloudfront", "create-invalidation", "--distribution-id", "DIST123", "--paths", "/index.html", "/assets/*"],
      expect.any(Object),
    );
  });

  it("throws when invalidation ID is missing from response", async () => {
    mockAwsOutput(JSON.stringify({ Invalidation: {} }));
    await expect(invalidateCloudFront("DIST123")).rejects.toThrow("Could not get invalidation ID");
  });

  it("throws when Invalidation key is missing from response", async () => {
    mockAwsOutput(JSON.stringify({}));
    await expect(invalidateCloudFront("DIST123")).rejects.toThrow("Could not get invalidation ID");
  });
});

describe("checkArtifactVersionExists", () => {
  it("returns true when artifact version path exists", async () => {
    mockExec.mockImplementation(async () => 0);
    const result = await checkArtifactVersionExists("artifact.krashidbuilt.com", "ctrl", "1.0.0");
    expect(result).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "aws",
      ["s3", "ls", "s3://artifact.krashidbuilt.com/ctrl/1.0.0/"],
      expect.any(Object),
    );
  });

  it("returns false when aws s3 ls throws", async () => {
    mockExec.mockRejectedValueOnce(new Error("not found"));
    const result = await checkArtifactVersionExists("artifact.krashidbuilt.com", "ctrl", "1.0.0");
    expect(result).toBe(false);
  });
});

describe("syncFromArtifact", () => {
  it("syncs from artifact to application bucket", async () => {
    mockExec.mockImplementation(async () => 0);
    await syncFromArtifact("artifact.krashidbuilt.com", "ctrl", "1.0.0", "ctrl.krashidbuilt.com");

    expect(mockExec).toHaveBeenCalledWith("aws", [
      "s3",
      "sync",
      "--delete",
      "s3://artifact.krashidbuilt.com/ctrl/1.0.0/",
      "s3://ctrl.krashidbuilt.com/",
    ]);
  });

  it("propagates sync errors", async () => {
    mockExec.mockRejectedValueOnce(new Error("sync failed"));
    await expect(syncFromArtifact("artifact.krashidbuilt.com", "ctrl", "1.0.0", "ctrl.krashidbuilt.com")).rejects.toThrow(
      "sync failed",
    );
  });
});

describe("listArtifactVersions", () => {
  it("parses and sorts versions from S3 listing (descending)", async () => {
    mockAwsOutput(
      "                           PRE 0.1.0/\n                           PRE 1.0.0/\n                           PRE 0.2.0/\n",
    );
    const result = await listArtifactVersions("artifact.krashidbuilt.com", "ctrl");
    expect(result).toEqual(["1.0.0", "0.2.0", "0.1.0"]);
  });

  it("filters out non-PRE lines", async () => {
    mockAwsOutput("2024-01-01 00:00:00 somefile.txt\n                           PRE 1.0.0/\n");
    const result = await listArtifactVersions("artifact.krashidbuilt.com", "ctrl");
    expect(result).toEqual(["1.0.0"]);
  });

  it("returns empty array for empty output", async () => {
    mockAwsOutput("");
    const result = await listArtifactVersions("artifact.krashidbuilt.com", "ctrl");
    expect(result).toEqual([]);
  });

  it("handles versions with same major.minor but different patch", async () => {
    mockAwsOutput(
      "                           PRE 1.0.1/\n                           PRE 1.0.0/\n                           PRE 1.0.2/\n",
    );
    const result = await listArtifactVersions("artifact.krashidbuilt.com", "ctrl");
    expect(result).toEqual(["1.0.2", "1.0.1", "1.0.0"]);
  });

  it("handles equal versions", async () => {
    mockAwsOutput("                           PRE 1.0.0/\n                           PRE 1.0.0/\n");
    const result = await listArtifactVersions("artifact.krashidbuilt.com", "ctrl");
    expect(result).toEqual(["1.0.0", "1.0.0"]);
  });

  it("calls correct S3 path", async () => {
    mockAwsOutput("");
    await listArtifactVersions("artifact.krashidbuilt.com", "myapp");
    expect(mockExec).toHaveBeenCalledWith(
      "aws",
      ["s3", "ls", "s3://artifact.krashidbuilt.com/myapp/"],
      expect.any(Object),
    );
  });
});
