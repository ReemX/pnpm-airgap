# pnpm-airgap

**The complete solution for transferring pnpm dependencies to air-gapped environments.**

## The Problem

Getting pnpm projects into secure, offline, or air-gapped environments is challenging:

- **No tooling for pnpm lockfiles** - Existing airgap tools only work with npm's package-lock.json
- **Complex dependency trees** - pnpm's advanced resolution (peer deps, optionals, workspaces) makes manual approaches nearly impossible
- **Registry population gap** - No automated way to populate offline registries with pnpm project dependencies

## The Solution

**pnpm-airgap** is a standalone tool that:

- Reads `pnpm-lock.yaml` and downloads ALL dependencies
- Publishes packages to any npm-compatible registry (Verdaccio, Nexus, Artifactory)
- Works as a single file - no `npm install` required in airgap
- Supports pnpm lockfile versions 5.x, 6.x, and 9.x

## Quick Start

### 1. Download the standalone CLI

The CLI is a single file (~1.1MB) that runs with just Node.js:

```bash
# From npm (online)
npm pack pnpm-airgap
tar -xzf pnpm-airgap-*.tgz
# Use: node package/dist/cli.cjs

# Or build from source
pnpm install && pnpm build
# Use: node dist/cli.cjs
```

### 2. Fetch dependencies (online)

```bash
node cli.cjs fetch -l ./pnpm-lock.yaml -o ./packages
```

### 3. Transfer to airgap

Copy the `packages` folder and `cli.cjs` to your air-gapped environment.

### 4. Publish to local registry (airgap)

```bash
# Start your registry (e.g., Verdaccio)
verdaccio &

# Login
npm login --registry http://localhost:4873

# Publish all packages
node cli.cjs publish -p ./packages -r http://localhost:4873
```

### 5. Install your project

```bash
pnpm install --registry http://localhost:4873
```

## Interactive Mode

Run without arguments for a guided wizard:

```bash
node cli.cjs
```

```
┌─────────────────────────────────────────┐
│  pnpm-airgap v2.0.0                     │
│  Transfer dependencies to air-gapped    │
│  environments with ease                 │
└─────────────────────────────────────────┘

? What would you like to do?
  ❯ 📦 Fetch dependencies from lockfile
    📤 Publish packages to registry
    🔄 Sync registries
    📊 Export registry state
    📖 Quick start guide
    ✖ Exit
```

## Commands

### `fetch` - Download packages from lockfile

```bash
node cli.cjs fetch [options]

Options:
  -l, --lockfile <path>      Path to pnpm-lock.yaml (default: ./pnpm-lock.yaml)
  -o, --output <path>        Output directory (default: ./airgap-packages)
  -r, --registry <url>       Source registry (default: https://registry.npmjs.org)
  --registry-state <path>    Registry state file for incremental fetching
  --skip-optional            Skip optional dependencies
  --concurrency <number>     Parallel downloads (default: 5)
  --debug                    Enable debug output
```

### `publish` - Publish packages to registry

```bash
node cli.cjs publish [options]

Options:
  -p, --packages <path>      Packages directory (default: ./airgap-packages)
  -r, --registry <url>       Target registry (default: http://localhost:4873)
  --concurrency <number>     Parallel publishes (default: 3)
  --no-skip-existing         Publish all packages even if they exist
  --dry-run                  Preview without publishing
  --debug                    Enable debug output
```

### `sync` - Sync between registries

```bash
node cli.cjs sync [options]

Options:
  -s, --source <url>         Source registry URL
  -d, --dest <url>           Destination registry URL
  -o, --output <path>        Output directory
  --scope <scope>            Only sync packages in this scope
  --download-only            Only download, don't publish
  --publish-only             Only publish existing packages
  --dry-run                  Preview without changes
```

### `registry-state export` - Export for incremental sync

Export all packages from a registry to enable incremental fetching:

```bash
node cli.cjs registry-state export -r http://localhost:4873 -o registry-state.json

# Then use with fetch to skip existing packages
node cli.cjs fetch -l pnpm-lock.yaml --registry-state registry-state.json
```

### `info` - Show bundle information

```bash
node cli.cjs info ./packages
```

### `init` - Create config file

```bash
node cli.cjs init
```

## Configuration

Create `pnpm-airgap.config.json`:

```json
{
  "fetch": {
    "lockfilePath": "./pnpm-lock.yaml",
    "outputDir": "./airgap-packages",
    "concurrency": 5,
    "registryUrl": "https://registry.npmjs.org",
    "skipOptional": false
  },
  "publish": {
    "packagesDir": "./airgap-packages",
    "registryUrl": "http://localhost:4873",
    "concurrency": 3,
    "skipExisting": true
  },
  "sync": {
    "sourceRegistry": "",
    "destRegistry": "http://localhost:4873",
    "outputDir": "./sync-packages",
    "skipExisting": true
  }
}
```

## Features

| Feature | Description |
|---------|-------------|
| **Standalone Binary** | Single 1.1MB file, runs with just Node.js - no npm install needed |
| **Interactive Mode** | Guided wizard for all commands |
| **Auto-detection** | Finds lockfiles and package directories automatically |
| **Incremental Sync** | Export registry state to skip already-synced packages |
| **Smart Tagging** | Auto-detects prerelease tags, handles version conflicts |
| **Safety Blocks** | Prevents accidental publish to public registries (npmjs.org) |
| **Rate Limiting** | Automatic backoff for 429 errors |
| **Robust Parsing** | Handles scoped packages, aliases, patches, peer deps |

## Workflow Examples

### Complete Airgap Transfer

**Online Machine:**
```bash
# Fetch all dependencies
node cli.cjs fetch -l pnpm-lock.yaml -o ./packages

# Create transfer archive
tar -czf transfer.tar.gz packages/ cli.cjs
```

**Offline Machine:**
```bash
# Extract
tar -xzf transfer.tar.gz

# Start registry and login
verdaccio &
npm login --registry http://localhost:4873

# Publish
node cli.cjs publish -p ./packages -r http://localhost:4873

# Install your project
echo "registry=http://localhost:4873" > .npmrc
pnpm install
```

### Incremental Updates

Avoid re-downloading packages that already exist:

```bash
# Export state from airgap registry
node cli.cjs registry-state export -r http://verdaccio:4873 -o state.json

# Transfer state.json to online machine

# Fetch only missing packages
node cli.cjs fetch -l pnpm-lock.yaml --registry-state state.json -o ./packages
# Result: If lockfile needs 500 packages but 450 exist, only 50 are downloaded
```

## Programmatic API

```typescript
import { fetchDependencies, publishPackages } from 'pnpm-airgap';

// Fetch
await fetchDependencies({
  lockfilePath: './pnpm-lock.yaml',
  outputDir: './packages',
  registryUrl: 'https://registry.npmjs.org',
  concurrency: 5,
});

// Publish
await publishPackages({
  packagesDir: './packages',
  registryUrl: 'http://localhost:4873',
  concurrency: 3,
  skipExisting: true,
});
```

## Compatibility

| Component | Supported Versions |
|-----------|-------------------|
| **Node.js** | 18.0.0 or higher |
| **pnpm lockfile** | v5, v6, v9 |
| **Registries** | Verdaccio, Nexus, Artifactory, any npm-compatible |
| **Platforms** | Windows, Linux, macOS |

## Reports

Both fetch and publish commands generate JSON reports:

- `metadata.json` - Package list and metadata
- `bundle-info.json` - Download statistics
- `publish-report.json` - Publishing results

## Troubleshooting

### Authentication Issues

```bash
# Verify you're logged in
npm whoami --registry http://localhost:4873

# Re-login if needed
npm login --registry http://localhost:4873
```

### Missing Packages

Check `bundle-info.json` for download failures and ensure lockfile is current.

### Publishing Conflicts

The tool automatically handles:
- Version conflicts (uses version-specific tags)
- Prerelease versions (applies correct tags)
- Already-existing packages (skips by default)

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
pnpm test

# Lint
pnpm lint
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
