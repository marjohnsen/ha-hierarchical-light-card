# Hierarchical Light Card

A [Home Assistant](https://www.home-assistant.io/) dashboard card that shows every light in your home as a hierarchy: **floors → rooms → lights**.

A home with many lights does not fit in a flat list. Dashboards grow into a pile of entity lists, light groups and per-room cards that you maintain by hand. This card uses the hierarchy Home Assistant already has: your floors and areas. You start with a few floors, drill down to a room, then to a single light, and you can toggle or dim at every level. One card covers the whole home, however many lights it has.

```yaml
type: custom:hierarchical-light-card
```

## Features

- **Hierarchical navigation.** Tap a floor to see its rooms and a room to see its lights. A back header shows where you are.
- **Control at every level.** A floor or room row toggles and dims every light below it, and shows how many are on and their brightness.
- **Automatic discovery.** The hierarchy is built from your Home Assistant floors and areas. Add, rename or move a light and the card follows.
- **Scenes.** A Scenes row lists every scene with its room and when it was last activated.
- **Adjustable hierarchy.** In the visual editor you can reorder items, hide lights and skip a floor or room level, without writing YAML.
- **No dependencies.** One JavaScript file, no build step.

## Installation

### HACS

1. Open HACS → ⋮ → **Custom repositories**.
2. Add this repository's URL with type **Dashboard**.
3. Install **Hierarchical Light Card** and reload the browser.

On Home Assistant 2026.11 or newer you can instead open Settings → Marketplace → **Add from link**, enter the repository URL and choose type **Dashboard**.

### Manual

1. Copy `dist/hierarchical-light-card.js` to `<config>/www/`.
2. Open Settings → Dashboards → ⋮ → **Resources** and add `/local/hierarchical-light-card.js` as a **JavaScript module**.
3. Reload the browser.

When you update the file, change the resource URL (for example, add `?v=2`) so the browser loads the new copy.

## Usage

Add the card from the dashboard's card picker, or in YAML with `type: custom:hierarchical-light-card`. It needs no configuration.

Each row has three controls:

| Action | Result |
| --- | --- |
| Tap the bulb | Toggle the light, the room or the whole floor |
| Drag the row sideways | Set the brightness; the bar behind the row shows the level |
| Tap the row | Go one level deeper, or open the light's more-info dialog |

Tapping the bulb of a room or floor turns off the lights that are on; if none are on, it turns them all on. Dragging sets every dimmable light in it to the same level. The command is sent once, when you release.

When the lights that are on in a room or floor are at different levels, the bar fades out and the row shows their range, such as `20–80%`.

Tap a scene to activate it.

## Configuration

All options are optional. Set them in the visual editor or in YAML.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `title` | string | *(none)* | Header text at the top level |
| `sort` | string | `name` | `name`, `level` (floors by level, the rest by name) or `none` (registry order) |
| `show_brightness` | boolean | `true` | Enable dimming |
| `show_percentage` | boolean | `true` | Show the brightness or On/Off column |
| `show_unassigned` | boolean | `true` | Show lights without a room and rooms without a floor |
| `show_scenes` | boolean | `true` | Show the Scenes row |
| `include_hidden` | boolean | `false` | Include entities hidden in Home Assistant |
| `switches` | list | `[]` | `switch.*` entities to show as on/off lights |
| `exclude` | list | `[]` | Lights and scenes to leave out |
| `flatten` | object | *(none)* | Floors and rooms to skip as a level: lists `floors` and `areas` |
| `order` | object | *(none)* | Custom order: lists `floors`, `areas`, `lights` and `scenes` |

The visual editor writes `exclude`, `flatten` and `order` for you. Untick a light or scene to exclude it. Untick a floor or room to flatten it, so its content appears one level up. Use the arrows to reorder; items you have not moved follow `sort`.

### Example

```yaml
type: custom:hierarchical-light-card
title: Lights
sort: level
switches:
  - switch.reading_lamp
exclude:
  - light.server_rack
flatten:
  areas:
    - outside
```

### Theming

The brightness bar uses the theme variable `--state-light-active-color`. Scene colours can be set with `--hlc-mood-yellow`, `--hlc-mood-red` and `--hlc-mood-purple`.

## Limitations

- Floors require Home Assistant 2024.4 or newer. Older versions start at room level.
- Only floors and rooms that contain lights are listed.
- Hue room and zone groups are listed as lights, but are left out of a room's or floor's total when it contains other lights.
- The card's own texts are in English.

## Development

The card is a single file, `dist/hierarchical-light-card.js`. Run the tests with Node 20 or newer:

```sh
npm test
```

The tests cover the logic, not rendering or touch handling.

## License

MIT

