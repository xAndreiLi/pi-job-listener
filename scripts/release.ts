/**
 * Release helper: verify, test, bump, commit, and tag in one step.
 *
 * Usage:
 *   npm run release -- 0.2.0        # explicit version
 *   npm run release -- minor        # major | minor | patch
 *
 * The CHANGELOG section for the target version must be written (and committed) first.
 * Publishing happens in CI when the tag is pushed:
 *   git push origin main --follow-tags
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const PACKAGE = "pi-job-listener";

function fail(message: string): never {
	console.error(`\nrelease: ${message}\n`);
	process.exit(1);
}

function capture(command: string, args: string[]): string {
	return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function run(command: string, args: string[]): void {
	execFileSync(command, args, { stdio: "inherit" });
}

/** npm is npm.cmd on Windows, which Node only spawns through a shell. */
function runNpm(args: string[]): void {
	execFileSync(NPM, args, { stdio: "inherit", ...(process.platform === "win32" ? { shell: true } : {}) });
}

function bump(version: string, kind: "major" | "minor" | "patch"): string {
	const [major, minor, patch] = version.split(".").map((part) => Number(part));
	if (kind === "major") return `${major + 1}.0.0`;
	if (kind === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

const requested = process.argv[2];
if (!requested) fail("usage: npm run release -- <version|major|minor|patch>");

const branch = capture("git", ["branch", "--show-current"]);
if (branch !== "main") fail(`release from main (currently on ${branch})`);

const dirty = capture("git", ["status", "--porcelain"]).split("\n").filter(Boolean);
if (dirty.length > 0) fail(`working tree is not clean:\n  ${dirty.join("\n  ")}`);

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const current = pkg.version;
const next = ["major", "minor", "patch"].includes(requested)
	? bump(current, requested as "major" | "minor" | "patch")
	: requested;
if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`invalid version "${requested}"`);
if (next === current) fail(`version is already ${current}`);

const changelog = readFileSync("CHANGELOG.md", "utf8");
if (!changelog.includes(`## ${next} `)) {
	fail(`CHANGELOG.md has no "## ${next}" section — write and commit it first`);
}

const existingTag = capture("git", ["tag", "--list", `v${next}`]);
if (existingTag) fail(`tag v${next} already exists`);

console.log(`\nrelease: ${current} → ${next}\n`);
runNpm(["run", "test:all"]);

runNpm(["version", next, "--no-git-tag-version", "--allow-same-version"]);
run("git", ["add", "package.json", "CHANGELOG.md"]);
run("git", ["commit", "-m", `chore(release): ${next}`]);
run("git", ["tag", "-a", `v${next}`, "-m", `${PACKAGE} ${next}`]);

console.log(
	[
		"",
		`Tagged v${next}. Publish it with:`,
		"",
		"  git push origin main --follow-tags",
		"",
		"CI (.github/workflows/publish.yml) runs the full test suite and publishes on the tag.",
		"",
	].join("\n"),
);
