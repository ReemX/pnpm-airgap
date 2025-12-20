/**
 * Progress tracking and display utilities
 */

import ora, { type Ora } from 'ora';
import chalk from 'chalk';

export interface ProgressState {
  success: number;
  skipped: number;
  failed: number;
  completed: number;
  total: number;
}

/**
 * Format progress counts for display
 */
function formatCounts(state: ProgressState): string {
  const parts = [
    chalk.green(`✓ ${state.success}`),
    chalk.gray(`⊘ ${state.skipped}`),
    chalk.red(`✗ ${state.failed}`),
  ];
  return `${parts.join(' │ ')} ${chalk.dim(`(${state.completed}/${state.total})`)}`;
}

/**
 * Progress tracker with spinner and counts
 */
export class ProgressTracker {
  private spinner: Ora;
  private state: ProgressState;
  private label: string;

  constructor(label: string, total: number, initialSkipped = 0) {
    this.label = label;
    this.state = {
      success: 0,
      skipped: initialSkipped,
      failed: 0,
      completed: initialSkipped,
      total,
    };
    this.spinner = ora({
      text: this.formatText(),
      prefixText: '',
    }).start();

    // Show initial state if there are pre-skipped items
    if (initialSkipped > 0) {
      this.update();
    }
  }

  private formatText(): string {
    return `${this.label} ${formatCounts(this.state)}`;
  }

  update(delta?: { success?: number; skipped?: number; failed?: number }): void {
    if (delta) {
      if (delta.success) {
        this.state.success += delta.success;
        this.state.completed += delta.success;
      }
      if (delta.skipped) {
        this.state.skipped += delta.skipped;
        this.state.completed += delta.skipped;
      }
      if (delta.failed) {
        this.state.failed += delta.failed;
        this.state.completed += delta.failed;
      }
    }
    this.spinner.text = this.formatText();
  }

  success(): void {
    this.update({ success: 1 });
  }

  skip(): void {
    this.update({ skipped: 1 });
  }

  fail(): void {
    this.update({ failed: 1 });
  }

  // For pre-checked items that don't need individual updates
  markPreChecked(count: number): void {
    this.state.completed = count;
    this.state.skipped = count;
    this.update();
  }

  complete(message?: string): void {
    this.spinner.succeed(message || this.formatText());
  }

  error(message: string): void {
    this.spinner.fail(message);
  }

  warn(message: string): void {
    this.spinner.warn(message);
  }

  get stats(): ProgressState {
    return { ...this.state };
  }
}

/**
 * Simple spinner wrapper
 */
export function createSpinner(text: string): Ora {
  return ora(text).start();
}

/**
 * Print section header
 */
export function printHeader(title: string, subtitle?: string): void {
  console.log();
  console.log(chalk.bold.blue(`📦 ${title}`));
  if (subtitle) {
    console.log(chalk.gray(subtitle));
  }
  console.log();
}

/**
 * Print key-value info line
 */
export function printInfo(label: string, value: string): void {
  console.log(chalk.gray(`${label}: `) + chalk.white(value));
}

/**
 * Print summary section
 */
export function printSummary(stats: {
  total?: number;
  success?: number;
  skipped?: number;
  failed?: number;
  [key: string]: number | undefined;
}): void {
  console.log();
  console.log(chalk.bold('Summary'));
  console.log(chalk.gray('─'.repeat(30)));

  for (const [key, value] of Object.entries(stats)) {
    if (value === undefined) continue;

    const label = key.charAt(0).toUpperCase() + key.slice(1);
    let color = chalk.white;

    if (key === 'success' || key === 'downloaded' || key === 'published') {
      color = chalk.green;
    } else if (key === 'failed' || key === 'errors') {
      color = value > 0 ? chalk.red : chalk.gray;
    } else if (key === 'skipped') {
      color = chalk.gray;
    }

    console.log(`  ${label}: ${color(value.toString())}`);
  }
}

/**
 * Print error list
 */
export function printErrors(errors: Array<{ package: string; error?: string }>, maxShow = 10): void {
  if (errors.length === 0) return;

  console.log();
  console.log(chalk.red(`Errors (${errors.length}):`));
  errors.slice(0, maxShow).forEach((err) => {
    console.log(chalk.red(`  • ${err.package}: ${err.error || 'Unknown error'}`));
  });
  if (errors.length > maxShow) {
    console.log(chalk.gray(`  ... and ${errors.length - maxShow} more`));
  }
}
