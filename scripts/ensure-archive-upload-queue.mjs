#!/usr/bin/env node
/**
 * Ensure the archive-upload Queue exists before `wrangler deploy`.
 *
 * R2 buckets can be auto-provisioned by wrangler; Queues currently are not
 * (or not on the wrangler version pinned here), so Workers Builds fails with:
 *   Queue "archive-upload-events" does not exist.
 *
 * Creating an existing queue exits non-zero — treat that as success.
 */
import { spawnSync } from "node:child_process";

const QUEUE = "archive-upload-events";

const result = spawnSync(
	"npx",
	["wrangler", "queues", "create", QUEUE],
	{ encoding: "utf8", shell: process.platform === "win32" },
);

const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(out);

if (result.status === 0) {
	process.exit(0);
}

// Idempotent: already exists is fine.
if (/already exists|A queue with that name already exists/i.test(out)) {
	console.log(`Queue "${QUEUE}" already exists; continuing.`);
	process.exit(0);
}

// Some wrangler versions print the name without "already exists".
if (/archive-upload-events/i.test(out) && /exist/i.test(out) && !/does not exist/i.test(out)) {
	console.log(`Queue "${QUEUE}" appears to already exist; continuing.`);
	process.exit(0);
}

console.error(`Failed to ensure queue "${QUEUE}" (exit ${result.status}).`);
process.exit(result.status ?? 1);
