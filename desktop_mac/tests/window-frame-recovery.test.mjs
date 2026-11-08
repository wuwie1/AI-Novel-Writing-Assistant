import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('desktop frame recovery leaves full-screen Spaces and their transitions to AppKit', { skip: process.platform !== 'darwin' }, () => {
  const source = readFileSync(new URL('../native/Sources/App/WindowFrameRecovery.swift', import.meta.url), 'utf8');
  const checks = `
let screen = NSRect(x: 0, y: 0, width: 1440, height: 900)
let desktop = NSRect(x: 0, y: 64, width: 1440, height: 812)
let regular = NSRect(x: 100, y: 100, width: 800, height: 600)
var recovery = WindowFrameRecovery()
precondition(recovery.adjustedFrame(screen, within: desktop, styleMask: .fullScreen) == nil)
recovery.isTransitioningFullScreen = true
precondition(recovery.adjustedFrame(screen, within: desktop, styleMask: .titled) == nil)
recovery.isTransitioningFullScreen = false
precondition(recovery.adjustedFrame(screen, within: desktop, styleMask: .titled) == desktop)
precondition(recovery.adjustedFrame(regular, within: desktop, styleMask: .titled) == nil)
precondition(recovery.adjustedFrame(regular, within: .zero, styleMask: .titled) == nil)
`;
  const result = spawnSync('xcrun', ['swift', '-'], { input: source + '\n' + checks, encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
