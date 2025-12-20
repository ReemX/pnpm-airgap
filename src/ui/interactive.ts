/**
 * Interactive mode - guided wizard for all commands
 */

import { select, input, confirm, checkbox } from '@inquirer/prompts';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { fetchDependencies } from '../commands/fetch.js';
import { publishPackages } from '../commands/publish.js';
import { syncRegistries } from '../commands/sync.js';
import { exportRegistryState } from '../commands/registry-state.js';
import { DEFAULTS, DEFAULT_CONFIG } from '../constants.js';

// Config file path
const CONFIG_PATH = './pnpm-airgap.config.json';

// Runtime config (loaded on start)
let config: typeof DEFAULT_CONFIG = { ...DEFAULT_CONFIG };

/**
 * Load config file if it exists
 */
async function loadConfig(): Promise<void> {
  try {
    if (await fs.pathExists(CONFIG_PATH)) {
      const loaded = await fs.readJson(CONFIG_PATH);
      config = { ...DEFAULT_CONFIG, ...loaded };
    }
  } catch {
    // Ignore errors, use defaults
  }
}

/**
 * Save config file
 */
async function saveConfig(): Promise<void> {
  try {
    await fs.writeJson(CONFIG_PATH, config, { spaces: 2 });
  } catch {
    // Ignore save errors
  }
}

// Styled banner
const BANNER = `
${chalk.bold.cyan('┌─────────────────────────────────────────┐')}
${chalk.bold.cyan('│')}  ${chalk.bold.white('pnpm-airgap')} ${chalk.gray('v2.0.0')}                     ${chalk.bold.cyan('│')}
${chalk.bold.cyan('│')}  ${chalk.gray('Transfer dependencies to air-gapped')}    ${chalk.bold.cyan('│')}
${chalk.bold.cyan('│')}  ${chalk.gray('environments with ease')}                 ${chalk.bold.cyan('│')}
${chalk.bold.cyan('└─────────────────────────────────────────┘')}
`;

// Theme for prompts
const theme = {
  prefix: chalk.cyan('?'),
  style: {
    answer: (text: string) => chalk.cyan(text),
    message: (text: string) => chalk.bold(text),
    highlight: (text: string) => chalk.cyan(text),
  },
};

/**
 * Auto-detect lockfile in current directory
 */
async function detectLockfile(): Promise<string | null> {
  const candidates = ['pnpm-lock.yaml', 'pnpm-lock.yml'];

  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) {
      return candidate;
    }
  }

  // Check parent directories
  const parentLock = path.join('..', 'pnpm-lock.yaml');
  if (await fs.pathExists(parentLock)) {
    return parentLock;
  }

  return null;
}

/**
 * Auto-detect packages directory
 */
async function detectPackagesDir(): Promise<string | null> {
  const candidates = ['airgap-packages', 'packages', 'tarballs', '.packages'];

  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) {
      const files = await fs.readdir(candidate);
      if (files.some(f => f.endsWith('.tgz'))) {
        return candidate;
      }
    }
  }

  return null;
}

/**
 * Count tarballs in a directory
 */
async function countTarballs(dir: string): Promise<number> {
  try {
    const files = await fs.readdir(dir);
    return files.filter(f => f.endsWith('.tgz')).length;
  } catch {
    return 0;
  }
}

/**
 * Interactive fetch command
 */
async function interactiveFetch(): Promise<void> {
  console.clear();
  console.log(BANNER);
  console.log(chalk.bold('📦 Fetch Dependencies\n'));

  const detectedLockfile = await detectLockfile();

  const lockfilePath = await input({
    message: 'Lockfile path:',
    default: detectedLockfile || config.fetch.lockfilePath || DEFAULTS.LOCKFILE_PATH,
    theme,
    validate: async (value) => {
      if (!value) return 'Lockfile path is required';
      if (!(await fs.pathExists(value))) return `File not found: ${value}`;
      return true;
    },
  });

  const outputDir = await input({
    message: 'Output directory:',
    default: config.fetch.outputDir || DEFAULTS.PACKAGES_DIR,
    theme,
  });

  const registryUrl = await input({
    message: 'Source registry:',
    default: config.fetch.registryUrl || DEFAULTS.NPM_REGISTRY_URL,
    theme,
    validate: (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return 'Invalid URL format';
      }
    },
  });

  const options = await checkbox({
    message: 'Options:',
    choices: [
      { name: 'Skip optional dependencies', value: 'skipOptional', checked: config.fetch.skipOptional },
      { name: 'Enable debug output', value: 'debug', checked: config.fetch.debug },
    ],
    theme,
  });

  const concurrency = await input({
    message: 'Concurrency (parallel downloads):',
    default: String(config.fetch.concurrency || 5),
    theme,
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num < 1 || num > 20) return 'Enter a number between 1 and 20';
      return true;
    },
  });

  // Save config for next time
  config.fetch = {
    ...config.fetch,
    lockfilePath,
    outputDir,
    registryUrl,
    concurrency: parseInt(concurrency, 10),
    skipOptional: options.includes('skipOptional'),
    debug: options.includes('debug'),
  };
  await saveConfig();

  // Summary
  console.log(chalk.gray('\n─────────────────────────────────────────'));
  console.log(chalk.bold('  Summary:'));
  console.log(chalk.gray(`  Lockfile:    ${lockfilePath}`));
  console.log(chalk.gray(`  Output:      ${outputDir}`));
  console.log(chalk.gray(`  Registry:    ${registryUrl}`));
  console.log(chalk.gray(`  Concurrency: ${concurrency}`));
  if (options.length > 0) {
    console.log(chalk.gray(`  Options:     ${options.join(', ')}`));
  }
  console.log(chalk.gray('─────────────────────────────────────────\n'));

  const proceed = await confirm({
    message: 'Proceed with fetch?',
    default: true,
    theme,
  });

  if (!proceed) {
    console.log(chalk.yellow('\nCancelled.'));
    return;
  }

  console.log('');
  await fetchDependencies({
    lockfilePath,
    outputDir,
    registryUrl,
    concurrency: parseInt(concurrency, 10),
    skipOptional: options.includes('skipOptional'),
    debug: options.includes('debug'),
  });
}

/**
 * Interactive publish command
 */
async function interactivePublish(): Promise<void> {
  console.clear();
  console.log(BANNER);
  console.log(chalk.bold('📤 Publish Packages\n'));

  const detectedDir = await detectPackagesDir();

  const packagesDir = await input({
    message: 'Packages directory:',
    default: detectedDir || config.publish.packagesDir || DEFAULTS.PACKAGES_DIR,
    theme,
    validate: async (value) => {
      if (!value) return 'Directory path is required';
      if (!(await fs.pathExists(value))) return `Directory not found: ${value}`;
      return true;
    },
  });

  const count = await countTarballs(packagesDir);
  if (count === 0) {
    console.log(chalk.yellow(`\nNo .tgz files found in ${packagesDir}`));
    return;
  }
  console.log(chalk.gray(`  Found ${chalk.bold(count)} packages\n`));

  const registryUrl = await input({
    message: 'Target registry:',
    default: config.publish.registryUrl || DEFAULTS.REGISTRY_URL,
    theme,
    validate: (value) => {
      try {
        const url = new URL(value);
        if (url.hostname === 'registry.npmjs.org') {
          return 'Cannot publish to npmjs.org - use a local registry';
        }
        return true;
      } catch {
        return 'Invalid URL format';
      }
    },
  });

  const options = await checkbox({
    message: 'Options:',
    choices: [
      { name: 'Skip existing packages (recommended)', value: 'skipExisting', checked: config.publish.skipExisting !== false },
      { name: 'Dry run (preview only)', value: 'dryRun', checked: config.publish.dryRun },
      { name: 'Enable debug output', value: 'debug', checked: config.publish.debug },
    ],
    theme,
  });

  const concurrency = await input({
    message: 'Concurrency (parallel publishes):',
    default: String(config.publish.concurrency || 3),
    theme,
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num < 1 || num > 10) return 'Enter a number between 1 and 10';
      return true;
    },
  });

  // Save config for next time
  config.publish = {
    ...config.publish,
    packagesDir,
    registryUrl,
    concurrency: parseInt(concurrency, 10),
    skipExisting: options.includes('skipExisting'),
    dryRun: options.includes('dryRun'),
    debug: options.includes('debug'),
  };
  await saveConfig();

  // Summary
  console.log(chalk.gray('\n─────────────────────────────────────────'));
  console.log(chalk.bold('  Summary:'));
  console.log(chalk.gray(`  Packages:    ${packagesDir} (${count} files)`));
  console.log(chalk.gray(`  Registry:    ${registryUrl}`));
  console.log(chalk.gray(`  Concurrency: ${concurrency}`));
  if (options.includes('dryRun')) {
    console.log(chalk.yellow(`  Mode:        DRY RUN`));
  }
  console.log(chalk.gray('─────────────────────────────────────────\n'));

  const proceed = await confirm({
    message: options.includes('dryRun') ? 'Run dry run?' : 'Proceed with publish?',
    default: true,
    theme,
  });

  if (!proceed) {
    console.log(chalk.yellow('\nCancelled.'));
    return;
  }

  console.log('');
  await publishPackages({
    packagesDir,
    registryUrl,
    concurrency: parseInt(concurrency, 10),
    skipExisting: options.includes('skipExisting'),
    dryRun: options.includes('dryRun'),
    debug: options.includes('debug'),
  });
}

/**
 * Interactive sync command
 */
async function interactiveSync(): Promise<void> {
  console.clear();
  console.log(BANNER);
  console.log(chalk.bold('🔄 Sync Registries\n'));

  const mode = await select({
    message: 'Sync mode:',
    choices: [
      { name: 'Full sync (download + publish)', value: 'full' },
      { name: 'Download only (for transfer to airgap)', value: 'download' },
      { name: 'Publish only (from existing packages)', value: 'publish' },
    ],
    theme,
  });

  let sourceRegistry = '';
  let destRegistry = '';
  let outputDir = config.sync.outputDir || './sync-packages';

  if (mode !== 'publish') {
    sourceRegistry = await input({
      message: 'Source registry URL:',
      default: config.sync.sourceRegistry || '',
      theme,
      validate: (value) => {
        if (!value) return 'Source registry is required';
        try {
          new URL(value);
          return true;
        } catch {
          return 'Invalid URL format';
        }
      },
    });
  }

  if (mode !== 'download') {
    destRegistry = await input({
      message: 'Destination registry URL:',
      default: config.sync.destRegistry || DEFAULTS.REGISTRY_URL,
      theme,
      validate: (value) => {
        if (!value) return 'Destination registry is required';
        try {
          const url = new URL(value);
          if (url.hostname === 'registry.npmjs.org') {
            return 'Cannot publish to npmjs.org - use a local registry';
          }
          return true;
        } catch {
          return 'Invalid URL format';
        }
      },
    });
  }

  if (mode !== 'publish') {
    outputDir = await input({
      message: 'Output directory:',
      default: config.sync.outputDir || './sync-packages',
      theme,
    });
  } else {
    const detectedDir = await detectPackagesDir();
    outputDir = await input({
      message: 'Packages directory:',
      default: detectedDir || config.sync.outputDir || './sync-packages',
      theme,
      validate: async (value) => {
        if (!(await fs.pathExists(value))) return `Directory not found: ${value}`;
        return true;
      },
    });
  }

  const scope = await input({
    message: 'Scope filter (optional, e.g., @mycompany):',
    default: config.sync.scope || '',
    theme,
  });

  const options = await checkbox({
    message: 'Options:',
    choices: [
      { name: 'Skip existing packages', value: 'skipExisting', checked: config.sync.skipExisting !== false },
      { name: 'Dry run (preview only)', value: 'dryRun', checked: config.sync.dryRun },
      { name: 'Enable debug output', value: 'debug', checked: config.sync.debug },
    ],
    theme,
  });

  // Save config for next time
  config.sync = {
    ...config.sync,
    sourceRegistry,
    destRegistry,
    outputDir,
    scope: scope || null,
    skipExisting: options.includes('skipExisting'),
    dryRun: options.includes('dryRun'),
    debug: options.includes('debug'),
  };
  await saveConfig();

  // Summary
  console.log(chalk.gray('\n─────────────────────────────────────────'));
  console.log(chalk.bold('  Summary:'));
  console.log(chalk.gray(`  Mode:        ${mode}`));
  if (sourceRegistry) console.log(chalk.gray(`  Source:      ${sourceRegistry}`));
  if (destRegistry) console.log(chalk.gray(`  Destination: ${destRegistry}`));
  console.log(chalk.gray(`  Output:      ${outputDir}`));
  if (scope) console.log(chalk.gray(`  Scope:       ${scope}`));
  console.log(chalk.gray('─────────────────────────────────────────\n'));

  const proceed = await confirm({
    message: 'Proceed with sync?',
    default: true,
    theme,
  });

  if (!proceed) {
    console.log(chalk.yellow('\nCancelled.'));
    return;
  }

  console.log('');
  await syncRegistries({
    sourceRegistry,
    destRegistry,
    outputDir,
    scope: scope || null,
    downloadOnly: mode === 'download',
    publishOnly: mode === 'publish',
    skipExisting: options.includes('skipExisting'),
    dryRun: options.includes('dryRun'),
    debug: options.includes('debug'),
  });
}

/**
 * Interactive registry state export
 */
async function interactiveRegistryState(): Promise<void> {
  console.clear();
  console.log(BANNER);
  console.log(chalk.bold('📊 Export Registry State\n'));

  const registryUrl = await input({
    message: 'Registry URL:',
    default: config.registryState.registryUrl || DEFAULTS.REGISTRY_URL,
    theme,
    validate: (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return 'Invalid URL format';
      }
    },
  });

  const outputPath = await input({
    message: 'Output file:',
    default: config.registryState.outputPath || './registry-state.json',
    theme,
  });

  const scope = await input({
    message: 'Scope filter (optional, e.g., @mycompany):',
    default: config.registryState.scope || '',
    theme,
  });

  const debug = await confirm({
    message: 'Enable debug output?',
    default: config.registryState.debug || false,
    theme,
  });

  // Save config for next time
  config.registryState = {
    ...config.registryState,
    registryUrl,
    outputPath,
    scope: scope || null,
    debug,
  };
  await saveConfig();

  console.log('');
  await exportRegistryState({
    registryUrl,
    outputPath,
    scope: scope || null,
    debug,
  });
}

/**
 * Show quick start guide
 */
function showQuickStart(): void {
  console.clear();
  console.log(BANNER);
  console.log(chalk.bold('📖 Quick Start Guide\n'));

  console.log(chalk.cyan('Typical workflow:'));
  console.log(chalk.gray('─────────────────────────────────────────'));

  console.log(chalk.bold('\n1. Online Environment:'));
  console.log(chalk.white('   Fetch dependencies from your project:'));
  console.log(chalk.gray('   $ node cli.cjs fetch -l pnpm-lock.yaml -o ./packages'));

  console.log(chalk.bold('\n2. Transfer:'));
  console.log(chalk.white('   Copy the packages folder to USB/transfer medium'));

  console.log(chalk.bold('\n3. Air-gapped Environment:'));
  console.log(chalk.white('   Start local registry and publish:'));
  console.log(chalk.gray('   $ verdaccio'));
  console.log(chalk.gray('   $ npm login --registry http://localhost:4873'));
  console.log(chalk.gray('   $ node cli.cjs publish -p ./packages -r http://localhost:4873'));

  console.log(chalk.bold('\n4. Install:'));
  console.log(chalk.white('   Use the local registry:'));
  console.log(chalk.gray('   $ pnpm install --registry http://localhost:4873'));

  console.log(chalk.gray('\n─────────────────────────────────────────'));
  console.log(chalk.gray('Press Enter to continue...\n'));
}

/**
 * Main interactive mode entry point
 */
export async function runInteractiveMode(): Promise<void> {
  // Load config once at start
  await loadConfig();

  console.clear();
  console.log(BANNER);

  const action = await select({
    message: 'What would you like to do?',
    choices: [
      {
        name: `${chalk.cyan('📦')} Fetch dependencies from lockfile`,
        value: 'fetch',
        description: 'Download packages for offline transfer'
      },
      {
        name: `${chalk.cyan('📤')} Publish packages to registry`,
        value: 'publish',
        description: 'Publish tarballs to local registry'
      },
      {
        name: `${chalk.cyan('🔄')} Sync registries`,
        value: 'sync',
        description: 'Copy packages between registries'
      },
      {
        name: `${chalk.cyan('📊')} Export registry state`,
        value: 'registry-state',
        description: 'Export for incremental syncing'
      },
      {
        name: `${chalk.cyan('📖')} Quick start guide`,
        value: 'help',
        description: 'Learn how to use this tool'
      },
      {
        name: `${chalk.gray('✖')} Exit`,
        value: 'exit',
      },
    ],
    theme,
  });

  try {
    switch (action) {
      case 'fetch':
        await interactiveFetch();
        break;
      case 'publish':
        await interactivePublish();
        break;
      case 'sync':
        await interactiveSync();
        break;
      case 'registry-state':
        await interactiveRegistryState();
        break;
      case 'help':
        showQuickStart();
        await runInteractiveMode(); // Return to menu
        break;
      case 'exit':
        console.log(chalk.gray('\nGoodbye!\n'));
        break;
    }
  } catch (error) {
    if ((error as Error).name === 'ExitPromptError') {
      console.log(chalk.gray('\nCancelled.\n'));
    } else {
      throw error;
    }
  }
}
