// ==UserScript==
// @name         StarPicker
// @namespace    https://github.com/Napreth/StarPicker
// @version      1.0.0
// @description  Filter GitHub stars by type, language, author, list, topic, stars, forks and update date; sort results independently.
// @author       Napreth
// @license      MIT
// @match        https://github.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const FILTERS = ['type', 'language', 'author', 'list', 'topic', 'star', 'fork', 'update'];
  const MULTI_FILTERS = new Set(['type', 'language', 'author', 'list', 'topic']);
  const TYPE_LABELS = { public: 'Public', private: 'Private', source: 'Sources', fork: 'Forks', sponsorable: 'Can be sponsored', mirror: 'Mirrors', template: 'Templates' };
  const SORTS = {
    starred: 'Recently starred',
    'starred-asc': 'Least recently starred',
    updated: 'Recently active',
    'updated-asc': 'Least recently active',
    stars: 'Most stars',
    'stars-asc': 'Fewest stars',
    forks: 'Most forks',
    'forks-asc': 'Fewest forks',
    name: 'Name (A–Z)',
  };

  const terms = value => [...new Set(value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];

  function parseCount(value) {
    const match = String(value).replace(/[\s,\u00a0]/g, '').match(/^(\d+(?:\.\d+)?)([km])?$/i);
    if (!match) return null;
    return Math.round(Number(match[1]) * ({ k: 1000, m: 1000000 }[match[2]?.toLowerCase()] || 1));
  }

  function parseRange(value, date = false) {
    const parts = value.split('..');
    if (parts.length !== 2) throw new Error('Enter a minimum and/or maximum.');
    const bounds = parts.map(part => {
      if (!part) return null;
      if (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(part)) throw new Error('Use dates in YYYY-MM-DD format.');
        const parsed = new Date(`${part}T00:00:00`);
        if (!Number.isFinite(parsed.getTime()) || localDate(parsed) !== part) throw new Error('Enter a valid date.');
        return part;
      }
      if (!/^\d+$/.test(part) || !Number.isSafeInteger(Number(part))) throw new Error('Use whole numbers of zero or more.');
      return Number(part);
    });
    if (bounds[0] !== null && bounds[1] !== null && bounds[0] > bounds[1]) {
      throw new Error('The minimum must not be greater than the maximum.');
    }
    return bounds;
  }

  function localDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  const QUALIFIERS = { type: 'type', language: 'language', author: 'author', list: 'list', topic: 'topic', star: 'star', stars: 'star', fork: 'fork', forks: 'fork', update: 'update', updated: 'update' };
  const QUERY_KEYS = { type: 'type', language: 'language', author: 'author', list: 'list', topic: 'topic', star: 'stars', fork: 'forks', update: 'updated' };
  const LABELS = { type: 'Type', language: 'Language', author: 'Author', list: 'List', topic: 'Topic', star: 'Star', fork: 'Fork', update: 'Update', text: 'Text' };
  const quoteValue = value => /[\s(),"\\]/.test(value) ? JSON.stringify(value) : value;

  function queryError(message, position) {
    const error = new Error(`${message} (column ${position + 1})`);
    error.position = position;
    return error;
  }

  function tokenize(query) {
    if (query.length > 8000) throw queryError('Query is too long.', 8000);
    const tokens = [];
    let index = 0;
    while (index < query.length) {
      if (/\s/.test(query[index])) { index++; continue; }
      const start = index;
      if ('()-'.includes(query[index])) {
        const character = query[index++];
        tokens.push({ type: character === '-' ? 'NOT' : character, raw: character, start, end: index });
        continue;
      }
      let quoted = false;
      while (index < query.length) {
        const character = query[index];
        if (character === '\\' && quoted) { index += 2; continue; }
        if (character === '"') quoted = !quoted;
        if (!quoted && /[\s()]/.test(character)) break;
        index++;
      }
      if (quoted) throw queryError('Unclosed quotation mark.', start);
      const raw = query.slice(start, index);
      tokens.push({ type: ['AND', 'OR', 'NOT'].includes(raw) ? raw : 'TERM', raw, start, end: index });
    }
    return tokens;
  }

  function choices(raw, position) {
    const values = [];
    let start = 0;
    let quoted = false;
    for (let index = 0; index <= raw.length; index++) {
      if (raw[index] === '\\' && quoted) { index++; continue; }
      if (raw[index] === '"') quoted = !quoted;
      if (index < raw.length && (quoted || raw[index] !== ',')) continue;
      const part = raw.slice(start, index);
      if (!part) throw queryError('A filter value is missing.', position + start);
      try {
        if (part.startsWith('"')) {
          const value = JSON.parse(part);
          if (!value) throw new Error();
          values.push(value);
        } else {
          if (part.includes('"')) throw new Error();
          values.push(part);
        }
      } catch { throw queryError('Use double quotes around values containing spaces.', position + start); }
      start = index + 1;
    }
    return values;
  }

  function dateBoundary(raw, position = 0) {
    if (!/^(?:\d{8}(?:\d{6})?|\d{4}-\d{2}-\d{2})$/.test(raw)) throw queryError('Use a date such as 20260812.', position);
    const compact = raw.replace(/-/g, '');
    if (!/^\d{8}(?:\d{6})?$/.test(compact)) throw queryError('Use a date such as 20260812.', position);
    const day = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
    const date = new Date(`${day}T${compact.length === 14 ? `${compact.slice(8, 10)}:${compact.slice(10, 12)}:${compact.slice(12, 14)}` : '00:00:00'}`);
    if (!Number.isFinite(date.getTime()) || localDate(date) !== day || compact.length === 14 && `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}` !== compact.slice(8)) throw queryError('Enter a valid date.', position);
    const start = date.getTime();
    if (compact.length === 14) return [start, start];
    date.setDate(date.getDate() + 1);
    return [start, date.getTime() - 1];
  }

  function dateComparison(raw, position) {
    if (raw === '*') return value => value !== null;
    const range = raw.match(/^(\d{8})-(\d{8})$/);
    if (range || raw.includes('..')) {
      const parts = range ? range.slice(1) : raw.split('..');
      if (parts.length !== 2) throw queryError('Use a range such as 20250611-20250912.', position);
      const min = !parts[0] || parts[0] === '*' ? null : dateBoundary(parts[0], position)[0];
      const max = !parts[1] || parts[1] === '*' ? null : dateBoundary(parts[1], position)[1];
      if (min !== null && max !== null && min > max) throw queryError('The range minimum exceeds its maximum.', position);
      return value => value !== null && (min === null || value >= min) && (max === null || value <= max);
    }
    const match = raw.match(/^(<=|>=|<|>|=)?(.+)$/);
    const [start, end] = dateBoundary(match[2], position);
    return value => value !== null && ({ '>=': value >= start, '>': value > end, '<=': value <= end, '<': value < start, '=': value >= start && value <= end })[match[1] || '='];
  }

  function updatePresets(now = new Date()) {
    const ago = months => {
      const date = new Date(now);
      const day = date.getDate();
      date.setDate(1);
      date.setMonth(date.getMonth() - months);
      const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      date.setDate(Math.min(day, last));
      return `>=${localDate(date).replaceAll('-', '')}`;
    };
    const daysAgo = days => {
      const date = new Date(now);
      date.setDate(date.getDate() - days);
      return `>=${localDate(date).replaceAll('-', '')}`;
    };
    const yesterday = new Date(now.getTime() - 86400000);
    const stamp = `${localDate(yesterday).replaceAll('-', '')}${String(yesterday.getHours()).padStart(2, '0')}${String(yesterday.getMinutes()).padStart(2, '0')}${String(yesterday.getSeconds()).padStart(2, '0')}`;
    return [['within a year', ago(12)], ['within six months', ago(6)], ['within three months', ago(3)], ['within a month', ago(1)], ['within a week', daysAgo(7)], ['within three days', daysAgo(3)], ['within 24 hours', `>=${stamp}`]];
  }

  function comparison(raw, date, position) {
    if (date) return dateComparison(raw, position);
    const scalar = text => {
      if (date) {
        try { return parseRange(`${text}..`, true)[0]; }
        catch { throw queryError('Use a valid YYYY-MM-DD date.', position); }
      }
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw queryError('Use a non-negative whole number.', position);
      return Number(text);
    };
    const operator = raw.match(/^(<=|>=|<|>|=)(.+)$/);
    if (operator) {
      const boundary = scalar(operator[2]);
      return value => value !== null && ({ '<': value < boundary, '>': value > boundary, '<=': value <= boundary, '>=': value >= boundary, '=': value === boundary })[operator[1]];
    }
    if (raw.includes('..')) {
      const bounds = raw.split('..');
      if (bounds.length !== 2) throw queryError('Use a range such as 10..100 or *..100.', position);
      const [min, max] = bounds.map(value => value === '*' || value === '' ? null : scalar(value));
      if (min !== null && max !== null && min > max) throw queryError('The range minimum exceeds its maximum.', position);
      return value => value !== null && (min === null || value >= min) && (max === null || value <= max);
    }
    if (raw === '*') return value => value !== null;
    const exact = scalar(raw);
    return value => value !== null && value === exact;
  }

  function atom(token) {
    const match = token.raw.match(/^([\w-]+):(.*)$/);
    if (!match) {
      const text = choices(token.raw, token.start).join(',').toLowerCase();
      return { type: 'term', key: 'text', values: [text], test: repo => (repo.searchText || repo.name).toLowerCase().includes(text) };
    }
    if (/^(no|has)$/i.test(match[1]) && match[2].toLowerCase() === 'list') {
      return atom({ ...token, raw: `list:${match[1].toLowerCase() === 'no' ? '@none' : '@any'}` });
    }
    const key = QUALIFIERS[match[1].toLowerCase()];
    if (!key) throw queryError(`Unknown qualifier "${match[1]}".`, token.start);
    const values = choices(match[2], token.start + match[1].length + 1);
    let test;
    if (MULTI_FILTERS.has(key)) {
      const normalized = values.map(value => value.toLowerCase());
      if (key === 'type' && normalized.some(value => !Object.hasOwn(TYPE_LABELS, value))) throw queryError('Choose a valid repository type.', token.start);
      test = repo => key === 'type' ? normalized.some(value => repo.types?.includes(value)) : key === 'language' ? normalized.includes((repo.language || '@none').toLowerCase()) : key === 'author' ? normalized.includes(repo.author.toLowerCase()) : key === 'topic'
        ? normalized.some(value => repo.topics?.includes(value))
        : normalized.some(value => value === '@none' ? repo.lists?.length === 0 : value === '@any' ? (repo.lists?.length || 0) > 0 : repo.lists?.some(name => name.toLowerCase() === value));
    } else {
      const predicates = values.map(value => comparison(value, key === 'update', token.start));
      test = repo => {
        const date = key === 'update' ? new Date(repo.updated) : null;
        const value = key === 'update' ? (Number.isFinite(date.getTime()) ? date.getTime() : null) : repo[key === 'star' ? 'stars' : 'forks'];
        return predicates.some(predicate => predicate(value));
      };
    }
    return { type: 'term', key, values, test };
  }

  function parseQuery(query) {
    const tokens = tokenize(query);
    if (!tokens.length) return null;
    let cursor = 0;
    let depth = 0;
    function unary() {
      const token = tokens[cursor++];
      if (!token) throw queryError('Expected a filter.', query.length);
      if (token.type === 'NOT') return { type: 'not', child: unary() };
      if (token.type === '(') {
        if (++depth > 5) throw queryError('Use no more than five levels of parentheses.', token.start);
        const child = or();
        if (tokens[cursor]?.type !== ')') throw queryError('Missing closing parenthesis.', token.start);
        cursor++;
        depth--;
        return child;
      }
      if (token.type !== 'TERM') throw queryError(`Unexpected ${token.raw}.`, token.start);
      return atom(token);
    }
    function and() {
      let node = unary();
      while (cursor < tokens.length && !['OR', ')'].includes(tokens[cursor].type)) {
        if (tokens[cursor].type === 'AND') cursor++;
        node = { type: 'and', left: node, right: unary() };
      }
      return node;
    }
    function or() {
      let node = and();
      while (tokens[cursor]?.type === 'OR') {
        cursor++;
        node = { type: 'or', left: node, right: and() };
      }
      return node;
    }
    const result = or();
    if (cursor !== tokens.length) throw queryError('Unexpected closing parenthesis.', tokens[cursor].start);
    return result;
  }

  function evaluateQuery(node, repo, deferTopics = false) {
    if (!node) return true;
    if (node.type === 'term') return deferTopics && (node.key === 'topic' && repo.topics === null || node.key === 'list' && repo.lists == null || node.key === 'type' && repo.types == null) ? null : node.test(repo);
    if (node.type === 'not') {
      const value = evaluateQuery(node.child, repo, deferTopics);
      return value === null ? null : !value;
    }
    const left = evaluateQuery(node.left, repo, deferTopics);
    const right = evaluateQuery(node.right, repo, deferTopics);
    if (node.type === 'and') return left === false || right === false ? false : left === null || right === null ? null : true;
    return left === true || right === true ? true : left === null || right === null ? null : false;
  }

  function containsTopic(node) {
    return Boolean(node && (node.key === 'topic' || containsTopic(node.child) || containsTopic(node.left) || containsTopic(node.right)));
  }

  function containsList(node) {
    return Boolean(node && (node.key === 'list' || containsList(node.child) || containsList(node.left) || containsList(node.right)));
  }

  function serializeQuery(node, parent = '') {
    if (!node) return '';
    if (node.type === 'term') return node.key === 'text' ? JSON.stringify(node.values[0]) : `${QUERY_KEYS[node.key]}:${node.values.map(quoteValue).join(',')}`;
    if (node.type === 'not') return `-${node.child.type === 'term' ? serializeQuery(node.child) : `(${serializeQuery(node.child)})`}`;
    const text = `${serializeQuery(node.left, node.type)} ${node.type.toUpperCase()} ${serializeQuery(node.right, node.type)}`;
    return node.type === 'or' && parent === 'and' ? `(${text})` : text;
  }

  function queryConjuncts(node) {
    return !node ? [] : node.type === 'and' ? [...queryConjuncts(node.left), ...queryConjuncts(node.right)] : [node];
  }

  function toggleQualifier(query, key, value) {
    const nodes = queryConjuncts(parseQuery(query));
    const found = nodes.findIndex(node => node.type === 'term' && node.key === key && node.values.length === 1 && node.values[0].toLowerCase() === value.toLowerCase());
    if (found >= 0) nodes.splice(found, 1);
    else nodes.push(atom({ raw: `${QUERY_KEYS[key]}:${quoteValue(value)}`, start: 0 }));
    const root = nodes.reduce((left, right) => left ? { type: 'and', left, right } : right, null);
    const result = serializeQuery(root);
    parseQuery(result);
    return result;
  }

  function facetState(query) {
    const result = {};
    const alternatives = node => node.type === 'or' ? [...alternatives(node.left), ...alternatives(node.right)] : [node];
    for (const group of queryConjuncts(parseQuery(query))) {
      const nodes = alternatives(group);
      const key = nodes[0].key;
      if (!nodes.every(node => node.type === 'term' && node.key === key) || !key) return null;
      if (key === 'text') { if (nodes.length > 1) return null; continue; }
      if (!MULTI_FILTERS.has(key) && (nodes.length > 1 || nodes[0].values.length > 1)) return null;
      const values = [...new Set(nodes.flatMap(node => node.values))];
      if (result[key] && (result[key].length !== values.length || result[key].some(value => !values.includes(value)))) return null;
      result[key] = values;
    }
    return result;
  }

  function clearFacet(query, key) {
    if (!facetState(query)) return query;
    const nodes = queryConjuncts(parseQuery(query)).filter(node => {
      let first = node;
      while (first.type === 'or') first = first.left;
      return first.key !== key;
    });
    return serializeQuery(nodes.reduce((left, right) => left ? { type: 'and', left, right } : right, null));
  }

  function toggleFacet(query, key, value) {
    const compatible = facetState(query);
    if (compatible) {
      const values = [...(compatible[key] || [])];
      const selected = values.findIndex(item => item.toLowerCase() === value.toLowerCase());
      if (MULTI_FILTERS.has(key)) {
        if (selected >= 0) values.splice(selected, 1);
        else values.push(value);
      } else values.splice(0, values.length, ...(selected >= 0 ? [] : [value]));
      const rest = parseQuery(clearFacet(query, key));
      const clause = values.length ? atom({ raw: `${QUERY_KEYS[key]}:${values.map(quoteValue).join(',')}`, start: 0 }) : null;
      return serializeQuery(rest && clause ? { type: 'and', left: rest, right: clause } : rest || clause);
    }
    if (!MULTI_FILTERS.has(key)) {
      const rest = queryConjuncts(parseQuery(query)).filter(node => !(node.type === 'term' && node.key === key));
      rest.push(atom({ raw: `${QUERY_KEYS[key]}:${quoteValue(value)}`, start: 0 }));
      return serializeQuery(rest.reduce((left, right) => left ? { type: 'and', left, right } : right, null));
    }
    const nodes = queryConjuncts(parseQuery(query));
    const index = nodes.findIndex(node => node.type === 'term' && node.key === key);
    const values = index >= 0 ? [...nodes[index].values] : [];
    const selected = values.findIndex(item => item.toLowerCase() === value.toLowerCase());
    if (selected >= 0) values.splice(selected, 1);
    else values.push(value);
    if (index >= 0) nodes.splice(index, 1);
    if (values.length) nodes.splice(index >= 0 ? index : nodes.length, 0, atom({ raw: `${QUERY_KEYS[key]}:${values.map(quoteValue).join(',')}`, start: 0 }));
    return serializeQuery(nodes.reduce((left, right) => left ? { type: 'and', left, right } : right, null));
  }

  function suggestionContext(query, cursor) {
    let start = 0, quoted = false;
    for (let index = 0; index < cursor; index++) {
      if (query[index] === '\\' && quoted) { index++; continue; }
      if (query[index] === '"') quoted = !quoted;
      if (!quoted && /[\s()]/.test(query[index])) start = index + 1;
    }
    const prefix = query.slice(start, cursor);
    const match = prefix.match(/^(-?)([\w-]+):(.*)$/s);
    let end = cursor;
    for (let index = cursor; index < query.length; index++) {
      if (query[index] === '\\' && quoted) { index++; end = index + 1; continue; }
      if (query[index] === '"') quoted = !quoted;
      if (!quoted && /[\s(),]/.test(query[index])) break;
      end = index + 1;
    }
    if (!match || !QUALIFIERS[match[2].toLowerCase()]) return { kind: 'provider', prefix, start, end };
    const valueStart = start + match[1].length + match[2].length + 1;
    let lastComma = -1;
    quoted = false;
    for (let index = valueStart; index < cursor; index++) {
      if (query[index] === '\\' && quoted) { index++; continue; }
      if (query[index] === '"') quoted = !quoted;
      if (!quoted && query[index] === ',') lastComma = index;
    }
    start = lastComma >= 0 ? lastComma + 1 : valueStart;
    return { kind: 'value', key: QUALIFIERS[match[2].toLowerCase()], prefix: query.slice(start, cursor).replace(/^"/, '').replace(/"$/, ''), start, end };
  }

  function builderFromQuery(query) {
    function convert(node) {
      if (!node) return { kind: 'group', operator: 'and', children: [] };
      if (node.type === 'and' || node.type === 'or') {
        const children = [];
        const collect = item => item.type === node.type ? (collect(item.left), collect(item.right)) : children.push(convert(item));
        collect(node);
        return { kind: 'group', operator: node.type, children };
      }
      if (node.type === 'not') {
        const child = convert(node.child);
        child.negated = !child.negated;
        return child;
      }
      let value = node.values.length > 1 ? node.values.map(quoteValue).join(',') : node.values[0];
      let operator = 'matches';
      if (['star', 'fork', 'update'].includes(node.key) && node.values.length === 1) {
        const comparison = value.match(/^(<=|>=|<|>|=)(.+)$/);
        if (comparison) { operator = comparison[1]; value = comparison[2]; }
        else if (value.includes('..')) operator = 'between';
        else if (value !== '*') operator = '=';
      }
      return { kind: 'condition', field: node.key, value, operator, alternatives: node.values.length > 1 };
    }
    const root = convert(parseQuery(query));
    return root.kind === 'group' ? root : { kind: 'group', operator: 'and', children: [root] };
  }

  function builderQuery(root) {
    function build(item, depth = 0) {
      if (depth > 5) throw new Error('Use no more than five nested groups.');
      let query;
      if (item.kind === 'group') {
        const parts = item.children.map(child => build(child, depth + 1));
        query = parts.join(item.operator === 'or' ? ' OR ' : ' AND ');
        if (parts.length > 1) query = `(${query})`;
      } else {
        const value = item.value.trim();
        if (!value) throw new Error(`Choose a value for ${LABELS[item.field]}.`);
        if (item.field === 'text') query = JSON.stringify(value);
        else if (['author', 'topic', 'list'].includes(item.field)) {
          const values = item.alternatives ? choices(value, 0).map(part => part.trim()) : [value];
          query = `${QUERY_KEYS[item.field]}:${values.map(quoteValue).join(',')}`;
        } else {
          const operator = item.operator === 'matches' ? '' : item.operator === 'between' ? '' : item.operator;
          query = `${QUERY_KEYS[item.field]}:${operator}${value}`;
        }
      }
      return item.negated && query ? `NOT (${query})` : query;
    }
    const query = build(root);
    parseQuery(query);
    return query;
  }

  function sortRepos(repos, sort) {
    const [key, order] = sort.split('-');
    const direction = order === 'asc' ? 1 : -1;
    return [...repos].sort((a, b) => {
      if (key === 'name') return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.index - b.index;
      if (key === 'starred') return (b.index - a.index) * direction;
      const av = key === 'updated' ? Date.parse(a.updated) : a[key];
      const bv = key === 'updated' ? Date.parse(b.updated) : b[key];
      const aMissing = av === null || !Number.isFinite(av);
      const bMissing = bv === null || !Number.isFinite(bv);
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      return (aMissing ? 0 : (av - bv) * direction) || a.index - b.index;
    });
  }

  function readState(url) {
    const state = { query: url.searchParams.get('q') || '' };
    for (const key of ['type', 'language']) {
      const value = url.searchParams.get(key);
      if (value && value !== 'all') state.query = state.query ? `(${state.query}) AND ${key}:${quoteValue(value)}` : `${key}:${quoteValue(value)}`;
    }
    // Migrate links produced by the first prototype to the shared query syntax.
    FILTERS.forEach(key => {
      const value = url.searchParams.get(`sp_${key}`);
      if (value) state.query = `${state.query} ${QUERY_KEYS[key]}:${key === 'author' || key === 'topic' ? terms(value).map(quoteValue).join(',') : value}`.trim();
    });
    const nativeSort = url.searchParams.get('sort');
    const fallback = ({ created: 'starred', updated: 'updated', stars: 'stars' }[nativeSort] || 'starred')
      + (url.searchParams.get('direction') === 'asc' ? '-asc' : '');
    const sort = url.searchParams.get('sp_sort') || fallback;
    state.sort = Object.hasOwn(SORTS, sort) ? sort : 'starred';
    return state;
  }

  function writeState(url, state) {
    const next = new URL(url);
    FILTERS.forEach(key => next.searchParams.delete(`sp_${key}`));
    if (state.query) next.searchParams.set('q', state.query);
    else next.searchParams.delete('q');
    if (state.sort !== 'starred') next.searchParams.set('sp_sort', state.sort);
    else next.searchParams.delete('sp_sort');
    next.searchParams.delete('sort');
    next.searchParams.delete('direction');
    next.searchParams.delete('type');
    next.searchParams.delete('language');
    return next;
  }

  function dataURL(value) {
    const url = new URL(value);
    const remove = [];
    url.searchParams.forEach((_, key) => { if (key.startsWith('sp_') || ['q', 'sort', 'direction', 'submit'].includes(key)) remove.push(key); });
    remove.forEach(key => url.searchParams.delete(key));
    return url;
  }

  // The same pure filtering and sorting functions are exercised by the Node tests.
  if (typeof module === 'object' && module.exports) {
    module.exports = { parseCount, parseRange, parseQuery, evaluateQuery, containsTopic, containsList, serializeQuery, toggleQualifier, toggleFacet, facetState, clearFacet, updatePresets, dateBoundary, queryConjuncts, tokenize, sortRepos, readState, writeState, localDate, suggestionContext, builderFromQuery, builderQuery, dataURL };
    return;
  }

  const STYLE = `
    .sp-search{position:relative;width:100%;margin:0!important}.sp-resultbar{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-height:18px;margin:0 0 5px}.sp-status{font-size:12px;color:var(--fgColor-muted,#59636e);text-align:right}.sp-status[data-error]{color:var(--fgColor-danger,#d1242f)}
    .sp-queryline{display:flex;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;background:var(--bgColor-default,#fff)}.sp-queryline:focus-within{outline:2px solid var(--focus-outlineColor,#0969da);outline-offset:-1px}.sp-querywrap{position:relative;flex:1;min-width:0}
    .sp-query,.sp-highlight{font:14px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:normal;padding:7px 12px;border:0;margin:0;white-space:pre;box-sizing:border-box}.sp-query{position:relative;display:block;width:100%;background:transparent!important;color:transparent!important;caret-color:var(--fgColor-default,#1f2328);outline:0!important;box-shadow:none!important;border-radius:6px}.sp-query::placeholder{color:var(--fgColor-muted,#59636e)}.sp-highlight{position:absolute;inset:0;overflow:hidden;pointer-events:none;color:var(--fgColor-default,#1f2328)}
    .sp-value{background:var(--bgColor-accent-muted,#ddf4ff);color:var(--fgColor-accent,#0969da);border-radius:3px;padding:2px 0}.sp-operator{color:var(--fgColor-accent,#0969da);font-weight:600}
    .sp-icon-button{display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--fgColor-muted,#59636e);padding:6px 10px;cursor:pointer;border-radius:4px}.sp-icon-button:hover{background:var(--bgColor-muted,#f6f8fa)}.sp-submit{border-left:1px solid var(--borderColor-default,#d1d9e0);border-radius:0 6px 6px 0}
    .sp-error{font-size:12px;margin:6px 0 0;color:var(--fgColor-danger,#d1242f)}.sp-queryline:has([aria-invalid="true"]){border-color:var(--borderColor-danger-emphasis,#d1242f)}
    .sp-toolbar{position:relative;display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:12px;padding:6px;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;background:var(--bgColor-muted,#f6f8fa)}.sp-controls{display:flex;align-items:center;gap:1px;flex-wrap:wrap}.sp-filter{position:relative}.sp-filter>summary{display:flex;align-items:center;gap:5px;list-style:none;cursor:pointer;border:0;border-radius:5px;background:transparent;color:var(--fgColor-muted,#59636e);font:13px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:5px 6px;white-space:nowrap}.sp-filter>summary::-webkit-details-marker{display:none}.sp-filter>summary:hover,.sp-filter[open]>summary{background:var(--bgColor-neutral-muted,#818b981f)}.sp-filter>summary svg{flex:none}.sp-filter>summary svg:last-child{width:12px;height:12px}.sp-filter[data-active]>summary{color:var(--fgColor-accent,#0969da)}.sp-sort{margin-left:auto}
    .sp-panel,.sp-suggestions{z-index:1000;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:8px;background:var(--bgColor-default,#fff);color:var(--fgColor-default,#1f2328);box-shadow:var(--shadow-floating-small,0 8px 24px #140f1826)}.sp-panel{position:fixed;left:8px;top:8px;width:300px;max-width:calc(100vw - 16px);overflow:hidden;display:flex;flex-direction:column}.sp-list-panel{width:440px}.sp-panel-title{padding:10px 12px;font-size:12px;font-weight:600;border-bottom:1px solid var(--borderColor-muted,#d1d9e0)}.sp-panel-search{padding:8px}.sp-panel-search input{width:100%;min-height:30px;font-size:12px}.sp-options{max-height:320px;min-height:0;overflow-y:auto;padding:4px;overscroll-behavior:contain}.sp-panel-footer{flex:none;border-top:1px solid var(--borderColor-muted,#d1d9e0);padding:4px}.sp-panel-footer:empty{display:none}
    .sp-option{display:flex;align-items:center;gap:8px;min-height:34px;width:100%;padding:6px 8px;text-align:left;font:13px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;color:inherit;background:transparent;border:0;border-radius:5px;white-space:normal}.sp-option:hover,.sp-option:focus-visible{background:var(--bgColor-muted,#f6f8fa)}.sp-option[aria-selected="true"]{color:var(--fgColor-accent,#0969da)}.sp-option img{width:20px;height:20px;border-radius:50%;flex:none}.sp-option-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sp-option-description{font-size:12px;color:var(--fgColor-muted,#59636e)}.sp-check{width:16px;flex:none;color:var(--fgColor-accent,#0969da)}.sp-mark{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;font-size:11px;line-height:12px;border:1px solid var(--borderColor-default,#d1d9e0);color:var(--fgColor-accent,#0969da);flex:none}.sp-checkbox{border-radius:3px}.sp-radio{border-radius:50%;font-size:9px}.sp-option[aria-selected="true"] .sp-mark{border-color:var(--fgColor-accent,#0969da);background:var(--bgColor-accent-muted,#ddf4ff)}
    .sp-menu-action{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;border:0;border-radius:5px;background:transparent;padding:7px 8px;color:var(--fgColor-muted,#59636e);font-size:12px;cursor:pointer}.sp-menu-action:hover{background:var(--bgColor-muted,#f6f8fa)}.sp-create-list{color:var(--fgColor-success,#1a7f37);font-weight:600}.sp-list-row{display:flex;align-items:center;border-radius:5px}.sp-list-row:hover{background:var(--bgColor-muted,#f6f8fa)}.sp-list-row>.sp-option{flex:1;width:0}.sp-list-row .sp-option-label{flex:0 1 auto}.sp-list-actions{display:flex;gap:2px;flex:none;padding-right:4px}.sp-list-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:4px;border:0;border-radius:4px;background:transparent;color:var(--fgColor-muted,#59636e);cursor:pointer}.sp-list-action:hover{background:var(--bgColor-neutral-muted,#818b981f);text-decoration:none}.sp-danger{color:var(--fgColor-danger,#d1242f)}.sp-list-action:disabled{opacity:.4;cursor:default}.sp-pill{display:inline-flex;align-items:center;justify-content:center;flex:0 0 48px;width:48px;min-height:20px;border:1px solid var(--borderColor-muted,#d1d9e0);border-radius:20px;padding:0 4px;color:var(--fgColor-muted,#59636e);background:var(--bgColor-neutral-muted,#818b981f);font-size:11px;line-height:18px;font-variant-numeric:tabular-nums}
    .sp-suggestions{position:absolute;top:calc(100% + 4px);left:0;width:380px;max-width:calc(100vw - 32px);padding:4px;max-height:300px;overflow:auto}.sp-suggestion-group{font-size:12px;font-weight:600;color:var(--fgColor-muted,#59636e);padding:7px 10px}.sp-skeleton{height:12px;margin:12px;border-radius:6px;background:var(--bgColor-neutral-muted,#818b981f)}
    .sp-muted{padding:10px;font-size:12px;color:var(--fgColor-muted,#59636e)}.sp-empty{padding:40px 16px;text-align:center;color:var(--fgColor-muted,#59636e)}.sp-native-hidden,[data-sp-row][hidden],[class^="sp-"][hidden],[class*=" sp-"][hidden]{display:none!important}
    .sp-list-dialog{width:min(480px,calc(100vw - 24px));max-height:calc(100vh - 24px);padding:0;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:12px;background:var(--bgColor-default,#fff);color:var(--fgColor-default,#1f2328);box-shadow:0 16px 48px #1f232833;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.sp-list-dialog::backdrop{background:#1f232866}.sp-dialog-header,.sp-dialog-footer{display:flex;align-items:center;gap:8px;padding:16px}.sp-dialog-header{justify-content:space-between;border-bottom:1px solid var(--borderColor-muted,#d1d9e0)}.sp-dialog-header h2{margin:0;font-size:16px;font-weight:600}.sp-dialog-body{padding:16px;overflow:auto}.sp-dialog-body label{display:block;margin-bottom:14px;font-weight:600}.sp-dialog-body label input:not([type=checkbox]),.sp-dialog-body textarea{display:block;width:100%;margin-top:6px}.sp-dialog-body input[type=checkbox]{margin-right:6px}.sp-dialog-footer{justify-content:flex-end;border-top:1px solid var(--borderColor-muted,#d1d9e0)}
    @media(max-width:600px){.sp-toolbar{gap:2px}.sp-filter>summary{padding:5px}.sp-sort{margin-left:0}.sp-list-panel{width:calc(100vw - 16px)}.sp-pill{flex-basis:44px;width:44px}.sp-resultbar{min-height:18px}}
  `;
  let current;
  let scheduled = false;
  const topicCache = new Map();
  const listCatalogCache = new Map();

  function readListCatalog(root, username) {
    const region = root.querySelector('#profile-lists-container');
    if (!region) return null;
    return [...region.querySelectorAll('a[href]')].flatMap(link => {
      const title = link.querySelector('h3');
      if (!title) return [];
      const url = new URL(link.getAttribute('href'), location.origin);
      const prefix = `/stars/${username}/lists/`.toLowerCase();
      if (url.origin !== location.origin || !url.pathname.toLowerCase().startsWith(prefix)) return [];
      const count = link.querySelector('.text-small')?.textContent.match(/[\d,]+/);
      const privateList = Boolean(link.querySelector('.octicon-lock')) || [...link.querySelectorAll('.Label,[aria-label]')].some(node => /private/i.test(node.getAttribute('aria-label') || node.textContent));
      return [{ name: title.textContent.replace(/\s+/g, ' ').trim(), slug: decodeURIComponent(url.pathname.slice(prefix.length)), href: url.href, count: count ? parseCount(count[0]) : null, private: privateList }];
    });
  }

  function listForm(root, url, deleting = false) {
    const path = new URL(url, location.origin).pathname.toLowerCase();
    return [...root.querySelectorAll('form[action]')].find(form => new URL(form.getAttribute('action'), location.origin).pathname.toLowerCase() === path && (deleting ? form.querySelector('input[name="_method"][value="delete"]') : form.querySelector('[name="user_list[name]"]')));
  }

  function element(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    const strokes = {
      type: 'M3 2.5h9v11H3z M5.5 2.5v11 M7.5 5h2.5 M7.5 7.5h2.5',
      language: 'M5 4 1.5 8 5 12 M11 4l3.5 4-3.5 4 M9.5 2.5l-3 11',
      author: 'M10.5 5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0 M3 14v-2a5 4 0 0 1 10 0v2',
      list: 'M5.5 3h8 M5.5 8h8 M5.5 13h8 M2 3h.5 M2 8h.5 M2 13h.5',
      topic: 'M2 2h6l6 6-6 6-6-6z M5 5h.1',
      star: 'm8 1.5 2 4.2 4.5.6-3.3 3.2.8 4.5-4-2.1-4 2.1.8-4.5L1.5 6.3 6 5.7z',
      fork: 'M5 4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0 M14 4a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0 M9.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0 M3.5 5.5v2A2.5 2.5 0 0 0 6 10h2 M12.5 5.5v2A2.5 2.5 0 0 1 10 10H8v1.5',
      update: 'M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M8 4v4l2.5 1.5',
      sort: 'M4 2v12 M1.5 11.5 4 14l2.5-2.5 M9 3h5 M9 7h3.5 M9 11h2',
      external: 'M9 2h5v5 M14 2 7 9 M6 3H2v11h11v-4',
      trash: 'M2 4h12 M6 4V2h4v2 M4 4l.5 10h7L12 4 M6.5 6.5v5 M9.5 6.5v5',
      plus: 'M8 2v12 M2 8h12',
    };
    const paths = {
      search: 'M10.68 11.74a6 6 0 1 1 1.06-1.06l3.04 3.04a.75.75 0 0 1-1.06 1.06ZM11.5 7a4.5 4.5 0 1 0-9 0 4.5 4.5 0 0 0 9 0Z',
      clear: 'M2.343 13.657A8 8 0 1 1 13.657 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.75.75 0 0 0-1.06 1.06L6.94 8l-1.97 1.97a.75.75 0 1 0 1.06 1.06L8 9.06l1.97 1.97a.75.75 0 0 0 1.06-1.06L9.06 8l1.97-1.97a.75.75 0 0 0-1.06-1.06L8 6.94Z',
      close: 'M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 0 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 0 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z',
      filter: 'M1.75 3a.75.75 0 0 0 0 1.5h12.5a.75.75 0 0 0 0-1.5Zm2 4.25a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5Zm3 4.25a.75.75 0 0 0 0 1.5h2.5a.75.75 0 0 0 0-1.5Z',
      triangle: 'm4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z',
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    [['viewBox', '0 0 16 16'], ['width', '16'], ['height', '16'], ['fill', 'currentColor'], ['aria-hidden', 'true']].forEach(([key, value]) => svg.setAttribute(key, value));
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', paths[name] || paths.filter);
    if (strokes[name]) {
      path.setAttribute('d', strokes[name]);
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.4');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
    }
    svg.append(path);
    return svg;
  }

  function rowsIn(frame) {
    return [...frame.querySelectorAll('h3 a[href]')]
      .map(a => a.closest('.col-12'))
      .filter((row, index, rows) => row && rows.indexOf(row) === index && row.querySelector('h3 a')?.getAttribute('href').split('/').filter(Boolean).length === 2);
  }

  function record(row, index) {
    const name = row.querySelector('h3 a').getAttribute('href').replace(/^\//, '').replace(/\/$/, '');
    const count = suffix => {
      const link = row.querySelector(`a[href$="/${suffix}"]`);
      // GitHub omits the stargazers/forks link when its count is zero.
      return link ? parseCount(link.textContent) : 0;
    };
    return {
      row, index, name, author: name.split('/')[0], stars: count('stargazers'), forks: count('forks'),
      updated: row.querySelector('relative-time[datetime]')?.getAttribute('datetime') || '',
      searchText: `${name} ${row.querySelector('p.col-9, p[itemprop="description"], .py-1 > p, .tmp-py-1 > p')?.textContent || ''}`,
      topics: null,
      lists: null,
      types: null,
      language: row.querySelector('[itemprop="programmingLanguage"]')?.textContent.trim() || '@none',
    };
  }

  function nextPage(frame, base) {
    const link = [...frame.querySelectorAll('.paginate-container a[href]')].find(a => a.textContent.trim() === 'Next');
    if (!link) return null;
    const url = dataURL(new URL(link.getAttribute('href'), base));
    if (url.origin !== location.origin || url.pathname !== new URL(base).pathname) throw new Error('Unexpected pagination URL.');
    return url.href;
  }

  async function request(url, signal, json = false) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const timer = setTimeout(abort, 30000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        credentials: json ? 'omit' : 'same-origin',
        headers: { Accept: json ? 'application/vnd.github+json' : 'text/html' },
        ...(json ? { referrerPolicy: 'no-referrer' } : {}),
      });
      if (!response.ok) {
        const reset = response.headers.get('x-ratelimit-reset');
        const suffix = reset ? ` Retry after ${new Date(Number(reset) * 1000).toLocaleTimeString()}.` : '';
        throw new Error(`GitHub returned ${response.status}.${suffix}`);
      }
      if (json) return { data: await response.json(), link: response.headers.get('link') };
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      return doc;
    } catch (error) {
      if (controller.signal.aborted && !signal.aborted) throw new Error('GitHub took too long to respond. Please retry.');
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  class StarPicker {
    constructor(frame) {
      this.frame = frame;
      this.controller = new AbortController();
      const pageURL = new URL(frame.getAttribute('src') || location.href, location.href);
      this.state = readState(pageURL);
      this.showErrors = Boolean(this.state.query);
      this.originalRows = rowsIn(frame);
      const nativeType = frame.querySelector('#stars-type-filter-menu-button')?.closest('action-menu');
      const nativeLanguage = frame.querySelector('#stars-language-filter-menu-button')?.closest('action-menu');
      const nativeSort = frame.querySelector('#stars-sort-menu-button')?.closest('action-menu');
      this.anchor = nativeType?.parentElement?.parentElement;
      this.host = this.originalRows[0]?.parentElement || this.anchor?.parentElement?.parentElement;
      if (!nativeType || !nativeLanguage || !this.anchor || !this.host) return;
      this.pagination = frame.querySelector('.paginate-container');
      this.baseURL = new URL(pageURL);
      const parameterNames = [];
      this.baseURL.searchParams.forEach((value, key) => parameterNames.push(key));
      parameterNames.forEach(key => {
        if (key.startsWith('sp_') || ['q', 'after', 'before', 'page', 'sort', 'direction', 'submit', 'type', 'language'].includes(key)) this.baseURL.searchParams.delete(key);
      });
      this.username = this.baseURL.pathname.split('/').filter(Boolean)[0];
      if (this.username === 'stars') this.username = this.baseURL.pathname.split('/').filter(Boolean)[1];
      this.initialIsFirst = !['q', 'after', 'before', 'page', 'sort', 'direction', 'type', 'language'].some(key => pageURL.searchParams.has(key));
      this.nativeEmpty = [...this.host.children].filter(node => node.matches('.blankslate-container, .blankslate, .Box') && !node.contains(this.anchor));
      this.values = { type: Object.keys(TYPE_LABELS), language: [], author: [], list: [], topic: [] };
      this.valuesReady = new Set(['type']);
      this.typeMembership = new Map();
      this.preparing = {};
      this.removeLists();
      this.frame.firstElementChild?.classList.remove('tmp-mt-5', 'mt-5');
      this.buildSearch();
      this.toolbar = element('section', { class: 'sp-toolbar', 'aria-label': 'Filter starred repositories' });
      this.resultbar = element('div', { class: 'sp-resultbar' });
      this.status = element('span', { class: 'sp-status', role: 'status', 'aria-live': 'polite' }, 'Stars');
      this.retry = element('button', { type: 'button', class: 'btn btn-sm', hidden: '' }, 'Retry');
      this.retry.addEventListener('click', () => this.apply());
      this.resultbar.append(this.status, this.retry);
      this.searchForm.prepend(this.resultbar);
      this.controls = element('div', { class: 'sp-controls' });
      nativeType.remove();
      nativeLanguage.remove();
      if (nativeSort) {
        nativeSort.classList.add('sp-native-hidden');
        nativeSort.parentElement.classList.add('sp-native-hidden');
      }
      FILTERS.forEach(key => this.addFilter(key));
      this.toolbar.append(this.controls, this.buildSort());
      this.anchor.after(this.toolbar);
      this.empty = element('div', { class: 'sp-empty', hidden: '' });
      this.empty.append(element('h3', {}, 'No results matched your search'), element('p', {}, 'Try a different search query.'));
      this.toolbar.after(this.empty);
      this.nativeReset = frame.querySelector('a.issues-reset-query');
      if (this.nativeReset) {
        this.nativeReset.closest('.TableObject')?.classList.add('sp-native-hidden');
      }
      document.addEventListener('click', event => {
        const path = event.composedPath();
        if (!path.includes(this.toolbar)) this.closeFilters();
        if (!path.includes(this.searchForm)) this.closeSuggestions();
      }, { signal: this.controller.signal });
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        const open = this.toolbar.querySelector('details[open]');
        if (open) { open.open = false; open.querySelector('summary').focus(); }
        this.closeSuggestions();
      }, { signal: this.controller.signal });
      this.refreshEditor();
      this.syncNavigation();
      if (frame.hasAttribute('src')) history.replaceState(history.state, '', writeState(pageURL, this.state));
      this.apply();
    }

    buildSearch() {
      this.searchForm = element('form', { class: 'sp-search', role: 'search', 'aria-label': 'Filter starred repositories', 'data-turbo': 'false' });
      const line = element('div', { class: 'sp-queryline' });
      const wrap = element('div', { class: 'sp-querywrap' });
      this.highlight = element('div', { class: 'sp-highlight', 'aria-hidden': 'true' });
      this.input = element('input', {
        id: 'sp-query', class: 'sp-query', type: 'text', role: 'combobox', 'aria-label': 'Filter stars',
        'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'sp-query-suggestions',
        'aria-describedby': 'sp-query-error', placeholder: 'Filter stars', autocomplete: 'off', spellcheck: 'false',
      });
      this.input.value = this.state.query;
      this.suggestions = element('div', { id: 'sp-query-suggestions', class: 'sp-suggestions', role: 'listbox', 'aria-label': 'Suggestions', hidden: '' });
      wrap.append(this.highlight, this.input, this.suggestions);
      this.clearQueryButton = element('button', { class: 'sp-icon-button', type: 'button', 'aria-label': 'Clear filter', hidden: '' });
      this.clearQueryButton.append(icon('clear'));
      const clearQuery = () => {
        this.input.value = '';
        this.commit();
        this.input.focus();
        this.closeSuggestions();
      };
      this.clearQueryButton.addEventListener('click', clearQuery);
      const search = element('button', { class: 'sp-icon-button sp-submit', type: 'submit', 'aria-label': 'Search' });
      search.append(icon('search'));
      line.append(wrap, this.clearQueryButton, search);
      this.queryError = element('p', { id: 'sp-query-error', class: 'sp-error', role: 'status', 'aria-live': 'polite', hidden: '' });
      this.searchForm.append(line, this.queryError);
      this.frame.querySelector('form.subnav-search').replaceWith(this.searchForm);
      this.searchForm.addEventListener('submit', event => {
        event.preventDefault();
        event.stopPropagation();
        this.closeSuggestions();
        this.showErrors = true;
        this.commit();
      });
      this.input.addEventListener('compositionstart', () => { this.composing = true; this.closeSuggestions(); });
      this.input.addEventListener('compositionend', () => { this.composing = false; this.refreshEditor(); this.showSuggestions(); });
      this.input.addEventListener('input', () => {
        if (this.composing) return;
        this.refreshEditor();
        this.showSuggestions();
      });
      this.input.addEventListener('focus', () => this.showSuggestions());
      this.input.addEventListener('click', () => this.showSuggestions());
      this.input.addEventListener('scroll', () => { this.highlight.scrollLeft = this.input.scrollLeft; });
      this.input.addEventListener('keydown', event => {
        if (event.isComposing || this.composing) return;
        const options = [...this.suggestions.querySelectorAll('[role="option"]')];
        if (event.key === 'Escape') { this.closeSuggestions(); event.preventDefault(); return; }
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault();
          if (this.suggestions.hidden) { this.showSuggestions(); return; }
          if (!options.length) return;
          const previous = this.suggestionIndex ?? -1;
          this.suggestionIndex = previous < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
            : (previous + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
          options.forEach((option, index) => option.setAttribute('aria-selected', String(index === this.suggestionIndex)));
          const option = options[this.suggestionIndex];
          this.input.setAttribute('aria-activedescendant', option.id);
          option.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Tab' && !this.suggestions.hidden && options.length) {
          event.preventDefault();
          options[this.suggestionIndex >= 0 ? this.suggestionIndex : 0].click();
        } else if (event.key === 'Enter' && !this.suggestions.hidden && options[this.suggestionIndex]) {
          event.preventDefault();
          options[this.suggestionIndex].click();
        }
      });
    }

    refreshEditor() {
      const query = this.input.value;
      this.clearQueryButton.hidden = !query;
      this.highlight.replaceChildren();
      try {
        let cursor = 0;
        for (const token of tokenize(query)) {
          this.highlight.append(document.createTextNode(query.slice(cursor, token.start)));
          const match = token.raw.match(/^([\w-]+:)(.*)$/s);
          if (match && QUALIFIERS[match[1].slice(0, -1).toLowerCase()]) {
            this.highlight.append(document.createTextNode(match[1]), element('span', { class: 'sp-value' }, match[2]));
          } else this.highlight.append(element('span', { class: ['AND', 'OR', 'NOT'].includes(token.type) ? 'sp-operator' : '' }, token.raw));
          cursor = token.end;
        }
        this.highlight.append(document.createTextNode(query.slice(cursor)));
      } catch { this.highlight.textContent = query; }
      this.highlight.scrollLeft = this.input.scrollLeft;
      try {
        const root = parseQuery(query);
        this.showErrors = false;
        this.queryError.hidden = true;
        this.input.setAttribute('aria-invalid', 'false');
        const keys = new Set();
        const visit = node => { if (!node) return; if (node.key) keys.add(node.key); visit(node.child); visit(node.left); visit(node.right); };
        visit(root);
        this.controls?.querySelectorAll('[data-filter]').forEach(node => node.toggleAttribute('data-active', keys.has(node.dataset.filter)));
        return true;
      } catch (error) {
        this.queryError.textContent = error.message;
        this.queryError.hidden = !this.showErrors;
        this.input.setAttribute('aria-invalid', String(Boolean(this.showErrors)));
        return false;
      }
    }

    presets(key) {
      if (key === 'star') return ['>100', '>=1000', '>=10000', '100..1000', '*..100', '0'];
      if (key === 'fork') return ['>10', '>=100', '>=1000', '10..100', '*..10', '0'];
      this.updateOptions ||= updatePresets();
      return this.updateOptions.map(([, value]) => value);
    }

    positionPanel(details) {
      const panel = details.querySelector('.sp-panel');
      const rect = details.querySelector('summary').getBoundingClientRect();
      const popup = panel.getBoundingClientRect();
      const below = innerHeight - rect.bottom - 12;
      const top = popup.height > below && rect.top > below ? Math.max(8, rect.top - popup.height - 4) : rect.bottom + 4;
      panel.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - popup.width - 8))}px`;
      panel.style.top = `${top}px`;
      panel.style.maxHeight = `${Math.max(120, innerHeight - top - 8)}px`;
    }

    menuKeyboard(options) {
      options.addEventListener('keydown', event => {
        const buttons = [...options.querySelectorAll('[role="option"]')];
        const index = buttons.indexOf(document.activeElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      });
    }

    buildSort() {
      const details = element('details', { class: 'sp-filter sp-sort', 'data-sort': '' });
      const summary = element('summary', { 'aria-label': 'Sort by', 'aria-haspopup': 'listbox' });
      this.sortLabel = element('span', {}, SORTS[this.state.sort]);
      summary.append(icon('sort'), this.sortLabel, icon('triangle'));
      const panel = element('div', { class: 'sp-panel', role: 'dialog', 'aria-label': 'Sort by' });
      panel.append(element('div', { class: 'sp-panel-title' }, 'Sort by'));
      const options = element('div', { class: 'sp-options', role: 'listbox', 'aria-label': 'Sort order' });
      Object.entries(SORTS).forEach(([value, label]) => {
        const option = element('button', { type: 'button', class: 'sp-option', role: 'option', 'data-value': value, 'aria-selected': String(this.state.sort === value) });
        option.append(element('span', { class: 'sp-check', 'aria-hidden': 'true' }, this.state.sort === value ? '✓' : ''), element('span', {}, label));
        option.addEventListener('click', () => {
          this.state.sort = value;
          this.sortLabel.textContent = label;
          options.querySelectorAll('button').forEach(button => {
            const selected = button.dataset.value === value;
            button.setAttribute('aria-selected', String(selected));
            button.firstElementChild.textContent = selected ? '✓' : '';
          });
          this.commit(false);
          details.open = false;
          summary.focus();
        });
        options.append(option);
      });
      this.menuKeyboard(options);
      panel.append(options);
      details.append(summary, panel);
      details.addEventListener('toggle', () => {
        if (!details.open) return;
        this.closeFilters(details);
        this.closeSuggestions();
        this.positionPanel(details);
        options.querySelector('[aria-selected="true"]')?.focus();
      });
      return details;
    }

    addFilter(key) {
      const label = LABELS[key];
      const multi = MULTI_FILTERS.has(key);
      const details = element('details', { class: 'sp-filter', 'data-filter': key });
      const summary = element('summary', { 'aria-label': `Filter by ${key}`, 'aria-haspopup': 'listbox' });
      summary.append(icon(key), element('span', {}, label), icon('triangle'));
      const panel = element('div', { class: `sp-panel${key === 'list' ? ' sp-list-panel' : ''}`, role: 'dialog', 'aria-label': `Filter by ${key}` });
      panel.append(element('div', { class: 'sp-panel-title' }, `Filter by ${key}`));
      const search = element('div', { class: 'sp-panel-search' });
      const input = element('input', {
        class: 'form-control', type: 'search', 'aria-label': `Filter ${key}`,
        placeholder: key === 'update' ? '>=20260812 or 20250611-20250912' : `Filter ${label.toLowerCase()}`,
      });
      search.append(input);
      const options = element('div', { class: 'sp-options', role: 'listbox', 'aria-label': `${label} results`, 'aria-multiselectable': String(multi) });
      const footer = element('div', { class: 'sp-panel-footer' });
      const clear = element('button', { type: 'button', class: 'sp-menu-action sp-clear-filter', hidden: '' }, 'Clear this filter');
      clear.addEventListener('click', () => {
        this.input.value = clearFacet(this.input.value, key);
        this.commit();
        this.refreshMenus();
        input.focus();
      });
      footer.append(clear);
      if (key === 'list') {
        const create = element('button', { type: 'button', class: 'sp-menu-action sp-create-list' });
        create.append(icon('plus'), element('span', {}, 'Create list'));
        create.addEventListener('click', () => { details.open = false; this.openListDialog(); });
        footer.append(create);
      }
      panel.append(search, options, footer);
      input.addEventListener('input', () => this.populateOptions(key, options, input.value));
      input.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); options.querySelector('[role="option"]')?.focus(); }
        if (event.key === 'Enter') { event.preventDefault(); options.querySelector('[role="option"]')?.click(); }
      });
      this.menuKeyboard(options);
      details.addEventListener('toggle', () => {
        if (!details.open) return;
        this.closeFilters(details);
        this.closeSuggestions();
        input.value = '';
        this.populateOptions(key, options, '');
        this.positionPanel(details);
        input.focus();
        if (MULTI_FILTERS.has(key) && !this.valuesReady.has(key)) {
          options.replaceChildren(element('div', { class: 'sp-muted' }, 'Loading…'));
          this.ensureValues(key).then(() => {
            if (details.open) { this.populateOptions(key, options, input.value); this.positionPanel(details); }
          }).catch(error => options.replaceChildren(element('div', { class: 'sp-error', role: 'alert' }, error.message)));
        }
      });
      details.append(summary, panel);
      this.controls.append(details);
    }

    async ensureValues(key) {
      if (this.valuesReady.has(key)) return;
      if (this.preparing[key]) return this.preparing[key];
      this.preparing[key] = (async () => {
        if (key === 'list') { await this.loadCatalog(); return; }
        const records = await this.loadAll();
        if (key === 'topic') await this.loadTopics(records);
      })();
      try { await this.preparing[key]; }
      finally { delete this.preparing[key]; }
    }

    refreshMenus() {
      this.controls.querySelectorAll('details[open][data-filter]').forEach(details => this.populateOptions(details.dataset.filter, details.querySelector('.sp-options'), details.querySelector('input').value));
    }

    populateOptions(key, list, search) {
      const multi = MULTI_FILTERS.has(key);
      let values = multi ? this.values[key] : this.presets(key);
      const needle = search.trim();
      values = values.filter(value => value.toLowerCase().includes(needle.toLowerCase()) || this.optionLabel(key, value).toLowerCase().includes(needle.toLowerCase())).slice(0, 80);
      if (needle && !multi && !values.includes(needle)) values.unshift(needle);
      let state = null;
      try { state = facetState(this.input.value); } catch {}
      const selected = (state?.[key] || []).map(value => value.toLowerCase());
      const details = list.closest('details');
      details.querySelector('.sp-clear-filter').hidden = !state?.[key]?.length;
      details.querySelector('.sp-panel-footer').hidden = key !== 'list' && !state?.[key]?.length;
      const create = details.querySelector('.sp-create-list');
      if (create) create.hidden = !this.canManageLists;
      list.replaceChildren();
      values.forEach(value => {
        try { atom({ raw: `${QUERY_KEYS[key]}:${quoteValue(value)}`, start: 0 }); }
        catch (error) { if (value === needle) list.append(element('div', { class: 'sp-error', role: 'alert' }, error.message)); return; }
        const checked = selected.includes(value.toLowerCase());
        const option = element('button', { type: 'button', class: 'sp-option', role: 'option', 'data-value': value, 'aria-selected': String(checked) });
        option.append(element('span', { class: `sp-mark ${multi ? 'sp-checkbox' : 'sp-radio'}`, 'aria-hidden': 'true' }, checked ? multi ? '✓' : '●' : ''));
        if (key === 'author' && /^[\w-]+$/.test(value)) option.append(element('img', { src: `https://github.com/${value}.png?size=40`, alt: '', loading: 'lazy' }));
        option.append(element('span', { class: 'sp-option-label' }, this.optionLabel(key, value)));
        const definition = key === 'list' && this.listDefinitions?.find(item => item.name === value);
        if (definition) {
          option.append(element('span', { class: 'sp-pill', 'aria-label': `${definition.count ?? 0} repositories` }, String(definition.count ?? 0)), element('span', { class: 'sp-pill' }, definition.private ? 'private' : 'public'));
        }
        option.addEventListener('click', () => {
          try {
            this.input.value = toggleFacet(this.input.value, key, value);
            this.commit();
            this.populateOptions(key, list, search);
            if (!multi) { details.open = false; details.querySelector('summary').focus(); }
            else list.querySelectorAll('[role="option"]').forEach(button => { if (button.dataset.value === value) button.focus({ preventScroll: true }); });
          } catch (error) { this.queryError.textContent = error.message; this.queryError.hidden = false; }
        });
        if (!definition) { list.append(option); return; }
        const row = element('div', { class: 'sp-list-row', role: 'presentation' });
        const actions = element('div', { class: 'sp-list-actions' });
        const visit = element('a', { class: 'sp-list-action', href: definition.href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open list ${definition.name}`, title: 'Open list' });
        visit.append(icon('external'));
        actions.append(visit);
        const remove = element('button', { type: 'button', class: 'sp-list-action sp-danger', 'aria-label': `Delete list ${definition.name}`, title: 'Delete list' });
        remove.append(icon('trash'));
        if (!this.canManageLists) remove.disabled = true;
        remove.addEventListener('click', () => { details.open = false; this.openListDialog(definition); });
        actions.append(remove);
        row.append(option, actions);
        list.append(row);
      });
      if (!list.childElementCount) list.append(element('div', { class: 'sp-muted' }, 'No matching values.'));
    }

    optionLabel(key, value) {
      if (key === 'list' && value === '@none') return 'No lists';
      if (key === 'list' && value === '@any') return 'Any list';
      if (key === 'type') return TYPE_LABELS[value] || value;
      if (key === 'language' && value === '@none') return 'No language';
      if (MULTI_FILTERS.has(key)) return value;
      if (key === 'update') {
        this.presets(key);
        return this.updateOptions.find(([, option]) => option === value)?.[0] || value;
      }
      const comparison = value.match(/^(>=|<=|>|<|=)?(.*)$/);
      const labels = { '>=': 'At least', '<=': 'At most', '>': 'More than', '<': 'Less than', '=': 'Exactly', '': 'Exactly' };
      if (value.includes('..')) return value.replace('..', ' to ').replaceAll('*', 'any');
      return `${labels[comparison[1] || '']} ${Number(comparison[2]).toLocaleString()}`;
    }
    showSuggestions() {
      if (this.composing || !this.input.isConnected) return;
      const requestId = this.suggestionRequest = (this.suggestionRequest || 0) + 1;
      const context = suggestionContext(this.input.value, this.input.selectionStart ?? this.input.value.length);
      this.suggestions.replaceChildren();
      this.suggestionIndex = -1;
      const items = [];
      if (context.kind === 'provider') {
        if (/^-?[\w]*$/.test(context.prefix)) {
          const prefix = context.prefix.replace(/^-/, '').toLowerCase();
          FILTERS.filter(key => key.startsWith(prefix) || QUERY_KEYS[key].startsWith(prefix)).forEach(key => {
            items.push({ label: LABELS[key], detail: `${QUERY_KEYS[key]}:`, replacement: `${context.prefix.startsWith('-') ? '-' : ''}${QUERY_KEYS[key]}:`, provider: true });
          });
          ['AND', 'OR', 'NOT'].filter(value => context.prefix && value.toLowerCase().startsWith(context.prefix.toLowerCase())).forEach(value => items.push({ label: value, replacement: `${value} `, provider: true }));
        }
      } else {
        const key = context.key;
        const enumerated = MULTI_FILTERS.has(key);
        if (enumerated && !this.valuesReady.has(key)) {
          this.suggestions.append(element('div', { class: 'sp-suggestion-group' }, `Loading ${LABELS[key].toLowerCase()}…`));
          for (let index = 0; index < 3; index++) this.suggestions.append(element('div', { class: 'sp-skeleton', 'aria-hidden': 'true' }));
          this.suggestions.hidden = false;
          this.input.setAttribute('aria-expanded', 'true');
          this.ensureValues(key).then(() => {
            if (this.suggestionRequest === requestId && document.activeElement === this.input) this.showSuggestions();
          }).catch(error => {
            if (this.suggestionRequest === requestId) this.suggestions.replaceChildren(element('div', { class: 'sp-error', role: 'status' }, error.message));
          });
          return;
        }
        const values = enumerated ? this.values[key] : this.presets(key);
        values.filter(value => value.toLowerCase().includes(context.prefix.toLowerCase()) || this.optionLabel(key, value).toLowerCase().includes(context.prefix.toLowerCase())).slice(0, 40).forEach(value => {
          items.push({ label: this.optionLabel(key, value), replacement: quoteValue(value), key, value });
        });
      }
      if (items.length) this.suggestions.append(element('div', { class: 'sp-suggestion-group' }, context.kind === 'provider' ? 'Filter by' : LABELS[context.key]));
      items.forEach((item, index) => {
        const option = element('button', { id: `sp-suggestion-${index}`, type: 'button', class: 'sp-option', role: 'option', 'aria-selected': 'false' });
        if (item.provider) option.append(icon('filter'));
        if (item.key === 'author' && /^[\w-]+$/.test(item.value)) option.append(element('img', { src: `https://github.com/${item.value}.png?size=40`, alt: '' }));
        option.append(element('span', { class: 'sp-option-label' }, item.label));
        if (item.detail) option.append(element('span', { class: 'sp-option-description' }, item.detail));
        option.addEventListener('mousedown', event => event.preventDefault());
        option.addEventListener('click', () => {
          this.input.setRangeText(item.replacement, context.start, context.end, 'end');
          this.refreshEditor();
          this.input.focus();
          this.closeSuggestions();
          if (item.provider) this.showSuggestions();
          else if (this.refreshEditor()) this.commit();
        });
        this.suggestions.append(option);
      });
      this.suggestions.hidden = !items.length;
      this.input.setAttribute('aria-expanded', String(Boolean(items.length)));
    }

    closeSuggestions() {
      this.suggestionRequest = (this.suggestionRequest || 0) + 1;
      this.suggestions.hidden = true;
      this.input.setAttribute('aria-expanded', 'false');
      this.input.removeAttribute('aria-activedescendant');
      this.suggestionIndex = -1;
    }

    closeFilters(except) {
      this.toolbar.querySelectorAll('details[open]').forEach(node => { if (node !== except) node.open = false; });
    }

    syncNavigation() {
      const links = [...this.frame.querySelectorAll('#stars-type-filter-menu-list a, #stars-language-filter-menu-list a, .paginate-container a')];
      if (this.nativeReset) links.push(this.nativeReset);
      links.forEach(link => {
        const next = writeState(new URL(link.href), this.state).href;
        if (link.href !== next) link.href = next;
      });
    }

    commit(fromInput = true) {
      if (fromInput) {
        if (!this.refreshEditor()) return false;
        this.state.query = this.input.value.trim();
      }
      history.replaceState(history.state, '', writeState(new URL(location.href), this.state));
      this.syncNavigation();
      this.apply();
      return true;
    }

    message(text, error = false) {
      this.status.textContent = text;
      this.status.toggleAttribute('data-error', error);
    }

    async loadAll() {
      if (this.records) return this.records;
      if (this.loading) return this.loading;
      this.loading = (async () => {
        const records = [];
        const seenNames = new Set();
        const visited = new Set();
        let url = this.baseURL.href;
        let frame = this.initialIsFirst ? this.frame : null;
        do {
          if (visited.has(url)) throw new Error('GitHub repeated a page. Retry to load the complete result.');
          visited.add(url);
          if (!frame) {
            const doc = await request(url, this.controller.signal);
            frame = doc.querySelector('#user-starred-repos');
            if (!frame) throw new Error('The stars page could not be read. Check your GitHub session and retry.');
          }
          const rows = rowsIn(frame);
          for (const row of rows) {
            const repo = record(row, records.length);
            if (!seenNames.has(repo.name.toLowerCase())) {
              seenNames.add(repo.name.toLowerCase());
              records.push(repo);
            }
          }
          this.message(`Loading all starred repositories… ${records.length} loaded`);
          const next = nextPage(frame, url);
          if (next && !rows.length) throw new Error('A stars page was incomplete. Please retry.');
          url = next;
          frame = null;
        } while (url);
        this.records = records;
        this.suggest('author', records.map(repo => repo.author));
        this.suggest('language', records.map(repo => repo.language));
        return records;
      })();
      try { return await this.loading; }
      finally { this.loading = null; }
    }

    suggest(key, values) {
      this.values[key] = [...new Set(values)].sort((a, b) => a.localeCompare(b));
      this.valuesReady.add(key);
    }

    removeLists() {
      this.canManageLists ||= Boolean(listForm(document, `/stars/${encodeURIComponent(this.username)}/lists`));
      const definitions = readListCatalog(document, this.username);
      if (definitions) listCatalogCache.set(this.username.toLowerCase(), { definitions, expires: Date.now() + 300000 });
      const cached = listCatalogCache.get(this.username.toLowerCase());
      if (cached && cached.expires > Date.now()) {
        this.listDefinitions = cached.definitions;
        this.values.list = ['@none', '@any', ...cached.definitions.map(item => item.name)];
        this.valuesReady.add('list');
      }
      const region = document.querySelector('#profile-lists-container');
      const block = region?.parentElement;
      if (block && !block.contains(this.frame)) block.remove();
      else if (block) {
        [...block.children].filter(node => node !== region && !node.contains(this.frame) && /^Lists\s*(?:\(|$)/.test(node.querySelector('h2')?.textContent.trim() || '')).forEach(node => node.remove());
        region.remove();
      }
    }

    async loadCatalog() {
      if (this.listDefinitions) return this.listDefinitions;
      const doc = await request(new URL(`/${encodeURIComponent(this.username)}?tab=stars`, location.origin), this.controller.signal);
      this.canManageLists = Boolean(listForm(doc, `/stars/${encodeURIComponent(this.username)}/lists`));
      const definitions = readListCatalog(doc, this.username);
      if (!definitions) throw new Error('GitHub list information could not be read.');
      this.listDefinitions = definitions;
      this.values.list = ['@none', '@any', ...definitions.map(item => item.name)];
      this.valuesReady.add('list');
      listCatalogCache.set(this.username.toLowerCase(), { definitions, expires: Date.now() + 300000 });
      return definitions;
    }

    async openListDialog(definition) {
      if (this.listDialog?.open) return;
      const deleting = Boolean(definition);
      const dialog = this.listDialog = element('dialog', { class: 'sp-list-dialog', 'aria-labelledby': 'sp-list-dialog-title' });
      const header = element('div', { class: 'sp-dialog-header' });
      header.append(element('h2', { id: 'sp-list-dialog-title' }, deleting ? 'Delete list' : 'Create list'));
      const close = element('button', { type: 'button', class: 'sp-icon-button', 'aria-label': 'Close dialog' });
      close.append(icon('close'));
      close.addEventListener('click', () => dialog.close());
      header.append(close);
      const form = element('form', { 'data-turbo': 'false' });
      const body = element('div', { class: 'sp-dialog-body' });
      const loading = element('p', { class: 'sp-muted', role: 'status' }, 'Loading…');
      const error = element('p', { class: 'sp-error', role: 'alert', hidden: '' });
      body.append(loading, error);
      const footer = element('div', { class: 'sp-dialog-footer' });
      const cancel = element('button', { type: 'button', class: 'btn' }, 'Cancel');
      cancel.addEventListener('click', () => dialog.close());
      const submit = element('button', { type: 'submit', class: deleting ? 'btn btn-danger' : 'btn btn-primary', disabled: '' }, deleting ? 'Delete list' : 'Create list');
      footer.append(cancel, submit);
      form.append(body, footer);
      dialog.append(header, form);
      dialog.addEventListener('close', () => {
        dialog.remove();
        if (this.listDialog === dialog) this.listDialog = null;
        this.controls.querySelector('details[data-filter="list"] summary')?.focus();
      });
      document.body.append(dialog);
      dialog.showModal();
      try {
        const target = deleting ? definition.href : `/stars/${encodeURIComponent(this.username)}/lists`;
        const doc = await request(deleting ? definition.href : this.baseURL, this.controller.signal);
        if (!dialog.isConnected) return;
        const native = listForm(doc, target, deleting);
        if (!native) throw new Error('GitHub did not provide a form for this list. Check your session and retry.');
        form.action = new URL(native.getAttribute('action'), location.origin).href;
        form.method = 'post';
        native.querySelectorAll('input[type="hidden"][name]').forEach(input => form.prepend(document.importNode(input, true)));
        loading.remove();
        if (deleting) body.prepend(element('p', {}, `Delete “${definition.name}”? The repositories in this list will remain starred.`));
        else {
          const name = element('label', {}, 'Name');
          name.append(element('input', { class: 'form-control', name: 'user_list[name]', required: '', maxlength: '32', autocomplete: 'off' }));
          const description = element('label', {}, 'Description');
          description.append(element('textarea', { class: 'form-control', name: 'user_list[description]', maxlength: '160', rows: '3' }));
          const privacy = element('label', {}, 'Private');
          privacy.prepend(element('input', { type: 'checkbox', name: 'user_list[private]', value: '1' }));
          body.prepend(name, description, privacy);
          name.querySelector('input').focus();
        }
        submit.disabled = false;
      } catch (failure) { loading.remove(); error.textContent = failure.message; error.hidden = false; }
      form.addEventListener('submit', async event => {
        event.preventDefault();
        event.stopPropagation();
        submit.disabled = true;
        error.hidden = true;
        try {
          const response = await fetch(form.action, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'text/html' }, body: new URLSearchParams(new FormData(form)), signal: this.controller.signal });
          if (!response.ok) throw new Error(`GitHub could not ${deleting ? 'delete' : 'create'} this list (${response.status}).${deleting ? '' : ' Check the name and try again.'}`);
          listCatalogCache.delete(this.username.toLowerCase());
          delete this.listDefinitions;
          this.valuesReady.delete('list');
          const definitions = await this.loadCatalog();
          const name = form.elements.namedItem('user_list[name]')?.value.trim().replace(/\s+/g, ' ');
          if (deleting ? definitions.some(item => item.href === definition.href) : !definitions.some(item => item.name === name)) throw new Error(`GitHub did not confirm that the list was ${deleting ? 'deleted' : 'created'}. Please refresh and check the list.`);
          this.records?.forEach(repo => { repo.lists = null; });
          this.refreshMenus();
          this.apply();
          dialog.close();
        } catch (failure) { error.textContent = failure.message; error.hidden = false; submit.disabled = false; }
      });
    }

    async loadTypes(records, query) {
      const required = new Set();
      const visit = node => {
        if (!node) return;
        if (node.key === 'type') node.values.forEach(value => required.add(value.toLowerCase()));
        visit(node.child); visit(node.left); visit(node.right);
      };
      visit(query);
      this.typeRequests ||= new Map();
      for (const type of required) {
        if (this.typeMembership.has(type)) continue;
        if (!this.typeRequests.has(type)) this.typeRequests.set(type, (async () => {
          const names = new Set();
          const visited = new Set();
          const first = new URL(this.baseURL);
          first.searchParams.set('type', type);
          let url = first.href;
          do {
            if (visited.has(url)) throw new Error('GitHub repeated a type page.');
            visited.add(url);
            const doc = await request(url, this.controller.signal);
            const frame = doc.querySelector('#user-starred-repos');
            if (!frame) throw new Error('Repository type information could not be read.');
            const rows = rowsIn(frame);
            rows.forEach(row => names.add(row.querySelector('h3 a').getAttribute('href').replace(/^\//, '').replace(/\/$/, '').toLowerCase()));
            const next = nextPage(frame, url);
            if (next && !rows.length) throw new Error('An incomplete type page was returned.');
            url = next;
          } while (url);
          this.typeMembership.set(type, names);
        })().finally(() => this.typeRequests.delete(type)));
        await this.typeRequests.get(type);
      }
      records.forEach(repo => { repo.types = [...this.typeMembership].filter(([, names]) => names.has(repo.name.toLowerCase())).map(([type]) => type); });
    }

    async loadLists(records) {
      if (records.every(repo => repo.lists !== null)) return;
      if (this.loadingLists) return this.loadingLists;
      this.loadingLists = (async () => {
        const definitions = await this.loadCatalog();
        const memberships = new Map();
        let cursor = 0;
        const worker = async () => {
          while (cursor < definitions.length) {
            const definition = definitions[cursor++];
            const names = new Set();
            const visited = new Set();
            let url = definition.href;
            do {
              if (visited.has(url)) throw new Error('GitHub repeated a list page.');
              visited.add(url);
              const doc = await request(url, this.controller.signal);
              if (!doc.querySelector('#user-profile-frame')) throw new Error(`Could not read list ${definition.name}.`);
              const links = [...doc.querySelectorAll('main h2.h3 a[href], main h3 a[href]')].filter(link => /^\/[^/]+\/[^/]+\/?$/.test(link.getAttribute('href')));
              links.forEach(link => names.add(link.getAttribute('href').replace(/^\//, '').replace(/\/$/, '').toLowerCase()));
              const next = [...doc.querySelectorAll('.paginate-container a[href], .pagination a[href], a[rel="next"]')].find(link => link.rel === 'next' || link.textContent.trim() === 'Next');
              if (next && !links.length) throw new Error(`An incomplete page was returned for ${definition.name}.`);
              url = next ? new URL(next.getAttribute('href'), url).href : null;
              if (url && (new URL(url).origin !== location.origin || new URL(url).pathname !== new URL(definition.href).pathname)) throw new Error('Unexpected list pagination URL.');
            } while (url);
            if (!names.size && definition.count > 0) throw new Error(`Repositories in ${definition.name} could not be read.`);
            memberships.set(definition.href, names);
          }
        };
        await Promise.all([worker(), worker()]);
        records.forEach(repo => {
          repo.lists = definitions.filter(definition => memberships.get(definition.href)?.has(repo.name.toLowerCase())).flatMap(definition => [definition.name, definition.slug]);
        });
      })();
      try { await this.loadingLists; }
      finally { this.loadingLists = null; }
    }

    async loadTopics(records) {
      const cached = topicCache.get(this.username.toLowerCase());
      let topics = cached && cached.expires > Date.now() ? cached.topics : null;
      if (!topics) {
        topics = new Map();
        let url = `https://api.github.com/users/${encodeURIComponent(this.username)}/starred?per_page=100`;
        const visited = new Set();
        do {
          if (visited.has(url)) throw new Error('GitHub repeated a topic data page.');
          visited.add(url);
          const { data, link } = await request(url, this.controller.signal, true);
          if (!Array.isArray(data)) throw new Error('GitHub returned invalid topic data.');
          data.forEach(repo => { if (repo.full_name && Array.isArray(repo.topics)) topics.set(repo.full_name.toLowerCase(), repo.topics); });
          const next = link?.match(/<([^>]+)>;\s*rel="next"/);
          url = next ? next[1] : null;
          if (url && new URL(url).origin !== 'https://api.github.com') throw new Error('Unexpected topic data URL.');
        } while (url);
        topicCache.set(this.username.toLowerCase(), { topics, expires: Date.now() + 5 * 60 * 1000 });
      }
      // The public API does not include private repositories. Read their topics using the signed-in page.
      for (const repo of records) {
        if (repo.topics !== null) continue;
        repo.topics = topics.get(repo.name.toLowerCase()) ?? null;
        if (repo.topics !== null) continue;
        const doc = await request(new URL(`/${repo.name}`, location.origin), this.controller.signal);
        if (!doc.querySelector('meta[name="octolytics-dimension-repository_nwo"]')) throw new Error(`Could not read topics for ${repo.name}.`);
        repo.topics = [...doc.querySelectorAll('a.topic-tag[href*="/topics/"]')].map(a => a.textContent.trim().toLowerCase());
      }
      this.suggest('topic', [...topics.values(), ...records.map(repo => repo.topics || [])].flat());
    }

    async apply() {
      const revision = this.revision = (this.revision || 0) + 1;
      this.retry.hidden = true;
      this.frame.setAttribute('aria-busy', 'true');
      try {
        const query = parseQuery(this.state.query);
        this.message('Loading all starred repositories…');
        const records = await this.loadAll();
        if (revision !== this.revision || this.controller.signal.aborted) return;
        if (tokenize(this.state.query).some(token => /^type:/i.test(token.raw))) {
          this.message('Loading repository types…');
          await this.loadTypes(records, query);
        }
        if (revision !== this.revision || this.controller.signal.aborted) return;
        if (containsList(query)) {
          this.message('Loading lists…');
          await this.loadLists(records);
        }
        if (revision !== this.revision || this.controller.signal.aborted) return;
        if (containsTopic(query)) {
          this.message('Loading repository topics…');
          // Narrow by cheap filters before retrieving any private repository topics.
          // Three-valued evaluation preserves candidates inside OR and NOT groups.
          const candidates = records.filter(repo => evaluateQuery(query, repo, true) !== false);
          if (candidates.length) await this.loadTopics(candidates);
        }
        if (revision !== this.revision || this.controller.signal.aborted) return;
        const filtered = sortRepos(records.filter(repo => evaluateQuery(query, repo)), this.state.sort);
        this.render(filtered, records);
      } catch (error) {
        if (revision !== this.revision || this.controller.signal.aborted) return;
        this.message(`Filters not applied. ${error.message}`, true);
        this.retry.hidden = false;
      } finally {
        if (revision === this.revision) this.frame.removeAttribute('aria-busy');
      }
    }

    render(filtered, records) {
      const visible = new Set(filtered);
      records.forEach(repo => {
        repo.row.setAttribute('data-sp-row', '');
        repo.row.hidden = !visible.has(repo);
      });
      this.originalRows.forEach(row => { if (!records.some(repo => repo.row === row)) row.remove(); });
      const fragment = document.createDocumentFragment();
      // Move the original nodes so GitHub's star and list controls remain available.
      [...filtered, ...records.filter(repo => !visible.has(repo))].forEach(repo => fragment.append(repo.row));
      if (this.pagination) {
        this.pagination.classList.add('sp-native-hidden');
        this.pagination.before(fragment);
      } else this.host.append(fragment);
      this.nativeEmpty.forEach(node => node.classList.add('sp-native-hidden'));
      this.empty.hidden = filtered.length > 0;
      this.frame.dataset.spTotal = String(records.length);
      this.frame.dataset.spMatches = String(filtered.length);
      this.message(`${filtered.length} / ${records.length} stars`);
    }

    destroy() {
      this.controller.abort();
      this.listDialog?.remove();
    }
  }

  function mount() {
    scheduled = false;
    const frame = document.querySelector('#user-starred-repos');
    if (current?.frame === frame) {
      current.removeLists();
      if (current.toolbar?.isConnected) return;
    }
    current?.destroy();
    current = null;
    if (!frame?.querySelector('#stars-type-filter-menu-button')) return;
    if (!document.getElementById('starpicker-style')) document.head.append(element('style', { id: 'starpicker-style' }, STYLE));
    current = new StarPicker(frame);
  }

  function scheduleMount() {
    if (scheduled) return;
    scheduled = true;
    // Background tabs pause animation frames; filtering must also survive navigation there.
    queueMicrotask(mount);
  }

  const observer = new MutationObserver(scheduleMount);
  // Turbo can replace the body as well as an individual frame.
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ['turbo:load', 'turbo:frame-load', 'pjax:end'].forEach(event => document.addEventListener(event, scheduleMount));
  window.addEventListener('popstate', scheduleMount);
  mount();
})();
