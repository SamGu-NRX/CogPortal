import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localOrigin } from './local-origin.ts';

function refusal(raw: string): string {
  try {
    localOrigin(raw);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  assert.fail(`accepted ${raw}`);
}

test('accepts bare loopback origins', () => {
  assert.equal(localOrigin('http://127.0.0.1:5195'), 'http://127.0.0.1:5195');
  assert.equal(localOrigin('http://127.0.0.1:5195/'), 'http://127.0.0.1:5195');
  assert.equal(localOrigin('http://localhost:5173'), 'http://localhost:5173');
  assert.equal(localOrigin('http://[::1]:5195'), 'http://[::1]:5195');
  assert.equal(localOrigin('https://localhost:8443'), 'https://localhost:8443');
});

test('refuses hosts that are not loopback, including lookalikes', () => {
  for (const raw of [
    'https://cogportal.example.org',
    'http://localhost.example.org:5195',
    'http://127.0.0.1.nip.io:5195',
    'http://10.0.0.5:5195',
    'http://0.0.0.0:5195',
  ]) {
    assert.match(refusal(raw), /must name 127\.0\.0\.1, localhost or \[::1\] as its host/, raw);
  }
});

test('refuses a loopback URL that is more than an origin', () => {
  for (const raw of ['http://127.0.0.1:5195/leaderboard', 'http://127.0.0.1:5195/?next=x', 'http://127.0.0.1:5195/#x']) {
    assert.match(refusal(raw), /must be an origin with no path, query or fragment/, raw);
  }
});

test('refuses credentials and other schemes', () => {
  assert.match(refusal('http://user:pass@127.0.0.1:5195'), /must not carry credentials/);
  assert.match(refusal('file:///127.0.0.1'), /must use http or https/);
  assert.match(refusal('javascript:alert(1)'), /must use http or https/);
  // A scheme-less host parses as a scheme of its own.
  assert.match(refusal('localhost:5195'), /must use http or https/);
});

test('refuses text that is not a URL', () => {
  assert.match(refusal('127.0.0.1:5195x'), /is not a URL/);
  assert.match(refusal(''), /is not a URL/);
});

test('never repeats the refused value', () => {
  for (const raw of [
    'https://student:hunter2-secret@cogportal.example.org',
    'http://127.0.0.1:5195/?token=cog_live_SECRET123',
    'https://cogportal.example.org/#access_token=SECRET456',
    'not a url SECRET789',
  ]) {
    const message = refusal(raw);
    for (const fragment of ['hunter2', 'SECRET', 'student', 'cogportal.example.org', 'token=']) {
      assert.ok(!message.includes(fragment), `${JSON.stringify(fragment)} leaked from a refused URL`);
    }
  }
});
