# UI Typography System Plan

## Purpose

H-Gripe Studio needs a clear typography contract before the UI is restyled.

The goal is not to copy a portfolio website. The goal is to borrow the same
high-end feeling:

- soft geometric Latin typography
- clean Chinese fallback
- restrained dark UI
- strong hierarchy without heavy borders
- English technical terms kept readable inside Chinese UI

## Core Decision

Use a mixed font stack instead of forcing one font to do everything.

Recommended stack:

```css
:root {
  --font-ui: "Satoshi", "MiSans", "Noto Sans SC", sans-serif;
  --font-display: "Satoshi", "MiSans", "Noto Sans SC", sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Code", monospace;
}
```

Why:

- `Satoshi` gives English UI labels, product terms, headings, and node names a
  soft modern feel.
- `MiSans` gives Chinese UI text a similar rounded, modern weight.
- `Noto Sans SC` is the stable open fallback for missing Chinese glyphs.
- `JetBrains Mono` / `Cascadia Code` keeps logs, paths, IDs, JSON, and FFmpeg
  commands readable.

Do not use `ClashDisplay` as the main UI font. It can be considered later for
brand-only surfaces, but it is not suitable for dense production UI or Chinese
fallback.

## Mixed Chinese / English Is Expected

H-Gripe will always contain mixed labels:

```text
节点画布
Smart Layer Split
FFmpeg Export
GPU Device Report
PSD Layer
Timeline Clip
```

This is not a problem if the font stack is ordered correctly:

```css
font-family: "Satoshi", "MiSans", "Noto Sans SC", sans-serif;
```

Browser/WebView shaping will use:

- Satoshi for Latin glyphs.
- MiSans for Chinese glyphs.
- Noto Sans SC when MiSans does not cover a glyph.

The product should not translate every technical term into Chinese just to make
the UI look uniform. Terms such as `PSD`, `FFmpeg`, `GPU`, `Timeline`, `Grade`,
`Layer`, `Smart Layer Split`, and `Render Plan` can remain English when that is
clearer for production users.

## Font Licensing

### Satoshi

Source: Fontshare / Indian Type Foundry.

Expected use:

- English UI text.
- Node names.
- Technical labels.
- Short headings.

License direction:

- Free for personal and commercial use under Fontshare / ITF Free Font License.
- Treat as a closed-source third-party font, not an open font to modify or
  resell.
- If bundled, keep license/notice text with the app.

### MiSans

Source: Xiaomi / HyperOS font distribution.

Expected use:

- Chinese UI fallback.
- Mixed Chinese/English app text.
- Dense production panels.

License direction:

- Official distribution allows commercial work use, but the app should keep the
  original license notice and avoid redistributing modified font files.
- Use only the official font package.

### Noto Sans SC

Source: Google Noto / SIL Open Font License.

Expected use:

- Safe CJK fallback.
- Missing glyph fallback.
- Legal safety fallback if MiSans packaging is not ready.

License direction:

- OFL-licensed and safe for commercial use.

## Font Asset Rules

If fonts are bundled into the app:

- Put font files under a dedicated asset directory, for example:

```text
apps/desktop-tauri/studio-ui/src/assets/fonts/
```

- Add or update third-party notices:

```text
THIRD_PARTY_NOTICES.md
```

- Keep each font's license file or official notice.
- Do not rename font families to make them look first-party.
- Do not edit, subset, or repackage font files until licensing and build needs
  are reviewed.

If packaging risk is a concern, start with CSS fallback names first and add
bundled files in a later PR.

## UI Usage Rules

### Global UI

Use `--font-ui`.

Targets:

- app shell
- node canvas
- node cards
- panels
- buttons
- inputs
- menus
- tabs
- drawer UI
- modals

Default:

```css
body {
  font-family: var(--font-ui);
  font-size: 14px;
  line-height: 1.4;
  letter-spacing: 0;
}
```

### Display / Brand

Use `--font-display` only for controlled, short text:

- app logo
- welcome / empty state headings
- major section titles
- large node family labels if needed

Suggested range:

```css
.display-title {
  font-family: var(--font-display);
  font-weight: 600;
  letter-spacing: 0;
  line-height: 1;
}
```

Avoid negative letter spacing. It can look good in a portfolio hero, but it is
fragile in a bilingual desktop tool.

### Technical / Code Text

Use `--font-mono`.

Targets:

- paths
- JSON
- IDs
- command output
- FFmpeg logs
- device reports
- small code-like tokens

```css
.mono,
code,
pre {
  font-family: var(--font-mono);
}
```

### Node Cards

Node cards should stay compact and readable:

- node title: `13-14px`, `font-weight: 600`
- node family / badge: `11-12px`, `font-weight: 600`
- parameter label: `12px`, `font-weight: 500`
- parameter value: `12-13px`, `font-weight: 400`
- output/status text: `11-12px`

Do not make node card text hero-sized. The Satoshi/MiSans style should make the
cards feel cleaner, not bigger.

### Bottom Production Drawer

The drawer is a production surface, not a landing page.

Recommended:

- tab label: `13px`, `font-weight: 600`
- clip label: `12px`, `font-weight: 500`
- timeline timecode: mono, `11-12px`
- inspector labels: `12px`
- inspector values: `12-13px`

### Image / PSD Editor

Photoshop-style muscle memory matters more than decorative type.

Recommended:

- toolbar tooltips and labels: `12px`
- panel title: `12-13px`, `font-weight: 600`
- layer name: `12-13px`, `font-weight: 500`
- property values: `12px`

Use the same `--font-ui` stack. Do not introduce a separate "Photoshop font".

## Dark Theme Tokens

The reference feel comes from restrained contrast, not gradients.

Suggested starting tokens:

```css
:root {
  --bg-app: #0b0b0d;
  --bg-panel: #111116;
  --bg-panel-2: #191920;
  --border-soft: #27272a;

  --text-main: #f6f7ff;
  --text-muted: #c0c0cf;
  --text-dim: #7f7f8f;

  --accent: #b5ff6d;
}
```

Usage:

- `--text-main` only for primary labels and selected states.
- `--text-muted` for most UI text.
- `--text-dim` for secondary hints.
- `--accent` for selection dots, active status, running state, key affordances.

Do not flood the UI with accent green. Use it as a signal, not as decoration.

## Implementation Order

### Phase 1: Token Contract Only

Goal: define font variables and fallback order.

Tasks:

- Add `--font-ui`, `--font-display`, `--font-mono` CSS variables.
- Set body font to `--font-ui`.
- Set code/log/path surfaces to `--font-mono`.
- Do not redesign layout yet.
- Do not import bundled font files yet if licensing/package placement is still
  under review.

### Phase 2: Bundle Fonts

Goal: make the app render consistently offline.

Tasks:

- Add official Satoshi files.
- Add official MiSans files if license/notice is ready.
- Add Noto Sans SC only if needed for stable fallback coverage.
- Add license notices.
- Use `@font-face` with `font-display: swap`.

Suggested CSS:

```css
@font-face {
  font-family: "Satoshi";
  src: url("./assets/fonts/Satoshi-Variable.woff2") format("woff2");
  font-display: swap;
}

@font-face {
  font-family: "MiSans";
  src: url("./assets/fonts/MiSans-Regular.woff2") format("woff2");
  font-display: swap;
}
```

### Phase 3: Component Polish

Goal: apply type scale without changing product layout.

Targets:

- app shell
- top toolbar
- node cards
- context menus
- bottom drawer
- modal headers
- timeline labels
- layer list

Do not use oversized hero typography inside dense tool panels.

### Phase 4: Visual QA

Check:

- Chinese-only labels.
- English-only technical terms.
- mixed labels such as `导出 FFmpeg Render Plan`.
- long node names.
- long file paths.
- compact buttons.
- high DPI scaling.
- Windows font fallback behavior.

## Non-Goals

- Do not build a landing-page hero style into the app shell.
- Do not make all UI text large.
- Do not use negative letter spacing.
- Do not use accent green as a large background fill.
- Do not replace mono logs with Satoshi.
- Do not reintroduce multiple unrelated font stacks per panel.

## Success Criteria

- English technical terms look as polished as the reference style.
- Chinese UI text does not fall back to random system fonts.
- Mixed Chinese/English labels feel intentional.
- Dense production panels remain readable.
- Node cards look more refined without growing in size.
- Font licensing and notices are clear before bundled fonts ship.
