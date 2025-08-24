#!/usr/bin/env node
const { program } = require('commander');
const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');
const packageJson = require('../package.json');

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
  .action(async (options) => {
    const fetcher = require('../lib/online-fetcher');

    try {
      // Load config
      const configPath = options.config || './pnpm-airgap.config.json';
      let config = {};
      if (await fs.pathExists(configPath)) {
        config = await fs.readJson(configPath);
      }

      // Merge CLI options with config - smart defaults handling
      const finalConfig = {
        // Base defaults
        lockfilePath: './pnpm-lock.yaml',
        outputDir: './airgap-packages',
        concurrency: 5,
        registryUrl: 'https://registry.npmjs.org',
        skipOptional: false,
        // Config file overrides defaults (use fetch section)
        ...(config.fetch || {}),
        // Only CLI options that were actually provided override config
        ...(options.lockfile && { lockfilePath: options.lockfile }),
        ...(options.output && { outputDir: options.output })
      };

      console.log(chalk.blue('🚀 Starting dependency fetch...'));
      console.log(chalk.gray(`Lockfile: ${finalConfig.lockfilePath}`));
      console.log(chalk.gray(`Output: ${finalConfig.outputDir}`));

      await fetcher.fetchDependencies(finalConfig);

      console.log(chalk.green('✅ All dependencies fetched successfully!'));
      console.log(chalk.yellow(`📦 Packages saved to: ${path.resolve(finalConfig.outputDir)}`));
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error.message);
      process.exit(1);
    }
  });

program
  .command('publish')
  .description('Publish all packages to local registry (offline mode)')
  .option('-c, --config <path>', 'Path to config file')
  .option('-p, --packages <path>', 'Path to packages directory')
  .option('-r, --registry <url>', 'Verdaccio registry URL')
  .action(async (options) => {
    const publisher = require('../lib/offline-publisher');

    try {
      // Load config
      const configPath = options.config || './pnpm-airgap.config.json';
      let config = {};
      if (await fs.pathExists(configPath)) {
        config = await fs.readJson(configPath);
      }

      // Merge CLI options with config - smart defaults handling
      const finalConfig = {
        // Base defaults
        packagesDir: './airgap-packages',
        registryUrl: 'http://localhost:4873',
        concurrency: 3,
        skipExisting: true,
        // Config file overrides defaults (use publish section)
        ...(config.publish || {}),
        // Only CLI options that were actually provided override config
        ...(options.packages && { packagesDir: options.packages }),
        ...(options.registry && { registryUrl: options.registry })
      };

      console.log(chalk.blue('🚀 Starting package publishing...'));
      console.log(chalk.gray(`Packages: ${finalConfig.packagesDir}`));
      console.log(chalk.gray(`Registry: ${finalConfig.registryUrl}`));
      console.log(chalk.yellow('⚠️  Make sure you are logged in to the registry:'));
      console.log(chalk.gray(`   npm login --registry ${finalConfig.registryUrl}`));
      console.log();

      await publisher.publishPackages(finalConfig);

      console.log(chalk.green('✅ All packages published successfully!'));
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error.message);
      process.exit(1);
    }
  });

program
  .command('bootstrap')
  .description('Publish packages without dependencies (for initial Verdaccio setup)')
  .option('-p, --packages <path>', 'Path to packages directory', './airgap-packages')
  .option('-r, --registry <url>', 'Verdaccio registry URL', 'http://localhost:4873')
  .action(async (options) => {
    const bootstrap = require('../lib/bootstrap-publisher');

    try {
      console.log(chalk.blue('🚀 Bootstrap mode - dependency-free publishing'));
      console.log(chalk.yellow('⚠️  Make sure you are logged in to the registry:'));
      console.log(chalk.gray(`   npm login --registry ${options.registry}`));
      console.log();

      await bootstrap.bootstrapPublish(options.packages, options.registry);

      console.log(chalk.green('✅ Bootstrap publishing complete!'));
      console.log(chalk.gray('You can now install pnpm-airgap normally and use the full publish command.'));
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error.message);
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Create a default configuration file')
  .action(async () => {
    const defaultConfig = {
      fetch: {
        lockfilePath: './pnpm-lock.yaml',
        outputDir: './airgap-packages',
        concurrency: 5,
        registryUrl: 'https://registry.npmjs.org',
        skipOptional: false
      },
      publish: {
        packagesDir: './airgap-packages',
        registryUrl: 'http://localhost:4873',
        concurrency: 3,
        skipExisting: true
      }
    };

    const configPath = './pnpm-airgap.config.json';

    if (await fs.pathExists(configPath)) {
      console.log(chalk.yellow('⚠️  Config file already exists'));
      return;
    }

    await fs.writeJson(configPath, defaultConfig, { spaces: 2 });
    console.log(chalk.green('✅ Created pnpm-airgap.config.json'));
  });

program.parse();
