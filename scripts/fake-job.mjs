#!/usr/bin/env node
/**
 * Deterministic stand-ins for the processes that make an agent wait.
 * Each one is longer or quieter than the extension's 5 s grace window.
 *
 *   node scripts/fake-job.mjs fast    -> finishes inline, no job
 *   node scripts/fake-job.mjs build   -> ~8 s of progress lines, exits 0
 *   node scripts/fake-job.mjs fail    -> quiet, then a failure, exits 1
 *   node scripts/fake-job.mjs quiet   -> silent for 30 s (stall detector should fire)
 *   node scripts/fake-job.mjs hang    -> waiting on input forever
 */

const mode = process.argv[2] ?? "build";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === "fast") {
	console.log("ok");
	process.exit(0);
}

if (mode === "build") {
	console.log("> vite build");
	for (let i = 1; i <= 20; i++) {
		console.log(`transforming (${i}/20) src/mod${i}.ts`);
		await sleep(400);
	}
	console.log("1183 modules transformed.");
	console.log("✓ build complete");
	process.exit(0);
}

if (mode === "fail") {
	console.log("> pytest -q");
	console.log("collected 412 items");
	await sleep(5000);
	console.log("tests/test_db.py ....................F");
	await sleep(1500);
	console.log("AssertionError: connection still in transaction after rollback");
	console.log("1 failed, 311 passed in 42.19s");
	process.exit(1);
}

if (mode === "quiet") {
	console.log("> python train.py --epochs 50");
	console.log("loading dataset...");
	await sleep(30000);
	console.log("epoch 1 done");
	process.exit(0);
}

if (mode === "hang") {
	console.log("> npx create-app@latest my-app");
	console.log("Ok to proceed? (y)");
	await sleep(600000);
	process.exit(0);
}

if (mode === "tick") {
	// Prints on a slow-but-steady cadence: slower than a stall threshold would like, but plainly alive.
	// Used to check that silence is not re-reported every time it pauses.
	const times = Number(process.argv[3] ?? 4);
	const every = Number(process.argv[4] ?? 1200);
	for (let i = 1; i <= times; i++) {
		console.log(`tick ${i}`);
		await sleep(every);
	}
	process.exit(0);
}

console.error(`unknown mode: ${mode}`);
process.exit(2);
