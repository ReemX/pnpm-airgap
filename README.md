# pnpm-airgap

Transfer pnpm project dependencies between online and offline environments with ease.

## Features

- 🚀 **Fast parallel downloads** - Configurable concurrency for optimal speed
- 📦 **Support for pnpm v9+** - Compatible with latest lockfile formats
- 🔐 **Secure authentication** - Uses standard npm credentials
- 🎯 **Multiple versions support** - Handles different versions of the same package
- 📊 **Detailed reporting** - Track success, failures, and skipped packages
- 🛡️ **Robust error handling** - Continues on individual failures

## Installation

```bash
npm install -g pnpm-airgap
```

### Bootstrap Installation (For Empty Registries)

If your offline registry doesn't have the dependencies needed to install this package itself, you can use the dependency-free bootstrap publisher:

1. **Extract this package tarball** to your offline machine:
   ```bash
   tar -xzf pnpm-airgap-1.0.0.tgz
   cd package
   ```

2. **Use the bootstrap publisher** to publish packages with zero dependencies:
   ```bash
   # Method 1: Using the CLI command (recommended)
   node bin/cli.js bootstrap --packages ./airgap-packages --registry http://localhost:4873
   
   # Method 2: Direct script execution
   node lib/bootstrap-publisher.js ./airgap-packages http://localhost:4873
   ```

The bootstrap publisher uses only Node.js built-in modules and can publish packages even when your registry is completely empty.

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

First, ensure Verdaccio is running:
```bash
# Install and start Verdaccio (if not already running)
npm install -g verdaccio
verdaccio
```

Authenticate with your local registry:
```bash
npm login --registry http://localhost:4873
```

Publish the packages:
```bash
pnpm-airgap publish --packages ./airgap-packages --registry http://localhost:4873
```

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
tar -xzf pnpm-airgap-1.0.0.tgz
cd package

# Use bootstrap publisher with zero dependencies
node bin/cli.js bootstrap --packages ../airgap-packages

# Now you can install pnpm-airgap normally
npm install -g pnpm-airgap
```

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
- **pnpm**: All versions (including v9+)
- **Verdaccio**: 4.x and 5.x
- **npm**: For authentication and publishing

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions, please use the GitHub issue tracker.
