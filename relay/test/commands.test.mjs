/**
 * S1 command ingestion tests (node:test, no deps):
 *   - fixture updates through the parser (grammar twin of
 *     bridge-ai/packages/bridge-command-queue/tests/grammar.test.ts)
 *   - duplicate update_id replay → exactly one outbox entry (A11)
 *   - spoofed chat → dropped + audit row (A3)
 *   - outbox pull/ack cursor semantics
 *
 * Run: node --test test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  initCommands,
  parseCommand,
  handlePinnedMessage,
  auditUnknownChat,
  pullCommands,
  ackCommands,
  appendCommand,
  outboxStatus,
} from '../src/commands.mjs';

function freshState() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-cmd-'));
  initCommands({ stateDir: dir, outboxToken: 'test-token', commandsEnabled: true });
  return dir;
}

const NOTIFICATION =
  'Draft for Ben Ross · Expression of Interest. Risk: external send.\n' +
  'Reply: send a3f2c1 · edit a3f2c1 <your changes> · drop a3f2c1\n' +
  "Expires to tomorrow's evening note if unanswered.";

test('grammar twin: shared fixtures', () => {
  const dir = freshState();
  try {
    assert.deepEqual(
      [parseCommand('send a3f2c1').kind, parseCommand('send a3f2c1').hash],
      ['send', 'a3f2c1']
    );
    const edit = parseCommand('edit a3f2c1 make it shorter and drop the apology');
    assert.equal(edit.kind, 'edit');
    assert.equal(edit.instruction, 'make it shorter and drop the apology');
    assert.equal(parseCommand('undo a3f2c1').kind, 'cancel');
    assert.equal(parseCommand('status').kind, 'status');
    assert.equal(parseCommand('Freeze').kind, 'freeze');
    assert.equal(parseCommand('tz lisbon').city, 'lisbon');

    const bare = parseCommand('yes', NOTIFICATION);
    assert.equal(bare.kind, 'send');
    assert.equal(bare.hash, 'a3f2c1');
    assert.equal(bare.bare, true);

    const bareNoCtx = parseCommand('send');
    assert.equal(bareNoCtx.kind, 'send');
    assert.equal(bareNoCtx.hash, null);

    assert.equal(parseCommand('send the board pack to print on Monday').kind, 'capture');
    assert.equal(parseCommand('idea: a museum of unsent emails').kind, 'capture');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate update_id replays produce exactly one outbox entry (A11)', () => {
  const dir = freshState();
  try {
    const msg = { message_id: 10, chat: { id: 1 }, text: 'send a3f2c1' };
    assert.equal(handlePinnedMessage(555, msg), true);
    // replay of the same getUpdates batch after a crash:
    assert.equal(handlePinnedMessage(555, msg), true); // consumed, but not re-enqueued
    const cmds = pullCommands(0, 100);
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].id, 'tg-555');
    assert.equal(cmds[0].kind, 'send');
    // duplicate is audited
    const audit = readFileSync(path.join(dir, 'outbox', 'audit.jsonl'), 'utf-8');
    assert.match(audit, /duplicate-update/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('slash commands and empty text stay with the channel', () => {
  const dir = freshState();
  try {
    assert.equal(handlePinnedMessage(1, { message_id: 1, text: '/help' }), false);
    assert.equal(handlePinnedMessage(2, { message_id: 2, text: '' }), false);
    assert.equal(pullCommands(0, 100).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spoofed chat is dropped with an audit row (A3)', () => {
  const dir = freshState();
  try {
    // telegram.mjs drops non-pinned chats before the command module; the
    // contract here is the audit row + zero outbox writes.
    auditUnknownChat('999999', { message_id: 77 });
    const audit = readFileSync(path.join(dir, 'outbox', 'audit.jsonl'), 'utf-8');
    assert.match(audit, /unknown-chat-dropped/);
    assert.match(audit, /999999/);
    assert.equal(pullCommands(0, 100).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pull/ack cursor: acked commands never re-deliver', () => {
  const dir = freshState();
  try {
    appendCommand({ id: 'tg-1', kind: 'capture', text: 'one', received_at: 'x' });
    appendCommand({ id: 'tg-2', kind: 'status', text: 'status', received_at: 'x' });
    appendCommand({ id: 'tg-3', kind: 'freeze', text: 'freeze', received_at: 'x' });

    let batch = pullCommands(0, 2);
    assert.deepEqual(batch.map((c) => c.seq), [1, 2]);
    ackCommands(2);
    batch = pullCommands(0, 100);
    assert.deepEqual(batch.map((c) => c.id), ['tg-3']);

    const status = outboxStatus();
    assert.equal(status.acked_seq, 2);
    assert.equal(status.pending, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture command carries reply context for the Mac consumer', () => {
  const dir = freshState();
  try {
    const msg = {
      message_id: 12,
      text: 'task',
      reply_to_message: { text: 'Filed under _inbox (note) as a note. Wrong? Reply: task / idea / person / drop.' },
    };
    handlePinnedMessage(700, msg);
    const [cmd] = pullCommands(0, 10);
    assert.equal(cmd.kind, 'capture');
    assert.match(cmd.reply_to_text, /Filed under/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
