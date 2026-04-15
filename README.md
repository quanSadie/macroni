# Macroni

**Live**: https://quansadie.github.io/macroni/

Calorie & macro tracker PWA. Runs offline, installs to the home screen, stores everything in `localStorage`. Bilingual (EN / VI).

## Why

Most calorie trackers reset every day — eat 500 over today, tomorrow starts fresh. No consequence, no reward, so users disengage in days.

Macroni applies a **one-directional carry-over**: over-eating creates debt that reduces tomorrow's budget. Under-eating *does not* create credit. Every day matters.

## Features

### Discipline (the core)

- **One-directional debt carry-over**: `D_next = max(0, D + (net − baseBudget))`. Over-eat → tomorrow shrinks. Under-eat → debt pays down (clamped at zero).
- **Skip penalty**: planning a workout and skipping it costs −150 kcal off tomorrow per skipped item.
- **Missed-log penalty**: a day with no logs auto-fills as `baseBudget + 200 kcal` — you don't get to forget for free.
- **12-hour log lock**: can't edit or delete logs after 12 h. No retroactive prettying-up.
- **Weekly reckoning**: if last 7 days net positive vs baseBudget, every day next week loses 50 kcal. Needs ≥4 logged days in the prior week to fire.
- **BMR floor**: displayed budget never drops below your BMR — eating below BMR is unsafe.
- **Manual debt reset**: escape hatch when accumulated debt becomes unrealistic. Two-step confirm (`confirm()` + typing `RESET`). Every reset is logged permanently in Settings.

### Goal-based planning

You don't pick a deficit. Enter target weight + timeframe; the app derives daily deficit, daily budget, and weekly rate. Live feedback classifies the plan as **sustainable / aggressive / unhealthy**, with explicit warnings for sub-BMR budgets or rates above 1 kg/week.

On every weigh-in, the deficit recomputes against the new weight + remaining time — falling behind schedule shifts you into a more aggressive bracket and surfaces a warning.

### Food

- USDA FoodData Central search built in (CORS-friendly). Pick → form auto-fills with kcal + protein/carbs/fat per 100 g. Change grams → everything rescales.
- Star button on each search hit: save to favorites in one tap.
- Favorites as inline chips in the add dialog.
- Macros: protein/carbs/fat. Protein has a goal (`1.6 × bodyweight` default, overridable) with a progress bar; C/F shown as totals only.

### Workouts

**Cardio** — auto-detected MET from a built-in lookup (running, cycling, swimming, HIIT, boxing…). Calories: `MET × weight × hours × intensity_mult`.

**Gym** — session-based with sets × reps × kg:
- Per exercise: name + a list of `{ reps, kg }` sets
- Calories: `Σ (reps × effective_kg) × 0.05`, where `effective_kg = max(kg, bodyweight × 0.4)` (the floor handles bodyweight exercises)
- Save sessions as templates; one tap prefills every exercise with last-used sets

### Body tracking

- Quick weigh-in (⚖ in topbar) with optional photo (compressed to ~50–150 KB JPEG)
- Sparkline trend in History (last 30 weigh-ins)
- Auto-recompute alert when weight changes ≥2 kg between logs
- 3-column progress photo gallery, tap to view full

### Activity heatmap

GitHub-style 365-day heatmap, two modes: food-log days and training days.

## Install on Android

Open the live URL in Chrome → menu (⋮) → **Install app**. Full-screen, offline, native-feeling icon.

## Run locally

```bash
npx serve .
# or
python -m http.server 8000
```

Service worker requires `http(s)://` or `localhost` — `file://` won't register the SW but the app still runs.

## Configuring discipline rules

Five tunable constants at the top of `app.js`:

```js
const LOCK_HOURS = 12;
const SKIP_PENALTY = 150;
const MISSED_DAY_SURPLUS = 200;
const WEEKLY_OVERAGE_PENALTY = 50;
const WEEKLY_MIN_DAYS = 4;
```

## Stack

Vanilla JavaScript / HTML / CSS. No framework, no build step, no dependencies. Deliberately kept that way — easier to audit, easier to host.

## License

MIT.
