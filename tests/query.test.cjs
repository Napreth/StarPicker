const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseQuery, evaluateQuery, serializeQuery, containsTopic, toggleQualifier, sortRepos, readState, writeState, parseCount } = require('../starpicker.user.js');
const repos = [
  { index: 0, name: 'Alice/zero', author: 'Alice', stars: 0, forks: 0, updated: '2026-10-01T08:00:00Z', topics: ['cli'] },
  { index: 1, name: 'Bob/tool', author: 'Bob', stars: 100, forks: 5, updated: '2026-10-20T08:00:00Z', topics: ['javascript', 'cli'], searchText: 'Bob/tool a command line tool' },
  { index: 2, name: 'Alice/web', author: 'Alice', stars: 500, forks: 20, updated: '2026-10-23T08:00:00Z', topics: ['javascript'] },
  { index: 3, name: 'Carol/unknown', author: 'Carol', stars: null, forks: null, updated: '', topics: [] },
];
const filter = query => repos.filter(repo => evaluateQuery(parseQuery(query), repo)).map(repo => repo.index);

for (const [query, expected] of [
  ['', [0, 1, 2, 3]],
  ['author:alice stars:>=100', [2]],
  ['author:alice AND stars:>=100', [2]],
  ['author:alice OR author:bob AND stars:>0', [0, 1, 2]],
  ['(author:alice OR author:bob) AND stars:>0', [1, 2]],
  ['(author:alice AND (stars:0 OR topic:javascript)) -forks:>=10', [0]],
  ['NOT (author:alice OR author:carol)', [1]],
  ['-(topic:cli OR author:carol)', [2]],
  ['topic:cli,javascript', [0, 1, 2]],
  ['topic:cli topic:javascript', [1]],
  ['author:alice,bob', [0, 1, 2]],
  ['author:alice author:bob', []],
  ['AUTHOR:"Alice" TOPIC:"javascript"', [2]],
  ['author:Ali OR topic:java', []],
  ['"command line"', [1]],
  ['web OR "command line"', [1, 2]],
  ['-unknown', [0, 1, 2]],
  ['stars:>100', [2]],
  ['star:>=100 fork:<=5', [1]],
  ['stars:<100', [0]],
  ['forks:=0', [0]],
  ['stars:0..100', [0, 1]],
  ['stars:100..*', [1, 2]],
  ['forks:*..0', [0]],
  ['stars:0,500', [0, 2]],
  ['stars:*', [0, 1, 2]],
  ['updated:2026-10-20..2026-10-23', [1, 2]],
  ['update:>=2026-10-20 updated:<2026-10-23', [1]],
  ['updated:2026-10-20', [1]],
]) test(`query: ${query || '(empty)'}`, () => assert.deepEqual(filter(query), expected));

test('invalid queries return errors with source positions', () => {
  for (const query of ['author:', 'topic:a,', 'author:a OR', 'AND topic:a', '(topic:a', 'topic:a)', '()', 'topic:"unclosed', 'topic:a AND OR topic:b', 'unknown:value', 'stars:-1', 'stars:1.5', 'stars:100..10', 'forks:1..2..3', 'updated:2026-02-30', 'updated:2026-13-01']) assert.throws(() => parseQuery(query), error => Number.isInteger(error.position), query);
  assert.doesNotThrow(() => parseQuery('(((((topic:cli)))))'));
  assert.throws(() => parseQuery('((((((topic:cli))))))'));
});

test('deferred topic data preserves OR and NOT candidates', () => {
  const repo = { ...repos[0], topics: null };
  assert.equal(evaluateQuery(parseQuery('author:alice OR topic:cli'), repo, true), true);
  assert.equal(evaluateQuery(parseQuery('author:bob OR -topic:cli'), repo, true), null);
  assert.equal(evaluateQuery(parseQuery('author:bob AND -topic:cli'), repo, true), false);
  assert.equal(evaluateQuery(parseQuery('NOT (topic:cli OR author:bob)'), repo, true), null);
  assert.equal(containsTopic(parseQuery('author:bob OR -topic:cli')), true);
});

test('serialization and dropdown edits preserve grouping and quoted terms', () => {
  for (const query of ['(author:alice OR author:bob) stars:>0', '-(topic:cli AND stars:<100)', 'NOT NOT author:alice', 'topic:"a,b" OR "AND" OR "author:literal"', '"quoted \\"word\\""']) assert.deepEqual(filter(serializeQuery(parseQuery(query))), filter(query), query);
  const query = toggleQualifier('author:alice OR author:bob', 'star', '>0');
  assert.deepEqual(filter(query), [1, 2]);
  assert.match(query, /^\(author:alice OR author:bob\) AND stars:>0$/);
  assert.deepEqual(filter(toggleQualifier(toggleQualifier(query, 'topic', 'cli'), 'topic', 'cli')), [1, 2]);
});

test('sort preserves the matching set, source order and missing values', () => {
  const selected = repos.filter(repo => evaluateQuery(parseQuery('topic:javascript'), repo));
  for (const sort of ['starred', 'starred-asc', 'stars', 'stars-asc', 'forks', 'forks-asc', 'updated', 'updated-asc', 'name']) assert.deepEqual(sortRepos(selected, sort).map(repo => repo.index).sort(), [1, 2]);
  assert.deepEqual(sortRepos(selected, 'stars').map(repo => repo.index), [2, 1]);
  assert.deepEqual(selected.map(repo => repo.index), [1, 2]);
  assert.deepEqual(sortRepos(repos, 'starred'), repos);
  assert.deepEqual(sortRepos(repos, 'starred-asc'), [...repos].reverse());
  for (const sort of ['stars', 'stars-asc', 'forks', 'forks-asc', 'updated', 'updated-asc']) assert.equal(sortRepos(repos, sort).at(-1).index, 3);
});

test('URL query round-trip migrates native scopes into the unified filters', () => {
  const url = new URL('https://github.com/alice?tab=stars&type=source&language=c%23&sort=stars');
  const state = { query: '(author:alice OR author:bob) -topic:cli stars:>100', sort: 'forks' };
  const next = writeState(url, state);
  assert.deepEqual(readState(next), state);
  assert.equal(next.searchParams.has('type'), false);
  assert.equal(next.searchParams.has('language'), false);
  const migrated = readState(url);
  assert.match(migrated.query, /type:source/);
  assert.match(migrated.query, /language:c#/);
  assert.deepEqual(readState(writeState(url, migrated)), migrated);
  assert.equal(next.searchParams.has('sort'), false);
  assert.equal(writeState(next, { query: '', sort: 'forks' }).searchParams.get('sp_sort'), 'forks');
  const old = readState(new URL('https://github.com/alice?sp_author=alice,bob&sp_star=100..&sp_sort=stars'));
  assert.equal(old.query, 'author:alice,bob stars:100..');
  assert.equal(writeState(new URL('https://github.com/alice?sp_star=1..'), old).searchParams.has('sp_star'), false);
});

const { facetState, clearFacet, updatePresets } = require('../starpicker.user.js');

test('all enum facets use OR within a dimension and AND across dimensions', () => {
  let query = toggleFacet('', 'topic', 'cli');
  query = toggleFacet(query, 'topic', 'javascript');
  assert.deepEqual(filter(query), [0, 1, 2]);
  assert.deepEqual(facetState(query).topic, ['cli', 'javascript']);
  query = toggleFacet(query, 'author', 'alice');
  assert.deepEqual(filter(query), [0, 2]);
  query = toggleFacet(query, 'author', 'bob');
  assert.deepEqual(filter(query), [0, 1, 2]);
  query = toggleFacet(query, 'topic', 'cli');
  assert.deepEqual(filter(query), [1, 2]);
});

test('single facets replace their old condition instead of adding another', () => {
  for (const [key, first, second] of [['star', '>100', '>=1000'], ['fork', '>10', '0'], ['update', '>=20260812', '20250611-20250912']]) {
    const initial = toggleFacet('author:alice', key, first);
    const changed = toggleFacet(initial, key, second);
    assert.deepEqual(facetState(changed)[key], [second]);
    assert.equal(toggleFacet(changed, key, second), 'author:alice');
  }
});

test('clearing compatible grouped facets preserves the other dimensions and text', () => {
  const query = '(author:alice OR author:bob) AND (topic:cli OR topic:javascript) stars:>=0 "tool"';
  assert.deepEqual(facetState(query).author, ['alice', 'bob']);
  assert.deepEqual(filter(clearFacet(query, 'topic')), [1]);
  assert.equal(facetState(clearFacet(query, 'author')).author, undefined);
  assert.deepEqual(filter(toggleFacet('author:alice OR author:bob', 'topic', 'javascript')), [1, 2]);
});

test('complex boolean expressions do not expose a misleading per-facet clear', () => {
  for (const query of ['author:alice OR topic:cli', '-author:alice', 'topic:cli topic:javascript', 'stars:1,2', 'stars:>10 stars:<100', '"one" OR "two"']) {
    assert.equal(facetState(query), null, query);
    assert.equal(clearFacet(query, 'author'), query);
  }
});

test('unified Type and Language preserve multi-select semantics', () => {
  const examples = [
    { ...repos[0], types: ['public', 'source'], language: 'C#' },
    { ...repos[1], types: ['private', 'fork'], language: 'TypeScript' },
    { ...repos[2], types: ['public', 'fork'], language: '@none' },
  ];
  const select = query => examples.filter(repo => evaluateQuery(parseQuery(query), repo)).map(repo => repo.index);
  assert.deepEqual(select('type:public,private language:c#,typescript'), [0, 1]);
  assert.deepEqual(select('(type:source OR type:fork) AND language:@none'), [2]);
  assert.equal(evaluateQuery(parseQuery('NOT type:public'), { ...repos[0], types: null }, true), null);
  assert.throws(() => parseQuery('type:unknown'));
});

test('compact update dates and ranges include the full local boundary days', () => {
  const rows = ['2025-06-10T23:59:59', '2025-06-11T00:00:00', '2025-09-12T23:59:59', '2025-09-13T00:00:00'].map((updated, index) => ({ ...repos[0], updated, index }));
  const select = value => rows.filter(repo => evaluateQuery(parseQuery(`updated:${value}`), repo)).map(repo => repo.index);
  assert.deepEqual(select('20250611-20250912'), [1, 2]);
  assert.deepEqual(select('>=20250912'), [2, 3]);
  assert.deepEqual(select('<=20250611'), [0, 1]);
  assert.deepEqual(select('>20250611'), [2, 3]);
  for (const value of ['20260230', '20261301', '2025-0611', '20250912-20250611', '20250611000060']) assert.throws(() => parseQuery(`updated:${value}`), value);
});

test('the seven Update presets use calendar months and an exact 24-hour cutoff', () => {
  const now = new Date('2026-08-31T12:30:00');
  const options = updatePresets(now);
  assert.deepEqual(options.map(([label]) => label), ['within a year', 'within six months', 'within three months', 'within a month', 'within a week', 'within three days', 'within 24 hours']);
  assert.equal(options[1][1], '>=20260228');
  const query = parseQuery(`updated:${options.at(-1)[1]}`);
  assert.equal(evaluateQuery(query, { ...repos[0], updated: '2026-08-30T12:29:59' }), false);
  assert.equal(evaluateQuery(query, { ...repos[0], updated: '2026-08-30T12:30:00' }), true);
});

test('GitHub displayed counts accept separators, zero and abbreviations', () => {
  assert.equal(parseCount('15,375'), 15375);
  assert.equal(parseCount('1.2k'), 1200);
  assert.equal(parseCount('0'), 0);
  assert.equal(parseCount('unknown'), null);
});

const { containsList, toggleFacet, suggestionContext, builderFromQuery, builderQuery } = require('../starpicker.user.js');
const listed = repos.map((repo, index) => ({ ...repo, lists: index === 0 ? ['📱 玩机', '玩机'] : index === 1 ? ['📱 玩机', '玩机', '⬇️ 下载', '下载'] : [] }));
const listFilter = query => listed.filter(repo => evaluateQuery(parseQuery(query), repo)).map(repo => repo.index);

test('List supports quoted names, slugs, OR alternatives and overlapping membership', () => {
  assert.deepEqual(listFilter('list:"📱 玩机"'), [0, 1]);
  assert.deepEqual(listFilter('list:玩机'), [0, 1]);
  assert.deepEqual(listFilter('list:玩机 list:下载'), [1]);
  assert.deepEqual(listFilter('list:玩机,下载'), [0, 1]);
  assert.deepEqual(listFilter('list:下载 OR (author:alice -list:玩机)'), [1, 2]);
});

test('no:list and has:list include unassigned and assigned repositories', () => {
  assert.deepEqual(listFilter('no:list'), [2, 3]);
  assert.deepEqual(listFilter('list:@none'), [2, 3]);
  assert.deepEqual(listFilter('has:list'), [0, 1]);
  assert.deepEqual(listFilter('-list:@none'), [0, 1]);
  assert.equal(containsList(parseQuery('topic:cli OR -list:下载')), true);
});

test('unloaded List membership remains unknown under negation and OR', () => {
  const repo = { ...repos[0], lists: null, topics: null };
  assert.equal(evaluateQuery(parseQuery('-list:玩机'), repo, true), null);
  assert.equal(evaluateQuery(parseQuery('no:list OR topic:cli'), repo, true), null);
  assert.equal(evaluateQuery(parseQuery('author:bob AND no:list'), repo, true), false);
});

test('facet multi-select uses OR and removes only the selected value', () => {
  let query = toggleFacet('stars:>=0', 'list', '玩机');
  query = toggleFacet(query, 'list', '下载');
  assert.match(query, /list:玩机,下载/);
  assert.deepEqual(listFilter(query), [0, 1]);
  query = toggleFacet(query, 'list', '玩机');
  assert.deepEqual(listFilter(query), [1]);
  assert.deepEqual(listFilter(toggleFacet('author:alice OR author:bob', 'list', '下载')), [1]);
});

test('advanced Filter builder round-trips boolean and comparison semantics', () => {
  for (const query of ['', 'list:"📱 玩机" stars:>=100', 'no:list OR (list:下载 -topic:cli)', 'NOT (author:alice OR author:bob)', '(stars:>100 OR forks:0..10) -updated:<2026-10-20', 'stars:0,>100', 'topic:"a,b" OR "AND"', 'author:alice,bob topic:cli']) {
    assert.deepEqual(listFilter(builderQuery(builderFromQuery(query))), listFilter(query), query);
  }
});

test('advanced builder writes group matching, numeric ranges and exclusions', () => {
  const draft = { kind: 'group', operator: 'or', children: [
    { kind: 'condition', field: 'list', operator: 'matches', value: '下载' },
    { kind: 'group', operator: 'and', children: [
      { kind: 'condition', field: 'star', operator: 'between', value: '400..600' },
      { kind: 'condition', field: 'topic', operator: 'matches', value: 'cli', negated: true },
    ] },
  ] };
  assert.deepEqual(listFilter(builderQuery(draft)), [1, 2]);
  assert.throws(() => builderQuery({ kind: 'group', operator: 'and', children: [{ kind: 'condition', field: 'list', operator: 'matches', value: '' }] }));
});

test('suggestion replacement respects the cursor, comma lists and quoted Unicode names', () => {
  const query = 'list:"📱 玩机" stars:>=100';
  const context = suggestionContext(query, query.indexOf('机'));
  assert.equal(context.key, 'list');
  assert.equal(context.prefix, '📱 玩');
  assert.equal(query.slice(context.start, context.end), '"📱 玩机"');
  const authors = 'author:alice,bob topic:cli';
  const partial = suggestionContext(authors, authors.indexOf('bob') + 2);
  assert.equal(authors.slice(partial.start, partial.end), 'bob');
  assert.equal(partial.prefix, 'bo');
  assert.equal(suggestionContext('-topic:cli', 9).key, 'topic');
});

test('data pagination removes local query state without losing native scope or cursor', () => {
  const { dataURL } = require('../starpicker.user.js');
  const url = dataURL('https://github.com/alice?tab=stars&type=source&language=c%23&after=cursor&q=list%3Atools&sp_sort=stars&sp_author=alice&sort=stars&direction=desc');
  assert.equal(url.searchParams.get('after'), 'cursor');
  assert.equal(url.searchParams.get('type'), 'source');
  assert.equal(url.searchParams.get('language'), 'c#');
  for (const name of ['q', 'sp_sort', 'sp_author', 'sort', 'direction']) assert.equal(url.searchParams.has(name), false, name);
});
