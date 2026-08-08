import pkg from "./package.json" with { type: "json" };

/**
 * Release automation: bump the patch (or minor / major) version in
 * package.json, commit + tag + push, then create the GitHub release.
 *
 *   bun run release              # patch bump (0.1.12 -> 0.1.13)
 *   bun run release -- minor     # minor bump (0.1.12 -> 0.2.0)
 *   bun run release -- major     # major bump (0.1.12 -> 1.0.0)
 *   bun run release -- 1.2.3     # explicit version
 *
 * Uses the `ghp` provider wrapper (PylotLight-scoped GitHub token) rather
 * than the global `gh`, which is authenticated as a read-only account.
 */

const bumpArg = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

const versionMatch = /^(\d+)\.(\d+)\.(\d+)/.exec(pkg.version as string);
if (!versionMatch) {
  console.error(`Cannot parse current version from package.json: ${pkg.version}`);
  process.exit(1);
}
const major = Number(versionMatch[1]);
const minor = Number(versionMatch[2]);
const patch = Number(versionMatch[3]);

function nextVersion(requested?: string): string {
  if (requested && /^\d+\.\d+\.\d+/.test(requested)) return requested;
  switch (requested) {
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

const version = nextVersion(bumpArg);
const tag = `v${version}`;

if (version === pkg.version) {
  console.error(`Version ${pkg.version} is already released. Pass major/minor or an explicit version.`);
  process.exit(1);
}

const dirty = await Bun.$`git status --porcelain`.text();
if (dirty.trim()) {
  console.error(`Working tree is not clean:\n${dirty}`);
  process.exit(1);
}

console.log(`Releasing ${pkg.version} -> ${version} (tag ${tag})${dryRun ? " [dry-run]" : ""}`);
if (dryRun) process.exit(0);

// Bump package.json
const json = JSON.parse(await Bun.file("package.json").text());
json.version = version;
await Bun.write("package.json", JSON.stringify(json, null, 2) + "\n");

await Bun.$`git add package.json`;
await Bun.$`git commit -m ${`chore: bump version to ${version}`}`;
await Bun.$`git tag ${tag}`;

await Bun.$`git push origin main --tags`;

await Bun.$`ghp release create ${tag} --title ${tag} --verify-tag --generate-notes`;

console.log(`✓ Released ${tag}`);