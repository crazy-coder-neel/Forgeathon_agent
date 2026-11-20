import test from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitWaitMs } from '../src/trueforge/client';

test('rateLimitWaitMs: detects provider rate limits and honours "retry in Ns"', () => {
  assert.equal(rateLimitWaitMs(undefined), undefined);
  assert.equal(rateLimitWaitMs('Incorrect API key provided (401)'), undefined);
  assert.equal(rateLimitWaitMs('Request failed (429): too many requests'), 30_000);
  assert.equal(rateLimitWaitMs('RESOURCE_EXHAUSTED: quota exceeded. Please retry in 12.3s'), 14_000);
  assert.equal(rateLimitWaitMs('rate limit hit, retry after 1s'), 5_000); // floor
  assert.equal(rateLimitWaitMs('429 quota, retry in 500s'), 90_000); // ceiling
});
