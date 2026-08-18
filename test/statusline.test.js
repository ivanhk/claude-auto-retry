import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRateLimited, findRateLimitMessage, detectOverload, isWorking,
} from '../src/patterns.js';
import { parseResetTime } from '../src/time-parser.js';
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

// claude-hud's newer layouts render the usage state as one bottom row with block gauges:
//   V1: "Context ██░░░░░░░░ 21% │ Usage ⚠ Limit reached (resets in 2h)"        — LIMITED
//   V2: "Context ██░░░░░░░░ 16% │ Usage ██░░░░░░░░ 20% (resets in 4h 49m)"      — meter
//   V3: V2 + " | Weekly ████████░░ 81% (resets in 23h 19m)"                    — meter + weekly
// V1 is the live limit indicator (often the only one once CC's own banner scrolled away)
// and must stay content; V2/V3 are informational meters whose "(resets …)" is the rolling
// session/weekly WINDOW, not the limit reset — they must be chrome so they neither
// false-match a limit nor hijack a real banner's reset via the bottom-up scan.
describe('claude-hud gauge meter rows (Context │ Usage │ Weekly)', () => {
  const V1 = 'Context ██░░░░░░░░ 21% │ Usage ⚠ Limit reached (resets in 2h)';
  const V2 = 'Context ██░░░░░░░░ 16% │ Usage ██░░░░░░░░ 20% (resets in 4h 49m)';
  const V3 = 'Context ██░░░░░░░░ 16% │ Usage ██░░░░░░░░ 20% (resets in 4h 49m) | Weekly ████████░░ 81% (resets in 23h 19m)';
  const banner = "You've hit your session limit · resets 3pm (UTC)";

  it('V1 (⚠ Limit reached) IS detected and its reset parses', () => {
    const pane = ['some ordinary content', V1, ...CHROME].join('\n');
    assert.equal(isRateLimited(pane, [], TAIL), true);
    assert.match(findRateLimitMessage(pane, [], TAIL), /Limit reached/);
    const r = parseResetTime(findRateLimitMessage(pane, [], TAIL));
    assert.ok(r && r.relative, 'reset must parse as relative');
    assert.equal(r.waitMs, 2 * 3_600_000);
  });

  it('V2/V3 meters alone do NOT read as a limit', () => {
    for (const v of [V2, V3]) {
      const pane = ['some ordinary content', v, ...CHROME].join('\n');
      assert.equal(isRateLimited(pane, [], TAIL), false, v);
      assert.equal(findRateLimitMessage(pane, [], TAIL), null, v);
    }
  });

  it('V2/V3 meters below a real banner do NOT hijack its reset', () => {
    for (const v of [V2, V3]) {
      const pane = [banner, v, ...CHROME].join('\n');
      assert.equal(isRateLimited(pane, [], TAIL), true, v);
      const msg = findRateLimitMessage(pane, [], TAIL);
      assert.match(msg, /resets 3pm/, `the banner must win over the meter — got: ${msg}`);
      assert.doesNotMatch(msg, /4h|Weekly|23h/, v);
    }
  });

  it('a real banner ABOVE the V1 limit row still detects (both name the limit)', () => {
    const pane = [banner, V1, ...CHROME].join('\n');
    assert.equal(isRateLimited(pane, [], TAIL), true);
  });

  it('a real WEEKLY limit (⚠ variant, no gauge) still detects and parses fully', () => {
    // The gauge is what marks a row as a meter; "Weekly ⚠ Limit reached (resets in 23h
    // 19m)" has none, so it is content — the live indicator for a weekly limit, and the
    // compound-duration parse must keep the trailing 19m (was truncated to 23h).
    const weekly = 'Weekly ⚠ Limit reached (resets in 23h 19m)';
    const pane = ['some ordinary content', 'Context ██░░░░░░░░ 16% │ Usage ██░░░░░░░░ 20%', weekly, ...CHROME].join('\n');
    assert.equal(isRateLimited(pane, [], TAIL), true);
    assert.match(findRateLimitMessage(pane, [], TAIL), /Weekly ⚠ Limit reached/);
    const r = parseResetTime(findRateLimitMessage(pane, [], TAIL));
    assert.ok(r && r.relative, 'reset must parse as relative');
    assert.equal(r.waitMs, (23 * 60 + 19) * 60_000);
  });

  it('a weekly GAUGE segment on its own row is chrome too', () => {
    // Some claude-hud versions render the weekly meter as a separate row; the pattern
    // anchors on the label+gauge shape, not on line position, so it must still strip.
    const weekly = 'Weekly ████████░░ 81% (resets in 23h 19m)';
    const alone = ['ordinary content', 'Context ██░░░░░░░░ 16% │ Usage ██░░░░░░░░ 20%', weekly, ...CHROME].join('\n');
    assert.equal(isRateLimited(alone, [], TAIL), false);
    const below = [banner, 'Context ██░░░░░░░░ 16% │ Usage ██░░░░░░░░ 20%', weekly, ...CHROME].join('\n');
    assert.match(findRateLimitMessage(below, [], TAIL), /resets 3pm/);
  });

  it('prose about usage/percentages (no gauge run) is NOT stripped', () => {
    const pane = [
      'We have used 20% of the weekly budget so far, resets in spirit only',
      ...CHROME,
    ].join('\n');
    assert.equal(isRateLimited(pane, [], TAIL), false);
    // The sentence stays content: it carries no limit name, so nothing detects — but it
    // must not be dropped from the window either (it is the last content line).
    assert.equal(findRateLimitMessage(pane, [], TAIL), null);
  });
});
