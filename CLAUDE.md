# CLAUDE.md

Context for Claude Code working in this repo.

## What this is

Macroni — a single-user PWA for tracking calories with strict carry-over semantics and discipline penalties. Zero backend. Data lives in `localStorage`. Deployable to any static host; installable on Android home screen.

UI is Vietnamese. User-facing strings stay Vietnamese unless explicitly asked otherwise.

## Stack choices (and why)

- **Vanilla JS / HTML / CSS**, no build step, no framework. The whole app is ~600 lines of JS. A build step would hurt more than help here.
- **No dependencies.** If you're tempted to add one, stop and ask.
- **Single-file modules**: `app.js` holds everything. Don't split into modules unless it grows past ~1200 lines.
- **Mobile-first**. Desktop is not a supported target.

## File layout

```
index.html     # all UI markup, uses data-i18n attributes for strings
app.js         # state, rules, rendering, wiring — one file, top-down
i18n.js        # I18N dict (vi/en) + t() helper + applyI18n() traversal
styles.css     # dark theme, CSS variables in :root
manifest.json  # PWA install metadata
sw.js          # cache-first service worker
icon.svg       # app icon (also used for PWA install)
```

## UI structure (3 tabs)

- **Ăn / Food** — meal list + single "+ Log food" button (favorites inline as chips inside the add dialog)
- **Tập / Train** — two sub-sections: "Planned for today" (with + plan button) and "Done" (logged workouts) + single "+ Log workout" button
- **Lịch sử / History** — weight trend + sparkline, GitHub-style heatmap (track/workout toggle), progress photos, daily log list

The plan-vs-log distinction is kept because the skip penalty depends on planned-but-not-completed items, but they live in the same tab for navigational simplicity.

## i18n

- `t(key, params?)` reads from `I18N[state.lang]`, falls back to VI.
- Initial language auto-detects from `navigator.language` (en* → en, else vi).
- Toggle lives in Settings. Switching calls `applyI18n()` which traverses `[data-i18n]`, `[data-i18n-placeholder]`, `[data-i18n-aria]` and rewrites text/attrs.
- **Dynamic strings** (rendered via `innerHTML`) must call `t()` at render time — they won't be re-translated by `applyI18n()`. The `render()` call after language change is what refreshes dynamic parts.
- Default favorites (Cơm trắng, Phở bò, etc.) are Vietnamese-specific and are NOT translated — they're user-owned data after first boot.

## Core rules (DO NOT silently change)

These are the user's explicit discipline rules. Modifying any of them changes the product's identity. If a change is needed, surface it to the user first.

1. **Carry-over is one-directional**. Over-eating creates debt; under-eating pays it back but never creates credit.
   - Formula: `D_next = max(0, D + (net − baseBudget))`
2. **Skipped planned workout**: −150 kcal next day, per skipped item.
3. **Missed log day**: auto-filled as `baseBudget + 200` kcal (worst-case assumption).
4. **Log lock**: items can't be edited/deleted after 12 hours (`LOCK_HOURS`).
5. **Weekly reckoning**: if the previous 7 days' net vs `baseBudget` summed positive, every day of the current week gets −50 kcal (`WEEKLY_OVERAGE_PENALTY`).

All five constants live at the top of `app.js` and are the *only* tunables that should be tweaked without redesigning the logic:

```js
const LOCK_HOURS = 12;
const SKIP_PENALTY = 150;
const MISSED_DAY_SURPLUS = 200;
const WEEKLY_OVERAGE_PENALTY = 50;
const WEEKLY_MIN_DAYS = 4;
```

## Edge-case decisions (don't revisit without cause)

- **Budget floor = BMR.** `dayBudget()` is clamped at `calcBMR(profile)`. Debt still accrues/pays on the same formula — floor is display-only and medical-safety. When floored, `isBudgetFloored(day)` is true and the UI shows a warning. Never let budget drop below BMR regardless of debt size.
- **Weekly penalty needs ≥ `WEEKLY_MIN_DAYS` (4) days logged in the prior week.** Prevents false positives on fresh install mid-week, vacation returns, or sparse logging weeks. Partial data is not enough evidence to justify a punishment.
- **Manual debt reset exists and is tracked.** User can clear accumulated debt via Settings → "Reset nợ". It requires confirm + typing "RESET" verbatim. Every reset is appended to `state.resets[]` permanently (date + kcal erased) and shown in Settings. The friction is psychological, not technical — the escape exists so users don't abandon the app after a bad stretch, but the counter is visible so it's not free.

## Data model

Single `state` object persisted to `localStorage` under `macroni_v1`:

```
{
  profile: { gender, age, height, weight, activity, tdee, dailyDeficit, baseBudget },
  days: {
    "YYYY-MM-DD": {
      meals:    [{id, name, kcal, time, locked?}],
      workouts: [{id, name, met, minutes, intensity, kcal, time}],
      plan:     [{id, name, completed}],
      carryDebt, skipPenalty, weeklyPenalty,
      autoFilled, skipFinalized
    }
  },
  favorites: { foods: [...], exercises: [...] },
  lastOpenDate: "YYYY-MM-DD",
  resets: [{ date, debtErased, at }],
  weights: [{ date, kg, photo?, at }]  // photo is base64 JPEG data-URL, optional
}
```

`carryDebt`, `skipPenalty`, `weeklyPenalty` on a day object are *already applied* to that day's displayed budget — they're not "pending".

## Budget computation

```
foodBudget(day)   = baseBudget − carryDebt
rawBudget(day)    = foodBudget − skipPenalty − weeklyPenalty
dayBudget(day)    = max(rawBudget, BMR)       // BMR floor for safety
remaining         = dayBudget − (consumed − burned)
```

The UI shows `dayBudget` as the budget and displays the breakdown (carry/skip/weekly) in a penalty box when any are non-zero.

## Rollover (critical path)

`rollover()` runs on app open and on midnight-while-open. It:
1. Finalizes skip penalty for `lastOpenDate` (pushes skip cost to next day).
2. For each gap day between `lastOpenDate + 1` and `today − 1`: sets carry, sets weekly penalty, auto-fills if empty, finalizes skip.
3. Sets today's `carryDebt` and `weeklyPenalty`.
4. Updates `lastOpenDate`.

Idempotent: `skipFinalized` flag prevents double-charging skip penalty. Re-running on the same day only recomputes today's carry/weekly (cheap).

## Workouts: cardio vs gym

Two distinct shapes stored in `day.workouts[]`, discriminated by `type`:

**Cardio** (running, cycling, swimming, HIIT, etc.)
```
{ id, type: 'cardio', name, met, minutes, intensity, kcal, time }
```
- MET is auto-detected from exercise name via `MET_TABLE` in `app.js` (substring match on lowercased name). Fallback = 5 if no match.
- User does not input MET manually in the normal flow — the dialog shows "MET auto-detected: X" as a read-only hint.
- Calories: `kcal = MET × weight_kg × (minutes / 60) × intensity_mult` (low 0.85 / med 1.0 / high 1.2).
- Favorites: `state.favorites.exercises[] = {name, met}`. Power users can still customize MET here.

**Gym / resistance** (push day, pull day, legs, etc.)
```
{
  id, type: 'gym',
  sessionName: 'Push day',
  duration: 60,             // total minutes for the whole session
  exercises: [
    { name: 'Bench press', sets: [{reps: 10, kg: 60}, ...] },
    ...
  ],
  kcal,                     // auto-computed
  time
}
```
- Calories: **volume-based**, not time-based. `kcal = Σ(reps × effective_kg) × 0.05`, where `effective_kg = max(kg, bodyweight × 0.4)`. The 40%-bodyweight floor handles bodyweight exercises (pullups, dips, pushups) where `kg=0` is entered — without it, bodyweight work would score 0 kcal. Duration is kept as an optional informational field but does NOT drive the kcal calculation.
- **Why not duration × MET?** A 60-minute light stretching session and a 60-minute heavy-compound session burn wildly different calories. Volume is a better proxy for energy expenditure in resistance training. The previous duration × MET formula is wrong and was replaced.
- Sets/reps/kg DO affect kcal, and also serve as the base for future progressive-overload tracking.
- Session templates: `state.favorites.gymSessions[] = {name, exercises: [{name, lastSets}]}`. Tapping a session chip prefills the whole form with last-used sets.

Rendering: cardio items show as a single line. Gym items render with an expandable `▸` chevron revealing each exercise's set list as `reps×kg` chips.

## Macros (protein / carbs / fat)

- Each meal entry carries optional `protein`, `carbs`, `fat` (grams) in addition to `kcal`. Missing values are treated as 0 in totals — backward compat with pre-macros data is free.
- Favorites additionally store `protein100`, `carbs100`, `fat100` alongside `kcal100` when they came from the food DB. This is what makes the grams field rescale everything proportionally.
- **Protein target**: `profile.proteinTarget` overrides the default. Default formula: `1.6 × body_weight_kg`, which is the standard recommendation for a cutting phase with preserved muscle. User can change in Settings.
- **Why only track protein visibly, not all three?** Protein is the only macro that has a *minimum* people should hit when cutting. Carbs and fat are shown as totals but not as goals — eating below your fat/carb number isn't a problem the way missing protein is.
- Main-screen macros card: protein progress bar (purple, turns green when target met) + carbs/fat totals in muted colors. Budget/remaining ring stays calorie-focused — the discipline rules still run on kcal only.
- Meal list items show compact `{P}P {C}C {F}F` pills when any macro is > 0. Pills hidden entirely if all three are 0 (keeps UI clean for manual entries without macros).

## Food search (USDA FoodData Central)

- Endpoint: `https://api.nal.usda.gov/fdc/v1/foods/search?query=...&api_key=KEY`.
- **Why USDA and not OpenFoodFacts**: OFF's search endpoints (`world.openfoodfacts.org/cgi/search.pl`, `api/v2/search`, and `search.openfoodfacts.org/search`) either return HTTP 503 under load or omit the `Access-Control-Allow-Origin` header — all unusable from a browser. USDA FoodData Central sends proper CORS (`Access-Control-Allow-Origin: *`) and is reliable.
- **API key handling**:
  - Default: `DEMO_KEY` (public, limited to 10 requests/hour per IP — OK for occasional use).
  - Users can paste their own free key (1000/hour) in Settings → "USDA API key". Stored in `state.profile.usdaKey`.
  - Free key signup: https://api.data.gov/signup/ (just email, instant).
- **Rate-limit detection**: HTTP 403/429 → thrown as `rate_limit` error, surfaced with a specific i18n message pointing to Settings.
- **Response parsing**: foods[] → each food has `foodNutrients` array. Pick the one where `nutrientName === 'Energy'` AND `unitName === 'KCAL'` (skip KJ entries). Per-100g values.
- **Coverage**: US-focused but includes most international staples. Search with English names (`banana`, `chicken breast`, `rice`). Vietnamese-only searches will mostly return no results — manual entry remains the fallback.
- **Never try to proxy OFF through a public CORS proxy** (corsproxy.io, allorigins, etc.) — they are rate-limited, often offline, and introduce a third-party dependency that can quietly break the feature.
- User picks a hit → form prefills with `name`, `grams=100`, `kcal=kcal100`. Typing a new grams value recomputes kcal proportionally.
- Weak coverage for Vietnamese prepared foods (phở, bún, cơm nhà nấu) — manual entry is always available as a fallback.
- Service worker (`sw.js`) explicitly skips cross-origin requests so it doesn't cache or intercept OpenFoodFacts responses.

## TDEE formula

Mifflin–St Jeor:
- Male:   `10×kg + 6.25×cm − 5×age + 5`
- Female: `10×kg + 6.25×cm − 5×age − 161`
- TDEE = BMR × activity multiplier (1.2 / 1.375 / 1.55 / 1.725 / 1.9)

## Goal-based planning

Users do NOT manually pick a deficit. They set a **target weight** and **timeframe** (weeks). The app computes everything from there:

```
remainingDays = daysUntil(targetDate)
weightDelta   = currentWeight - targetWeight  // +cut, −bulk, 0 maintain
dailyDeficit  = (weightDelta × 7700) / remainingDays
baseBudget    = TDEE − dailyDeficit
weeklyRate    = weightDelta / (remainingDays / 7)
```

- Profile stores `targetWeight` + `targetDate` (YYYY-MM-DD). Not `goalWeeks` — absolute date is more robust as time passes.
- `planFromGoal(profile)` computes the plan on demand. `applyGoalToProfile(profile)` writes `tdee`, `dailyDeficit`, `baseBudget` back.
- **On weigh-in**: `applyGoalToProfile` re-runs. Less time remaining + closer to goal = adjusted deficit. If user slips behind schedule, deficit gets more aggressive — surfaced via the UI feedback quality classifier.
- **Plan quality** (`planQuality`): `danger` if budget < BMR or rate > 1 kg/week. `warn` if rate > 0.7 kg/week. `ok` otherwise. Displayed with colored feedback in onboarding + settings.
- **Protein target**: still `1.6 × body_weight_kg` by default. Independent of the goal plan. User can override in Settings.
- **Legacy profiles** (pre-goal-based, only has `dailyDeficit` without `targetWeight`/`targetDate`) still work — the save path falls back to the old direct-deficit formula. User upgrades by filling in the goal fields.

## Running locally

```bash
npx serve .
# or
python -m http.server 8000
```

Service worker requires `http(s)://` or `localhost` — `file://` won't register the SW but the app still runs.

## Things to avoid

- **Don't add a backend / account system.** This is intentionally single-device. Export/import JSON is acceptable if requested.
- **Don't add "credit" / reward logic** for under-eating. The one-directional carry is the point.
- **Don't silently relax the lock.** If a log is wrong, the user eats the penalty — that's the feature.
- **Don't add a build step** (bundler, TS, JSX) without explicit ask.
- **Don't introduce dependencies.** Vanilla stays vanilla.
- **Don't auto-sync to external services.** No cloud, no analytics, no telemetry.

## Weight log + progress photos

- `state.weights` is a deduped-by-date array (one entry per day; re-weighing the same day overwrites but preserves photo if a new one isn't provided).
- Quick weigh-in button (⚖ in topbar) opens a dialog: kg + optional photo. Saving calls `logWeight()` which also updates `profile.weight`, recomputes TDEE, and updates `baseBudget`.
- If weight change ≥2kg, an alert surfaces the old/new TDEE so the user notices budget shifted.
- Photos are compressed via `compressImage()` (canvas resize to max 900px, JPEG quality 0.7). Stored as base64 data URLs directly in `state`. Typical size ~50-150KB/photo.
- **localStorage quota caveat**: ~5-10MB depending on browser. Roughly 30-100 photos before risk of quota errors. If this becomes a real problem, next step is IndexedDB for photos (not yet done).

## Heatmap

- GitHub-style 365-day grid in History tab. Two modes: "Log calo" (meal logging) and "Tập luyện" (workout days). Toggle via `.htab` buttons.
- `renderHeatmap()` reads the mode from the active tab and rebuilds. Levels 0-4 map to fixed color stops in CSS (`.hm.lv0` through `.hm.lv4`).
- Auto-filled (missed) days count as level 0 in the track heatmap — missing a day is a miss, not a log.

## Ideas deferred

- **True home-screen widget** (KWGT + Cloudflare Worker exposing JSON) — discussed with user, not implemented.
- **Weight tracking / trend graph** — not asked for yet.
- **Macro tracking (P/C/F)** — out of scope; calorie-only is deliberate for simplicity.
