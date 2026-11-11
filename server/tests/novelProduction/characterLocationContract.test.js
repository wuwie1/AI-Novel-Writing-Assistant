const test = require('node:test');
const assert = require('node:assert/strict');
const {chapterArtifactDeltaOutputSchema} = require('../../dist/prompting/prompts/novel/chapterArtifactDelta.prompts');

test('unified extraction preserves actual and non-present location evidence for guarded backfill', () => {
  const input = {
    summary:'甲仍在牢房，乙到客栈。',stateDeltas:{},syncPlan:{reason:'按最终正文回填'},confidence:0.95,
    characterLocationDeltas:[{
      characterId:'a',characterName:'甲',fromLocation:'牢房',locationName:'客栈',
      movementType:'move',timeContext:'plan',continuityStatus:'consistent',
      evidence:'甲打算明日去客栈。',explanation:'尚未出发。',
    }],
  };
  assert.deepEqual(chapterArtifactDeltaOutputSchema.parse(input).characterLocationDeltas, input.characterLocationDeltas);
});

test('older extraction checkpoints remain reusable without fabricated location changes', () => {
  const parsed = chapterArtifactDeltaOutputSchema.parse({summary:'旧正文',stateDeltas:{},syncPlan:{reason:'无位置记录'},confidence:0.9});
  assert.deepEqual(parsed.characterLocationDeltas, []);
});

function extractionWithLocation(location) {
  return {
    summary: '方荃首次出现在出租屋。',
    stateDeltas: {},
    syncPlan: {reason: '按最终正文回填'},
    confidence: 0.95,
    characterLocationDeltas: [{
      characterId: 'doctor',
      characterName: '方荃',
      locationName: '出租屋',
      movementType: 'stay',
      timeContext: 'present',
      continuityStatus: 'consistent',
      evidence: '方荃坐在出租屋的床沿上。',
      ...location,
    }],
  };
}

test('blank prior locations become unknown without discarding the location or its evidence', () => {
  for (const fromLocation of ['', '  ', '\t\n', null]) {
    const input = extractionWithLocation({fromLocation});
    const parsed = chapterArtifactDeltaOutputSchema.parse(input);
    assert.deepEqual(parsed.characterLocationDeltas, [{...input.characterLocationDeltas[0], fromLocation: null}]);
    assert.deepEqual(chapterArtifactDeltaOutputSchema.parse(parsed), parsed, 'saved extraction remains reusable');
  }
});

test('omitted and known prior locations retain their existing meaning', () => {
  const omitted = chapterArtifactDeltaOutputSchema.parse(extractionWithLocation({}));
  assert.equal(omitted.characterLocationDeltas[0].fromLocation, undefined);
  const known = chapterArtifactDeltaOutputSchema.parse(extractionWithLocation({fromLocation: '  站台  '}));
  assert.equal(known.characterLocationDeltas[0].fromLocation, '站台');
});

test('unknown prior locations do not weaken identity, destination, evidence or movement validation', () => {
  for (const invalid of [
    {fromLocation: 0}, {fromLocation: false}, {fromLocation: {}}, {fromLocation: []},
    {characterName: ''}, {locationName: ''}, {evidence: ''},
    {movementType: 'teleport'}, {timeContext: 'unknown'}, {continuityStatus: 'unknown'},
  ]) {
    const result = chapterArtifactDeltaOutputSchema.safeParse(extractionWithLocation(invalid));
    assert.equal(result.success, false, JSON.stringify(invalid));
  }
});
