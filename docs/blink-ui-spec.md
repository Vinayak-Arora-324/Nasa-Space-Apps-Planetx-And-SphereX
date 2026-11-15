# Blink — sky viewer UI specification

A handoff document for building this interface into an existing front end. It describes a working design prototype: what the user sees, how it behaves, the exact visual values, and what the real data layer must supply.

**Read this first:** the prototype uses a *simulated* sky. Every star, moving object, speed and timestamp in it is generated. Sections 9 and 10 say which parts are stand-ins and what real data must replace them. Nothing here has been validated against real SPHEREx data.

---

## 1. What it is

A full-window viewer for survey sky images (SPHEREx first, other missions later). It has two connected views:

1. **Sphere view** — the user is inside the whole sky, looks around, and picks a spot.
2. **Patch view** — one small flat patch of sky, played over time like a video so that moving objects (asteroids, comets) stand out against fixed stars.

The sphere is for *finding* a place. The patch is for *watching* it change. Time playback and mover detection exist only in the patch view.

### Design principles

- **The sky is the interface.** On load, nothing is visible but the sky. Controls appear on interaction and fade away when idle.
- **Controls blend in.** No opaque panels or cards. Translucent text and hairline outlines sit directly on the image.
- **Plain language first.** A non-technical visitor sees only Coordinates and Mission. Anything specialist is behind "Advanced options".
- **Not a slideshow.** Frames are aligned to the same stars and cross-faded, so the patch reads as one continuous clip.

---

## 2. Visual tokens

### Colour

| Role | Value |
|---|---|
| Ground (page and sky background) | `#05070B` |
| Primary text | `#E9E6DF` |
| Secondary text | `rgba(233,230,223,0.78)` |
| Section labels | `rgba(233,230,223,0.72)` |
| Control text (unselected) | `rgba(233,230,223,0.86)` |
| Control fill (unselected) | `rgba(5,7,11,0.35)` |
| Control border (unselected) | `rgba(233,230,223,0.2)` |
| Selected control fill and border | `rgba(233,230,223,0.92)` with text `#0A0C10` |
| Accent (movers, primary action, current frame) | `#F2B84B` |
| Error text | `#FFB4A2` |
| Difference-mode background | `#171A20` |

The accent is the only saturated colour in the UI. Alternatives offered in the prototype: `#7FD6C2`, `#FF8F6B`, `#C9B6FF`.

### Type

| Use | Family | Details |
|---|---|---|
| Wordmark "Blink" | Cormorant Garamond 500 | 30px, line-height 1 |
| UI text | Inter 400/500/600 | 14px base, 13px for notes |
| Coordinates, numbers, band labels | IBM Plex Mono 400/500 | 12–14px |
| Section labels | Inter 600 | 11px, uppercase, letter-spacing 0.12em |

Fallbacks: Georgia for the serif, system-ui for Inter, ui-monospace for the mono.

### Shape and spacing

- Inputs and rectangular buttons: 6px radius, 44px tall.
- Pill buttons (presets, modes, speeds, toggles): 999px radius, 34–44px tall.
- Round icon buttons: 44–48px.
- Page side padding: `clamp(16px, 3vw, 36px)`.
- All interactive targets are at least 44px tall, except preset pills (34px) and band chips (38px).
- Focus ring: `2px solid #F2B84B`, offset 2px.

---

## 3. Layout

One root element, `height: 100vh` (min 560px), `overflow: hidden`.

```
┌──────────────────────────────────────────────────────────────┐
│ Blink                                   centre coords · width │  header: one read-out line,
│                                                               │  the rest on hover / focus
│                                                               │
│                     full-bleed sky canvas                     │
│                                                               │
│               ┌──────── one panel at a time ────────┐         │  sheet (only when opened):
│               │ Coordinates  or  Turn back the sky   │         │  coordinates + advanced, or
│               └──────────────────────────────────────┘         │  the rewind form
│   ╭──────────────────────────────────────────────────────╮    │
│   │ Find an object…  −  +  Open the centre  Coordinates  │    │  bar (bottom centre)
│   │                               Turn back the sky       │    │
│   ╰──────────────────────────────────────────────────────╯    │
└──────────────────────────────────────────────────────────────┘
```

The bar changes with the view: the sphere bar above; in a rewind, "Change date or place · Back to tonight · Back to
the whole sky"; in a patch, the playback controls with a "Coordinates & options" button.

- **Canvas:** absolutely positioned, fills the root, `object-fit: cover`. Internal resolution 1600×1000 in the prototype; a real build should match device pixels.
- **UI layer:** absolutely positioned over the canvas, `pointer-events: none` on the layer itself so the sky stays interactive in empty areas.
- **Scrim:** only a short top gradient behind the header. The bar and sheet carry their own frosted, blurred background, so the rest of the sky is not darkened.
- **Header:** top, wordmark left, one right-aligned mono line (centre coordinates) on the right; the other read-outs appear on hover or focus. In a patch the header stays on screen (with the cursor position) while the rest of the UI is hidden.
- **Dock:** a column at the bottom centre: the sheet (at most one panel, scrolling inside itself) above the bar. On a phone both span the width and the sheet is capped at 62% of the height.

---

## 4. Opening sequence and idle behaviour

### Load

1. The canvas starts fully covered by a ground-colour veil and fades in over about 3.3 seconds (veil opacity eased with smoothstep).
2. At the same time the canvas scales from 1.08 to 1.0 over 4.5s, `cubic-bezier(0.2, 0.6, 0.2, 1)`.
3. The sphere view is already live and drifting slowly (right ascension increases about 1.1° per second) until the user first interacts.
4. All controls are at opacity 0.

### Revealing controls

The sky comes first: looking around never brings the controls up.

- Moving the mouse within 150px of the bottom edge or 80px of the top edge, or over a control, reveals the UI. Moving it over the rest of the sky does not.
- A tap on the sky while the UI is hidden reveals it, as does a mouse click on the sky during the opening drift or in a rewind.
- Any key press reveals the UI, except the look-around keys (arrows, `+`, `-`) on the sky. `H` toggles the controls (outside text fields).
- Interaction during the first part of the load fade is ignored, so the opening stays clean.
- While hidden, controls have `pointer-events: none` but remain keyboard-focusable; focusing one reveals the UI.
- A one-line hint above the bar ("Drag to look around · scroll to zoom · click a spot to open it · H hides the controls") shows until the sky is first dragged or scrolled, and is remembered per browser.

### Hiding controls

- Dragging (6px or more) or scrolling on the sky hides the UI at once. So do flying to a patch, leaving one, and starting a rewind.
- Otherwise, after 3.5 seconds without interaction the UI fades out. The timer does not fire while the pointer is over the controls, focus is inside them, during a drag, or while a panel is open.

### Panels

- "Coordinates" and "Turn back the sky" each open a panel above the bar; opening one closes the other. The × button, Escape (with focus in the panel) or a click on the sky closes it. A click that closes a panel does not also navigate.

### Other rules tied to visibility

- The centre crosshair and the sphere's place markers draw only while the UI is visible.
- With a mouse, a click on the sky flies there even while the UI is hidden (after the opening drift has stopped). A touch on the sky while the UI is hidden only reveals the UI.
- With `prefers-reduced-motion`: no fade, no scale, no drift, playback starts paused.

---

## 5. Sphere view

### Camera

- State: centre right ascension, centre declination, horizontal field of view.
- Starts at RA 285°, Dec −8°, field of view 85° (Milky Way in frame).
- Field of view range 3.5°–100°.
- Projection is perspective from the sphere's centre (gnomonic). East is to the left, north is up.

### Interaction

| Input | Result |
|---|---|
| Drag | Turn the view; the sky follows the pointer. Declination clamps at ±89°. |
| Scroll | Zoom, `fov *= exp(deltaY * 0.0015)`. |
| Zoom in past 4.5° | Automatically fly into the patch at the centre. |
| Click (movement under 6px) | Fly to that spot and open its patch. |
| Zoom buttons | Animate field of view ×0.55 (in) or ×1.8 (out) over 0.45s. |
| "Open the patch at the centre" | Fly into the current centre. |

All input is ignored while a fly animation is running. Cursor is `grab`.

### Content

- Stars as soft glows, tinted by the selected band.
- A Milky Way band of diffuse haze along the galactic plane.
- Below a 24° field of view, additional faint stars fade in so the sky fills out as the user zooms.
- Place markers with labels (visible with UI only): the four presets. The two ecliptic poles get an accent ring about 3.5° in radius, labelled "deep field", standing in for "regions with enough repeat observations to be worth playing".

### Dock (right block)

- A search box ("Find an object…"). Focusing it lists the preset places; typing filters them and offers "Look up “…”" for any other name, resolved as in the coordinates form.
- Zoom out button, zoom in button, the accent-outlined "Open the centre" (the only accent control in the bar), and quiet "Coordinates" and "Turn back the sky" buttons that open their panels.

---

## 6. Patch view

A flat image of one field, aligned across all frames. Cursor is `crosshair`.

### Playback

- 24 frames in the prototype.
- Base speed 4 frames per second, multiplied by the speed setting (0.5×, 1×, 2×).
- After the last frame, hold for 0.6 of a frame, then loop.
- Playback time is continuous (fractional), which is what makes Video mode smooth.

### Dock (right block)

1. **Play/pause** — 48px round button.
2. **Frame strip** — one button per frame, each 44px tall with a thin bar inside. Current frame: 16px bar in accent. Past frames: 6px bar at 55% white. Future frames: 6px at 22% white. Clicking a frame jumps to it and pauses.
3. Below the strip: "Frame 07 / 24" on the left, elapsed time "T + 9.0 h" on the right.
4. **View mode** pills: Video, Blink, Difference, Trails.
5. **Speed** pills: 0.5×, 1×, 2×.
6. **"Ring the movers"** toggle (becomes "Movers ringed", accent-coloured, when on).
7. **"Back to the whole sky"** button.
8. One line of plain-language explanation for the current mode (copy in section 6.1).

### 6.1 View modes

| Mode | Rendering | Explanation shown to the user |
|---|---|---|
| **Video** | Aligned frames cross-faded; mover positions interpolated between frames. | "Every frame is lined up on the same stars, so the sky plays as one clip. The stars hold still; anything that slides is moving." |
| **Blink** | Hard cut between whole frames, no interpolation. | "Hard cuts between frames. A moving object jumps while everything else stays put." |
| **Difference** | Each frame minus the previous one on a mid-grey ground. Fixed stars leave faint residuals; a mover shows a bright spot at its current position and a dark spot at its previous one. | "Each frame minus the one before it. Fixed stars cancel to grey; a mover leaves a bright spot where it is and a dark one where it was." |
| **Trails** | All frames up to now stacked; each mover's past positions stay visible, joined by a thin line. | "Frames stacked as they play. Fixed stars stay points; a mover draws a line." |

### 6.2 Mover markers

- Off by default.
- When on: a 20px-radius accent ring around each mover, with a mono label "M1", "M2"… offset up and right.
- A mover selected in the Advanced list is ringed with a thicker stroke even when the toggle is off.

### 6.3 Other patch interactions

- **Click the sky:** re-centre on that point. The new patch fades in from the veil (about 1.1s), with no fly animation.
- **Scroll out:** return to the sphere.
- **Changing patch width:** rebuilds the patch in place with the same fade.

---

## 7. Moving between the two views

### Fly to a target (from either view)

Triggered by a sphere click, a preset, the coordinates form, or zooming past the threshold.

- Duration: `2.4s + min(2.2, separation° / 50)`, plus 0.8s if starting from a patch.
- Three phases over progress `p` from 0 to 1, each eased with smoothstep:
  1. **0–0.3, pull back:** field of view widens to `max(current, min(70°, separation × 0.8))` (at least 8° when leaving a patch). If starting in a patch, it cross-fades out to the sphere.
  2. **0.3–0.7, travel:** centre moves to the target by the shortest route in right ascension.
  3. **0.7–1.0, arrive:** field of view narrows to the chosen patch width. The patch cross-fades in over the last 18% (`p` 0.82–1.0).
- Field of view always interpolates logarithmically.
- The UI switches to patch controls at the start of the flight, and the coordinate inputs update to the target.

### Leave a patch

- Duration 2.2s. Field of view widens from the patch width to 55°. The patch cross-fades out over the first 40%.

---

## 8. Left column controls

### Coordinates (in the Coordinates panel)

- **Right ascension** text input. Accepts decimal degrees (`270.0`) or sexagesimal hours (`18:00:00`, `18h 00m 00s`). Valid range 0 ≤ RA < 360°.
- **Declination** text input. Accepts decimal degrees (`+66.56`) or sexagesimal degrees. Valid range −90° to +90°.
- **Patch width** select: 0.25°, 0.5°, 1° (default), 2°, 3.5°.
- **"Fly to this patch"** submit button, accent outline. Enter in either field submits.
- Error messages, shown under the form with `role="alert"`:
  - "Right ascension should be 0–360° or 00:00:00–23:59:59."
  - "Declination should be between −90° and +90°."
- **Preset pills:**

| Label | RA (°) | Dec (°) |
|---|---|---|
| North Ecliptic Pole | 270.0 | +66.56 |
| South Ecliptic Pole | 90.0 | −66.56 |
| Orion Nebula | 83.82 | −5.39 |
| Galactic Centre | 266.417 | −29.008 |

### Mission

Single-select buttons: SPHEREx (default), NEOWISE, ZTF. Changing mission resets the band to that mission's first band. NEOWISE and ZTF are examples of how further missions slot in, not a commitment to those surveys.

### Advanced options (collapsed by default)

A native disclosure (`<details>`), with a chevron that rotates when open.

- **Wavelength band** — "Which colour of light the picture is taken in. Different bands make different objects stand out." Single-select chips:
  - SPHEREx: 0.75–1.11, 1.11–1.64, 1.64–2.42, 2.42–3.82, 3.82–4.42, 4.42–5.00 µm
  - NEOWISE: W1 · 3.4 µm, W2 · 4.6 µm
  - ZTF: g, r, i
- **Moving objects found** (patch view only) — "Things that change position between frames, such as asteroids. Each row shows how fast it moves and in which direction. Select one to keep it ringed." A count in accent, then one row per mover: name (`M1`), rate in arcseconds per hour, and direction as position angle (`PA 134°`, measured from north through east). Clicking a row selects or deselects it.

### Header read-outs (top right, mono 12px)

1. Centre coordinates and width: `18h 00m 00.0s  +66° 33′ 36″  ·  1°`. In the sphere view this tracks the camera, updated at most five times a second.
2. Mission and band.
3. Coordinates under the cursor, or a hint when there are none ("Drag to look around" / "Click the sky to re-centre").
4. "SIMULATED IMAGERY" — remove once real data is wired in.

---

## 9. What the real data layer must supply

The prototype generates everything. A real build needs these, per mission:

**For the sphere**

- A multi-resolution all-sky tile source (HiPS is the astronomy standard). A single texture cannot hold the whole sky at survey resolution.
- A coverage map: which regions have enough repeat observations to play. This replaces the two hard-coded "deep field" rings.

**For a patch** — given centre RA, Dec, width, mission and band:

- An ordered list of frames, each with an image and a real observation timestamp.
- All frames resampled onto one common pixel grid centred on the request. Alignment is the whole basis of the mover modes; without it, everything appears to move.
- The actual pixel scale and orientation, so cursor coordinates are correct.
- Optionally, a list of detected or known movers with a position per frame, to drive the rings, labels, rates and directions.

**Things the prototype assumes that real data will break**

- **Even cadence.** The prototype shows `T + n × 1.5 h`. Real frames will be unevenly spaced and often few. The frame strip and time label should use real timestamps, and playback should cope with as few as two frames, or one.
- **Fixed frame count of 24.**
- **Empty results.** There is no "no data for this patch" or loading state yet. Both are needed.
- **Difference and Trails are drawn, not computed.** The prototype paints the expected result. A real build must subtract and stack actual pixels.

---

## 10. Stand-ins to replace

| Prototype | Real build |
|---|---|
| Sphere drawn in a 2D canvas with hand-written perspective maths | Aladin Lite (already does sphere navigation over HiPS) or a WebGL library |
| Sphere stars and patch stars generated separately, so they don't match | One data source for both, so the fly-in lands on the same stars |
| Movers invented per patch, moving in straight lines | Real detections or catalogue positions |
| Band changes only tint the image | Load the actual band's images |
| Mission changes only alter star blur | Load that mission's data |
| Canvas at a fixed 1600×1000, stretched to cover | Render at device resolution |

---

## 11. Accessibility

- All controls are real `<button>`, `<input>`, `<select>`, `<label>` elements; toggles and single-select groups use `aria-pressed`.
- Icon-only buttons have `aria-label` (Play/Pause, Zoom in, Zoom out, "Go to frame n").
- The canvas has `role="img"` and a label describing the current view, centre and width.
- Every navigation action has a non-pointer route: the coordinates form, presets, zoom buttons, "Open the patch at the centre", and "Back to the whole sky".
- No global keyboard handlers.
- Text over the sky relies on the bottom scrim and a dark text-shadow for contrast; check this again against real, brighter imagery.

**Not yet handled:** pinch-to-zoom on touch screens, and keyboard panning of the sphere.

---

## 12. Suggested component breakdown

Adapt to whatever framework the existing front end uses.

- `SkyViewer` — root; owns view (`sphere` | `patch`), UI visibility, and the idle timer.
- `SkyCanvas` — rendering and pointer input; delegates to a sphere renderer or a patch renderer, and cross-fades between them using a single `mix` value from 0 (sphere) to 1 (patch).
- `FlyController` — the camera animations in section 7.
- `CoordinateForm` — parsing, validation, presets.
- `MissionPicker`, `AdvancedOptions` (`BandPicker`, `MoverList`).
- `SphereDock` and `PlaybackDock` (`FrameStrip`, `ModePicker`, `SpeedPicker`, `MarkerToggle`).
- `HeaderReadout`.

### State summary

| State | Values | Default |
|---|---|---|
| view | sphere, patch | sphere |
| UI visible | boolean | false |
| camera | RA, Dec, field of view | 285°, −8°, 85° |
| patch | RA, Dec, width | — |
| patch width | 0.25, 0.5, 1, 2, 3.5 | 1 |
| mission | spherex, neowise, ztf | spherex |
| band | index into the mission's bands | second SPHEREx band |
| mode | video, blink, diff, trail | video |
| playing | boolean | true |
| speed | 0.5, 1, 2 | 1 |
| frame | 0 to frame count − 1 | 0 |
| markers on | boolean | false |
| selected mover | index or none | none |

---

## 13. Acceptance checklist

- [ ] On load, only the sky is visible; it fades in and is already moving.
- [ ] Controls appear near the edges, on a tap, key press or focus; dragging or scrolling the sky hides them at once; they fade after idle unless hovered, focused or a panel is open.
- [ ] Drag turns the sphere; scroll zooms; clicking a spot flies in and opens its patch.
- [ ] Entering valid coordinates flies to them from either view; invalid input shows the right message.
- [ ] In a patch, fixed stars stay still across frames in all four modes.
- [ ] Each mode matches its description in section 6.1.
- [ ] "Ring the movers" and selecting a mover both ring the right object.
- [ ] "Back to the whole sky" and scrolling out both return to the sphere at the same location.
- [ ] Layout holds at phone width: dock stacks and scrolls, nothing overflows sideways.
- [ ] Reduced-motion users get no fade, drift or autoplay.
- [ ] Empty and loading states exist for patches with no data.
