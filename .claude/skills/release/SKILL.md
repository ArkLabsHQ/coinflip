---
name: release
description: Use when cutting a new version release for coinflip — "bump and release", "cut a release", "ship vX.Y.Z", "tag and release". Bumps package.json, pushes to master, pushes a vX.Y.Z tag, and publishes a GitHub release. Tagging is what triggers the version-pinned Docker images via docker.yml.
---

# Bump & Release (coinflip)

Cut a versioned release: bump `package.json`, push to master, push a `vX.Y.Z` tag, publish a GitHub release.

**There is no release automation.** The only workflows are `docker.yml` and `e2e.yml`; neither creates tags or releases. `docker.yml` only *reacts* to pushes:
- **push to `master`** → builds + pushes `…-server` / `-client` / `-bundle` images tagged `:latest`, `:master`, `:sha-<sha>`.
- **push of a `v*` tag** → builds + pushes the **semver** images `:X.Y.Z` and `:vX.Y.Z`. The version comes from the **git tag**, NOT `package.json`.

So: pushing to master ships `:latest`; the **tag** is what produces a version-pinned image. Always tag, then release.

## Steps

**1. Pick the version (semver).** Gauge scope against the last tag:
```bash
git fetch origin master --tags
LAST=$(git describe --tags --abbrev=0)        # e.g. v0.4.1
git diff "$LAST"..origin/master --stat
```
- Only `.github/`, tests, docs, CI → **patch** (`x.y.Z+1`)
- Backward-compatible feature / endpoint / UI → **minor** (`x.Y+1.0`)
- Breaking protocol/API change → **major** (`X+1.0.0`)

If it's ambiguous, ask the maintainer. NB: `package.json` historically lagged the tags (it sat at `0.3.20` through `v0.4.0`) — set it to the **new** version regardless of what's there.

**2. Bump `package.json`** (root) — the `"version"` field, no `v` prefix:
```jsonc
"version": "0.4.2",
```

**3. Commit (package.json ONLY) + push to master.** Leave any unrelated dirty files unstaged:
```bash
git add package.json
git commit -m "chore(release): v0.4.2 — <one-line summary>"
git push origin master        # → docker.yml builds :latest/:master/:sha + e2e.yml runs
```

**4. Tag + push the tag.** This repo's git config **forces annotated tags** (a lightweight `git tag vX.Y.Z` fails with `fatal: no tag message?`):
```bash
git tag -a v0.4.2 -m "v0.4.2"
git push origin v0.4.2        # → docker.yml builds the semver images :0.4.2 / :v0.4.2
```

**5. Publish the GitHub release** from the existing tag. Write notes to a file — inline `--notes "…backticks…"` breaks in the shell — and do NOT pass `--target <sha>` (it errors `target_commitish is invalid`; gh attaches to the existing tag):
```bash
cat > /tmp/rel-notes.md <<'EOF'
## v0.4.2 — <summary>

### Fixed / Added / Changed
- …

**Full changelog:** https://github.com/ArkLabsHQ/coinflip/compare/v0.4.1...v0.4.2
EOF
gh release create v0.4.2 --title "v0.4.2 — <summary>" --notes-file /tmp/rel-notes.md
rm -f /tmp/rel-notes.md
```

**6. Verify** both image builds + the release-commit e2e are green:
```bash
gh run list --workflow docker.yml --limit 3 --json headSha,headBranch,conclusion \
  -q '.[] | (.headSha[0:8])+" "+.headBranch+" "+(.conclusion // "running")'   # expect master + vX.Y.Z both success
gh run list --branch master --workflow "E2E Tests" --limit 1 --json conclusion -q '.[0].conclusion'
git rev-list -n1 v0.4.2 | cut -c1-8        # tag should point at the bump commit
gh release view v0.4.2 --json tagName,url
```
The bump commit is package.json-only, so its e2e matches the prior green commit — confirm green, don't assume.

## Gotchas (learned the hard way)
- **`package.json` does NOT drive Docker tags** — `docker.yml`'s `type=semver` reads the git ref. The tag is mandatory for a pinned image; bump+push alone only gives `:latest`.
- **`gh release create --target <short-sha>`** → `target_commitish is invalid`. Omit `--target` (gh tags default-branch HEAD), or pre-create the tag (step 4) so gh just attaches.
- **`git tag vX.Y.Z`** (lightweight) → `fatal: no tag message?` — repo forces annotated. Use `git tag -a … -m …`.
- **`gh release create --notes "…"`** with backticks fails in the shell — use `--notes-file`.
- Direct `git push origin master` is allowed (no PR for the bump). Stage **only** `package.json`.
- Any push to master triggers the full ~15min e2e (no path filter yet) — expected, not an error.
