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
  .option('-c, --config <path>', 'Path to config file', './pnpm-airgap.config.json')
  .option('-l, --lockfile <path>', 'Path to pnpm-lock.yaml', './pnpm-lock.yaml')
  .option('-o, --output <path>', 'Output directory for packages', './airgap-packages')
  .action(async (options) => {
    const fetcher = require('../lib/online-fetcher');

    try {
      // Load config
      let config = {};
      if (await fs.pathExists(options.config)) {
        config = await fs.readJson(options.config);
      }

      // Merge CLI options with config
      const finalConfig = {
        lockfilePath: options.lockfile,
        outputDir: options.output,
        concurrency: 5,
        registryUrl: 'https://registry.npmjs.org',
        ...config,
        ...options
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
  .option('-c, --config <path>', 'Path to config file', './pnpm-airgap.config.json')
  .option('-p, --packages <path>', 'Path to packages directory', './airgap-packages')
  .option('-r, --registry <url>', 'Verdaccio registry URL', 'http://localhost:4873')
  .action(async (options) => {
    const publisher = require('../lib/offline-publisher');

    try {
      // Load config
      let config = {};
      if (await fs.pathExists(options.config)) {
        config = await fs.readJson(options.config);
      }

      // Merge CLI options with config
      const finalConfig = {
        packagesDir: options.packages,
        registryUrl: options.registry,
        concurrency: 3,
        ...config,
        ...options
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
