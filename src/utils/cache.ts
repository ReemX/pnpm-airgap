/**
 * LRU Cache implementation for efficient memory management
 */

import { debug } from './logger.js';

export class LRUCache<K, V> {
  private maxSize: number;
  private evictionCount: number;
  private cache: Map<K, V>;
  private accessOrder: K[];

  constructor(maxSize: number, evictionCount = 100) {
    this.maxSize = maxSize;
    this.evictionCount = evictionCount;
    this.cache = new Map();
    this.accessOrder = [];
  }

  get(key: K): V | undefined {
    if (this.cache.has(key)) {
      this.updateAccessOrder(key);
      return this.cache.get(key);
    }
    return undefined;
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  set(key: K, value: V): void {
    if (!this.cache.has(key) && this.cache.size >= this.maxSize) {
      this.evict();
    }
    this.cache.set(key, value);
    this.updateAccessOrder(key);
  }

  delete(key: K): boolean {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  get size(): number {
    return this.cache.size;
  }

  entries(): IterableIterator<[K, V]> {
    return this.cache.entries();
  }

  private updateAccessOrder(key: K): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(key);
  }

  private evict(): void {
    const toRemove = this.accessOrder.splice(0, this.evictionCount);
    for (const key of toRemove) {
      this.cache.delete(key);
    }
    debug(`LRU Cache evicted ${toRemove.length} entries, size now: ${this.cache.size}`);
  }
}
