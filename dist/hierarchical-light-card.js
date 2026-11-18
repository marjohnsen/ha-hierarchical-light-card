/**
 * Hierarchical Light Card for Home Assistant
 *
 * One dashboard card that auto-discovers every `light.*` entity and exposes it
 * through a three-level hierarchy: Floors -> Rooms (areas) -> Lights.
 *
 * The file is a plain ES module without dependencies or a build step:
 *   1. Pure logic (discovery, aggregation, service-call planning) - exported
 *      so it can be unit tested in Node.
 *   2. The custom element - only defined when running in a browser.
 */

export const VERSION = '1.0.0';
export const UNASSIGNED = '__unassigned__';
export const SCENES = '__scenes__'; // id of the "Scenes" entry, ordered and flattened like a floor

export const DEFAULT_CONFIG = Object.freeze({
  title: '', // optional; without it the top level has no header
  show_brightness: true,
  show_percentage: true,
  show_unassigned: true,
  show_scenes: true, // list scene.* entities under a "Scenes" entry
  sort: 'name', // 'name' | 'level' | 'none'
  include_hidden: false,
  switches: [], // explicitly listed switch.* entities to treat as lights
  exclude: [], // entity ids to ignore
  // Custom order, set in the card editor. Listed ids come first, in this
  // order; everything else follows according to `sort`.
  order: Object.freeze({ floors: [], areas: [], lights: [], scenes: [] }),
  // Floors / areas that are not shown as a level of their own: their content
  // appears one level up instead. Set in the card editor.
  flatten: Object.freeze({ floors: [], areas: [] }),
});

const SORT_MODES = ['name', 'level', 'none'];
const REGISTRY_EVENTS = [
  'entity_registry_updated',
  'device_registry_updated',
  'area_registry_updated',
  'floor_registry_updated',
];
const HOLD_CAP_MS = 10000; // longest time a released value is shown before the real state is trusted again
const KEY_COMMIT_MS = 300; // keyboard: send once the arrow keys have been idle this long
const MIXED_TOLERANCE = 2; // brightness spread (in %) below which a group counts as uniform
const REGISTRY_DEBOUNCE_MS = 300;

/* ------------------------------------------------------------------------ */
/* Pure logic                                                               */
/* ------------------------------------------------------------------------ */

const toList = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

export function normalizeConfig(config) {
  if (config != null && typeof config !== 'object') {
    throw new Error('hierarchical-light-card: invalid configuration');
  }
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  if (!SORT_MODES.includes(cfg.sort)) {
    throw new Error(`hierarchical-light-card: "sort" must be one of ${SORT_MODES.join(', ')}`);
  }
  cfg.switches = toList(cfg.switches).map(String);
  const bad = cfg.switches.find((id) => !id.startsWith('switch.'));
  if (bad) {
    throw new Error(`hierarchical-light-card: "switches" may only contain switch.* entities (got ${bad})`);
  }
  cfg.exclude = toList(cfg.exclude).map(String);
  const order = cfg.order == null ? {} : cfg.order;
  if (typeof order !== 'object' || Array.isArray(order)) {
    throw new Error('hierarchical-light-card: "order" must contain the lists floors, areas and lights');
  }
  cfg.order = {
    floors: toList(order.floors).map(String),
    areas: toList(order.areas).map(String),
    lights: toList(order.lights).map(String),
    scenes: toList(order.scenes).map(String),
  };
  const flatten = cfg.flatten == null ? {} : cfg.flatten;
  if (typeof flatten !== 'object' || Array.isArray(flatten)) {
    throw new Error('hierarchical-light-card: "flatten" must contain the lists floors and areas');
  }
  cfg.flatten = {
    floors: toList(flatten.floors).map(String),
    areas: toList(flatten.areas).map(String),
  };
  cfg.title = cfg.title == null ? DEFAULT_CONFIG.title : String(cfg.title);
  return cfg;
}

const domainOf = (entityId) => entityId.slice(0, entityId.indexOf('.'));

export function isAvailable(stateObj) {
  return !!stateObj && stateObj.state !== 'unavailable';
}

export function isDimmable(stateObj) {
  if (!stateObj || !stateObj.entity_id || domainOf(stateObj.entity_id) !== 'light') return false;
  const attrs = stateObj.attributes || {};
  const modes = attrs.supported_color_modes;
  if (Array.isArray(modes)) {
    // Every colour mode except "onoff" implies brightness support.
    return modes.some((mode) => mode !== 'onoff' && mode !== 'unknown');
  }
  // Legacy fallbacks (SUPPORT_BRIGHTNESS = 1).
  return ((attrs.supported_features || 0) & 1) === 1 || typeof attrs.brightness === 'number';
}

export function brightnessPct(stateObj) {
  if (!stateObj || stateObj.state !== 'on') return 0;
  const raw = stateObj.attributes && stateObj.attributes.brightness;
  if (typeof raw !== 'number') return 100;
  return Math.max(1, Math.min(100, Math.round((raw / 255) * 100)));
}

/** Member entity ids of a light group, or null when the entity is not a group. */
function groupMembers(stateObj) {
  const members = stateObj && stateObj.attributes && stateObj.attributes.entity_id;
  return Array.isArray(members) ? members.filter((m) => typeof m === 'string') : null;
}

/** Groups that do not expose their member ids (e.g. Hue rooms/zones). */
function isOpaqueGroup(stateObj) {
  return !!stateObj && !!stateObj.attributes && stateObj.attributes.is_hue_group === true && !groupMembers(stateObj);
}

/**
 * Reduce a list of entity ids to the set that should actually be measured and
 * commanded, so that no physical light is addressed twice:
 *  - duplicates are removed;
 *  - a group whose members are all in scope is dropped (members are used);
 *  - a group with members outside the scope is kept, and its in-scope members
 *    are dropped (the group already covers them);
 *  - groups with unknown members (Hue rooms/zones) are dropped whenever the
 *    scope contains any other light.
 */
export function effectiveTargets(entityIds, states) {
  const scope = new Set(entityIds);
  if (scope.size <= 1) return [...scope];

  const result = new Set(scope);
  const keptGroups = [];
  const opaque = [];

  for (const id of scope) {
    const stateObj = states[id];
    const members = groupMembers(stateObj);
    if (members) {
      const others = members.filter((m) => m !== id);
      if (others.length && others.every((m) => scope.has(m))) result.delete(id);
      else if (others.length) keptGroups.push(id);
    } else if (isOpaqueGroup(stateObj)) {
      opaque.push(id);
    }
  }

  const visited = new Set();
  const dropMembers = (groupId) => {
    if (visited.has(groupId)) return;
    visited.add(groupId);
    for (const member of groupMembers(states[groupId]) || []) {
      if (member === groupId) continue;
      result.delete(member);
      dropMembers(member);
    }
  };
  for (const groupId of keptGroups) {
    if (result.has(groupId)) dropMembers(groupId);
  }

  if (opaque.length && result.size > opaque.length) {
    for (const id of opaque) result.delete(id);
  }
  return [...result];
}

/**
 * Compute the aggregate state of a set of entities.
 * state: 'on' | 'off' | 'partial' | 'unavailable'
 */
export function aggregate(entityIds, states) {
  const targets = effectiveTargets(entityIds, states);
  const available = [];
  const on = [];
  const off = [];
  const dimmable = [];
  const levels = []; // level of every dimmable light that is on
  let dimmableTotal = 0;

  for (const id of targets) {
    const stateObj = states[id];
    const dim = isDimmable(stateObj);
    if (dim) dimmableTotal += 1;
    if (!isAvailable(stateObj)) continue;
    available.push(id);
    if (dim) dimmable.push(id);
    if (stateObj.state === 'on') {
      on.push(id);
      if (dim) levels.push(brightnessPct(stateObj));
    } else {
      off.push(id);
    }
  }

  let state = 'partial';
  if (!available.length) state = 'unavailable';
  else if (!on.length) state = 'off';
  else if (on.length === available.length) state = 'on';

  const brightness = levels.length
    ? Math.round(levels.reduce((sum, v) => sum + v, 0) / levels.length)
    : 0;

  return {
    targets,
    total: targets.length,
    available, // controllable entities
    on,
    off,
    dimmable, // controllable entities that support brightness
    dimmableTotal, // including unavailable ones (decides whether the row can dim)
    state,
    brightness, // average of dimmable lights that are on
    // Lowest and highest level among the dimmable lights that are on.
    min: levels.length ? Math.min(...levels) : 0,
    max: levels.length ? Math.max(...levels) : 0,
    // The dimmable lights that are on are not at one common level. Lights
    // that are off do not count.
    mixed: levels.length > 1 && Math.max(...levels) - Math.min(...levels) > MIXED_TOLERANCE,
  };
}

function callsByDomain(entityIds, service, data = {}) {
  const byDomain = new Map();
  for (const id of entityIds) {
    const domain = domainOf(id);
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(id);
  }
  return [...byDomain].map(([domain, ids]) => ({
    domain,
    service,
    data: { ...data },
    target: { entity_id: ids },
  }));
}

/** Any light on -> turn those off. Otherwise turn every available light on. */
export function planToggle(agg) {
  if (!agg.available.length) return [];
  return agg.on.length ? callsByDomain(agg.on, 'turn_off') : callsByDomain(agg.available, 'turn_on');
}

/** Brightness only ever targets available, dimmable lights. */
export function planBrightness(agg, pct) {
  const value = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  if (!agg.dimmable.length) return [];
  if (value === 0) {
    const onSet = new Set(agg.on);
    const lit = agg.dimmable.filter((id) => onSet.has(id));
    return lit.length ? callsByDomain(lit, 'turn_off') : [];
  }
  return callsByDomain(agg.dimmable, 'turn_on', { brightness_pct: value });
}

/** True when the lights report the level that was asked for. */
export function brightnessReached(agg, value) {
  if (value <= 0) return agg.brightness === 0; // no dimmable light is on any more
  const on = new Set(agg.on);
  if (!agg.dimmable.every((id) => on.has(id))) return false; // a light has not come on yet
  return !agg.mixed && Math.abs(agg.brightness - value) <= MIXED_TOLERANCE;
}

/**
 * True when the lights report what a hold asked for. A hold is either a
 * brightness (`{ value }`) or a toggle (`{ on }`).
 */
export function holdReached(agg, hold) {
  if (typeof hold.on === 'boolean') {
    return hold.on ? agg.on.length === agg.available.length : agg.on.length === 0;
  }
  return brightnessReached(agg, hold.value);
}

/** How many lights will be on once the held action has taken effect. */
export function assumedOnCount(agg, hold) {
  if (typeof hold.on === 'boolean') return hold.on ? agg.available.length : 0;
  // A brightness only reaches the dimmable lights; the others stay as they are.
  const dimmable = new Set(agg.dimmable);
  const others = agg.on.filter((id) => !dimmable.has(id)).length;
  return others + (hold.value > 0 ? agg.dimmable.length : 0);
}

/**
 * Whether a row should still show what the user set instead of the
 * reported state. A hold is `{ value | on, phase, until }`:
 *  - 'editing': being dragged / typed, nothing sent yet - always shown;
 *  - 'sending': the service call is running - shown until the cap;
 *  - 'sent': the call succeeded - shown until the lights report the value,
 *    or until the cap if they never do.
 */
export function holdActive(hold, agg, now) {
  if (!hold) return false;
  if (hold.phase === 'editing') return true;
  if (now >= hold.until) return false;
  return hold.phase === 'sending' || !holdReached(agg, hold);
}

/** "Just now", "5 min ago", "2 hours ago", "Yesterday", "3 days ago". */
export function relativeTime(thenMs, nowMs) {
  const minutes = Math.floor(Math.max(0, nowMs - thenMs) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Yesterday' : `${days} days ago`;
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** Items whose id is in `list` first, in list order; the rest keep their order. */
function applyOrder(items, list) {
  if (!Array.isArray(list) || !list.length) return items;
  const pos = new Map(list.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, index, rank: pos.has(item.id) ? pos.get(item.id) : Infinity }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
    .map((entry) => entry.item);
}

/**
 * Move `id` one step (`delta` = -1 up, +1 down) among its siblings.
 * `siblingIds` is the group as currently displayed, `list` the stored order
 * for that level. Returns the new stored list: the whole group is written in
 * its new order, other groups in the list are left alone.
 */
export function moveInOrder(siblingIds, list, id, delta) {
  const stored = Array.isArray(list) ? list : [];
  const from = siblingIds.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= siblingIds.length) return stored;
  const group = [...siblingIds];
  [group[from], group[to]] = [group[to], group[from]];
  const members = new Set(group);
  return [...stored.filter((other) => !members.has(other)), ...group];
}

/**
 * Build Floors -> Areas -> Entities from the registries plus the live states.
 * Only entities that currently have a state are included.
 */
export function buildHierarchy(registries, states, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  const reg = registries || {};
  const floorList = reg.floors || [];
  const areaList = reg.areas || [];
  const floorsById = new Map(floorList.map((f) => [f.floor_id, f]));
  const areasById = new Map(areaList.map((a) => [a.area_id, a]));
  const devicesById = new Map((reg.devices || []).map((d) => [d.id, d]));
  const entityReg = new Map((reg.entities || []).map((e) => [e.entity_id, e]));
  const exclude = new Set(cfg.exclude);
  const extra = new Set(cfg.switches);

  // Entity ids are object keys / set members, so they are deduplicated.
  const ids = new Set();
  for (const id in states) {
    if (id.startsWith('light.') || extra.has(id)) ids.add(id);
  }

  const buckets = new Map(); // area id -> entities
  let count = 0;
  for (const id of ids) {
    if (exclude.has(id)) continue;
    const entry = entityReg.get(id);
    if (entry) {
      if (entry.disabled_by) continue;
      if (!cfg.include_hidden && (entry.hidden_by || entry.hidden === true)) continue;
    }
    let areaId = (entry && entry.area_id) || null;
    if (!areaId && entry && entry.device_id) {
      const device = devicesById.get(entry.device_id);
      areaId = (device && device.area_id) || null;
    }
    if (!areaId || !areasById.has(areaId)) areaId = UNASSIGNED;

    const attrs = states[id].attributes || {};
    const name = attrs.friendly_name || (entry && (entry.name || entry.original_name)) || id;
    if (!buckets.has(areaId)) buckets.set(areaId, []);
    buckets.get(areaId).push({ id, name: String(name) });
    count += 1;
  }

  // Scenes are triggers, not lights: they are listed on their own.
  const scenes = [];
  if (cfg.show_scenes) {
    for (const id in states) {
      if (!id.startsWith('scene.') || exclude.has(id)) continue;
      const entry = entityReg.get(id);
      if (entry) {
        if (entry.disabled_by) continue;
        if (!cfg.include_hidden && (entry.hidden_by || entry.hidden === true)) continue;
      }
      let areaId = (entry && entry.area_id) || null;
      if (!areaId && entry && entry.device_id) {
        const device = devicesById.get(entry.device_id);
        areaId = (device && device.area_id) || null;
      }
      const area = areaId ? areasById.get(areaId) : null;
      const attrs = states[id].attributes || {};
      const name = attrs.friendly_name || (entry && (entry.name || entry.original_name)) || id;
      scenes.push({ id, name: String(name), area: (area && area.name) || null });
    }
    if (cfg.sort !== 'none') scenes.sort(byName);
  }

  const floorMap = new Map();
  const floorFor = (floorId) => {
    if (!floorMap.has(floorId)) {
      const f = floorsById.get(floorId);
      floorMap.set(floorId, {
        id: floorId,
        name: f ? f.name || floorId : 'Unassigned',
        icon: (f && f.icon) || null,
        level: f && typeof f.level === 'number' ? f.level : null,
        areas: [],
      });
    }
    return floorMap.get(floorId);
  };

  for (const area of areaList) {
    const entities = buckets.get(area.area_id);
    if (!entities) continue;
    const floorId = area.floor_id && floorsById.has(area.floor_id) ? area.floor_id : UNASSIGNED;
    floorFor(floorId).areas.push({
      id: area.area_id,
      name: area.name || area.area_id,
      icon: area.icon || null,
      entities,
    });
  }
  if (buckets.has(UNASSIGNED)) {
    floorFor(UNASSIGNED).areas.push({
      id: UNASSIGNED,
      name: 'No area',
      icon: null,
      entities: buckets.get(UNASSIGNED),
    });
  }

  // Registry order first, the synthetic "Unassigned" floor last.
  let floors = floorList.map((f) => floorMap.get(f.floor_id)).filter(Boolean);
  const flat = floors.length === 0; // no floors in use: start at room level
  const unassigned = floorMap.get(UNASSIGNED);
  if (unassigned) {
    if (flat) {
      if (!cfg.show_unassigned) unassigned.areas = unassigned.areas.filter((a) => a.id !== UNASSIGNED);
      if (unassigned.areas.length) floors = [unassigned];
    } else if (cfg.show_unassigned) {
      floors.push(unassigned);
    }
  }

  if (cfg.sort !== 'none') {
    const last = (cmp) => (a, b) => {
      if ((a.id === UNASSIGNED) !== (b.id === UNASSIGNED)) return a.id === UNASSIGNED ? 1 : -1;
      return cmp(a, b);
    };
    const byLevel = (a, b) => {
      if (a.level === b.level) return byName(a, b);
      if (a.level === null) return 1;
      if (b.level === null) return -1;
      return a.level - b.level;
    };
    floors.sort(last(cfg.sort === 'level' ? byLevel : byName));
    for (const floor of floors) {
      floor.areas.sort(last(byName));
      for (const area of floor.areas) area.entities.sort(byName);
    }
  }

  // A custom order from the card editor wins over the sort mode.
  const order = cfg.order || {};
  floors = applyOrder(floors, order.floors);
  for (const floor of floors) {
    floor.areas = applyOrder(floor.areas, order.areas);
    for (const area of floor.areas) area.entities = applyOrder(area.entities, order.lights);
  }

  count = floors.reduce((n, f) => n + f.areas.reduce((m, a) => m + a.entities.length, 0), 0);
  return { floors, flat, count, scenes: applyOrder(scenes, order.scenes) };
}

/**
 * Turn the Floors -> Areas -> Entities hierarchy into the tree the card
 * navigates. A flattened floor or area is not a level of its own: its
 * children take its place among its siblings. Scenes form one more entry
 * next to the floors. A node is `{ key, kind, id, name, ids, children }`;
 * lights and scenes have `children: null`.
 */
export function buildTree(hierarchy, config) {
  const flatten = (config && config.flatten) || {};
  const order = (config && config.order) || {};
  const skipFloors = new Set(flatten.floors || []);
  const skipAreas = new Set(flatten.areas || []);
  const lightNode = (e) => ({ key: e.id, kind: 'entity', id: e.id, name: e.name, ids: [e.id], children: null });
  const areaNodes = (area) => {
    const lights = area.entities.map(lightNode);
    if (skipAreas.has(area.id)) return lights;
    return [
      { key: `area:${area.id}`, kind: 'area', id: area.id, name: area.name, ids: lights.map((l) => l.id), children: lights },
    ];
  };
  // One segment per floor (plus one for the scenes); each contributes either
  // itself or, when flattened, its children.
  const segments = [];
  for (const floor of (hierarchy && hierarchy.floors) || []) {
    const children = floor.areas.flatMap(areaNodes);
    if (hierarchy.flat || skipFloors.has(floor.id)) {
      segments.push({ id: floor.id, nodes: children });
    } else {
      const ids = floor.areas.flatMap((a) => a.entities.map((e) => e.id));
      segments.push({
        id: floor.id,
        nodes: [{ key: `floor:${floor.id}`, kind: 'floor', id: floor.id, name: floor.name, ids, children }],
      });
    }
  }
  const scenes = (hierarchy && hierarchy.scenes) || [];
  if (scenes.length) {
    const children = scenes.map((s) => ({
      key: s.id,
      kind: 'scene',
      id: s.id,
      name: s.name,
      area: s.area,
      ids: [s.id],
      children: null,
    }));
    const ids = scenes.map((s) => s.id);
    const node = { key: 'scenes', kind: 'scenes', id: SCENES, name: 'Scenes', ids, children };
    segments.push({ id: SCENES, nodes: skipFloors.has(SCENES) ? children : [node] });
  }
  // Floors already are in their final order; this places the scenes among them
  // (last unless the custom order says otherwise).
  return applyOrder(segments, order.floors).flatMap((segment) => segment.nodes);
}

/** Cheap fingerprint of "which lights exist and what are they called". */
export function discoveryKey(states, config) {
  let key = '';
  for (const id in states) {
    if (id.startsWith('light.') || id.startsWith('scene.')) {
      const attrs = states[id].attributes;
      key += `${id}\u0001${(attrs && attrs.friendly_name) || ''}\u0002`;
    }
  }
  for (const id of (config && config.switches) || []) {
    const stateObj = states[id];
    key += `${id}\u0001${stateObj ? (stateObj.attributes && stateObj.attributes.friendly_name) || '' : '!'}\u0002`;
  }
  return key;
}

/* ------------------------------------------------------------------------ */
/* Custom element                                                           */
/* ------------------------------------------------------------------------ */

/** Load the registries; null when the essential ones cannot be read. */
async function fetchRegistries(hass) {
  const fallback = (key, empty) => () => (hass[key] ? Object.values(hass[key]) : empty);
  const list = (type, onError) =>
    Promise.resolve()
      .then(() => hass.callWS({ type }))
      .catch(onError);
  let floors;
  let areas;
  let entities;
  let devices;
  try {
    [floors, areas, entities, devices] = await Promise.all([
      // Floors do not exist before HA 2024.4: degrade to "no floors".
      list('config/floor_registry/list', fallback('floors', [])),
      list('config/area_registry/list', fallback('areas', null)),
      list('config/entity_registry/list', fallback('entities', null)),
      list('config/device_registry/list', fallback('devices', null)),
    ]);
  } catch (err) {
    return null;
  }
  if (!Array.isArray(areas) || !Array.isArray(entities) || !Array.isArray(devices)) return null;
  return { floors: Array.isArray(floors) ? floors : [], areas, entities, devices };
}

const STYLES = `
  :host {
    display: block;
    --hlc-active: var(--state-light-active-color, var(--amber-color, #ffc107));
    --hlc-track: var(--divider-color, rgba(127, 127, 127, 0.3));
    --hlc-muted: var(--secondary-text-color, #727272);
    /* "Set the mood" colours for scenes. The Scenes row and the back header
       inside Scenes both run yellow, red, purple from top to bottom; the
       header ends in the purple of the scene rows below it. */
    --hlc-yellow: var(--hlc-mood-yellow, rgba(255, 179, 0, 0.4));
    --hlc-red: var(--hlc-mood-red, rgba(236, 64, 122, 0.32));
    --hlc-purple: var(--hlc-mood-purple, rgba(126, 87, 194, 0.36));
    --hlc-mood-gradient: linear-gradient(180deg, var(--hlc-yellow), var(--hlc-red), var(--hlc-purple));
  }
  [hidden] { display: none !important; }
  ha-card {
    container-type: inline-size;
    padding: 0;
    overflow: hidden; /* rows run edge to edge and are clipped by the card's corners */
    color: var(--primary-text-color);
  }
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    margin: 0;
    padding: 0;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  button:disabled { cursor: default; }
  button:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--primary-color, #03a9f4);
    outline-offset: 2px;
  }
  .icon-btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
  }
  .icon-btn:not(:disabled):hover { background: rgba(127, 127, 127, 0.15); }

  .header {
    display: flex;
    align-items: center;
    min-height: 48px;
    padding: 4px 8px 4px 16px;
  }
  .header.nested {
    padding-inline-start: 4px;
    /* Back header: a faint, even tint of the light colour. */
    background: rgba(255, 193, 7, 0.12);
    background: color-mix(in srgb, var(--hlc-active) 12%, transparent);
  }
  .header.nested.mood {
    background: linear-gradient(180deg, var(--hlc-yellow), var(--hlc-red), var(--hlc-purple));
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: var(--ha-card-header-font-size, 1.25rem);
    line-height: 1.3;
  }
  .header.nested .crumbs { font-size: 1.05rem; }
  .crumb {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-radius: 6px;
    padding: 4px;
  }
  button.crumb { color: var(--hlc-muted); flex: 0 1 auto; }
  button.crumb:hover { color: var(--primary-text-color); }
  .crumb.current { font-weight: 500; flex: 0 2 auto; }
  .sep { color: var(--hlc-muted); flex: none; }

  .rows {
    display: flex;
    flex-direction: column;
  }
  /* The whole row is the dimmer: its background fill shows the brightness. */
  .row {
    position: relative;
    isolation: isolate;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 52px;
    padding: 0 16px 0 10px;
    border-top: 1px solid var(--divider-color, rgba(127, 127, 127, 0.2));
    background: var(--hlc-row-background, transparent);
    overflow: hidden;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    touch-action: pan-y;
    transition: background-color 0.15s;
  }
  .row:hover { background: var(--hlc-row-background-hover, rgba(127, 127, 127, 0.08)); }
  .header[hidden] + .rows .row:first-child { border-top: 0; }
  .row.dragging { cursor: grabbing; }
  /* Scenes: the entry row carries the mood gradient; a scene row is a purple
     trigger that flashes the full gradient when activated. */
  .row[data-kind="scenes"],
  .row[data-kind="scenes"]:hover { background: linear-gradient(180deg, var(--hlc-red), var(--hlc-purple)); }
  .row[data-kind="scene"],
  .row[data-kind="scene"]:hover { background: var(--hlc-purple); }
  .row[data-kind="scenes"]:hover,
  .row[data-kind="scene"]:hover { filter: brightness(1.08); }
  .row[data-kind="scenes"] .bulb { color: var(--primary-text-color); }
  .row[data-kind="scene"]::after {
    content: "";
    position: absolute;
    z-index: -1;
    inset: 0;
    background: var(--hlc-mood-gradient);
    opacity: 0;
    pointer-events: none;
  }
  .row[data-kind="scene"].fired::after { animation: hlc-fired 1s ease-out; }
  @keyframes hlc-fired {
    0% { opacity: 0; transform: translateX(-100%); }
    30% { opacity: 1; transform: none; }
    100% { opacity: 0; transform: none; }
  }
  .row[data-state="unavailable"] > * { opacity: 0.5; }
  .row:has(.slider:focus-visible) {
    outline: 2px solid var(--primary-color, #03a9f4);
    outline-offset: -2px;
  }
  .fill {
    position: absolute;
    z-index: -1;
    top: 0;
    bottom: 0;
    left: 0;
    width: var(--pct, 0%);
    background: var(--hlc-active);
    opacity: 0.3;
    pointer-events: none;
    transition: width 0.25s ease, opacity 0.15s;
  }
  .row[data-state="partial"] .fill { opacity: 0.2; }
  .row.dragging .fill { opacity: 0.45; transition: none; }
  /* Lights at different levels: no level is shown. The bar has no edge; it
     fades out across the whole row instead. */
  .fade {
    display: none;
    position: absolute;
    z-index: -1;
    inset: 0;
    background: linear-gradient(90deg, var(--hlc-active), transparent);
    opacity: 0.3;
    pointer-events: none;
  }
  .row.mixed .fade { display: block; }
  .row.mixed .fill { display: none; }

  .bulb {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    color: var(--hlc-muted);
    --mdc-icon-size: 24px;
    transition: color 0.15s;
  }
  .row[data-state="on"] .bulb,
  .row[data-state="partial"] .bulb {
    color: var(--hlc-on-icon-color, var(--primary-text-color));
  }

  .label {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-self: stretch;
    text-align: start;
    border-radius: 20px;
    overflow: hidden;
    cursor: inherit;
  }
  .label:focus-visible { outline-offset: -2px; }
  .name {
    font-weight: 500;
    line-height: 1.25;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .secondary {
    font-size: 0.75rem;
    line-height: 1.2;
    color: var(--hlc-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .secondary:empty { display: none; }

  .value {
    flex: none;
    min-width: 36px;
    text-align: end;
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
    color: var(--primary-text-color);
    opacity: 0.8;
  }
  .chevron {
    flex: none;
    margin-inline: -4px -6px;
    color: var(--hlc-muted);
    --mdc-icon-size: 20px;
  }

  /* Native range input, visually hidden: keyboard and screen-reader access
     to the brightness. Pointer dimming is handled on the row itself. */
  .slider {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 1px;
    height: 1px;
    margin: 0;
    padding: 0;
    opacity: 0;
    pointer-events: none;
  }



  .message {
    padding: 24px 16px;
    text-align: center;
    color: var(--hlc-muted);
  }
  .message button {
    display: block;
    margin: 12px auto 0;
    padding: 6px 16px;
    border-radius: 16px;
    color: var(--primary-color, #03a9f4);
    border: 1px solid currentColor;
  }

  @container (max-width: 340px) {
    .row { gap: 6px; padding-inline: 8px 12px; }
  }

`;

const ROW_TEMPLATE = `
  <div class="fill"></div>
  <div class="fade"></div>
  <button class="bulb" type="button"><ha-icon></ha-icon></button>
  <button class="label" type="button"><span class="name"></span><span class="secondary"></span></button>
  <input class="slider" type="range" min="0" max="100" step="1">
  <span class="value"></span>

  <ha-icon class="chevron" icon="mdi:chevron-right" aria-hidden="true"></ha-icon>
`;

const setAttr = (el, name, value) => {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
};
const setText = (el, value) => {
  if (el.textContent !== value) el.textContent = value;
};
const setFlag = (el, prop, value) => {
  if (el[prop] !== value) el[prop] = value;
};

if (typeof window !== 'undefined' && typeof HTMLElement !== 'undefined' && window.customElements) {
  class HierarchicalLightCard extends HTMLElement {
    constructor() {
      super();
      this._config = normalizeConfig({});
      this._hass = null;
      this._conn = null; // connection we are subscribed to
      this._connected = false;
      this._registries = null;
      this._hierarchy = null;
      this._discoveryKey = '';
      this._status = 'loading'; // 'loading' | 'ready' | 'error'
      this._path = []; // keys of the tree nodes that were opened, top down
      this._tree = [];
      this._fired = new Map(); // scene id -> time it was activated from this card
      this._clock = null;
      this._rows = [];
      this._crumbs = [];
      this._rowEls = new Map();
      this._holds = new Map(); // row key -> { value, phase, until }, see holdActive()

      this._unsubs = [];
      this._subToken = null;
      this._loadSeq = 0;
      this._reloadTimer = null;


      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>${STYLES}</style>
        <ha-card>
          <div class="header">
            <button class="back icon-btn" type="button" hidden><ha-icon icon="mdi:chevron-left"></ha-icon></button>
            <nav class="crumbs" aria-label="Breadcrumb"></nav>
          </div>
          <div class="rows" role="list"></div>
          <div class="message" role="status" hidden></div>
        </ha-card>`;
      this._headerEl = root.querySelector('.header');
      this._backEl = root.querySelector('.back');
      this._crumbsEl = root.querySelector('.crumbs');
      this._rowsEl = root.querySelector('.rows');
      this._messageEl = root.querySelector('.message');
      this._backEl.addEventListener('click', () => this._goBack());
    }

    /* ---- Dashboard card API -------------------------------------------- */

    static getStubConfig() {
      return {};
    }

    /** Custom editor: the form below plus the order tree. */
    static getConfigElement() {
      return document.createElement('hierarchical-light-card-editor');
    }

    static getConfigForm() {
      const labels = {
        title: 'Title',
        sort: 'Sort order',
        show_brightness: 'Show brightness sliders',
        show_percentage: 'Show percentage',
        show_unassigned: 'Show unassigned lights',
        show_scenes: 'Show scenes',
        include_hidden: 'Include hidden entities',
        switches: 'Switches to treat as lights',

      };
      return {
        schema: [
          { name: 'title', selector: { text: {} } },
          {
            name: 'sort',
            selector: {
              select: {
                mode: 'dropdown',
                options: [
                  { value: 'name', label: 'Name' },
                  { value: 'level', label: 'Floor level, then name' },
                  { value: 'none', label: 'Registry order' },
                ],
              },
            },
          },
          {
            type: 'grid',
            name: '',
            schema: [
              { name: 'show_brightness', selector: { boolean: {} } },
              { name: 'show_percentage', selector: { boolean: {} } },
              { name: 'show_unassigned', selector: { boolean: {} } },
              { name: 'show_scenes', selector: { boolean: {} } },
              { name: 'include_hidden', selector: { boolean: {} } },
            ],
          },
          { name: 'switches', selector: { entity: { multiple: true, filter: { domain: 'switch' } } } },

        ],
        computeLabel: (schema) => labels[schema.name] || schema.name,
      };
    }

    setConfig(config) {
      this._config = normalizeConfig(config);
      if (this._hass && this._registries) this._rebuild();
      this._render();
    }

    set hass(hass) {
      const old = this._hass;
      this._hass = hass;
      if (!hass) return;
      this._start();
      if (!this._registries) return;
      if (old && old.states === hass.states) return;

      if (discoveryKey(hass.states, this._config) !== this._discoveryKey) {
        // A light appeared, disappeared or was renamed.
        this._rebuild();
        this._render();
      } else if (!old || this._visibleStatesChanged(old.states, hass.states)) {
        this._updateRows();
      }
    }

    get hass() {
      return this._hass;
    }

    getCardSize() {
      return 1 + Math.max(1, this._rows.length);
    }

    getGridOptions() {
      return { columns: 12, min_columns: 6 };
    }

    connectedCallback() {
      this._connected = true;
      this._start();
      this._render();
    }

    disconnectedCallback() {
      this._connected = false;
      this._stop();
    }

    /* ---- Registry discovery (independent from state updates) ---------- */

    _start() {
      const hass = this._hass;
      if (!this._connected || !hass || !hass.connection || this._conn === hass.connection) return;
      this._stop();
      const conn = hass.connection;
      this._conn = conn;
      const token = {};
      this._subToken = token;
      const onChange = () => this._scheduleReload();

      for (const eventType of REGISTRY_EVENTS) {
        Promise.resolve()
          .then(() => conn.subscribeEvents(onChange, eventType))
          .then((unsub) => {
            if (this._subToken === token) this._unsubs.push(unsub);
            else Promise.resolve().then(unsub).catch(() => {});
          })
          .catch(() => {
            /* event not available for this user / HA version */
          });
      }
      if (typeof conn.addEventListener === 'function') {
        // Re-sync after a reconnect: registries may have changed meanwhile.
        conn.addEventListener('ready', onChange);
        this._unsubs.push(() => conn.removeEventListener('ready', onChange));
      }
      this._loadRegistries();
      // Keeps "5 min ago" on the scene rows current.
      this._clock = setInterval(() => this._updateRows(), 60000);
    }

    _stop() {
      this._subToken = null;
      this._conn = null;
      this._loadSeq += 1; // invalidate in-flight loads
      for (const unsub of this._unsubs.splice(0)) {
        Promise.resolve().then(unsub).catch(() => {});
      }
      clearTimeout(this._reloadTimer);
      clearInterval(this._clock);
      this._reloadTimer = null;
      this._clock = null;
    }

    _scheduleReload() {
      clearTimeout(this._reloadTimer);
      this._reloadTimer = setTimeout(() => this._loadRegistries(), REGISTRY_DEBOUNCE_MS);
    }

    async _loadRegistries() {
      const hass = this._hass;
      if (!hass) return;
      const seq = ++this._loadSeq;
      const registries = await fetchRegistries(hass);
      if (seq !== this._loadSeq) return; // superseded or detached

      if (!registries) {
        if (this._registries) {
          // Keep showing the last known hierarchy.
          console.warn('hierarchical-light-card: registry refresh failed, keeping previous data');
        } else {
          this._status = 'error';
          this._render();
        }
        return;
      }

      this._registries = registries;
      this._status = 'ready';
      this._rebuild();
      this._render();
    }

    _rebuild() {
      const hass = this._hass;
      if (!hass || !this._registries) return;
      this._hierarchy = buildHierarchy(this._registries, hass.states, this._config);
      this._tree = buildTree(this._hierarchy, this._config);
      this._discoveryKey = discoveryKey(hass.states, this._config);
    }

    /* ---- View model ---------------------------------------------------- */

    _computeView() {
      const crumbs = [{ label: this._config.title, path: [] }];
      let nodes = this._tree;
      const path = [];
      for (const key of this._path) {
        const node = nodes.find((n) => n.key === key && n.children);
        if (!node) break; // that level vanished: stay at the deepest one that still exists
        path.push(key);
        crumbs.push({ label: node.name, path: [...path] });
        nodes = node.children;
      }
      this._path = path;
      this._rows = nodes.map((node) => ({
        key: node.key,
        kind: node.kind,
        name: node.name,
        ids: node.ids,
        entityId: node.children ? null : node.id,
        area: node.area || null,
        path: node.children ? [...path, node.key] : null, // where a tap on the row leads
      }));
      this._crumbs = crumbs;
    }

    _visibleStatesChanged(oldStates, newStates) {
      for (const row of this._rows) {
        for (const id of row.ids) {
          if (oldStates[id] !== newStates[id]) return true;
        }
      }
      return false;
    }

    /* ---- Rendering ----------------------------------------------------- */

    _t(key, fallback) {
      const localize = this._hass && this._hass.localize;
      return (typeof localize === 'function' && localize(key)) || fallback;
    }

    _render() {
      this._computeView();
      this._renderHeader();

      // Keyed reconciliation: rows keep their DOM (and slider focus/drag)
      // across state updates; navigation simply swaps the key set.
      const container = this._rowsEl;
      const seen = new Set();
      let prev = null;
      for (const row of this._rows) {
        let el = this._rowEls.get(row.key);
        if (!el) {
          el = this._createRow();
          this._rowEls.set(row.key, el);
        }
        el._row = row;
        seen.add(row.key);
        const expected = prev ? prev.nextSibling : container.firstChild;
        if (el !== expected) container.insertBefore(el, expected);
        prev = el;
      }
      for (const [key, el] of [...this._rowEls]) {
        if (seen.has(key)) continue;
        if (el._commitTimer) this._commit(el); // send a pending keyboard change
        el.remove();
        this._rowEls.delete(key);
        this._holds.delete(key);

      }

      this._updateRows();
      this._renderMessage();
    }

    _renderHeader() {
      const crumbs = this._crumbs;
      const nested = crumbs.length > 1;
      // Top level: no header unless a title is configured. Below it: a back header.
      setFlag(this._headerEl, 'hidden', !nested && !crumbs[0].label);
      this._headerEl.classList.toggle('nested', nested);
      this._headerEl.classList.toggle('mood', this._path[0] === 'scenes');

      setFlag(this._backEl, 'hidden', !nested);
      setAttr(this._backEl, 'aria-label', this._t('ui.common.back', 'Back'));

      const shown = crumbs.slice(-2).filter((crumb) => crumb.label);
      const frag = document.createDocumentFragment();
      shown.forEach((crumb, index) => {
        const isLast = index === shown.length - 1;
        if (index > 0) {
          const sep = document.createElement('span');
          sep.className = 'sep';
          sep.setAttribute('aria-hidden', 'true');
          sep.textContent = '/';
          frag.appendChild(sep);
        }
        const el = document.createElement(isLast ? 'span' : 'button');
        el.className = isLast ? 'crumb current' : 'crumb';
        el.textContent = crumb.label;
        if (isLast) {
          el.setAttribute('aria-current', 'page');
        } else {
          el.type = 'button';
          el.addEventListener('click', () => this._navigate(crumb.path));
        }
        frag.appendChild(el);
      });
      this._crumbsEl.replaceChildren(frag);
    }

    _renderMessage() {
      const el = this._messageEl;
      let text = '';
      let retry = false;
      if (this._status === 'loading') {
        text = 'Loading lights…';
      } else if (this._status === 'error') {
        text = 'Could not load the Home Assistant registries.';
        retry = true;
      } else if (!this._rows.length) {
        text = 'No lights found.';
      }
      setFlag(el, 'hidden', !text);
      if (el._text === text) return;
      el._text = text;
      el.textContent = text;
      if (retry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Retry';
        button.addEventListener('click', () => {
          this._status = 'loading';
          this._render();
          this._loadRegistries();
        });
        el.appendChild(button);
      }
    }

    _createRow() {
      const el = document.createElement('div');
      el.className = 'row';
      el.setAttribute('role', 'listitem');
      el.innerHTML = ROW_TEMPLATE;
      const refs = {
        bulb: el.querySelector('.bulb'),
        icon: el.querySelector('.bulb ha-icon'),
        label: el.querySelector('.label'),
        name: el.querySelector('.name'),
        secondary: el.querySelector('.secondary'),
        slider: el.querySelector('.slider'),

        value: el.querySelector('.value'),
        chevron: el.querySelector('.chevron'),
      };
      el._refs = refs;
      el._dragging = false;
      el._canDrag = false;
      el._suppressClick = false;

      // The bulb toggles; a tap anywhere else on the row navigates
      // (or opens more-info on a light). A horizontal drag dims instead and
      // swallows the click that follows it, so it never navigates.
      refs.bulb.addEventListener('click', () => {
        // On scene rows the icon is not a toggle: it does what the row does.
        if (el._row.kind === 'scene' || el._row.kind === 'scenes') this._activate(el._row);
        else this._toggle(el._row);
      });

      el.addEventListener('click', (ev) => {
        if (el._suppressClick) {
          el._suppressClick = false;
          return;
        }
        if (ev.target.closest('.bulb, .slider')) return;
        this._activate(el._row);
      });

      let gesture = null;
      const valueAt = (clientX) => {
        const rect = el.getBoundingClientRect();
        const pad = 10; // makes 0 % and 100 % reachable without hitting the exact edge
        const ratio = (clientX - rect.left - pad) / Math.max(1, rect.width - 2 * pad);
        return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
      };
      el.addEventListener('pointerdown', (ev) => {
        if (!el._canDrag || !ev.isPrimary || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
        if (ev.target.closest('.bulb')) return;
        gesture = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, active: false };
      });
      el.addEventListener('pointermove', (ev) => {
        if (!gesture || ev.pointerId !== gesture.id) return;
        if (!gesture.active) {
          const dx = Math.abs(ev.clientX - gesture.x);
          const dy = Math.abs(ev.clientY - gesture.y);
          if (dy > 10 && dy >= dx) {
            gesture = null; // vertical movement: the page is scrolling
            return;
          }
          if (dx < 6 || dx <= dy) return;
          gesture.active = true;
          el._dragging = true;
          el.classList.add('dragging');
          try {
            el.setPointerCapture(ev.pointerId);
          } catch (err) {
            /* pointer already gone */
          }
        }
        refs.slider.value = String(valueAt(ev.clientX));
        this._preview(el); // nothing is sent until release
      });
      const endGesture = (ev) => {
        if (!gesture || ev.pointerId !== gesture.id) return;
        const wasActive = gesture.active;
        gesture = null;
        if (!wasActive) return;
        el._dragging = false;
        el.classList.remove('dragging');
        el._suppressClick = true;
        setTimeout(() => {
          el._suppressClick = false;
        }, 250);
        this._commit(el);
      };
      el.addEventListener('pointerup', endGesture);
      el.addEventListener('pointercancel', endGesture);
      el.addEventListener('lostpointercapture', endGesture);

      // Keyboard / assistive technology path.
      refs.slider.addEventListener('input', () => {
        // Arrow keys have no "release": send once they have been idle.
        this._preview(el);
        clearTimeout(el._commitTimer);
        el._commitTimer = setTimeout(() => this._commit(el), KEY_COMMIT_MS);
      });
      return el;
    }

    _updateRows() {
      if (!this._hass) return;
      for (const row of this._rows) {
        const el = this._rowEls.get(row.key);
        if (el) this._updateRow(el, row);
      }
    }

    _updateRow(el, row) {
      const cfg = this._config;
      const refs = el._refs;
      setAttr(el, 'data-kind', row.kind);
      if (row.kind === 'scene' || row.kind === 'scenes') {
        this._updateSceneRow(el, row);
        return;
      }
      const agg = aggregate(row.ids, this._hass.states);
      const isGroup = row.kind !== 'entity';
      const unavailable = agg.state === 'unavailable';

      // What the user just set (brightness or toggle) is shown until the
      // lights report it; see holdActive().
      let hold = this._holds.get(row.key);
      if (hold && !holdActive(hold, agg, Date.now())) {
        this._holds.delete(row.key);
        hold = undefined;
      }
      const assumed = !!hold && hold.phase !== 'editing' && !unavailable;
      const onCount = assumed ? assumedOnCount(agg, hold) : agg.on.length;
      let state = agg.state;
      if (assumed) state = onCount === 0 ? 'off' : onCount >= agg.available.length ? 'on' : 'partial';
      const lit = state === 'on' || state === 'partial';
      const onText = this._t('state.default.on', 'On');
      const offText = this._t('state.default.off', 'Off');
      const unavailableText = this._t('state.default.unavailable', 'Unavailable');

      setAttr(el, 'data-state', state);

      // Bulb
      const icon = unavailable ? 'mdi:lightbulb-off-outline' : lit ? 'mdi:lightbulb' : 'mdi:lightbulb-outline';
      setAttr(refs.icon, 'icon', icon);
      setFlag(refs.bulb, 'disabled', unavailable);
      setAttr(refs.bulb, 'aria-pressed', state === 'partial' ? 'mixed' : String(lit));
      setAttr(refs.bulb, 'aria-label', `${row.name}: ${lit ? 'turn off' : 'turn on'}`);

      // Label
      setText(refs.name, row.name);
      let secondary = '';
      if (unavailable) secondary = unavailableText;
      else if (isGroup) secondary = `${onCount} of ${agg.available.length} on`;
      setText(refs.secondary, secondary);
      setAttr(refs.label, 'title', row.name);
      setFlag(refs.chevron, 'hidden', !isGroup);

      // Dimming when anything is dimmable; otherwise the bulb is the only control.
      const useSlider = cfg.show_brightness && agg.dimmableTotal > 0;
      setFlag(refs.slider, 'hidden', !useSlider);

      let valueText = '';
      let mixed = false;
      if (useSlider) {
        let value = agg.brightness;
        if (hold && typeof hold.value === 'number') {
          value = hold.value;
        } else if (hold) {
          // Toggled: off is empty; on shows the level reported so far, else
          // the level the row had last time, else full.
          value = hold.on ? agg.brightness || el._lastPct || 100 : 0;
        } else {
          mixed = agg.mixed; // different levels: a fade instead of a level
          if (value > 0 && !mixed) el._lastPct = value;
        }

        const text = String(value);
        if (refs.slider.value !== text) refs.slider.value = text;
        el.style.setProperty('--pct', `${value}%`);
        setFlag(refs.slider, 'disabled', agg.dimmable.length === 0);
        setAttr(refs.slider, 'aria-label', `${row.name} brightness`);
        // Different levels: the range among the lights that are on.
        const shown = mixed ? `${agg.min}\u2013${agg.max}%` : `${value}%`;
        setAttr(refs.slider, 'aria-valuetext', shown);
        valueText = unavailable ? '—' : shown;
      } else {
        el.style.setProperty('--pct', lit ? '100%' : '0%');
        valueText = unavailable ? '—' : lit ? onText : offText;
      }
      el.classList.toggle('mixed', mixed);
      el._canDrag = useSlider && agg.dimmable.length > 0;
      setFlag(refs.value, 'hidden', !cfg.show_percentage);
      setText(refs.value, valueText);
    }

    /** Scene rows: no state, no bar - an icon, a name and when it was last used. */
    _updateSceneRow(el, row) {
      const refs = el._refs;
      const states = this._hass.states;
      const now = Date.now();
      // A scene's state is the time it was last activated.
      const stamp = (id) => {
        const stateObj = states[id];
        const time = stateObj ? Date.parse(stateObj.state) : NaN;
        return Math.max(Number.isNaN(time) ? 0 : time, this._fired.get(id) || 0);
      };
      const isGroup = row.kind === 'scenes';
      let icon = 'mdi:creation';
      let secondary;
      let unavailable = false;
      if (isGroup) {
        // "Current mood": the scene that was used most recently.
        let lastId = null;
        for (const id of row.ids) {
          if (stamp(id) && (!lastId || stamp(id) > stamp(lastId))) lastId = id;
        }
        if (lastId) {
          const attrs = (states[lastId] && states[lastId].attributes) || {};
          secondary = `${attrs.friendly_name || lastId} \u00b7 ${relativeTime(stamp(lastId), now)}`;
        } else {
          secondary = row.ids.length === 1 ? '1 scene' : `${row.ids.length} scenes`;
        }
      } else {
        const stateObj = states[row.entityId];
        unavailable = !isAvailable(stateObj);
        icon = (stateObj && stateObj.attributes && stateObj.attributes.icon) || 'mdi:palette-outline';
        const time = stamp(row.entityId);
        let when = time ? relativeTime(time, now) : 'Never activated';
        if (unavailable) when = this._t('state.default.unavailable', 'Unavailable');
        secondary = row.area ? `${row.area} \u00b7 ${when}` : when;
      }

      setAttr(el, 'data-state', unavailable ? 'unavailable' : 'off');
      setAttr(refs.icon, 'icon', icon);
      setFlag(refs.bulb, 'disabled', unavailable);
      setAttr(refs.bulb, 'aria-label', isGroup ? row.name : `Activate ${row.name}`);
      setText(refs.name, row.name);
      setText(refs.secondary, secondary);
      setAttr(refs.label, 'title', row.name);
      setFlag(refs.chevron, 'hidden', !isGroup);
      setFlag(refs.slider, 'hidden', true);
      setFlag(refs.value, 'hidden', true);
      el.style.setProperty('--pct', '0%');
      el._canDrag = false;
    }

    /* ---- Interaction --------------------------------------------------- */

    _activate(row) {
      if (row.path) {
        this._navigate(row.path);
      } else if (row.kind === 'scene') {
        this._fireScene(row);
      } else if (row.entityId) {
        this.dispatchEvent(
          new CustomEvent('hass-more-info', {
            detail: { entityId: row.entityId },
            bubbles: true,
            composed: true,
          })
        );
      }
    }

    _fireScene(row) {
      if (!this._hass || !isAvailable(this._hass.states[row.entityId])) return;
      this._fired.set(row.entityId, Date.now()); // shows "Just now" before the state arrives
      this._callAll([{ domain: 'scene', service: 'turn_on', data: {}, target: { entity_id: [row.entityId] } }]);
      const el = this._rowEls.get(row.key);
      if (el) {
        el.classList.remove('fired');
        void el.offsetWidth; // restart the animation when tapped twice
        el.classList.add('fired');
      }
      this._updateRows();
    }

    _goBack() {
      const parent = this._crumbs[this._crumbs.length - 2];
      if (parent) this._navigate(parent.path);
    }

    _navigate(path) {
      const from = this._path;
      const hadFocus = !!this.shadowRoot.activeElement;

      // When going up, return focus to the row we came from.
      const goingUp = path.length < from.length && path.every((key, index) => key === from[index]);
      const focusKey = goingUp ? from[path.length] : null;

      this._path = [...path];
      this._render();

      if (!hadFocus) return;
      const el = (focusKey && this._rowEls.get(focusKey)) || this._rowEls.get(this._rows[0] && this._rows[0].key);
      const focusTarget = el ? el._refs.label : this._backEl;
      if (focusTarget && !focusTarget.hidden) focusTarget.focus({ preventScroll: true });
    }

    /**
     * Toggle and show the result at once. A second click while the first is
     * still being applied toggles what is shown, not the not-yet-updated state.
     */
    _toggle(row) {
      if (!this._hass) return;
      const agg = aggregate(row.ids, this._hass.states);
      if (!agg.available.length) return;
      const prev = this._holds.get(row.key);
      const pending = !!prev && prev.phase !== 'editing' && holdActive(prev, agg, Date.now());
      const on = (pending ? assumedOnCount(agg, prev) : agg.on.length) === 0;
      const calls = pending ? callsByDomain(agg.available, on ? 'turn_on' : 'turn_off') : planToggle(agg);
      this._sendHeld(row.key, { on, phase: 'sending', until: Date.now() + HOLD_CAP_MS }, calls);
    }

    /**
     * Show `hold` on the row and send `calls`. The hold ends when the lights
     * report it, the calls fail, or the cap runs out. A newer action replaces
     * the hold, so an older call that finishes later cannot release it.
     */
    _sendHeld(key, hold, calls) {
      this._holds.set(key, hold);
      this._updateRows();
      this._callAll(calls).then((ok) => {
        if (this._holds.get(key) !== hold) return; // superseded by a newer action
        if (ok) hold.phase = 'sent';
        else this._holds.delete(key);
        this._updateRows();
      });
      setTimeout(() => {
        if (this._holds.get(key) === hold) this._updateRows();
      }, HOLD_CAP_MS + 50);
    }

    /** Show the value being set on the row; nothing is sent. */
    _preview(el) {
      const refs = el._refs;
      const value = Number(refs.slider.value);
      this._holds.set(el._row.key, { value, phase: 'editing', until: 0 });
      el.classList.remove('mixed');
      el.style.setProperty('--pct', `${value}%`);
      setAttr(refs.slider, 'aria-valuetext', `${value}%`);
      setText(refs.value, `${value}%`);
      return value;
    }

    /**
     * Send the row's value once (drag released / keyboard idle) and keep
     * showing it until the lights report it, the call fails, or the cap runs
     * out. A newer drag replaces the hold, so an older call that finishes
     * later cannot release or overwrite it.
     */
    _commit(el) {
      clearTimeout(el._commitTimer);
      el._commitTimer = null;
      const key = el._row.key;
      const value = this._preview(el);
      if (!this._hass) {
        this._holds.delete(key);
        return;
      }
      const calls = planBrightness(aggregate(el._row.ids, this._hass.states), value);
      this._sendHeld(key, { value, phase: 'sending', until: Date.now() + HOLD_CAP_MS }, calls);
    }

    /** Resolves to true when every call succeeded. */
    _callAll(calls) {
      const hass = this._hass;
      return Promise.all(
        calls.map((call) =>
          Promise.resolve()
            .then(() => hass.callService(call.domain, call.service, call.data, call.target))
            .then(
              () => true,
              (err) => {
                console.warn(`hierarchical-light-card: ${call.domain}.${call.service} failed`, err);
                return false;
              }
            )
        )
      ).then((results) => results.every(Boolean));
    }
  }

  const EDITOR_STYLES = `
    :host { display: block; }
    [hidden] { display: none !important; }
    .order { margin-top: 24px; }
    .order-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
      font-weight: 500;
    }
    .hint, .note {
      margin: 0 0 8px;
      font-size: 0.875rem;
      color: var(--secondary-text-color, #727272);
    }
    button {
      font: inherit;
      color: inherit;
      background: none;
      border: 0;
      margin: 0;
      padding: 0;
      cursor: pointer;
    }
    button:disabled { cursor: default; opacity: 0.3; }
    button:focus-visible {
      outline: 2px solid var(--primary-color, #03a9f4);
      outline-offset: 1px;
    }
    .reset {
      padding: 4px 10px;
      border-radius: 14px;
      font-size: 0.875rem;
      font-weight: 400;
      color: var(--primary-color, #03a9f4);
    }
    .tree {
      border: 1px solid var(--divider-color, rgba(127, 127, 127, 0.3));
      border-radius: 8px;
      overflow: hidden;
    }
    details > .children { padding-inline-start: 20px; }
    .line {
      display: flex;
      align-items: center;
      gap: 4px;
      min-height: 40px;
      padding: 0 4px 0 12px;
      border-top: 1px solid var(--divider-color, rgba(127, 127, 127, 0.2));
    }
    .tree > :first-child > .line:first-child,
    .tree > .line:first-child { border-top: 0; }
    summary.line { cursor: pointer; list-style: none; }
    summary.line::-webkit-details-marker { display: none; }
    summary.line::before {
      content: "";
      flex: none;
      width: 0;
      height: 0;
      margin-inline-end: 6px;
      border-block: 5px solid transparent;
      border-inline-start: 6px solid currentColor;
      opacity: 0.6;
      transition: transform 0.12s;
    }
    details[open] > summary.line::before { transform: rotate(90deg); }
    .leaf { padding-inline-start: 30px; }
    .show {
      flex: none;
      width: 18px;
      height: 18px;
      margin: 0 8px 0 0;
      accent-color: var(--primary-color, #03a9f4);
      cursor: pointer;
    }
    .line.off .name { color: var(--secondary-text-color, #727272); }
    .line .name {
      flex: 1 1 auto;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .move {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      --mdc-icon-size: 20px;
    }
    .move:not(:disabled):hover { background: rgba(127, 127, 127, 0.15); }
  `;

  const FORM_FIELDS = [
    'title',
    'sort',
    'show_brightness',
    'show_percentage',
    'show_unassigned',
    'show_scenes',
    'include_hidden',
    'switches',
  ];

  /**
   * Card editor: the regular options form plus a floor > room > light tree in
   * which every item can be moved up or down among its siblings. The result
   * is stored in the card configuration (`order`), so Home Assistant saves it
   * with the dashboard for all users.
   */
  class HierarchicalLightCardEditor extends HTMLElement {
    constructor() {
      super();
      this._config = {};
      this._hass = null;
      this._registries = null;
      this._loading = false;
      this._failed = false;
      this._open = new Set(); // keys of expanded floors / rooms
      this._groups = new Map(); // group key -> sibling ids as displayed

      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>${EDITOR_STYLES}</style>
        <div class="form"></div>
        <div class="order">
          <div class="order-head">
            <span>Lights and order</span>
            <button class="reset" type="button">Reset order</button>
          </div>
          <p class="hint">Untick a light or scene to leave it out. Untick a floor, a room or Scenes to skip that level: what is inside it is shown one level up instead. Move items with the arrows; anything you have not moved follows the sort order above.</p>
          <p class="note" hidden></p>
          <div class="tree"></div>
        </div>`;
      this._resetEl = root.querySelector('.reset');
      this._noteEl = root.querySelector('.note');
      this._treeEl = root.querySelector('.tree');

      const form = HierarchicalLightCard.getConfigForm();
      this._form = document.createElement('ha-form');
      this._form.schema = form.schema;
      this._form.computeLabel = form.computeLabel;
      this._form.addEventListener('value-changed', (ev) => {
        ev.stopPropagation();
        this._emit({ ...this._config, ...ev.detail.value });
      });
      root.querySelector('.form').appendChild(this._form);

      this._resetEl.addEventListener('click', () => {
        const { order, ...rest } = this._config;
        this._emit(rest);
      });
      this._treeEl.addEventListener('click', (ev) => this._onTreeClick(ev));
      this._treeEl.addEventListener('change', (ev) => this._onTreeChange(ev));
      // "toggle" does not bubble, so listen in the capture phase.
      this._treeEl.addEventListener(
        'toggle',
        (ev) => {
          const key = ev.target.dataset && ev.target.dataset.key;
          if (!key) return;
          if (ev.target.open) this._open.add(key);
          else this._open.delete(key);
        },
        true
      );
    }

    setConfig(config) {
      const next = { ...(config || {}) };
      // Home Assistant echoes our own change back: nothing to redo.
      if (JSON.stringify(next) === JSON.stringify(this._config)) return;
      this._config = next;
      this._render();
    }

    set hass(hass) {
      const first = !this._hass;
      this._hass = hass;
      this._form.hass = hass;
      if (!hass) return;
      if (!this._registries && !this._loading && !this._failed) {
        this._loading = true;
        fetchRegistries(hass).then((registries) => {
          this._loading = false;
          if (registries) this._registries = registries;
          else this._failed = true;
          this._render();
        });
      }
      if (first) this._render();
    }

    get hass() {
      return this._hass;
    }

    _emit(config) {
      this._config = config;
      this._render();
      this.dispatchEvent(new CustomEvent('config-changed', { detail: { config }, bubbles: true, composed: true }));
    }

    _render() {
      let cfg;
      let invalid = false;
      try {
        cfg = normalizeConfig(this._config);
      } catch (err) {
        cfg = normalizeConfig({});
        invalid = true;
      }
      // Show the effective values, so defaults are not displayed as "off".
      this._form.data = Object.fromEntries(FORM_FIELDS.map((name) => [name, cfg[name]]));

      const hasOrder = cfg.order.floors.length + cfg.order.areas.length + cfg.order.lights.length > 0;
      setFlag(this._resetEl, 'hidden', !hasOrder);

      let note = '';
      if (invalid) note = 'The configuration is not valid; fix it in the code editor first.';
      else if (this._failed) note = 'Could not load the Home Assistant registries.';
      else if (!this._hass || !this._registries) note = 'Loading lights\u2026';
      setFlag(this._noteEl, 'hidden', !note);
      setText(this._noteEl, note);
      setFlag(this._treeEl, 'hidden', !!note);
      if (note) return;

      // Excluded lights stay listed here so they can be ticked again.
      const h = buildHierarchy(this._registries, this._hass.states, { ...cfg, exclude: [] });
      const excluded = new Set(cfg.exclude);
      const skipFloors = new Set(cfg.flatten.floors);
      const skipAreas = new Set(cfg.flatten.areas);
      this._groups.clear();
      // Top-level entries (the floors plus the scenes) in the order they are shown.
      const floorIds = applyOrder(
        [...h.floors.map((f) => ({ id: f.id })), ...(h.scenes.length ? [{ id: SCENES }] : [])],
        cfg.order.floors
      ).map((entry) => entry.id);
      const byId = new Map(); // top-level id -> its nodes
      for (const floor of h.floors) {
        const areaIds = floor.areas.map((a) => a.id);
        const areaNodes = floor.areas.map((area) => {
          const lightIds = area.entities.map((e) => e.id);
          const group = `lights:${floor.id}:${area.id}`;
          const lights = area.entities.map((entity) =>
            this._line('div', entity.name, 'lights', group, lightIds, entity.id, !excluded.has(entity.id))
          );
          const summary = this._line('summary', area.name, 'areas', `areas:${floor.id}`, areaIds, area.id, !skipAreas.has(area.id));
          return this._branch(`a:${floor.id}:${area.id}`, summary, lights);
        });
        if (h.flat) {
          byId.set(floor.id, areaNodes); // no floors in use: rooms are the top level
        } else {
          const summary = this._line('summary', floor.name, 'floors', 'floors', floorIds, floor.id, !skipFloors.has(floor.id));
          byId.set(floor.id, [this._branch(`f:${floor.id}`, summary, areaNodes)]);
        }
      }
      if (h.scenes.length) {
        const sceneIds = h.scenes.map((s) => s.id);
        const lines = h.scenes.map((scene) => {
          const name = scene.area ? `${scene.name} (${scene.area})` : scene.name;
          return this._line('div', name, 'scenes', 'scenes', sceneIds, scene.id, !excluded.has(scene.id));
        });
        const summary = this._line('summary', 'Scenes', 'floors', 'floors', floorIds, SCENES, !skipFloors.has(SCENES));
        byId.set(SCENES, [this._branch('scenes', summary, lines)]);
      }
      const nodes = floorIds.flatMap((id) => byId.get(id) || []);
      if (!nodes.length) {
        setFlag(this._noteEl, 'hidden', false);
        setText(this._noteEl, 'No lights found.');
        setFlag(this._treeEl, 'hidden', true);
      }
      this._treeEl.replaceChildren(...nodes);
    }

    _branch(key, summary, children) {
      const details = document.createElement('details');
      details.dataset.key = key;
      details.open = this._open.has(key);
      const body = document.createElement('div');
      body.className = 'children';
      body.append(...children);
      details.append(summary, body);
      return details;
    }

    _line(tag, name, kind, groupKey, siblingIds, id, checked) {
      this._groups.set(groupKey, siblingIds);
      const index = siblingIds.indexOf(id);
      const line = document.createElement(tag);
      line.className = `line${tag === 'summary' ? '' : ' leaf'}${checked ? '' : ' off'}`;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'show';
      box.checked = checked;
      box.dataset.kind = kind;
      box.dataset.id = id;
      const leaf = kind === 'lights' || kind === 'scenes';
      box.setAttribute('aria-label', leaf ? `Include ${name}` : `Show ${name} as its own level`);
      line.appendChild(box);
      const label = document.createElement('span');
      label.className = 'name';
      label.textContent = name;
      label.title = name;
      line.appendChild(label);
      for (const delta of [-1, 1]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'move';
        button.dataset.kind = kind;
        button.dataset.group = groupKey;
        button.dataset.id = id;
        button.dataset.delta = String(delta);
        button.disabled = delta < 0 ? index === 0 : index === siblingIds.length - 1;
        button.setAttribute('aria-label', `Move ${name} ${delta < 0 ? 'up' : 'down'}`);
        const icon = document.createElement('ha-icon');
        icon.setAttribute('icon', delta < 0 ? 'mdi:arrow-up' : 'mdi:arrow-down');
        button.appendChild(icon);
        line.appendChild(button);
      }
      return line;
    }

    /** Tick box: include a light, or show a floor / room as its own level. */
    _onTreeChange(ev) {
      const box = ev.target;
      if (!box || !box.classList || !box.classList.contains('show')) return;
      const { kind, id } = box.dataset;
      const toggled = (list) => {
        const rest = toList(list).map(String).filter((other) => other !== id);
        return box.checked ? rest : [...rest, id];
      };
      const config = { ...this._config };
      if (kind === 'lights' || kind === 'scenes') {
        config.exclude = toggled(config.exclude);
        if (!config.exclude.length) delete config.exclude;
      } else {
        const current = config.flatten && typeof config.flatten === 'object' ? config.flatten : {};
        const flatten = { ...current, [kind]: toggled(current[kind]) };
        if (toList(flatten.floors).length + toList(flatten.areas).length) config.flatten = flatten;
        else delete config.flatten;
      }
      this._emit(config);
      const again = [...this._treeEl.querySelectorAll('input.show')].find(
        (b) => b.dataset.kind === kind && b.dataset.id === id
      );
      if (again) again.focus();
    }

    _onTreeClick(ev) {
      const button = ev.target.closest('button.move');
      if (!button) return;
      ev.preventDefault(); // do not expand / collapse the row the button sits in
      const { kind, group, id } = button.dataset;
      const delta = Number(button.dataset.delta);
      const siblings = this._groups.get(group);
      if (button.disabled || !siblings) return;

      const current = this._config.order && typeof this._config.order === 'object' ? this._config.order : {};
      const list = moveInOrder(siblings, toList(current[kind]).map(String), id, delta);
      this._emit({ ...this._config, order: { ...current, [kind]: list } });

      // The tree was rebuilt: put the focus back on the item that moved.
      const moved = [...this._treeEl.querySelectorAll('button.move')].filter(
        (b) => b.dataset.kind === kind && b.dataset.id === id
      );
      const target = moved.find((b) => Number(b.dataset.delta) === delta && !b.disabled) || moved.find((b) => !b.disabled);
      if (target) target.focus();
    }
  }

  if (!customElements.get('hierarchical-light-card-editor')) {
    customElements.define('hierarchical-light-card-editor', HierarchicalLightCardEditor);
  }

  if (!customElements.get('hierarchical-light-card')) {
    customElements.define('hierarchical-light-card', HierarchicalLightCard);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === 'hierarchical-light-card')) {
    window.customCards.push({
      type: 'hierarchical-light-card',
      name: 'Hierarchical Light Card',
      description: 'Auto-discovered lights, navigable by floor, room and light.',
      preview: false,
    });
  }

  console.info(`%c HIERARCHICAL-LIGHT-CARD %c v${VERSION} `, 'color:#fff;background:#f9a825', 'color:#f9a825;background:#333');
}
