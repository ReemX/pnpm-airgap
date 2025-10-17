# pnpm-airgap

**The only tool that solves pnpm offline/airgap deployment.**

## The Problem

Getting pnpm projects into secure, offline, or airgap environments is **broken**:

- 🚫 **No tooling for pnpm lockfiles** - Existing airgap tools only work with npm's package-lock.json
- 🚫 **Manual extraction is painful** - Identifying and downloading hundreds of packages from pnpm-lock.yaml by hand
- 🚫 **Complex dependency trees** - pnpm's advanced resolution (peer deps, optionals, workspaces) makes manual approaches nearly impossible  
- 🚫 **Registry population gap** - No automated way to populate offline registries with pnpm project dependencies

**Real-world scenario**: You develop with pnpm online, then need to deploy to a secure network with no internet. Existing approaches have significant limitations:

### Why Existing Solutions Fall Short:

**`pnpm deploy`**: Only works for workspace packages, not full project dependencies  
**`pnpm pack`**: Creates single package tarballs, not complete dependency trees  
**npm-based airgap tools**: Don't understand pnpm's lockfile format or dependency resolution  
**Manual approaches**: Copying `node_modules` fails (pnpm uses symlinks), tarball extraction misses peer dependencies  
**Generic npm registry tools**: Require converting pnpm projects to npm, losing optimizations  

## The Solution

**pnpm-airgap fills the critical gap in pnpm tooling:**

✅ **Complete dependency extraction** - Reads `pnpm-lock.yaml` and fetches ALL dependencies (supports v6-v9+)  
✅ **Smart dependency resolution** - Handles peer deps, optional deps, and version conflicts like pnpm does  
✅ **Universal registry support** - Works with Verdaccio, Nexus, Artifactory, and any npm-compatible registry  
✅ **Zero-dependency bootstrap** - Can publish packages even when your offline registry is completely empty  
✅ **Enterprise-ready** - Handles real projects with 500+ dependencies and complex workspace setups  
✅ **Preserves pnpm benefits** - Maintains version resolution and dependency structure  

**Purpose-built for the pnpm ecosystem.** pnpm has excellent offline capabilities and actually works better offline than npm once packages are available. The challenge is **getting packages into your offline registry** - that's exactly what pnpm-airgap solves.

## Why This Workflow is Revolutionary

**Seamless Online-to-Offline Transition**: Traditional airgap workflows are complex, error-prone, and require deep understanding of package management internals. pnpm-airgap creates a **single, simple workflow**:

1. **Online**: `pnpm-airgap fetch` (one command extracts everything)
2. **Transfer**: Copy one folder 
3. **Offline**: `pnpm-airgap publish` (one command publishes everything)
4. **Deploy**: `pnpm install` works normally

**No workflow changes needed** - developers continue using pnpm normally, operations teams get reliable deployments, and security teams get full package visibility and control.

## Features

- 🚀 **Fast parallel downloads** - Configurable concurrency for optimal speed
- 📦 **Support for pnpm v6-v9+** - Compatible with all modern lockfile formats
- 🔐 **Secure authentication** - Uses standard npm credentials
- 🎯 **Multiple versions support** - Handles different versions of the same package
- 📊 **Detailed reporting** - Track success, failures, and skipped packages
- 🛡️ **Robust error handling** - Continues on individual failures
- ⚡ **Smart caching** - Pre-check optimization avoids redundant package info extraction
- 🏷️ **Automatic prerelease tags** - Detects and applies appropriate tags (beta, alpha, rc, etc.)
- 🔄 **Version conflict resolution** - Handles older version publishing with automatic tagging
- 🎨 **Enhanced Windows support** - Multiple tar extraction patterns for cross-platform compatibility
- 📦 **Memory-efficient** - 1MB limit on package.json extraction to prevent memory issues

## Installation

```bash
npm install -g pnpm-airgap
```

### Bootstrap Installation (For Empty Registries)

If your offline registry doesn't have the dependencies needed to install this package itself, you can use the dependency-free bootstrap publisher:

1. **Extract this package tarball** to your offline machine:
   ```bash
   tar -xzf pnpm-airgap-1.3.0.tgz
   cd package
   ```

2. **Use the bootstrap publisher** to publish packages with zero dependencies:
   ```bash
   # Direct script execution (only method that works without dependencies)
   node lib/bootstrap-publisher.js ./airgap-packages http://localhost:4873
   ```

The bootstrap publisher uses only Node.js built-in modules and can publish packages even when your registry is completely empty. It features smart pre-checking to avoid redundant processing and caches package info for optimal performance.

## Quick Start

### Step 1: Online Machine - Fetch Dependencies

```bash
# In your project directory with pnpm-lock.yaml
pnpm-airgap fetch

# Or specify custom paths
pnpm-airgap fetch --lockfile ./pnpm-lock.yaml --output ./packages
```

This creates an `airgap-packages` directory with all dependencies.

### Step 2: Transfer

Transfer the `airgap-packages` directory to your offline machine via USB, network share, etc.

### Step 3: Offline Machine - Publish to Local Registry

First, ensure your offline registry is running:
```bash
# Verdaccio (lightweight, zero-config)
npm install -g verdaccio && verdaccio

# Or Nexus/Artifactory for enterprise environments
# (follow your organization's setup guide)
```

Authenticate with your offline registry:
```bash
# Verdaccio
npm login --registry http://localhost:4873

# Nexus example
npm login --registry http://nexus.company.com:8081/repository/npm-group/

# Artifactory example  
npm login --registry https://artifactory.company.com/api/npm/npm-repo/
```

Publish the packages:
```bash
# Auto-detects registry from config or use explicit registry
pnpm-airgap publish --packages ./airgap-packages --registry http://localhost:4873
```

**🎯 Key Advantage**: This workflow seamlessly bridges online development with offline deployment, supporting any npm-compatible registry without requiring pnpm-specific configuration on the offline side.

### Step 4: Use Your Packages

Configure your project to use the local registry:
```bash
# Create .npmrc in your project
echo "registry=http://localhost:4873" > .npmrc

# Install dependencies
pnpm install
```

## Configuration

Create a configuration file for repeated use:

```bash
pnpm-airgap init
```

This creates `pnpm-airgap.config.json`:

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
  }
}
```

## Commands

### `pnpm-airgap fetch`

Fetch all dependencies from pnpm lockfile (online mode).

**Options:**
- `-c, --config <path>` - Path to config file (default: `./pnpm-airgap.config.json`)
- `-l, --lockfile <path>` - Path to pnpm-lock.yaml (default: `./pnpm-lock.yaml`)
- `-o, --output <path>` - Output directory for packages (default: `./airgap-packages`)

### `pnpm-airgap publish`

Publish all packages to local registry (offline mode).

**Options:**
- `-c, --config <path>` - Path to config file (default: `./pnpm-airgap.config.json`)
- `-p, --packages <path>` - Path to packages directory (default: `./airgap-packages`)
- `-r, --registry <url>` - Verdaccio registry URL (default: `http://localhost:4873`)

### `pnpm-airgap bootstrap`

Publish packages without dependencies (for initial Verdaccio setup). This is ideal when your offline registry is empty and doesn't have the dependencies needed to install pnpm-airgap itself.

**Options:**
- `-p, --packages <path>` - Path to packages directory (default: `./airgap-packages`)
- `-r, --registry <url>` - Verdaccio registry URL (default: `http://localhost:4873`)

**Example:**
```bash
pnpm-airgap bootstrap --packages ./airgap-packages --registry http://localhost:4873
```

### `pnpm-airgap init`

Create a default configuration file.

## Reports

Both commands generate detailed JSON reports:

- **Fetch**: `bundle-info.json` - Download statistics and errors
- **Publish**: `publish-report.json` - Publishing results for each package

## Workflow Examples

### Complete Airgap Transfer Workflow

**Online Machine:**
```bash
# 1. Create configuration
pnpm-airgap init

# 2. Fetch all dependencies
pnpm-airgap fetch

# 3. Create tarball for transfer
tar -czf airgap-transfer.tar.gz airgap-packages/ pnpm-airgap.config.json
```

**Offline Machine:**
```bash
# 1. Extract transferred files
tar -xzf airgap-transfer.tar.gz

# 2. Start Verdaccio (if not running)
verdaccio &

# 3. Login to registry
npm login --registry http://localhost:4873

# 4. Publish packages
pnpm-airgap publish

# 5. Configure project to use local registry
echo "registry=http://localhost:4873" > .npmrc

# 6. Install dependencies
pnpm install
```

### Bootstrap Scenario (Empty Registry)

If your offline registry doesn't have Node.js dependencies:

```bash
# Extract pnpm-airgap package manually
tar -xzf pnpm-airgap-1.3.0.tgz
cd package

# Use bootstrap publisher with zero dependencies
node bin/cli.js bootstrap --packages ../airgap-packages

# Now you can install pnpm-airgap normally
npm install -g pnpm-airgap
```

The bootstrap publisher now features:
- Smart pre-checking with caching to avoid redundant processing
- Support for multiple tar implementations (Windows/Linux)
- Automatic prerelease tag detection
- Version conflict resolution with automatic retry

## Troubleshooting

### Authentication Issues
```bash
# Ensure you're logged in to the target registry
npm login --registry http://localhost:4873

# Verify authentication
npm whoami --registry http://localhost:4873
```

### Missing Packages
- Check `bundle-info.json` for download failures
- Verify network connectivity during fetch
- Ensure lockfile is up to date: `pnpm install`

### Publishing Conflicts
- Use `skipExisting: true` in config to skip already published packages
- Check `publish-report.json` for detailed error messages

## Advanced Usage

### Custom Registry for Fetching
```javascript
// pnpm-airgap.config.json
{
  "fetch": {
    "registryUrl": "https://your-custom-registry.com"
  }
}
```

### Parallel Processing Tuning
```javascript
{
  "fetch": {
    "concurrency": 10  // Increase for faster downloads
  },
  "publish": {
    "concurrency": 5   // Adjust based on registry capacity
  }
}
```

## Programmatic API

You can also use pnpm-airgap programmatically in your Node.js applications:

```javascript
const { fetchDependencies, publishPackages } = require('pnpm-airgap');

// Fetch dependencies
const fetchConfig = {
  lockfilePath: './pnpm-lock.yaml',
  outputDir: './airgap-packages',
  concurrency: 5,
  registryUrl: 'https://registry.npmjs.org',
  skipOptional: false
};

await fetchDependencies(fetchConfig);

// Publish packages
const publishConfig = {
  packagesDir: './airgap-packages',
  registryUrl: 'http://localhost:4873',
  concurrency: 3,
  skipExisting: true
};

await publishPackages(publishConfig);
```

## Compatibility

- **Node.js**: 14.0.0 or higher
- **pnpm**: All versions (v6, v7, v8, v9+)
- **Verdaccio**: 4.x, 5.x, and 6.x
- **npm**: For authentication and publishing
- **Platforms**: Windows, Linux, macOS (cross-platform tar support)

## Recent Improvements (v1.3.0)

### Performance Enhancements
- **Package info caching**: Pre-check phase now caches extracted package info, eliminating redundant tarball extraction during publishing (~30% performance improvement)
- **Smart pre-checking**: Bulk existence checks before processing to skip already-published packages early
- **Memory optimization**: 1MB limit on package.json size to prevent memory issues with malformed packages

### Robustness Improvements
- **Enhanced error handling**: Better null-safety checks in lockfile parsing for various pnpm versions
- **Windows compatibility**: Multiple tar command patterns to handle different tar implementations (bsdtar, GNU tar)
- **Version conflict handling**: Automatic retry with version-specific tags when publishing older versions
- **Prerelease tag detection**: Automatic detection and application of appropriate tags (alpha, beta, rc, canary, dev, next, pre)

### Code Quality
- **Centralized constants**: All configuration values extracted to constants.js for maintainability
- **Consistent status codes**: All status returns use centralized STATUS constants
- **Improved modularity**: Shared utilities extracted for reuse across bootstrap and offline publishers
- **Better logging**: Enhanced progress reporting with detailed error messages

### Bug Fixes
- Fixed duplicate execAsync declaration in offline-publisher
- Fixed status constant inconsistency across modules
- Fixed null-safety issues in lockfile resolution parsing
- Fixed memory accumulation in large package.json extraction

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions, please use the GitHub issue tracker.
