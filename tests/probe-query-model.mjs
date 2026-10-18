import test from 'node:test';
import assert from 'node:assert/strict';
import { topTypes, createVisibleTypeCache } from '../web/query-model.js';
import { checkPlan } from '../tools/check.mjs';
import { checkTag } from '../tools/check-version.mjs';

test('bounded rankings match stable complete sorting, including ties and limits', () => {
  let seed = 312;
  const values = Array.from({ length: 10000 }, (_, id) => ({ id, score: (seed = (seed * 1664525 + 1013904223) >>> 0) % 119 }));
  for (const limit of [0, 1, 12, 400, 12000]) {
    assert.deepEqual(topTypes(values, (v) => v.score, limit), values.slice().sort((a, b) => b.score - a.score).slice(0, limit));
  }
  let calls = 0; topTypes(values, (v) => { calls++; return v.score; });
  assert.equal(calls, values.length);
  assert.throws(() => topTypes(values, (v) => v.score, -1));
});

test('visible data is reused across redraws and invalidated by filters and bundle replacement', () => {
  const state = { bundle: { types: [{ id: 0 }, { id: 1 }] }, kinds: new Set(['class']), langs: null,
    q: '', minCode: 0, hideGenerated: false, depFocus: false, selected: 0 };
  const cached = createVisibleTypeCache(); let calls = 0;
  const matches = () => { calls++; return true; };
  const initial = cached(state, matches); assert.equal(calls, 2);
  state.selected = 1; assert.equal(cached(state, matches), initial); assert.equal(calls, 2);
  for (const edit of [() => state.kinds.add('function'), () => { state.q = 'term'; },
    () => { state.langs = new Set(['javascript']); }, () => { state.minCode = 1; },
    () => { state.hideGenerated = true; }, () => { state.depFocus = true; },
    () => { state.selected = 0; }, () => { state.bundle = { types: [{ id: 0 }] }; }]) {
    const before = calls; edit(); cached(state, matches); assert.ok(calls > before);
  }
  assert.ok(Object.isFrozen(initial));
});

test('both graphs share one check set; CI includes launcher and quoting checks', () => {
  const both = checkPlan({ mode: 'both', launcher: true });
  assert.equal(both.filter(([name]) => name === 'languages').length, 1);
  for (const name of ['payload path quoting', 'MCP self graph', 'MCP CI graph', 'launcher build', 'launcher headless']) assert.ok(both.some(([label]) => label === name));
  assert.ok(both.findIndex(([label]) => label === 'launcher headless') > both.findIndex(([label]) => label === 'launcher build'));
  assert.throws(() => checkPlan({ mode: 'typo' }));
  assert.doesNotThrow(() => checkTag('1.9.0', 'v1.9.0'));
  assert.throws(() => checkTag('1.9.0', 'v1.9.1'), /does not match/);
});
