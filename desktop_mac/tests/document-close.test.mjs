import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('Swift quit gate distinguishes a live, loading and terminated editor and binds decisions to their request', {skip: process.platform !== 'darwin'}, async t => {
  const cache = await mkdtemp(path.join(tmpdir(), 'mac-close-swift-'));
  t.after(() => rm(cache, {recursive: true, force: true}));
  const source = await readFile(new URL('../native/Sources/Bridge/DocumentCloseGate.swift', import.meta.url), 'utf8');
  const checks = `
var prompts: [(DocumentCloseGate.Prompt, String)] = []
var decisions: [WindowCloseResult] = []
var dismissed: [String] = []
let gate = DocumentCloseGate(present: { prompts.append(($0, $1)) }, dismiss: { _, id, _ in dismissed.append(id) })
func quit() { gate.begin(quitting: true) { decisions.append($0) } }

// A non-ready live window needs explicit consent. A late page must still check its own drafts.
quit()
let first = prompts.last!.1
precondition(prompts.last!.0 == .window && decisions.isEmpty)
gate.windowDecision(.cancelled, id: first)
precondition(decisions == [.cancelled])
quit()
let second = prompts.last!.1
gate.documentReady()
gate.windowDecision(.allowed, id: second)
precondition(prompts.last!.0 == .document && gate.awaitsDocument(second))
quit()
precondition(decisions.last == .pending)
gate.documentDecision(.busy, id: second)
precondition(decisions.last == .busy)

// Allowing a navigation does not by itself replace the live document.
gate.begin(quitting: false) { decisions.append($0) }
gate.documentDecision(.allowed, id: prompts.last!.1)
precondition(gate.renderer == .ready && decisions.last == .allowed)
quit()
let oldDocument = prompts.last!.1
gate.documentCommitted()
precondition(decisions.last == .unavailable && gate.renderer == .loading)
quit()
let loading = prompts.last!.1
gate.documentDecision(.allowed, id: oldDocument)
gate.expire(loading)
precondition(decisions.last == .timedOut && dismissed.contains(loading))
quit()
let current = prompts.last!.1
gate.windowDecision(.allowed, id: loading)
gate.expire(loading)
precondition(decisions.last == .timedOut)
gate.windowDecision(.allowed, id: current)
precondition(decisions.last == .allowed)

// A terminated process cannot answer. Its old request fails; a new quit can complete.
gate.documentReady()
quit()
let beforeCrash = prompts.last!.1
gate.processTerminated()
gate.documentReady() // A queued message from the retired page cannot restore readiness.
precondition(decisions.last == .unavailable && gate.renderer == .terminated)
let promptCount = prompts.count
quit()
precondition(decisions.last == .allowed && prompts.count == promptCount)
gate.documentCommitted()
quit()
gate.documentDecision(.allowed, id: beforeCrash)
precondition(prompts.last!.0 == .window)
gate.windowDecision(.cancelled, id: prompts.last!.1)
precondition(decisions.last == .cancelled)
precondition(WindowCloseResult.busy.socketReply(requestID: "r")["cancelled"] as? Bool == false)
precondition(WindowCloseResult.cancelled.socketReply(requestID: "r")["cancelled"] as? Bool == true)
`;
  const result = spawnSync('xcrun', ['swift', '-module-cache-path', cache, '-'], {input: source + '\n' + checks, encoding: 'utf8'});
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
