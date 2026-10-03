import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localOrigin } from './local-origin.ts';

test('accepts bare loopback origins', () => {
  assert.equal(localOrigin('http://127.0.0.1:5195'), 'http://127.0.0.1:5195');
  assert.equal(localOrigin('http://127.0.0.1:5195/'), 'http://127.0.0.1:5195');
  assert.equal(localOrigin('http://localhost:5173'), 'http://localhost:5173');
  assert.equal(localOrigin('http://[::1]:5195'), 'http://[::1]:5195');
  assert.equal(localOrigin('https://localhost:8443'), 'https://localhost:8443');
});

test('refuses anything that could reach a deployed portal', () => {
  for (const raw of [
    'https://cogportal.example.org',
    'http://localhost.example.org:5195',
    'http://127.0.0.1.nip.io:5195',
    'http://10.0.0.5:5195',
    'http://0.0.0.0:5195',
  ]) {
    assert.throws(() => localOrigin(raw), /bare loopback origin/, raw);
  }
});

test('refuses a loopback URL that is more than an origin', () => {
  for (const raw of [
    'http://127.0.0.1:5195/leaderboard',
    'http://127.0.0.1:5195/?next=https://example.org',
    'http://127.0.0.1:5195/#x',
    'http://user:pass@127.0.0.1:5195',
    'file:///127.0.0.1',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => localOrigin(raw), /bare loopback origin/, raw);
  }
});

test('names the problem when APP_URL is not a URL', () => {
  assert.throws(() => localOrigin('127.0.0.1:5195x'), /must be a URL/);
  assert.throws(() => localOrigin(''), /must be a URL/);
});

test('refuses a scheme-less host, which parses as a scheme', () => {
  assert.throws(() => localOrigin('localhost:5195'), /bare loopback origin/);
});
