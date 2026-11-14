import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellQuote, verifyDecoderResults } from './verify-macos.mjs';

const successful =
  '<TestRun><Results><UnitTestResult testName="Vroom.Tests.NativePlaybackTests.RealMpvDecodesTracksAppliesSettingsAndSurvivesAnotherDecoderCrash" outcome="Passed" /></Results><ResultSummary><Counters total="4" passed="4" failed="0" notExecuted="0" /></ResultSummary></TestRun>';
test('accepts evidence that the real decoder test ran and rejects successful runs that skipped it', () => {
  assert.equal(verifyDecoderResults(successful).realDecoderExecuted, true);
  assert.throws(() =>
    verifyDecoderResults(
      successful
        .replace('outcome="Passed"', 'outcome="NotExecuted"')
        .replace('passed="4"', 'passed="3"')
        .replace('notExecuted="0"', 'notExecuted="1"'),
    ),
  );
  assert.throws(() =>
    verifyDecoderResults(
      successful.replace('RealMpvDecodesTracksAppliesSettingsAndSurvivesAnotherDecoderCrash', 'SettingsOnly'),
    ),
  );
  assert.throws(() =>
    verifyDecoderResults(successful.replace('passed="4"', 'passed="3"').replace('failed="0"', 'failed="1"')),
  );
  assert.throws(() => verifyDecoderResults('partial build output'));
});
test('the local launcher preserves paths containing whitespace and shell syntax as literal arguments', () => {
  assert.equal(
    shellQuote("/Users/Test Person/Video's $(name) `file`"),
    "'/Users/Test Person/Video'\\''s $(name) `file`'",
  );
});
