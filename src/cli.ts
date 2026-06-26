/**
 * pnpm-airgap CLI
 * Transfer pnpm dependencies between online and offline environments
 */

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { fetchDependencies } from './commands/fetch.js';
import { publishPackages } from './commands/publish.js';
import { syncRegistries } from './commands/sync.js';
import { exportRegistryState, registryStateFromLockfile } from './commands/registry-state.js';
import { prunePackages } from './commands/prune.js';
import { runInteractiveMode } from './ui/interactive.js';
import { DEFAULT_CONFIG } from './constants.js';

// Version is injected at build time via tsup define
const packageVersion = process.env.npm_package_version || '2.4.0';

const program = new Command();

program
  .name('pnpm-airgap')
  .description('Transfer pnpm dependencies between online and offline environments')
  .version(packageVersion);

// Fetch command
program
  .command('fetch')
  .description('Fetch all dependencies from pnpm lockfile')
  .option('-c, --config <path>', 'Path to config file')
  .option('-l, --lockfile <path>', 'Path to pnpm-lock.yaml')
  .option('-o, --output <path>', 'Output directory for packages')
  .option('-r, --registry <url>', 'Source registry URL')
  .option('--registry-state <path>', 'Registry state file for incremental fetching')
  .option('--skip-optional', 'Skip optional dependencies')
  .option('--concurrency <number>', 'Concurrent downloads', parseInt)
  .option('--debug', 'Enable debug output')
  .action(async (options) => {
    try {
      const config = await loadConfig(options.config);

      const result = await fetchDependencies({
        ...config.fetch,
        ...(options.lockfile && { lockfilePath: options.lockfile }),
        ...(options.output && { outputDir: options.output }),
        ...(options.registry && { registryUrl: options.registry }),
        ...(options.registryState && { registryStatePath: options.registryState }),
        ...(options.skipOptional && { skipOptional: true }),
        ...(options.concurrency && { concurrency: options.concurrency }),
        ...(options.debug && { debug: true }),
      });

      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      if (options.debug) console.error((error as Error).stack);
      process.exit(1);
    }
  });

// Publish command
program
  .command('publish')
  .description('Publish all packages to local registry')
  .option('-c, --config <path>', 'Path to config file')
  .option('-p, --packages <path>', 'Path to packages directory')
  .option('-r, --registry <url>', 'Registry URL')
  .option('--concurrency <number>', 'Concurrent publishes', parseInt)
  .option('--no-skip-existing', 'Publish all packages even if they exist')
  .option('--dry-run', 'Show what would be published')
  .option('--debug', 'Enable debug output')
  .action(async (options) => {
    try {
      const config = await loadConfig(options.config);

      const result = await publishPackages({
        ...config.publish,
        ...(options.packages && { packagesDir: options.packages }),
        ...(options.registry && { registryUrl: options.registry }),
        ...(options.concurrency && { concurrency: options.concurrency }),
        skipExisting: options.skipExisting !== false,
        ...(options.dryRun && { dryRun: true }),
        ...(options.debug && { debug: true }),
      });

      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      if (options.debug) console.error((error as Error).stack);
      process.exit(1);
    }
  });

// Sync command
program
  .command('sync')
  .description('Sync packages from one registry to another')
  .option('-c, --config <path>', 'Path to config file')
  .option('-s, --source <url>', 'Source registry URL')
  .option('-d, --dest <url>', 'Destination registry URL')
  .option('-o, --output <path>', 'Output directory')
  .option('--scope <scope>', 'Only sync packages in this scope')
  .option('--package-list <path>', 'File with packages to sync')
  .option('--max-versions <number>', 'Max versions per package', parseInt)
  .option('--since <date>', 'Only sync versions after this date')
  .option('--concurrency <number>', 'Concurrent operations', parseInt)
  .option('--download-only', 'Only download, do not publish')
  .option('--publish-only', 'Only publish existing packages')
  .option('--no-skip-existing', 'Re-publish existing packages')
  .option('--dry-run', 'Show what would be synced')
  .option('--debug', 'Enable debug output')
  .action(async (options) => {
    try {
      const config = await loadConfig(options.config);

      if (!options.source && !config.sync?.sourceRegistry) {
        console.error(chalk.red('Source registry URL is required'));
        console.error(chalk.gray('Use -s/--source or set sync.sourceRegistry in config'));
        process.exit(1);
      }

      if (!options.downloadOnly && !options.dest && !config.sync?.destRegistry) {
        console.error(chalk.red('Destination registry URL is required'));
        console.error(chalk.gray('Use -d/--dest or set sync.destRegistry in config'));
        process.exit(1);
      }

      const result = await syncRegistries({
        ...config.sync,
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
        ...(options.debug && { debug: true }),
      });

      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      if (options.debug) console.error((error as Error).stack);
      process.exit(1);
    }
  });

// Registry State commands
const registryState = program
  .command('registry-state')
  .description('Export and manage registry state');

registryState
  .command('export')
  .description('Export all packages from a registry')
  .option('-c, --config <path>', 'Path to config file')
  .option('-r, --registry <url>', 'Registry URL')
  .option('-o, --output <path>', 'Output file path')
  .option('-s, --scope <scope>', 'Only export packages in this scope')
  .option('--concurrency <number>', 'Concurrent operations', parseInt)
  .option('--debug', 'Enable debug output')
  .action(async (options) => {
    try {
      const config = await loadConfig(options.config);

      if (!options.registry && !config.registryState?.registryUrl) {
        console.error(chalk.red('Registry URL is required'));
        console.error(chalk.gray('Use -r/--registry or set registryState.registryUrl in config'));
        process.exit(1);
      }

      const result = await exportRegistryState({
        ...config.registryState,
        ...(options.registry && { registryUrl: options.registry }),
        ...(options.output && { outputPath: options.output }),
        ...(options.scope && { scope: options.scope }),
        ...(options.concurrency && { concurrency: options.concurrency }),
        ...(options.debug && { debug: true }),
      });

      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      if (options.debug) console.error((error as Error).stack);
      process.exit(1);
    }
  });

registryState
  .command('from-lockfile')
  .description('Build registry state from a pnpm lockfile')
  .option('-c, --config <path>', 'Path to config file')
  .option('-l, --lockfile <path>', 'Path to pnpm-lock.yaml')
  .option('-o, --output <path>', 'Output file path')
  .option('-m, --merge <path>', 'Existing registry-state to merge with')
  .option('-r, --registry <label>', 'Registry label for the output')
  .option('--skip-optional', 'Skip optional dependencies')
  .option('--debug', 'Enable debug output')
  .action(async (options) => {
    try {
      const result = await registryStateFromLockfile({
        ...(options.lockfile && { lockfilePath: options.lockfile }),
        ...(options.output && { outputPath: options.output }),
        ...(options.merge && { mergeWith: options.merge }),
        ...(options.registry && { registry: options.registry }),
        ...(options.skipOptional && { skipOptional: true }),
        ...(options.debug && { debug: true }),
      });

      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      if (options.debug) console.error((error as Error).stack);
      process.exit(1);
    }
  });

// Prune command
program
  .command('prune')
  .description('Remove registry versions not referenced by any consumer lockfile')
  .option('-l, --lockfile <paths...>', 'One or more pnpm-lock.yaml paths (union = keep-set)')
  .option('-r, --registry <url>', 'Registry URL')
  .option('--prune-orphans', 'Also remove whole packages absent from every lockfile')
  .option('--keep <names...>', 'Package names protected from orphan removal')
  .option('--concurrency <number>', 'Concurrent unpublishes', parseInt)
  .option('--yes', 'Execute removals (default is dry-run)')
  .option('--debug', 'Enable debug output')
  .action(async (options) => {
    try {
      if (!options.registry) {
        console.error(chalk.red('Registry URL is required'));
        console.error(chalk.gray('Use -r/--registry'));
        process.exit(1);
      }

      const result = await prunePackages({
        ...(options.lockfile && { lockfiles: options.lockfile }),
        registryUrl: options.registry,
        ...(options.concurrency && { concurrency: options.concurrency }),
        ...(options.pruneOrphans && { pruneOrphans: true }),
        ...(options.keep && { keep: options.keep }),
        dryRun: !options.yes,
        ...(options.debug && { debug: true }),
      });

      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      if (options.debug) console.error((error as Error).stack);
      process.exit(1);
    }
  });

// Init command
program
  .command('init')
  .description('Create a default configuration file')
  .option('--force', 'Overwrite existing config')
  .action(async (options) => {
    const configPath = './pnpm-airgap.config.json';

    if ((await fs.pathExists(configPath)) && !options.force) {
      console.log(chalk.yellow('Config file already exists'));
      console.log(chalk.gray('Use --force to overwrite'));
      return;
    }

    await fs.writeJson(configPath, DEFAULT_CONFIG, { spaces: 2 });
    console.log(chalk.green('✓ Created pnpm-airgap.config.json'));
  });

// Info command
program
  .command('info')
  .description('Show information about a packages bundle')
  .argument('<path>', 'Path to packages directory')
  .action(async (packagesPath) => {
    try {
      console.log(chalk.bold(`\n📦 Bundle Info: ${path.resolve(packagesPath)}\n`));

      if (await fs.pathExists(packagesPath)) {
        const files = await fs.readdir(packagesPath);
        const tarballs = files.filter((f) => f.endsWith('.tgz'));
        console.log(`Tarballs: ${chalk.bold(tarballs.length)}`);
      }

      const metadataPath = path.join(packagesPath, 'metadata.json');
      if (await fs.pathExists(metadataPath)) {
        const metadata = await fs.readJson(metadataPath);
        console.log(`Packages: ${chalk.bold(metadata.packageCount || metadata.packages?.length || 'N/A')}`);
        console.log(chalk.gray(`Created: ${metadata.timestamp || 'N/A'}`));
        if (metadata.registryUrl) {
          console.log(chalk.gray(`Registry: ${metadata.registryUrl}`));
        }
      }

      const bundleInfoPath = path.join(packagesPath, 'bundle-info.json');
      if (await fs.pathExists(bundleInfoPath)) {
        const bundleInfo = await fs.readJson(bundleInfoPath);
        console.log(`\n${chalk.bold('Fetch Summary')}`);
        console.log(chalk.green(`  Downloaded: ${bundleInfo.successfulDownloads || 0}`));
        console.log(chalk.gray(`  Skipped: ${bundleInfo.skippedDownloads || 0}`));
        if (bundleInfo.failedDownloads > 0) {
          console.log(chalk.red(`  Failed: ${bundleInfo.failedDownloads}`));
        }
      }

      const reportPath = path.join(packagesPath, 'publish-report.json');
      if (await fs.pathExists(reportPath)) {
        const report = await fs.readJson(reportPath);
        console.log(`\n${chalk.bold('Publish Summary')}`);
        console.log(chalk.green(`  Published: ${report.published || report.successful || 0}`));
        console.log(chalk.gray(`  Skipped: ${report.skipped || 0}`));
        if (report.failed > 0) {
          console.log(chalk.red(`  Failed: ${report.failed}`));
        }
      }

      console.log();
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      process.exit(1);
    }
  });

// Helper to load config file
async function loadConfig(configPath?: string): Promise<typeof DEFAULT_CONFIG> {
  const configFile = configPath || './pnpm-airgap.config.json';
  if (await fs.pathExists(configFile)) {
    const loaded = await fs.readJson(configFile);
    return { ...DEFAULT_CONFIG, ...loaded };
  }
  return { ...DEFAULT_CONFIG };
}

// If no arguments provided, run interactive mode
if (process.argv.length <= 2) {
  runInteractiveMode().catch((error) => {
    console.error(chalk.red('Error:'), error.message);
    process.exit(1);
  });
} else {
  program.parse();
}
