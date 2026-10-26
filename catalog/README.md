# DSH shared catalog index

`index.xml` is the reviewed, shared repository classification index submitted by DSH Melody Launcher users.

- All repositories live in one XML file.
- Rows are sorted by repository name (case-insensitive), then by full repository name.
- Each row stores only the repository, default branch, source update time, and final tags.
- Supported tags are `plugin`, `skill`, `runtime`, `preset`, `dsh`, and `invalid`.
- The launcher uses the tags to run only the detector needed to resolve current install targets.
- Pull requests are merged by a maintainer; unmerged user results never become active automatically.
- Every detection checks the latest `main` copy first. GitHub `ETag`/`304` responses avoid downloading unchanged XML; the five-minute memory cache is only a network-failure fallback.
- Each user publishes through their own fork's `plugin-update` branch. Before publishing, the launcher merges the latest upstream XML, the fork branch XML, and local results by repository name. A non-fast-forward update is re-read and retried automatically.
- Different repository rows can be merged together automatically. If two submissions change the same repository row, the later result wins in the generated XML and the maintainer can review the PR diff.

The shared XML must not contain credentials, local paths, downloaded source files, summaries, warnings, or machine-specific settings.

## Format

```xml
<?xml version="1.0" encoding="UTF-8"?>
<dsh-catalog schema="1">
  <repository name="owner/example-plugin" branch="main" updated="2026-08-18T00:00:00Z" tags="plugin"/>
  <repository name="owner/hybrid-suite" branch="main" updated="2026-08-18T00:00:00Z" tags="plugin,skill,preset"/>
  <repository name="owner/runtime-host" branch="main" updated="2026-08-18T00:00:00Z" tags="runtime"/>
</dsh-catalog>
```
