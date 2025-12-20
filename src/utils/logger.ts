/**
 * Logging utilities with debug mode support
 */

import chalk from 'chalk';

let debugMode = false;

export function setDebugMode(enabled: boolean): void {
  debugMode = enabled;
}

export function isDebugMode(): boolean {
  return debugMode;
}

function getTimestamp(): string {
  return new Date().toISOString().split('T')[1].slice(0, -1);
}

export function debug(message: string, data?: unknown): void {
  if (!debugMode) return;

  const timestamp = getTimestamp();
  if (data !== undefined) {
    console.log(chalk.gray(`[${timestamp}] [DEBUG] ${message}`), data);
  } else {
    console.log(chalk.gray(`[${timestamp}] [DEBUG] ${message}`));
  }
}

export function info(message: string): void {
  console.log(chalk.blue(message));
}

export function success(message: string): void {
  console.log(chalk.green(message));
}

export function warn(message: string): void {
  console.log(chalk.yellow(message));
}

export function error(message: string): void {
  console.log(chalk.red(message));
}

export function dim(message: string): void {
  console.log(chalk.gray(message));
}

// Styled output helpers
export const style = {
  title: (text: string) => chalk.bold.blue(text),
  success: (text: string) => chalk.green(text),
  error: (text: string) => chalk.red(text),
  warn: (text: string) => chalk.yellow(text),
  dim: (text: string) => chalk.gray(text),
  bold: (text: string) => chalk.bold(text),
  url: (text: string) => chalk.cyan.underline(text),
  count: (n: number) => chalk.bold.white(n.toString()),
};
