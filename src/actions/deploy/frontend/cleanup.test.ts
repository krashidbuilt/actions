import { describe, expect, it, type Mock, vi } from "vitest";

const { mockExec, mockGetExecOutput } = vi.hoisted(() => ({
  mockExec: vi.fn(async () => 0) as Mock,
  mockGetExecOutput: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

vi.mock("@actions/exec", () => ({
  exec: mockExec,
  getExecOutput: mockGetExecOutput,
}));

import {
  deleteFilesInBatches,
  determineFilesToDelete,
  getAllFilesFromBucket,
  getFilesFromVersions,
  getLastNVersions,
} from "./cleanup.js";

describe("getLastNVersions", () => {
  it("returns versions sorted by semver descending and limited to count", async () => {
    mockGetExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(["myapp/1.0.0/", "myapp/2.1.0/", "myapp/1.5.3/", "myapp/3.0.0/"]),
      stderr: "",
    });

    const versions = await getLastNVersions("artifact-bucket", "myapp", 2, "3.0.0");

    expect(versions).toEqual(["3.0.0", "2.1.0"]);
    expect(mockGetExecOutput).toHaveBeenCalledWith("aws", [
      "s3api",
      "list-objects-v2",
      "--bucket",
      "artifact-bucket",
      "--prefix",
      "myapp/",
      "--delimiter",
      "/",
      "--query",
      "CommonPrefixes[*].Prefix",
      "--output",
      "json",
    ]);
  });

  it("filters out empty version strings", async () => {
    mockGetExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(["myapp/1.0.0/", "myapp//"]),
      stderr: "",
    });

    const versions = await getLastNVersions("bucket", "myapp", 5, "1.0.0");
    expect(versions).toEqual(["1.0.0"]);
  });

  it("returns empty array when no versions exist", async () => {
    mockGetExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: "[]",
      stderr: "",
    });

    const versions = await getLastNVersions("bucket", "myapp", 3, "1.0.0");
    expect(versions).toEqual([]);
  });

  it("handles null/empty stdout", async () => {
    mockGetExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const versions = await getLastNVersions("bucket", "myapp", 3, "1.0.0");
    expect(versions).toEqual([]);
  });

  it("filters by channel — alpha only sees alpha versions", async () => {
    mockGetExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([
        "app/1.0.0-alpha.1/",
        "app/1.0.0-alpha.2/",
        "app/1.0.0-beta.1/",
        "app/1.0.0/",
        "app/1.0.0-alpha.3/",
      ]),
      stderr: "",
    });

    const versions = await getLastNVersions("bucket", "app", 3, "1.0.0-alpha.3");
    expect(versions).toEqual(["1.0.0-alpha.3", "1.0.0-alpha.2", "1.0.0-alpha.1"]);
  });

  it("filters by channel — beta only sees beta versions", async () => {
    mockGetExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(["app/0.1.1-alpha.20/", "app/0.1.1-alpha.21/", "app/0.1.1-beta.1/", "app/0.1.1/"]),
      stderr: "",
    });

    const versions = await getLastNVersions("bucket", "app", 3, "0.1.1-beta.1");
    expect(versions).toEqual(["0.1.1-beta.1"]);
  });

  it("filters by channel — stable only sees stable versions", async () => {
    mockGetExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(["app/1.0.0-alpha.1/", "app/1.0.0-beta.1/", "app/1.0.0/", "app/1.1.0/"]),
      stderr: "",
    });

    const versions = await getLastNVersions("bucket", "app", 3, "1.1.0");
    expect(versions).toEqual(["1.1.0", "1.0.0"]);
  });

  it("sorts prerelease versions by prerelease number", async () => {
    mockGetExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(["app/1.0.0-alpha.10/", "app/1.0.0-alpha.2/", "app/1.0.0-alpha.1/", "app/2.0.0-alpha.1/"]),
      stderr: "",
    });

    const versions = await getLastNVersions("bucket", "app", 4, "2.0.0-alpha.1");
    expect(versions).toEqual(["2.0.0-alpha.1", "1.0.0-alpha.10", "1.0.0-alpha.2", "1.0.0-alpha.1"]);
  });

  it("limits to requested count", async () => {
    mockGetExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(["app/1.0.0/", "app/2.0.0/", "app/3.0.0/", "app/4.0.0/", "app/5.0.0/"]),
      stderr: "",
    });

    const versions = await getLastNVersions("bucket", "app", 3, "5.0.0");
    expect(versions).toHaveLength(3);
    expect(versions).toEqual(["5.0.0", "4.0.0", "3.0.0"]);
  });

  it("handles versions with different length parts", async () => {
    mockGetExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(["app/1.0/", "app/1.0.1/"]),
      stderr: "",
    });

    const versions = await getLastNVersions("bucket", "app", 5, "1.0.1");
    expect(versions[0]).toBe("1.0.1");
    expect(versions[1]).toBe("1.0");
  });
});

describe("getFilesFromVersions", () => {
  it("collects files from multiple versions", async () => {
    mockGetExecOutput
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(["app/1.0.0/index.html", "app/1.0.0/assets/main.js"]),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(["app/2.0.0/index.html", "app/2.0.0/assets/main.js", "app/2.0.0/assets/style.css"]),
        stderr: "",
      });

    const files = await getFilesFromVersions("artifact-bucket", "app", ["1.0.0", "2.0.0"]);

    expect(files).toBeInstanceOf(Set);
    expect(files.has("index.html")).toBe(true);
    expect(files.has("assets/main.js")).toBe(true);
    expect(files.has("assets/style.css")).toBe(true);
    expect(files.size).toBe(3);
  });

  it("returns empty set when no versions provided", async () => {
    const files = await getFilesFromVersions("bucket", "app", []);
    expect(files.size).toBe(0);
    expect(mockGetExecOutput).not.toHaveBeenCalled();
  });

  it("deduplicates files across versions", async () => {
    mockGetExecOutput
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(["app/1.0.0/shared.js"]),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(["app/2.0.0/shared.js"]),
        stderr: "",
      });

    const files = await getFilesFromVersions("bucket", "app", ["1.0.0", "2.0.0"]);
    expect(files.size).toBe(1);
    expect(files.has("shared.js")).toBe(true);
  });

  it("handles empty stdout from a version", async () => {
    mockGetExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const files = await getFilesFromVersions("bucket", "app", ["1.0.0"]);
    expect(files.size).toBe(0);
  });

  it("calls s3api with correct prefix for each version", async () => {
    mockGetExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: "[]",
      stderr: "",
    });

    await getFilesFromVersions("my-bucket", "ctrl", ["3.0.0"]);

    expect(mockGetExecOutput).toHaveBeenCalledWith("aws", [
      "s3api",
      "list-objects-v2",
      "--bucket",
      "my-bucket",
      "--prefix",
      "ctrl/3.0.0/",
      "--query",
      "Contents[*].Key",
      "--output",
      "json",
    ]);
  });
});

describe("getAllFilesFromBucket", () => {
  it("returns list of file keys from the bucket", async () => {
    mockGetExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(["index.html", "assets/main.js", "assets/style.css"]),
      stderr: "",
    });

    const files = await getAllFilesFromBucket("app-bucket");

    expect(files).toEqual(["index.html", "assets/main.js", "assets/style.css"]);
    expect(mockGetExecOutput).toHaveBeenCalledWith("aws", [
      "s3api",
      "list-objects-v2",
      "--bucket",
      "app-bucket",
      "--query",
      "Contents[*].Key",
      "--output",
      "json",
    ]);
  });

  it("returns empty array for empty bucket", async () => {
    mockGetExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const files = await getAllFilesFromBucket("empty-bucket");
    expect(files).toEqual([]);
  });
});

describe("determineFilesToDelete", () => {
  it("identifies files not in the keep set for deletion", () => {
    const allFiles = ["assets/old.js", "assets/new.js", "assets/current.css"];
    const filesToKeep = new Set(["assets/new.js", "assets/current.css"]);

    const result = determineFilesToDelete(allFiles, filesToKeep);
    expect(result).toEqual(["assets/old.js"]);
  });

  it("never deletes index.html", () => {
    const allFiles = ["index.html", "stale.js"];
    const filesToKeep = new Set<string>();

    const result = determineFilesToDelete(allFiles, filesToKeep);
    expect(result).toEqual(["stale.js"]);
    expect(result).not.toContain("index.html");
  });

  it("never deletes robots.txt", () => {
    const allFiles = ["robots.txt", "old.js"];
    const filesToKeep = new Set<string>();

    const result = determineFilesToDelete(allFiles, filesToKeep);
    expect(result).not.toContain("robots.txt");
  });

  it("never deletes favicon.ico", () => {
    const allFiles = ["favicon.ico", "old.js"];
    const filesToKeep = new Set<string>();

    const result = determineFilesToDelete(allFiles, filesToKeep);
    expect(result).not.toContain("favicon.ico");
  });

  it("never deletes sitemap.xml", () => {
    const allFiles = ["sitemap.xml", "old.js"];
    const filesToKeep = new Set<string>();

    const result = determineFilesToDelete(allFiles, filesToKeep);
    expect(result).not.toContain("sitemap.xml");
  });

  it("never deletes files starting with underscore", () => {
    const allFiles = ["_redirects", "_headers", "old.js"];
    const filesToKeep = new Set<string>();

    const result = determineFilesToDelete(allFiles, filesToKeep);
    expect(result).toEqual(["old.js"]);
    expect(result).not.toContain("_redirects");
    expect(result).not.toContain("_headers");
  });

  it("preserves all critical files together", () => {
    const allFiles = ["index.html", "robots.txt", "favicon.ico", "sitemap.xml", "_config", "deleteme.js"];
    const filesToKeep = new Set<string>();

    const result = determineFilesToDelete(allFiles, filesToKeep);
    expect(result).toEqual(["deleteme.js"]);
  });

  it("returns empty array when all files are in the keep set", () => {
    const allFiles = ["a.js", "b.css"];
    const filesToKeep = new Set(["a.js", "b.css"]);

    const result = determineFilesToDelete(allFiles, filesToKeep);
    expect(result).toEqual([]);
  });

  it("returns empty array when all files are critical", () => {
    const allFiles = ["index.html", "robots.txt", "favicon.ico", "sitemap.xml"];
    const filesToKeep = new Set<string>();

    const result = determineFilesToDelete(allFiles, filesToKeep);
    expect(result).toEqual([]);
  });

  it("returns empty array when input is empty", () => {
    const result = determineFilesToDelete([], new Set());
    expect(result).toEqual([]);
  });
});

describe("deleteFilesInBatches", () => {
  it("deletes files in a single batch when under 1000", async () => {
    const files = ["file1.js", "file2.js", "file3.js"];

    await deleteFilesInBatches("my-bucket", files);

    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith("aws", [
      "s3api",
      "delete-objects",
      "--bucket",
      "my-bucket",
      "--delete",
      JSON.stringify({
        Objects: [{ Key: "file1.js" }, { Key: "file2.js" }, { Key: "file3.js" }],
        Quiet: true,
      }),
    ]);
  });

  it("splits into multiple batches when over 1000 files", async () => {
    const files = Array.from({ length: 2500 }, (_, i) => `file${i}.js`);

    await deleteFilesInBatches("my-bucket", files);

    expect(mockExec).toHaveBeenCalledTimes(3);

    // First batch: 1000 files
    const firstBatchArg = mockExec.mock.calls[0][1] as string[];
    const firstBatchDelete = JSON.parse(firstBatchArg[firstBatchArg.length - 1]);
    expect(firstBatchDelete.Objects).toHaveLength(1000);
    expect(firstBatchDelete.Objects[0].Key).toBe("file0.js");
    expect(firstBatchDelete.Objects[999].Key).toBe("file999.js");

    // Second batch: 1000 files
    const secondBatchArg = mockExec.mock.calls[1][1] as string[];
    const secondBatchDelete = JSON.parse(secondBatchArg[secondBatchArg.length - 1]);
    expect(secondBatchDelete.Objects).toHaveLength(1000);
    expect(secondBatchDelete.Objects[0].Key).toBe("file1000.js");

    // Third batch: 500 files
    const thirdBatchArg = mockExec.mock.calls[2][1] as string[];
    const thirdBatchDelete = JSON.parse(thirdBatchArg[thirdBatchArg.length - 1]);
    expect(thirdBatchDelete.Objects).toHaveLength(500);
    expect(thirdBatchDelete.Objects[0].Key).toBe("file2000.js");
  });

  it("does nothing when files array is empty", async () => {
    await deleteFilesInBatches("bucket", []);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("handles exactly 1000 files in one batch", async () => {
    const files = Array.from({ length: 1000 }, (_, i) => `file${i}.js`);

    await deleteFilesInBatches("bucket", files);

    expect(mockExec).toHaveBeenCalledTimes(1);
    const batchArg = mockExec.mock.calls[0][1] as string[];
    const batchDelete = JSON.parse(batchArg[batchArg.length - 1]);
    expect(batchDelete.Objects).toHaveLength(1000);
  });

  it("handles exactly 1001 files in two batches", async () => {
    const files = Array.from({ length: 1001 }, (_, i) => `file${i}.js`);

    await deleteFilesInBatches("bucket", files);

    expect(mockExec).toHaveBeenCalledTimes(2);
    const firstBatchArg = mockExec.mock.calls[0][1] as string[];
    const firstBatchDelete = JSON.parse(firstBatchArg[firstBatchArg.length - 1]);
    expect(firstBatchDelete.Objects).toHaveLength(1000);

    const secondBatchArg = mockExec.mock.calls[1][1] as string[];
    const secondBatchDelete = JSON.parse(secondBatchArg[secondBatchArg.length - 1]);
    expect(secondBatchDelete.Objects).toHaveLength(1);
  });
});
