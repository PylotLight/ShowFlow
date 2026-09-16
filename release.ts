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
 * Uses the `gh` CLI (GitHub's official tool) for tagging + release creation.
 * `gh` must be logged in with an account that has write access to the repo
 * (e.g. behind a PylotLight-scoped token). The historical `ghp` wrapper was
 * a laptop-only convenience and was dropped in favor of standard `gh`.
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
// [skip ci]: the version bump carries no code change — the release event
// build right after this is the one that ships, so skip the duplicate run.
await Bun.$`git commit -m ${`chore: bump version to ${version} [skip ci]`}`;
await Bun.$`git tag ${tag}`;

await Bun.$`git push origin main --tags`;

// Release notes come from CHANGELOG.md's [Unreleased] section so published
// releases carry the real notes (previously --generate-notes left only an
// auto compare-link). After a successful release the section rotates into a
// versioned heading, keeping the changelog accurate per version.
const changelog = await Bun.file("CHANGELOG.md").text();
const unreleasedHead = "## [Unreleased]";
const headIdx = changelog.indexOf(unreleasedHead);
let notesFile: string | null = null;
let unreleasedBody = "";
if (headIdx !== -1) {
  const bodyStart = headIdx + unreleasedHead.length;
  const nextHead = changelog.indexOf("\n## ", bodyStart);
  unreleasedBody = changelog.slice(bodyStart, nextHead === -1 ? undefined : nextHead).trim();
}
if (unreleasedBody) {
  notesFile = `${process.env.TMPDIR ?? "/tmp"}/showflow-release-notes-${version}.md`;
  await Bun.write(notesFile, `# ${tag}\n\n${unreleasedBody}\n`);
  await Bun.$`gh release create ${tag} --title ${tag} --verify-tag --notes-file ${notesFile}`;
} else {
  await Bun.$`gh release create ${tag} --title ${tag} --verify-tag --generate-notes`;
}

if (unreleasedBody && headIdx !== -1) {
  const today = new Date().toISOString().slice(0, 10);
  const bodyStart = headIdx + unreleasedHead.length;
  const nextHead = changelog.indexOf("\n## ", bodyStart);
  const before = changelog.slice(0, bodyStart);
  const after = nextHead === -1 ? "" : changelog.slice(nextHead);
  const rotated = `${before}\n\n## [${tag}] - ${today}\n${unreleasedBody}\n${after}`;
  await Bun.write("CHANGELOG.md", rotated);
  await Bun.$`git add CHANGELOG.md`;
  // [skip ci]: changelog-only commit — nothing to build.
  await Bun.$`git commit -m ${`chore: rotate changelog for ${tag} [skip ci]`}`;
  await Bun.$`git push origin main`;
}

console.log(`✓ Released ${tag}`);