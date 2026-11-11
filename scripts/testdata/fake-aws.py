#!/usr/bin/env python3
"""A stand-in `aws` for scripts/3d-publish.test.ts: just the calls 3d-publish.sh makes.

The bucket is a directory ($FAKE_S3/<key>); object metadata goes to <key>.meta.json under
$FAKE_S3_META. Every call is appended to $FAKE_AWS_LOG as one JSON line. $FAKE_AWS_FAIL_READ
makes reads of that key fail with a non-404 error. s3api get-object/put-object model versions
and ETags (md5 of the body): put-object honours --if-match, and $FAKE_AWS_CHANGE_AFTER_GET
changes the object right after a get-object (a concurrent writer).
"""

import fnmatch
import hashlib
import json
import os
import shutil
import sys

ROOT, META, LOG = os.environ["FAKE_S3"], os.environ["FAKE_S3_META"], os.environ["FAKE_AWS_LOG"]
args = sys.argv[1:]
with open(LOG, "a") as f:
    f.write(json.dumps(args) + "\n")


def opt(name, default=None):
    return args[args.index(name) + 1] if name in args else default


def key_of(url):
    assert url.startswith("s3://"), url
    return url[5:].split("/", 1)[1] if "/" in url[5:] else ""


def put(src, key):
    dest = os.path.join(ROOT, key)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copyfile(src, dest)
    meta = os.path.join(META, key + ".meta.json")
    os.makedirs(os.path.dirname(meta), exist_ok=True)
    with open(meta, "w") as f:
        json.dump({"cacheControl": opt("--cache-control"), "contentType": opt("--content-type")}, f)


def etag(path):
    with open(path, "rb") as f:
        return '"' + hashlib.md5(f.read()).hexdigest() + '"'


def keys(prefix=""):
    out = []
    for d, _, files in os.walk(ROOT):
        for name in files:
            k = os.path.relpath(os.path.join(d, name), ROOT)
            if k.startswith(prefix):
                out.append(k)
    return sorted(out)


def included(rel):
    keep = True  # aws: filters apply in order, the last match decides
    for i, a in enumerate(args):
        if a in ("--exclude", "--include") and fnmatch.fnmatch(rel, args[i + 1]):
            keep = a == "--include"
    return keep


if args[:2] == ["ssm", "get-parameter"]:
    print({"/platform/3d/bucket": "3d.example.com", "/platform/3d/distribution-id": "EFAKE1234"}[opt("--name")])
elif args[:2] == ["s3", "cp"]:
    src, dst = args[2], args[3]
    if src.startswith("s3://"):
        k = key_of(src)
        if os.environ.get("FAKE_AWS_FAIL_READ") == k:
            sys.stderr.write("fatal error: An error occurred (AccessDenied) when calling the GetObject operation\n")
            sys.exit(1)
        if not os.path.isfile(os.path.join(ROOT, k)):
            sys.stderr.write(f'fatal error: An error occurred (404) when calling the HeadObject operation: Key "{k}" does not exist\n')
            sys.exit(1)
        shutil.copyfile(os.path.join(ROOT, k), dst)
    else:
        put(src, key_of(dst))
elif args[:2] == ["s3", "sync"]:
    src, prefix = args[2], key_of(args[3])
    local = set()
    for d, _, files in os.walk(src):
        for name in files:
            rel = os.path.relpath(os.path.join(d, name), src)
            if included(rel):
                local.add(rel)
                put(os.path.join(d, name), prefix + rel)
    if "--delete" in args:
        for k in keys(prefix):
            rel = k[len(prefix):]
            if rel not in local and included(rel):
                os.remove(os.path.join(ROOT, k))
elif args[:2] == ["s3api", "list-objects-v2"]:
    query = opt("--query")
    if query == "CommonPrefixes[].Prefix":
        print("\t".join(sorted({k.split("/")[0] + "/" for k in keys() if "/" in k})) or "None")
    else:
        print("\t".join(keys(opt("--prefix", ""))) or "None")
elif args[:2] == ["s3api", "get-object"]:
    k, path = opt("--key"), os.path.join(ROOT, opt("--key"))
    if not os.path.isfile(path):
        sys.stderr.write("An error occurred (NoSuchKey) when calling the GetObject operation: The specified key does not exist.\n")
        sys.exit(254)
    shutil.copyfile(path, args[-1])
    m = {}
    if os.path.isfile(os.path.join(META, k + ".meta.json")):
        with open(os.path.join(META, k + ".meta.json")) as f:
            m = json.load(f)
    resp = {"ETag": etag(path), "VersionId": m.get("versionId") or "v-" + etag(path)[1:11],
            "Metadata": m.get("metadata") or {}}
    if m.get("cacheControl"):
        resp["CacheControl"] = m["cacheControl"]
    if m.get("contentType"):
        resp["ContentType"] = m["contentType"]
    print(json.dumps(resp, indent=4))
    if os.environ.get("FAKE_AWS_CHANGE_AFTER_GET"):
        with open(path, "a") as f:
            f.write("<!-- changed -->")
elif args[:2] == ["s3api", "put-object"]:
    k, path = opt("--key"), os.path.join(ROOT, opt("--key"))
    if opt("--if-match") is not None and (not os.path.isfile(path) or etag(path) != opt("--if-match")):
        sys.stderr.write("\nAn error occurred (PreconditionFailed) when calling the PutObject operation: "
                         "At least one of the pre-conditions you specified did not hold\n")
        sys.exit(254)
    put(opt("--body"), k)
    metadata = opt("--metadata")
    if metadata and metadata.startswith("file://"):
        with open(metadata[7:]) as f:
            metadata = f.read()
    version = "v-" + etag(path)[1:11]
    with open(os.path.join(META, k + ".meta.json"), "w") as f:
        json.dump({"cacheControl": opt("--cache-control"), "contentType": opt("--content-type"),
                   "metadata": json.loads(metadata) if metadata else {}, "versionId": version}, f)
    print(version)
elif args[:2] == ["cloudfront", "create-invalidation"]:
    print("IFAKE")
else:
    sys.stderr.write(f"fake aws: unsupported {args}\n")
    sys.exit(9)
