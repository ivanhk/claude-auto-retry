import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRateLimited, findRateLimitMessage, detectOverload, isWorking,
} from '../src/patterns.js';
import { DEFAULT_OVERLOAD } from '../src/config.js';

const TAIL = 12; // RATE_LIMIT_TAIL_LINES

// Claude Code's own input box + footer furniture (matches the tool-echo suite's CHROME).
const CHROME = [
  '╭──────────────────────────╮',
  '│ >                        │',
  '╰──────────────────────────╯',
  '  ⏵⏵ auto mode on',
  '~/project | v2.1.214',
];

// claude-hud (jarrodwatts/claude-hud) renders a multi-row statusLine directly under the
// input box. Shapes below are taken from the plugin's render sources: a model-badge +
// context-% line, a git ahead/behind line, a session-duration timer, a todos ratio row,
// and a "─" divider. These are the rows that bury a real rate-limit banner below the
// tail window and whose own usage text ("⚠ Limit", "NN%") can false-match LIMIT_PATTERNS.
const HUD = [
  '[Opus] ~/project | 47% | CC v2.1.214',
  'main ↑3 ↓1',
  '⏱️ 12m',
  '▸ Writing tests (2/5)',
  '──────────────────────────────────────',
];

// statusLine plugins (claude-hud and similar) render under the input box — the same live
// region Claude Code's own rate-limit banner occupies. Their rows are NOT built-in
// furniture, so before this fix the chrome allowlist didn't strip them: they consumed the
// content-tail budget and buried a real "resets …" banner below the detection window
// (a missed reset → no auto-continue). Now they're recognized as chrome.
describe('statusLine plugin rows are chrome (claude-hud)', () => {
  it('a real banner ABOVE a claude-hud statusLine is detected (was missed)', () => {
    const pane = [
      "You've hit your session limit · resets 3pm (UTC)",
      ...HUD,
      ...CHROME,
    ].join('\n');
    assert.equal(isRateLimited(pane, [], TAIL), true);
    assert.match(findRateLimitMessage(pane, []), /resets 3pm/);
  });

  it('a banner pushed far up by a tall statusLine stack is still detected', () => {
    // Expanded claude-hud view (context bar + usage bar + tools + agents + todos) plus
    // the standard chrome easily exceeds the 12-line tail. The banner must still register.
    const tallHud = [
      '[Sonnet 4.5] ~/long/path | 92% | CC v2.1.214',
      'main ↑12 ↓4',
      '⏱️ 1h 23m',
      '▸ Refactoring module (3/8)',
      '◐ Bash: build.sh',
      '──────────────────────────────────────',
      '[Opus] ~/long/path | 92% | CC v2.1.214',
      '──────────────────────────────────────',
    ];
    const pane = [
      "5-hour limit reached - resets 2:10am (Australia/Melbourne)",
      ...tallHud,
      ...CHROME,
    ].join('\n');
    assert.equal(isRateLimited(pane, [], TAIL), true);
    assert.match(findRateLimitMessage(pane, []), /resets 2:10am/);
  });

  it('hud usage text alone (no real banner) does NOT false-match a limit', () => {
    // claude-hud's usage row carries "⚠ Limit" / a percentage; without a real banner this
    // must not drive a retry. After stripping, these rows are gone from the content tail.
    const hudWithUsage = [
      '[Opus] ~/project | 78% | ⚠ Limit | CC v2.1.214',
      'main ↑3 ↓1',
      '──────────────────────────────────────',
    ];
    const pane = [
      'some ordinary conversation about quotas',
      ...hudWithUsage,
      ...CHROME,
    ].join('\n');
    assert.equal(isRateLimited(pane, [], TAIL), false);
    assert.equal(findRateLimitMessage(pane, []), null);
  });

  it('USAGE_CREDITS backstop finds a banner buried behind a statusLine', () => {
    // The companion "/usage-credits" line is trusted when nothing but chrome sits below
    // it; statusLine rows now count as chrome, so the backstop fires correctly.
    const pane = [
      "You've hit your session limit · resets 4pm (UTC)",
      '… /usage-credits to finish what you\'re working on.',
      ...HUD,
      ...CHROME,
    ].join('\n');
    assert.equal(isRateLimited(pane, [], TAIL), true);
  });

  it('statusLine rows do not interfere with the overload path', () => {
    const pane = [
      'ordinary content',
      ...HUD,
      ...CHROME,
    ].join('\n');
    assert.equal(detectOverload(pane, DEFAULT_OVERLOAD.patterns), false);
  });

  it('a real overload ABOVE a statusLine is still detected', () => {
    const pane = [
      '● API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
      ...HUD,
      ...CHROME,
    ].join('\n');
    assert.equal(detectOverload(pane, DEFAULT_OVERLOAD.patterns), true);
  });

  it('statusLine rows are NOT mistaken for a working footer (isWorking stays false)', () => {
    const pane = [...HUD, ...CHROME].join('\n');
    assert.equal(isWorking(pane), false);
  });
});

// The miss cost of a chrome pattern is a false retry: stripping real content lets a stale
// banner re-enter the window. So the new patterns must be ANCHORED to shapes real prose
// does not produce — same discipline as the built-in patterns. These controls pin that.
describe('statusLine chrome patterns are precise (no false strips)', () => {
  it('prose mentioning a model name + percentage is NOT stripped', () => {
    // No leading model badge + pipe + %: this is a sentence, not a statusLine row.
    const pane = [
      "I ran the suite with Opus and it covered 47% of the lines",
      ...CHROME,
    ].join('\n');
    // The sentence is kept as content, so no banner is fabricated → false.
    assert.equal(isRateLimited(pane, [], TAIL), false);
  });

  it('prose with a single arrow glyph is NOT stripped', () => {
    // "↑3" alone is not the "↑N ↓N" pair the pattern requires.
    const pane = [
      "output ↑3 after the fix",
      ...CHROME,
    ].join('\n');
    assert.equal(isRateLimited(pane, [], TAIL), false);
  });

  it('a flush-left "✓ Fixed it" summary is NOT stripped (no ratio suffix)', () => {
    const pane = [
      "✓ Fixed the bug",
      ...CHROME,
    ].join('\n');
    assert.equal(isRateLimited(pane, [], TAIL), false);
  });
});
