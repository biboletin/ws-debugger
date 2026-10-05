import test from 'node:test';
import assert from 'node:assert/strict';
import { containsSecret, sanitizeTemplates, addTemplate, removeTemplate, expandVars, MAX_TEMPLATES, MAX_TEXT } from '../public/js/templates.js';

test('containsSecret flags secrets but not ordinary messages', () => {
  for (const s of ['{"token":"abc"}', '{"password": "x"}', 'api_key=12345', 'Authorization: Bearer abcdefghij1234', 'Bearer abcdefghijklmnop',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln', '{"apiKey":"k"}']) assert.equal(containsSecret(s), true, s);
  for (const s of ['{"action":"subscribe","channel":"prices"}', '{"type":"ping"}', 'hello world', '48 65 6c 6c 6f', '{"id":"{{uuid}}","n":{{counter}}}']) {
    assert.equal(containsSecret(s), false, s);
  }
});
test('sanitizeTemplates drops invalid, duplicate and oversized entries', () => {
  const good = { id: 'abc1', name: ' A ', type: 'json', text: '{}' };
  const out = sanitizeTemplates([good, good, null, 5, { ...good, id: 'x y' }, { ...good, id: 'b', type: 'ping' }, { ...good, id: 'c', text: 'x'.repeat(MAX_TEXT + 1) }, { ...good, id: 'd', name: '' }]);
  assert.deepEqual(out, [{ id: 'abc1', name: 'A', type: 'json', text: '{}' }]);
  assert.deepEqual(sanitizeTemplates('nope'), []);
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `id${i}`, name: `n${i}`, type: 'raw', text: 't' }));
  assert.equal(sanitizeTemplates(many).length, MAX_TEMPLATES);
});
test('addTemplate validations, replace-by-name and limit', () => {
  let n = 0; const id = () => `id${++n}`;
  const err = (r) => r.error.key;
  assert.equal(err(addTemplate([], { name: '', type: 'raw', text: 'x' })), 'tpl.no_name');
  assert.equal(err(addTemplate([], { name: 'a', type: 'ping', text: '' })), 'tpl.ping');
  assert.equal(err(addTemplate([], { name: 'a', type: 'raw', text: '   ' })), 'tpl.empty_msg');
  assert.equal(err(addTemplate([], { name: 'a', type: 'raw', text: '{"token":"x"}' })), 'tpl.secret');
  assert.equal(err(addTemplate([], { name: 'a', type: 'raw', text: 'x'.repeat(MAX_TEXT + 1) })), 'tpl.too_long');
  let list = addTemplate([], { name: 'Sub', type: 'json', text: '{"a":1}' }, id).list;
  list = addTemplate(list, { name: 'sub', type: 'raw', text: 'changed' }, id).list; // same name, case-insensitive
  assert.equal(list.length, 1); assert.equal(list[0].text, 'changed'); assert.equal(list[0].id, 'id1');
  let full = Array.from({ length: MAX_TEMPLATES }, (_, i) => ({ id: `i${i}`, name: `n${i}`, type: 'raw', text: 't' }));
  assert.equal(err(addTemplate(full, { name: 'new', type: 'raw', text: 't' })), 'tpl.full');
  assert.equal(addTemplate(full, { name: 'N0', type: 'raw', text: 'upd' }).ok, true); // replacing is allowed when full
  assert.equal(removeTemplate(list, 'id1').length, 0);
});
test('expandVars replaces known variables only', () => {
  const o = { now: Date.UTC(2026, 9, 4, 12, 0, 0), counter: 7, uuid: () => 'U' };
  assert.equal(expandVars('{{uuid}}|{{uuid}}|{{timestamp}}|{{iso}}|{{counter}}|{{other}}|{uuid}', o),
    `U|U|${o.now}|2026-10-04T12:00:00.000Z|7|{{other}}|{uuid}`);
  assert.match(expandVars('{{uuid}}'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
