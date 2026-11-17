import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENES,
  UNASSIGNED,
  aggregate,
  assumedOnCount,
  brightnessReached,
  buildHierarchy,
  buildTree,
  discoveryKey,
  effectiveTargets,
  holdActive,
  holdReached,
  isDimmable,
  moveInOrder,
  normalizeConfig,
  planBrightness,
  planToggle,
  relativeTime,
} from '../dist/hierarchical-light-card.js';

const light = (id, state, attrs = {}) => ({
  entity_id: id,
  state,
  attributes: { supported_color_modes: ['brightness'], ...attrs },
});
const onoff = (id, state, attrs = {}) => light(id, state, { supported_color_modes: ['onoff'], ...attrs });
const toStates = (...list) => Object.fromEntries(list.map((s) => [s.entity_id, s]));

const registries = {
  floors: [
    { floor_id: 'ground', name: 'Ground Floor', level: 0 },
    { floor_id: 'first', name: 'First Floor', level: 1 },
  ],
  areas: [
    { area_id: 'living', name: 'Living Room', floor_id: 'ground' },
    { area_id: 'kitchen', name: 'Kitchen', floor_id: 'ground' },
    { area_id: 'bedroom', name: 'Bedroom', floor_id: 'first' },
    { area_id: 'garage', name: 'Garage', floor_id: null },
  ],
  devices: [
    { id: 'dev_kitchen', area_id: 'kitchen' },
    { id: 'dev_living', area_id: 'living' },
  ],
  entities: [
    { entity_id: 'light.ceiling', area_id: 'living', device_id: null },
    { entity_id: 'light.counter', area_id: null, device_id: 'dev_kitchen' },
    { entity_id: 'light.override', area_id: 'bedroom', device_id: 'dev_living' },
    { entity_id: 'light.garage', area_id: 'garage' },
    { entity_id: 'light.disabled', area_id: 'living', disabled_by: 'user' },
    { entity_id: 'light.hidden', area_id: 'living', hidden_by: 'user' },
    { entity_id: 'switch.lamp', area_id: 'living' },
    { entity_id: 'switch.kettle', area_id: 'kitchen' },
  ],
};

const states = toStates(
  light('light.ceiling', 'on', { brightness: 128, friendly_name: 'Ceiling' }),
  light('light.counter', 'off', { friendly_name: 'Counter' }),
  light('light.override', 'off', { friendly_name: 'Override' }),
  onoff('light.garage', 'off', { friendly_name: 'Garage Light' }),
  light('light.disabled', 'off'),
  light('light.hidden', 'off'),
  light('light.orphan', 'off', { friendly_name: 'Orphan' }),
  { entity_id: 'switch.lamp', state: 'on', attributes: { friendly_name: 'Lamp' } },
  { entity_id: 'switch.kettle', state: 'on', attributes: {} },
  { entity_id: 'sensor.temp', state: '21', attributes: {} }
);

const find = (h, floorId, areaId) =>
  h.floors
    .find((f) => f.id === floorId)
    ?.areas.find((a) => a.id === areaId)
    ?.entities.map((e) => e.id);

test('config: defaults and validation', () => {
  const cfg = normalizeConfig({ type: 'custom:hierarchical-light-card' });
  assert.equal(cfg.title, '');
  assert.equal(cfg.show_brightness, true);
  assert.equal(cfg.sort, 'name');
  assert.throws(() => normalizeConfig({ sort: 'bogus' }));
  assert.throws(() => normalizeConfig({ switches: ['sensor.x'] }));
  assert.deepEqual(cfg.order, { floors: [], areas: [], lights: [], scenes: [] });
  assert.deepEqual(normalizeConfig({ order: { lights: 'light.a' } }).order, {
    floors: [],
    areas: [],
    lights: ['light.a'],
    scenes: [],
  });
  assert.throws(() => normalizeConfig({ order: ['light.a'] }));
});

test('order: listed ids come first, the rest keeps the sort order', () => {
  const names = (h) => h.floors.map((f) => f.id);
  assert.deepEqual(names(buildHierarchy(registries, states, normalizeConfig({}))), ['first', 'ground', UNASSIGNED]);
  const cfg = normalizeConfig({
    order: { floors: ['ground'], areas: ['living', 'gone'], lights: ['light.ceiling'] },
  });
  const h = buildHierarchy(registries, states, cfg);
  assert.deepEqual(names(h), ['ground', 'first', UNASSIGNED]);
  const ground = h.floors.find((f) => f.id === 'ground');
  assert.equal(ground.areas[0].id, 'living');
  assert.equal(find(h, 'ground', 'living')[0], 'light.ceiling');
  // Same lights as without an order, only arranged differently.
  const plain = buildHierarchy(registries, states, normalizeConfig({}));
  assert.deepEqual([...find(h, 'ground', 'living')].sort(), [...find(plain, 'ground', 'living')].sort());
  assert.equal(h.count, plain.count);
});

test('hold: a toggle is assumed until every light has followed', () => {
  const s = toStates(
    light('light.a', 'on', { brightness: 128 }),
    light('light.b', 'off'),
    onoff('light.d', 'on'),
    onoff('light.e', 'off'),
    light('light.x', 'unavailable')
  );
  const all = ['light.a', 'light.b', 'light.d', 'light.e', 'light.x'];
  const partial = aggregate(all, s); // 2 of 4 available lights are on
  const allOff = aggregate(['light.b', 'light.e'], s);
  const allOn = aggregate(['light.a', 'light.d'], s);

  // Toggle: the count jumps straight to the target, unavailable lights excluded.
  assert.equal(assumedOnCount(partial, { on: true }), 4);
  assert.equal(assumedOnCount(partial, { on: false }), 0);
  assert.equal(holdReached(partial, { on: true }), false);
  assert.equal(holdReached(partial, { on: false }), false);
  assert.equal(holdReached(allOn, { on: true }), true);
  assert.equal(holdReached(allOff, { on: false }), true);

  // Brightness only reaches the dimmable lights; on/off lights stay as they are.
  assert.equal(assumedOnCount(partial, { value: 50 }), 3); // a, b + d (already on)
  assert.equal(assumedOnCount(partial, { value: 0 }), 1); // only d stays on

  // Shown until reached or the cap, like a brightness.
  const sent = { on: true, phase: 'sent', until: 5000 };
  assert.equal(holdActive(sent, partial, 100), true);
  assert.equal(holdActive(sent, allOn, 100), false);
  assert.equal(holdActive(sent, partial, 5000), false);
});

test('flatten: a skipped floor or room shows its content one level up', () => {
  const tree = (flatten) => {
    const cfg = normalizeConfig({ flatten, show_unassigned: false });
    return buildTree(buildHierarchy(registries, states, cfg), cfg);
  };
  const keys = (nodes) => nodes.map((n) => n.key);
  const lightsIn = (nodes) => nodes.flatMap((n) => n.ids).sort();

  const plain = tree({});
  assert.deepEqual(keys(plain), ['floor:first', 'floor:ground']);
  const ground = plain.find((n) => n.key === 'floor:ground');
  assert.ok(ground.children.every((n) => n.kind === 'area'));
  const living = ground.children.find((n) => n.key === 'area:living');
  assert.ok(living.children.length > 0 && living.children.every((n) => n.kind === 'entity' && n.children === null));

  // Floor skipped: its rooms sit among the floors, in the floor's place.
  const noFloor = tree({ floors: ['ground'] });
  assert.deepEqual(keys(noFloor), ['floor:first', ...keys(ground.children)]);

  // Room skipped: its lights sit among the rooms of the floor.
  const noRoom = tree({ areas: ['living'] }).find((n) => n.key === 'floor:ground');
  assert.ok(!keys(noRoom.children).includes('area:living'));
  for (const id of living.ids) assert.ok(keys(noRoom.children).includes(id));
  assert.deepEqual([...noRoom.ids].sort(), [...ground.ids].sort()); // floor still controls the same lights

  // Both skipped: the lights sit among the floors.
  const neither = tree({ floors: ['ground'], areas: ['living'] });
  for (const id of living.ids) assert.ok(keys(neither).includes(id));

  // Skipping levels never adds or loses a light.
  for (const t of [noFloor, tree({ areas: ['living'] }), neither]) assert.deepEqual(lightsIn(t), lightsIn(plain));
  assert.throws(() => normalizeConfig({ flatten: ['ground'] }));
});

test('scenes: listed as one entry next to the floors', () => {
  const scene = (id, name, when) => ({ entity_id: id, state: when, attributes: { friendly_name: name } });
  const withScenes = {
    ...states,
    ...toStates(
      scene('scene.movie', 'Movie night', '2026-01-01T20:00:00+00:00'),
      scene('scene.bright', 'Bright', 'unknown'),
      scene('scene.secret', 'Secret', 'unknown')
    ),
  };
  const reg = {
    ...registries,
    entities: [
      ...registries.entities,
      { entity_id: 'scene.movie', area_id: 'living' },
      { entity_id: 'scene.secret', hidden_by: 'user' },
    ],
  };
  const build = (config) => {
    const cfg = normalizeConfig({ show_unassigned: false, ...config });
    const h = buildHierarchy(reg, withScenes, cfg);
    return { h, tree: buildTree(h, cfg) };
  };
  const keys = (nodes) => nodes.map((n) => n.key);

  const { h, tree } = build({});
  assert.deepEqual(h.scenes, [
    { id: 'scene.bright', name: 'Bright', area: null },
    { id: 'scene.movie', name: 'Movie night', area: 'Living Room' },
  ]);
  assert.equal(h.count, buildHierarchy(registries, states, normalizeConfig({ show_unassigned: false })).count); // scenes are not lights
  assert.deepEqual(keys(tree), ['floor:first', 'floor:ground', 'scenes']); // last by default
  const entry = tree[2];
  assert.equal(entry.kind, 'scenes');
  assert.deepEqual(keys(entry.children), ['scene.bright', 'scene.movie']);
  assert.ok(entry.children.every((n) => n.kind === 'scene' && n.children === null));

  // Ordered and flattened like a floor; scenes themselves can be ordered and excluded.
  assert.deepEqual(keys(build({ order: { floors: [SCENES] } }).tree), ['scenes', 'floor:first', 'floor:ground']);
  assert.deepEqual(keys(build({ flatten: { floors: [SCENES] } }).tree), ['floor:first', 'floor:ground', 'scene.bright', 'scene.movie']);
  assert.deepEqual(keys(build({ order: { scenes: ['scene.movie'] } }).tree[2].children), ['scene.movie', 'scene.bright']);
  assert.deepEqual(keys(build({ exclude: ['scene.bright'] }).tree[2].children), ['scene.movie']);
  assert.deepEqual(keys(build({ show_scenes: false }).tree), ['floor:first', 'floor:ground']);
  // A new scene changes the discovery fingerprint; a scene being activated does not.
  assert.notEqual(discoveryKey(withScenes, {}), discoveryKey(states, {}));
  const fired = { ...withScenes, 'scene.bright': scene('scene.bright', 'Bright', '2026-01-02T08:00:00+00:00') };
  assert.equal(discoveryKey(fired, {}), discoveryKey(withScenes, {}));
});

test('relative time', () => {
  const now = Date.parse('2026-01-10T12:00:00Z');
  const ago = (ms) => relativeTime(now - ms, now);
  const min = 60000;
  assert.equal(ago(20000), 'Just now');
  assert.equal(ago(-5000), 'Just now'); // clock skew
  assert.equal(ago(5 * min), '5 min ago');
  assert.equal(ago(60 * min), '1 hour ago');
  assert.equal(ago(5 * 60 * min), '5 hours ago');
  assert.equal(ago(30 * 60 * min), 'Yesterday');
  assert.equal(ago(3 * 24 * 60 * min), '3 days ago');
});

test('order: moving an item rewrites only its own group', () => {
  const group = ['a', 'b', 'c'];
  assert.deepEqual(moveInOrder(group, [], 'c', -1), ['a', 'c', 'b']);
  assert.deepEqual(moveInOrder(group, [], 'a', 1), ['b', 'a', 'c']);
  // Other groups stored in the same list are untouched.
  assert.deepEqual(moveInOrder(group, ['x', 'c', 'y'], 'b', -1), ['x', 'y', 'b', 'a', 'c']);
  // Moving past either end, or an unknown id, changes nothing.
  assert.deepEqual(moveInOrder(group, ['x'], 'a', -1), ['x']);
  assert.deepEqual(moveInOrder(group, ['x'], 'c', 1), ['x']);
  assert.deepEqual(moveInOrder(group, undefined, 'zzz', 1), []);
  // Round trip through buildHierarchy: the displayed order follows the move.
  const before = buildHierarchy(registries, states, normalizeConfig({})).floors.map((f) => f.id);
  const floors = moveInOrder(before, [], before[1], -1);
  const after = buildHierarchy(registries, states, normalizeConfig({ order: { floors } })).floors.map((f) => f.id);
  assert.deepEqual(after, [before[1], before[0], ...before.slice(2)]);
});

test('discovery: builds floors > areas > lights from the registries', () => {
  const h = buildHierarchy(registries, states, normalizeConfig({}));
  assert.deepEqual(h.floors.map((f) => f.name), ['First Floor', 'Ground Floor', 'Unassigned']);
  assert.equal(h.flat, false);
  assert.deepEqual(find(h, 'ground', 'living'), ['light.ceiling']);
  // Inherits the area of its device.
  assert.deepEqual(find(h, 'ground', 'kitchen'), ['light.counter']);
  // Explicit entity area wins over the device area.
  assert.deepEqual(find(h, 'first', 'bedroom'), ['light.override']);
  // Area without floor and light without area are not dropped.
  assert.deepEqual(find(h, UNASSIGNED, 'garage'), ['light.garage']);
  assert.deepEqual(find(h, UNASSIGNED, UNASSIGNED), ['light.orphan']);
  assert.equal(h.count, 5);
});

test('discovery: skips disabled/hidden entities and non-light domains', () => {
  const all = buildHierarchy(registries, states, normalizeConfig({}))
    .floors.flatMap((f) => f.areas.flatMap((a) => a.entities.map((e) => e.id)));
  for (const id of ['light.disabled', 'light.hidden', 'switch.lamp', 'switch.kettle', 'sensor.temp']) {
    assert.ok(!all.includes(id), `${id} must not be discovered`);
  }
  const withHidden = buildHierarchy(registries, states, normalizeConfig({ include_hidden: true }));
  assert.ok(find(withHidden, 'ground', 'living').includes('light.hidden'));
});

test('discovery: only explicitly configured switches are included', () => {
  const h = buildHierarchy(registries, states, normalizeConfig({ switches: ['switch.lamp'] }));
  assert.deepEqual(find(h, 'ground', 'living'), ['light.ceiling', 'switch.lamp']);
  assert.deepEqual(find(h, 'ground', 'kitchen'), ['light.counter']);
});

test('discovery: options show_unassigned, exclude, sort', () => {
  const noUnassigned = buildHierarchy(registries, states, normalizeConfig({ show_unassigned: false }));
  assert.deepEqual(noUnassigned.floors.map((f) => f.id), ['first', 'ground']);

  const excluded = buildHierarchy(registries, states, normalizeConfig({ exclude: ['light.ceiling'] }));
  assert.equal(find(excluded, 'ground', 'living'), undefined);

  const byLevel = buildHierarchy(registries, states, normalizeConfig({ sort: 'level' }));
  assert.deepEqual(byLevel.floors.map((f) => f.id), ['ground', 'first', UNASSIGNED]);
});

test('discovery: without floors the hierarchy starts at room level', () => {
  const h = buildHierarchy({ ...registries, floors: [] }, states, normalizeConfig({}));
  assert.equal(h.flat, true);
  assert.equal(h.floors.length, 1);
  assert.deepEqual(h.floors[0].areas.map((a) => a.name), ['Bedroom', 'Garage', 'Kitchen', 'Living Room', 'No area']);
});

test('discovery: reassigning an area moves the light; new lights change the key', () => {
  const moved = {
    ...registries,
    entities: registries.entities.map((e) => (e.entity_id === 'light.ceiling' ? { ...e, area_id: 'bedroom' } : e)),
  };
  const h = buildHierarchy(moved, states, normalizeConfig({}));
  assert.deepEqual(find(h, 'first', 'bedroom'), ['light.ceiling', 'light.override']);
  assert.equal(find(h, 'ground', 'living'), undefined);

  const cfg = normalizeConfig({});
  const before = discoveryKey(states, cfg);
  assert.equal(discoveryKey({ ...states }, cfg), before);
  assert.notEqual(discoveryKey({ ...states, 'light.new': light('light.new', 'off') }, cfg), before);
});

test('isDimmable', () => {
  assert.equal(isDimmable(light('light.a', 'on')), true);
  assert.equal(isDimmable(light('light.a', 'on', { supported_color_modes: ['hs', 'color_temp'] })), true);
  assert.equal(isDimmable(onoff('light.a', 'on')), false);
  assert.equal(isDimmable({ entity_id: 'light.a', state: 'on', attributes: { supported_features: 1 } }), true);
  assert.equal(isDimmable({ entity_id: 'switch.a', state: 'on', attributes: { brightness: 5 } }), false);
  assert.equal(isDimmable(undefined), false);
});

test('aggregate: off / on / partial / unavailable', () => {
  const s = toStates(
    light('light.a', 'on', { brightness: 255 }),
    light('light.b', 'on', { brightness: 51 }),
    light('light.c', 'off'),
    onoff('light.d', 'on'),
    light('light.x', 'unavailable')
  );
  assert.equal(aggregate(['light.c'], s).state, 'off');
  assert.equal(aggregate(['light.a', 'light.b'], s).state, 'on');
  assert.equal(aggregate(['light.a', 'light.c'], s).state, 'partial');
  assert.equal(aggregate(['light.x'], s).state, 'unavailable');
  assert.equal(aggregate([], s).state, 'unavailable');
  // Unavailable entities do not make an otherwise-on group partial.
  assert.equal(aggregate(['light.a', 'light.x'], s).state, 'on');
});

test('aggregate: brightness is the average of dimmable lights that are on', () => {
  const s = toStates(
    light('light.a', 'on', { brightness: 255 }),
    light('light.b', 'on', { brightness: 51 }),
    light('light.c', 'off', { brightness: 200 }),
    onoff('light.d', 'on')
  );
  const agg = aggregate(['light.a', 'light.b', 'light.c', 'light.d'], s);
  assert.equal(agg.brightness, 60); // (100 + 20) / 2
  assert.deepEqual(agg.dimmable, ['light.a', 'light.b', 'light.c']);
  assert.equal(aggregate(['light.d'], s).dimmableTotal, 0);
  assert.equal(aggregate(['light.c'], s).brightness, 0);
});

test('aggregate: mixed when dimmable lights are at different levels (off = 0)', () => {
  const s = toStates(
    light('light.a', 'on', { brightness: 255 }),
    light('light.b', 'on', { brightness: 51 }),
    light('light.b2', 'on', { brightness: 53 }),
    light('light.c', 'off'),
    light('light.c2', 'off'),
    onoff('light.d', 'on'),
    light('light.x', 'unavailable')
  );
  assert.equal(aggregate(['light.a', 'light.b'], s).mixed, true);
  // The range runs from the dimmest to the brightest light that is on; off lights are left out.
  assert.deepEqual([aggregate(['light.a', 'light.b'], s).min, aggregate(['light.a', 'light.b'], s).max], [20, 100]);
  assert.deepEqual([aggregate(['light.a', 'light.c'], s).min, aggregate(['light.a', 'light.c'], s).max], [100, 100]);
  assert.equal(aggregate(['light.a', 'light.c'], s).mixed, true);
  assert.equal(aggregate(['light.b', 'light.b2'], s).mixed, false); // within tolerance
  assert.equal(aggregate(['light.c', 'light.c2'], s).mixed, false);
  assert.equal(aggregate(['light.a'], s).mixed, false);
  // On/off-only and unavailable lights do not count.
  assert.equal(aggregate(['light.a', 'light.d', 'light.x'], s).mixed, false);
});

test('toggle: any on -> turn those off, otherwise turn all available on', () => {
  const s = toStates(
    light('light.a', 'on', { brightness: 100 }),
    light('light.b', 'off'),
    light('light.x', 'unavailable'),
    { entity_id: 'switch.s', state: 'off', attributes: {} }
  );
  const off = planToggle(aggregate(['light.a', 'light.b', 'light.x', 'switch.s'], s));
  // turn_off carries no brightness data and only touches what is on.
  assert.deepEqual(off, [{ domain: 'light', service: 'turn_off', data: {}, target: { entity_id: ['light.a'] } }]);

  const on = planToggle(aggregate(['light.b', 'light.x', 'switch.s'], s));
  assert.deepEqual(on, [
    { domain: 'light', service: 'turn_on', data: {}, target: { entity_id: ['light.b'] } },
    { domain: 'switch', service: 'turn_on', data: {}, target: { entity_id: ['switch.s'] } },
  ]);

  assert.deepEqual(planToggle(aggregate(['light.x'], s)), []);
});

test('brightness: only available dimmable lights receive brightness_pct', () => {
  const s = toStates(
    light('light.a', 'on', { brightness: 100 }),
    light('light.b', 'off'),
    onoff('light.d', 'on'),
    light('light.x', 'unavailable'),
    { entity_id: 'switch.s', state: 'on', attributes: {} }
  );
  const ids = ['light.a', 'light.b', 'light.d', 'light.x', 'switch.s'];
  assert.deepEqual(planBrightness(aggregate(ids, s), 42.4), [
    { domain: 'light', service: 'turn_on', data: { brightness_pct: 42 }, target: { entity_id: ['light.a', 'light.b'] } },
  ]);
  // 0 % turns the lit dimmable lights off instead of sending brightness 0.
  assert.deepEqual(planBrightness(aggregate(ids, s), 0), [
    { domain: 'light', service: 'turn_off', data: {}, target: { entity_id: ['light.a'] } },
  ]);
  assert.deepEqual(planBrightness(aggregate(['light.d', 'switch.s'], s), 50), []);
});

test('group overlap: no light is addressed twice', () => {
  const s = toStates(
    light('light.group', 'on', { entity_id: ['light.a', 'light.b'] }),
    light('light.a', 'on'),
    light('light.b', 'off'),
    light('light.c', 'off'),
    light('light.hue_room', 'on', { is_hue_group: true })
  );
  // Fully contained group -> use the members.
  assert.deepEqual(effectiveTargets(['light.group', 'light.a', 'light.b', 'light.c'], s).sort(), [
    'light.a',
    'light.b',
    'light.c',
  ]);
  // Group reaching outside the scope -> keep the group, drop covered members.
  assert.deepEqual(effectiveTargets(['light.group', 'light.a', 'light.c'], s).sort(), ['light.c', 'light.group']);
  // Group whose members are not listed (e.g. hidden) is used as-is.
  assert.deepEqual(effectiveTargets(['light.group', 'light.c'], s).sort(), ['light.c', 'light.group']);
  // Duplicates collapse.
  assert.deepEqual(effectiveTargets(['light.a', 'light.a', 'light.c'], s), ['light.a', 'light.c']);
  // Groups with unknown members are dropped next to real lights, kept alone.
  assert.deepEqual(effectiveTargets(['light.hue_room', 'light.a'], s), ['light.a']);
  assert.deepEqual(effectiveTargets(['light.hue_room'], s), ['light.hue_room']);
});

test('hold: released value is shown until the lights report it, capped in time', () => {
  const at = (...levels) =>
    aggregate(
      levels.map((_, i) => `light.l${i}`),
      toStates(
        ...levels.map((pct, i) =>
          pct ? light(`light.l${i}`, 'on', { brightness: Math.round((pct / 100) * 255) }) : light(`light.l${i}`, 'off')
        )
      )
    );

  assert.equal(brightnessReached(at(60, 60), 60), true);
  assert.equal(brightnessReached(at(60, 61), 60), true); // rounding tolerance
  assert.equal(brightnessReached(at(20, 60), 60), false); // one light still on its way
  assert.equal(brightnessReached(at(0, 60), 60), false); // one light still off
  assert.equal(brightnessReached(at(0, 0), 0), true);
  assert.equal(brightnessReached(at(0, 30), 0), false);

  const old = at(20, 20);
  const done = at(60, 60);
  assert.equal(holdActive(undefined, old, 0), false);
  // While dragging there is no time limit.
  assert.equal(holdActive({ value: 60, phase: 'editing', until: 0 }, old, 1e9), true);
  // Call in flight: hold even if the state already matches, until the cap.
  const sending = { value: 60, phase: 'sending', until: 5000 };
  assert.equal(holdActive(sending, old, 100), true);
  assert.equal(holdActive(sending, done, 100), true);
  assert.equal(holdActive(sending, old, 5000), false);
  // Call finished: hold until the lights report the value, or the cap.
  const sent = { value: 60, phase: 'sent', until: 5000 };
  assert.equal(holdActive(sent, old, 100), true); // state arrives after the call returned
  assert.equal(holdActive(sent, done, 100), false);
  assert.equal(holdActive(sent, old, 5000), false);
  // A new drag inside the cap replaces the hold and is shown again.
  assert.equal(holdActive({ value: 30, phase: 'editing', until: 0 }, done, 200), true);
  assert.equal(holdActive({ value: 30, phase: 'sent', until: 5200 }, done, 300), true);
  assert.equal(holdActive({ value: 30, phase: 'sent', until: 5200 }, at(30, 30), 900), false);
});
