#!/usr/bin/env node
const { program } = require('commander');
const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');
const packageJson = require('../package.json');
const { DEFAULT_CONFIG } = require('../lib/constants');
const { isValidUrl, setDebugMode } = require('../lib/shared-utils');

program
  .name('pnpm-airgap')
  .description('Transfer pnpm dependencies between online and offline environments')
  .version(packageJson.version);

program
  .command('fetch')
  .description('Fetch all dependencies from pnpm lockfile (online mode)')
  .option('-c, --config <path>', 'Path to config file')
  .option('-l, --lockfile <path>', 'Path to pnpm-lock.yaml')
  .option('-o, --output <path>', 'Output directory for packages')
  .option('-r, --registry <url>', 'Source registry URL (default: https://registry.npmjs.org)')
  .option('--skip-optional', 'Skip optional dependencies')
  .option('--concurrency <number>', 'Number of concurrent downloads', parseInt)
  .option('--debug', 'Enable debug output')
  .action(async (options) => {
    const fetcher = require('../lib/online-fetcher');

    try {
      // Load config
      const configPath = options.config || './pnpm-airgap.config.json';
      let config = {};
      if (await fs.pathExists(configPath)) {
        config = await fs.readJson(configPath);
      }

      // Merge CLI options with config
      const finalConfig = {
        ...DEFAULT_CONFIG.fetch,
        ...(config.fetch || {}),
        ...(options.lockfile && { lockfilePath: options.lockfile }),
        ...(options.output && { outputDir: options.output }),
        ...(options.registry && { registryUrl: options.registry }),
        ...(options.skipOptional && { skipOptional: true }),
        ...(options.concurrency && { concurrency: options.concurrency }),
        ...(options.debug && { debug: true })
      };

      // Validate registry URL if custom
      if (options.registry && !isValidUrl(options.registry)) {
        console.error(chalk.red(`Invalid registry URL: ${options.registry}`));
        console.error(chalk.gray('URL must start with http:// or https://'));
        process.exit(1);
      }

      console.log(chalk.blue('Starting dependency fetch...'));
      console.log(chalk.gray(`Lockfile: ${finalConfig.lockfilePath}`));
      console.log(chalk.gray(`Output: ${finalConfig.outputDir}`));
      console.log(chalk.gray(`Registry: ${finalConfig.registryUrl}`));
      if (finalConfig.skipOptional) {
        console.log(chalk.gray('Skipping optional dependencies'));
      }
      console.log();

      const result = await fetcher.fetchDependencies(finalConfig);

      if (result.success) {
        console.log(chalk.green('\n✅ All dependencies fetched successfully!'));
      } else {
        console.log(chalk.yellow(`\n⚠️  Fetch completed with ${result.failed} errors`));
      }
      console.log(chalk.blue(`📦 Packages saved to: ${path.resolve(finalConfig.outputDir)}`));

      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error.message);
      if (options.debug) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program
  .command('publish')
  .description('Publish all packages to local registry (offline mode)')
  .option('-c, --config <path>', 'Path to config file')
  .option('-p, --packages <path>', 'Path to packages directory')
  .option('-r, --registry <url>', 'Verdaccio registry URL')
  .option('--concurrency <number>', 'Number of concurrent publishes', parseInt)
  .option('--no-skip-existing', 'Publish all packages even if they exist')
  .option('--dry-run', 'Show what would be published without actually publishing')
  .option('--debug', 'Enable debug output')
  .action(async (options) => {
    const publisher = require('../lib/offline-publisher');

    try {
      // Load config
      const configPath = options.config || './pnpm-airgap.config.json';
      let config = {};
      if (await fs.pathExists(configPath)) {
        config = await fs.readJson(configPath);
      }

      // Merge CLI options with config
      const finalConfig = {
        ...DEFAULT_CONFIG.publish,
        ...(config.publish || {}),
        ...(options.packages && { packagesDir: options.packages }),
        ...(options.registry && { registryUrl: options.registry }),
        ...(options.concurrency && { concurrency: options.concurrency }),
        skipExisting: options.skipExisting !== false,
        ...(options.dryRun && { dryRun: true }),
        ...(options.debug && { debug: true })
      };

      // Validate registry URL
      if (!isValidUrl(finalConfig.registryUrl)) {
        console.error(chalk.red(`Invalid registry URL: ${finalConfig.registryUrl}`));
        console.error(chalk.gray('URL must start with http:// or https://'));
        process.exit(1);
      }

      console.log(chalk.blue('Starting package publishing...'));
      console.log(chalk.gray(`Packages: ${finalConfig.packagesDir}`));
      console.log(chalk.gray(`Registry: ${finalConfig.registryUrl}`));
      if (!finalConfig.dryRun) {
        console.log(chalk.yellow('⚠️  Make sure you are logged in to the registry:'));
        console.log(chalk.gray(`   npm login --registry ${finalConfig.registryUrl}`));
      }
      console.log();

      const result = await publisher.publishPackages(finalConfig);

      if (result.success) {
        console.log(chalk.green(`\n✅ ${result.dryRun ? 'Dry run' : 'Publishing'} completed successfully!`));
      } else {
        console.log(chalk.yellow(`\n⚠️  Completed with ${result.failed} errors`));
      }

      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error.message);
      if (options.debug) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program
  .command('bootstrap')
  .description('Publish packages without dependencies (for initial Verdaccio setup)')
  .option('-p, --packages <path>', 'Path to packages directory', './airgap-packages')
  .option('-r, --registry <url>', 'Verdaccio registry URL', 'http://localhost:4873')
  .option('--dry-run', 'Show what would be published without actually publishing')
  .option('--debug', 'Enable debug output')
  .action(async (options) => {
    const bootstrap = require('../lib/bootstrap-publisher');

    try {
      // Validate registry URL
      if (!isValidUrl(options.registry)) {
        console.error(chalk.red(`Invalid registry URL: ${options.registry}`));
        console.error(chalk.gray('URL must start with http:// or https://'));
        process.exit(1);
      }

      console.log(chalk.blue('Bootstrap mode - dependency-free publishing'));
      if (!options.dryRun) {
        console.log(chalk.yellow('⚠️  Make sure you are logged in to the registry:'));
        console.log(chalk.gray(`   npm login --registry ${options.registry}`));
      }
      console.log();

      const result = await bootstrap.bootstrapPublish(options.packages, options.registry, {
        dryRun: options.dryRun,
        debug: options.debug
      });

      if (result.success) {
        console.log(chalk.green(`\n✅ Bootstrap ${result.dryRun ? 'dry run' : 'publishing'} complete!`));
        if (!result.dryRun) {
          console.log(chalk.gray('You can now install pnpm-airgap normally and use the full publish command.'));
        }
      } else {
        console.log(chalk.yellow(`\n⚠️  Bootstrap completed with ${result.failed} errors`));
      }

      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error.message);
      if (options.debug) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Create a default configuration file')
  .option('--force', 'Overwrite existing config file')
  .action(async (options) => {
    const configPath = './pnpm-airgap.config.json';

    if (await fs.pathExists(configPath) && !options.force) {
      console.log(chalk.yellow('⚠️  Config file already exists'));
      console.log(chalk.gray('Use --force to overwrite'));
      return;
    }

    await fs.writeJson(configPath, DEFAULT_CONFIG, { spaces: 2 });
    console.log(chalk.green('✅ Created pnpm-airgap.config.json'));
    console.log(chalk.gray('\nEdit this file to customize your fetch and publish settings.'));
  });

program
  .command('sync')
  .description('Sync all packages from one registry to another')
  .option('-c, --config <path>', 'Path to config file')
  .option('-s, --source <url>', 'Source registry URL to sync from')
  .option('-d, --dest <url>', 'Destination registry URL to sync to')
  .option('-o, --output <path>', 'Output directory for downloaded packages')
  .option('--scope <scope>', 'Only sync packages in this scope (e.g., @mycompany)')
  .option('--package-list <path>', 'File with list of packages to sync (one per line), or comma-separated')
  .option('--max-versions <number>', 'Maximum versions per package to sync (default: all)', parseInt)
  .option('--since <date>', 'Only sync versions published after this date (ISO format)')
  .option('--concurrency <number>', 'Number of concurrent operations', parseInt)
  .option('--download-only', 'Only download packages, do not publish')
  .option('--publish-only', 'Only publish existing packages in output directory')
  .option('--no-skip-existing', 'Re-publish packages even if they exist in destination')
  .option('--dry-run', 'Show what would be synced without actually doing it')
  .option('--debug', 'Enable debug output')
  .action(async (options) => {
    const { syncRegistries } = require('../lib/registry-sync');

    try {
      // Load config file
      const configPath = options.config || './pnpm-airgap.config.json';
      let config = {};
      if (await fs.pathExists(configPath)) {
        config = await fs.readJson(configPath);
      }

      // Merge: defaults < config file < CLI options
      const finalConfig = {
        ...DEFAULT_CONFIG.sync,
        ...(config.sync || {}),
        ...(options.source && { sourceRegistry: options.source }),
        ...(options.dest && { destRegistry: options.dest }),
        ...(options.output && { outputDir: options.output }),
        ...(options.scope && { scope: options.scope }),
        ...(options.packageList && { packageList: options.packageList }),
        ...(options.maxVersions && { maxVersions: options.maxVersions }),
        ...(options.since && { sinceDate: options.since }),
        ...(options.concurrency && { concurrency: options.concurrency }),
        ...(options.downloadOnly && { downloadOnly: true }),
        ...(options.publishOnly && { publishOnly: true }),
        skipExisting: options.skipExisting !== false,
        ...(options.dryRun && { dryRun: true }),
        ...(options.debug && { debug: true })
      };

      // Validate source URL (required)
      if (!finalConfig.sourceRegistry) {
        console.error(chalk.red('Source registry URL is required'));
        console.error(chalk.gray('Use -s/--source or set sync.sourceRegistry in config file'));
        process.exit(1);
      }
      if (!isValidUrl(finalConfig.sourceRegistry)) {
        console.error(chalk.red(`Invalid source registry URL: ${finalConfig.sourceRegistry}`));
        console.error(chalk.gray('URL must start with http:// or https://'));
        process.exit(1);
      }

      // Validate dest URL (required unless download-only)
      if (!finalConfig.downloadOnly) {
        if (!finalConfig.destRegistry) {
          console.error(chalk.red('Destination registry URL is required'));
          console.error(chalk.gray('Use -d/--dest or set sync.destRegistry in config file'));
          process.exit(1);
        }
        if (!isValidUrl(finalConfig.destRegistry)) {
          console.error(chalk.red(`Invalid destination registry URL: ${finalConfig.destRegistry}`));
          console.error(chalk.gray('URL must start with http:// or https://'));
          process.exit(1);
        }
      }

      if (!finalConfig.dryRun && !finalConfig.downloadOnly) {
        console.log(chalk.yellow('⚠️  Make sure you are logged in to the destination registry:'));
        console.log(chalk.gray(`   npm login --registry ${finalConfig.destRegistry}`));
        console.log();
      }

      const result = await syncRegistries(finalConfig);

      if (result.success) {
        console.log(chalk.green('\n✅ Sync completed successfully!'));
      } else {
        console.log(chalk.yellow(`\n⚠️  Sync completed with ${result.failed} errors`));
      }

      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error.message);
      if (options.debug) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program
  .command('info')
  .description('Show information about a packages bundle')
  .argument('<path>', 'Path to packages directory')
  .action(async (packagesPath) => {
    try {
      const metadataPath = path.join(packagesPath, 'metadata.json');
      const bundleInfoPath = path.join(packagesPath, 'bundle-info.json');
      const publishReportPath = path.join(packagesPath, 'publish-report.json');

      console.log(chalk.blue(`\n📦 Bundle Info: ${path.resolve(packagesPath)}\n`));

      // Count tarballs
      if (await fs.pathExists(packagesPath)) {
        const files = await fs.readdir(packagesPath);
        const tarballs = files.filter(f => f.endsWith('.tgz'));
        console.log(chalk.white(`Tarballs: ${tarballs.length}`));
      }

      // Show metadata
      if (await fs.pathExists(metadataPath)) {
        const metadata = await fs.readJson(metadataPath);
        console.log(chalk.white(`Packages in metadata: ${metadata.packageCount || metadata.packages?.length || 'N/A'}`));
        console.log(chalk.gray(`Created: ${metadata.timestamp || 'N/A'}`));
        if (metadata.registryUrl) {
          console.log(chalk.gray(`Source registry: ${metadata.registryUrl}`));
        }
      }

      // Show bundle info
      if (await fs.pathExists(bundleInfoPath)) {
        const bundleInfo = await fs.readJson(bundleInfoPath);
        console.log(chalk.white(`\nFetch Summary:`));
        console.log(chalk.green(`  Downloaded: ${bundleInfo.successfulDownloads || 0}`));
        console.log(chalk.gray(`  Skipped: ${bundleInfo.skippedDownloads || 0}`));
        if (bundleInfo.failedDownloads > 0) {
          console.log(chalk.red(`  Failed: ${bundleInfo.failedDownloads}`));
        }
      }

      // Show publish report
      if (await fs.pathExists(publishReportPath)) {
        const report = await fs.readJson(publishReportPath);
        console.log(chalk.white(`\nPublish Summary:`));
        console.log(chalk.green(`  Published: ${report.successful || 0}`));
        console.log(chalk.gray(`  Skipped: ${report.skipped || 0}`));
        if (report.failed > 0) {
          console.log(chalk.red(`  Failed: ${report.failed}`));
        }
        console.log(chalk.gray(`  Registry: ${report.registry || 'N/A'}`));
        console.log(chalk.gray(`  Last run: ${report.timestamp || 'N/A'}`));
      }

      console.log();
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error.message);
      process.exit(1);
    }
  });

program.parse();
