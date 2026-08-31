import { describe, expect, it } from 'vitest';
import { createSerialTaskQueue, removeQueueItemById } from './queue.js';

describe('createSerialTaskQueue', () => {
  it('runs tasks serially and coalesces duplicates for the same key', async () => {
    const queue = createSerialTaskQueue();
    const order = [];

    const first = queue.enqueue(async () => {
      order.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('first:end');
      return 'first';
    }, 'pcn:123');

    const duplicate = queue.enqueue(async () => {
      order.push('duplicate:start');
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('duplicate:end');
      return 'duplicate';
    }, 'pcn:123');

    const second = queue.enqueue(async () => {
      order.push('second:start');
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('second:end');
      return 'second';
    }, 'pcn:456');

    expect(duplicate).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('does not re-run a task when the previous chain rejects', async () => {
    const queue = createSerialTaskQueue();
    let attempts = 0;

    await expect(queue.enqueue(async () => {
      attempts += 1;
      throw new Error('boom');
    }, 'pcn:retry')).rejects.toThrow('boom');

    const second = queue.enqueue(async () => {
      attempts += 1;
      return 'second';
    }, 'pcn:retry');

    await expect(second).resolves.toBe('second');
    expect(attempts).toBe(2);
  });
});

describe('removeQueueItemById', () => {
  it('removes an item permanently by id', async () => {
    await expect(removeQueueItemById()).resolves.toBe(false);
    await expect(removeQueueItemById('')).resolves.toBe(false);
  });
});
