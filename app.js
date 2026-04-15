'use strict';

const LS_KEY = 'macroni_v1';
const LOCK_HOURS = 12;
const SKIP_PENALTY = 150;
const MISSED_DAY_SURPLUS = 200;
const WEEKLY_OVERAGE_PENALTY = 50;
const WEEKLY_MIN_DAYS = 4; // require N days logged in prior week to apply weekly penalty

const DEFAULT_FOODS = [
  { name: 'Cơm trắng (1 chén)', kcal: 200 },
  { name: 'Ức gà luộc (100g)', kcal: 165 },
  { name: 'Trứng luộc', kcal: 78 },
  { name: 'Chuối', kcal: 105 },
  { name: 'Phở bò', kcal: 450 },
];
const DEFAULT_EXERCISES = [
  { name: 'Đi bộ', met: 3.5 },
  { name: 'Chạy bộ', met: 8 },
  { name: 'Đạp xe', met: 7 },
  { name: 'HIIT', met: 8 },
];

// MET lookup for cardio — keys match any substring of the exercise name (lowercased).
// Sourced from Compendium of Physical Activities (approx, moderate intensity).
const MET_TABLE = [
  { keys: ['đi bộ', 'walk'], met: 3.5 },
  { keys: ['chạy nhanh', 'sprint'], met: 11 },
  { keys: ['chạy', 'jog', 'run'], met: 8 },
  { keys: ['đạp xe', 'cycl', 'bike'], met: 7 },
  { keys: ['bơi', 'swim'], met: 7 },
  { keys: ['nhảy dây', 'jump rope', 'skip'], met: 11 },
  { keys: ['hiit'], met: 8 },
  { keys: ['yoga'], met: 3 },
  { keys: ['pilates'], met: 3.5 },
  { keys: ['leo núi', 'hik', 'climb'], met: 6 },
  { keys: ['thể dục nhịp điệu', 'aerobic'], met: 6.5 },
  { keys: ['boxing', 'đấm bốc'], met: 9 },
  { keys: ['võ', 'martial'], met: 8 },
  { keys: ['cầu lông', 'badminton'], met: 5.5 },
  { keys: ['tennis'], met: 7 },
  { keys: ['bóng đá', 'soccer', 'football'], met: 8 },
  { keys: ['bóng rổ', 'basketball'], met: 7 },
];
// Gym calorie estimation — volume-based, not time-based.
// Empirical coefficient: total volume (reps × effective_kg) × GYM_KCAL_PER_VOLUME.
// The 40%-bodyweight floor handles bodyweight / assisted exercises where kg=0 or is low.
const GYM_KCAL_PER_VOLUME = 0.05;
const GYM_BW_FLOOR_FRAC = 0.4;

function gymCalories(exercises, bodyweight) {
  let total = 0;
  const floor = bodyweight * GYM_BW_FLOOR_FRAC;
  for (const ex of (exercises || [])) {
    for (const s of (ex.sets || [])) {
      const effective = Math.max(s.kg || 0, floor);
      total += (s.reps || 0) * effective * GYM_KCAL_PER_VOLUME;
    }
  }
  return Math.round(total);
}

function lookupMET(name) {
  const n = name.toLowerCase().trim();
  for (const row of MET_TABLE) {
    if (row.keys.some(k => n.includes(k))) return row.met;
  }
  return null;
}

// ---------- Storage ----------
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function saveState() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }

let state = loadState() || {
  profile: null,
  days: {},
  favorites: { foods: DEFAULT_FOODS.slice(), exercises: DEFAULT_EXERCISES.slice() },
  lastOpenDate: null,
  resets: [],
  weights: [], // [{date, kg, photo?, at}]
  lang: null,  // 'vi' | 'en' | null (auto-detect)
};
if (!state.resets) state.resets = [];
if (!state.weights) state.weights = [];
if (state.lang === undefined) state.lang = null;

// ---------- Date helpers ----------
function todayKey(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return todayKey(dt);
}
function diffDays(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  const A = new Date(ya, ma - 1, da), B = new Date(yb, mb - 1, db);
  return Math.round((B - A) / 86400000);
}
function fmtDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  const days = t('dow');
  const dt = new Date(y, m - 1, d);
  return `${days[dt.getDay()]}, ${d}/${m}/${y}`;
}

// ---------- TDEE ----------
function calcBMR(p) {
  // Mifflin-St Jeor
  const { weight, height, age, gender } = p;
  const s = gender === 'male' ? 5 : -161;
  return Math.round(10 * weight + 6.25 * height - 5 * age + s);
}
function calcTDEE(p) { return Math.round(calcBMR(p) * p.activity); }

// 7700 kcal ≈ 1kg of body fat.
const KCAL_PER_KG = 7700;

// Given current profile + goal (targetWeight, targetDate), compute daily deficit,
// base budget, and per-week rate. Used by onboarding, settings, and weigh-in.
function planFromGoal(profile) {
  const { weight, targetWeight, targetDate, tdee } = profile;
  const today = todayKey();
  const remainingDays = Math.max(1, diffDays(today, targetDate));
  const remainingWeeks = remainingDays / 7;
  const weightDelta = weight - targetWeight; // + = need to lose, - = need to gain
  const totalKcal = weightDelta * KCAL_PER_KG;
  const dailyDeficit = Math.round(totalKcal / remainingDays);
  const baseBudget = tdee - dailyDeficit;
  const weeklyRate = weightDelta / remainingWeeks;
  return { dailyDeficit, baseBudget, weeklyRate, remainingDays, remainingWeeks };
}

// Classify a plan into buckets for the UI feedback.
function planQuality(profile, plan) {
  const bmr = calcBMR(profile);
  const absRate = Math.abs(plan.weeklyRate);
  if (plan.baseBudget < bmr) return { kind: 'danger', key: 'plan_below_bmr' };
  if (absRate > 1) return { kind: 'danger', key: 'plan_too_fast' };
  if (absRate > 0.7) return { kind: 'warn', key: 'plan_aggressive' };
  if (absRate >= 0.25) return { kind: 'ok', key: 'plan_sustainable' };
  if (absRate > 0) return { kind: 'ok', key: 'plan_slow' };
  return { kind: 'neutral', key: 'plan_maintain' };
}

function applyGoalToProfile(profile) {
  profile.tdee = calcTDEE(profile);
  const plan = planFromGoal(profile);
  profile.dailyDeficit = plan.dailyDeficit;
  profile.baseBudget = plan.baseBudget;
  return plan;
}

function weeksFromNow(weeks) {
  return addDays(todayKey(), Math.round(weeks * 7));
}

// ---------- Day ops ----------
function ensureDay(key) {
  if (!state.days[key]) {
    state.days[key] = {
      meals: [],
      workouts: [],
      plan: [],
      carryDebt: 0,
      skipPenalty: 0,
      weeklyPenalty: 0,
      autoFilled: false,
      createdAt: Date.now(),
    };
  }
  return state.days[key];
}

function dayConsumed(day) { return day.meals.reduce((s, m) => s + m.kcal, 0); }
function dayBurned(day) { return day.workouts.reduce((s, w) => s + w.kcal, 0); }
function dayNet(day) { return dayConsumed(day) - dayBurned(day); }
function dayMacros(day) {
  return day.meals.reduce(
    (acc, m) => ({
      protein: acc.protein + (m.protein || 0),
      carbs: acc.carbs + (m.carbs || 0),
      fat: acc.fat + (m.fat || 0),
    }),
    { protein: 0, carbs: 0, fat: 0 }
  );
}
function proteinTarget() {
  const p = state.profile;
  if (p.proteinTarget) return p.proteinTarget;
  return Math.round(p.weight * 1.6); // default 1.6 g / kg bodyweight
}
function foodBudget(day) {
  return state.profile.baseBudget - (day.carryDebt || 0);
}
function rawBudget(day) {
  return foodBudget(day) - (day.skipPenalty || 0) - (day.weeklyPenalty || 0);
}
function budgetFloor() {
  // Never display a budget below BMR — eating below BMR is medically unsafe.
  return calcBMR(state.profile);
}
function dayBudget(day) {
  return Math.max(rawBudget(day), budgetFloor());
}
function isBudgetFloored(day) {
  return rawBudget(day) < budgetFloor();
}

// Carry semantics (user rule: over-eat creates debt, under-eat pays debt back, never credits):
//   D_next = max(0, D + (net - baseBudget))
function computeCarryFrom(prevKey) {
  const p = state.days[prevKey];
  if (!p) return 0;
  return Math.max(0, (p.carryDebt || 0) + dayNet(p) - state.profile.baseBudget);
}

// ---------- Rollover ----------
function rollover() {
  if (!state.profile) return;
  const today = todayKey();
  const last = state.lastOpenDate;

  if (last && last !== today && diffDays(last, today) > 0) {
    // Finalize skip penalty for `last` day (its planned workouts are now in the past)
    finalizeSkip(last);

    // Fill every day from (last+1) up to (today-1)
    let k = addDays(last, 1);
    while (k !== today) {
      const d = ensureDay(k);
      // propagate carry debt from previous day
      d.carryDebt = computeCarryFrom(addDays(k, -1));
      d.weeklyPenalty = computeWeeklyPenalty(k);
      // Auto-fill if nothing logged on this past day
      if (!d.autoFilled && d.meals.length === 0 && d.workouts.length === 0) {
        d.autoFilled = true;
        d.meals.push({
          id: genId(),
          name: t('auto_filled'),
          kcal: state.profile.baseBudget + MISSED_DAY_SURPLUS,
          time: Date.now(),
          locked: true,
        });
      }
      finalizeSkip(k);
      k = addDays(k, 1);
    }
  }

  // Compute today's carry + weekly penalty
  const today_ = ensureDay(today);
  today_.carryDebt = computeCarryFrom(addDays(today, -1));
  today_.weeklyPenalty = computeWeeklyPenalty(today);

  state.lastOpenDate = today;
  saveState();
}

function finalizeSkip(key) {
  const day = state.days[key];
  if (!day || day.skipFinalized) return;
  const skipped = (day.plan || []).filter(p => !p.completed).length;
  if (skipped > 0) {
    const next = ensureDay(addDays(key, 1));
    next.skipPenalty = (next.skipPenalty || 0) + skipped * SKIP_PENALTY;
  }
  day.skipFinalized = true;
}

function computeWeeklyPenalty(key) {
  // Penalty applies to every day of the week AFTER a week with net positive surplus.
  // Requires at least WEEKLY_MIN_DAYS logged in the prior week — avoids penalizing
  // partial weeks (fresh install mid-week, vacation returns, etc).
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay();
  const mondayOffset = (dow + 6) % 7;
  const mondayKey = addDays(key, -mondayOffset);
  let total = 0;
  let logged = 0;
  for (let i = 1; i <= 7; i++) {
    const k = addDays(mondayKey, -i);
    const day = state.days[k];
    if (!day) continue;
    logged++;
    total += dayNet(day) - state.profile.baseBudget;
  }
  if (logged < WEEKLY_MIN_DAYS) return 0;
  return total > 0 ? WEEKLY_OVERAGE_PENALTY : 0;
}

// ---------- IDs ----------
function genId() { return Math.random().toString(36).slice(2, 10); }

// ---------- Exercise calories ----------
function exCalories(met, minutes, intensity, weight) {
  const mult = intensity === 'low' ? 0.85 : intensity === 'high' ? 1.2 : 1;
  return Math.round(met * mult * weight * (minutes / 60));
}

// ---------- Weight log ----------
function currentWeight() {
  if (state.weights.length > 0) return state.weights[state.weights.length - 1].kg;
  return state.profile ? state.profile.weight : 70;
}
function logWeight(kg, photoDataUrl = null) {
  const date = todayKey();
  const existing = state.weights.findIndex(w => w.date === date);
  const entry = { date, kg, at: Date.now() };
  if (photoDataUrl) entry.photo = photoDataUrl;
  if (existing >= 0) {
    // preserve existing photo if new one not provided
    if (!photoDataUrl && state.weights[existing].photo) entry.photo = state.weights[existing].photo;
    state.weights[existing] = entry;
  } else {
    state.weights.push(entry);
  }
  // Update profile + recompute. If the user has a target (goal-based plan),
  // recompute deficit too — closer to goal or less time remaining = adjusted deficit.
  const p = state.profile;
  const oldTdee = p.tdee;
  p.weight = kg;
  if (p.targetWeight && p.targetDate) {
    applyGoalToProfile(p);
  } else {
    p.tdee = calcTDEE(p);
    p.baseBudget = p.tdee - (p.dailyDeficit || 0);
  }
  saveState();
  return { oldTdee, newTdee: p.tdee };
}

// ---------- Food search (USDA FoodData Central) ----------
// Uses api.nal.usda.gov which sends proper CORS headers.
// DEMO_KEY works but limited to 10 req/hour per IP.
// Users can paste their own free key (1000/hour) in Settings.
// Sign up: https://api.data.gov/signup/
async function searchFoodDB(query) {
  const key = (state.profile && state.profile.usdaKey) || 'DEMO_KEY';
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search`
    + `?query=${encodeURIComponent(query)}`
    + `&pageSize=20`
    + `&dataType=Foundation,SR%20Legacy,Branded`
    + `&api_key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (res.status === 429 || res.status === 403) {
    throw new Error('rate_limit');
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const results = [];
  for (const f of (data.foods || [])) {
    const nuts = f.foodNutrients || [];
    const findNut = (names, unit) => nuts.find(n =>
      names.includes(n.nutrientName) && (!unit || n.unitName === unit)
    );
    const kcalNut = findNut(['Energy'], 'KCAL');
    if (!kcalNut || !kcalNut.value) continue;
    const proteinNut = findNut(['Protein']);
    const fatNut = findNut(['Total lipid (fat)', 'Fat']);
    const carbNut = findNut(['Carbohydrate, by difference', 'Carbohydrates']);
    const brand = f.brandName || f.brandOwner || '';
    const name = (f.description || '') + (brand ? ` (${brand.trim()})` : '');
    if (!name || results.some(r => r.name === name)) continue;
    results.push({
      name,
      kcal100: Math.round(kcalNut.value),
      protein100: proteinNut ? +proteinNut.value.toFixed(1) : 0,
      carbs100: carbNut ? +carbNut.value.toFixed(1) : 0,
      fat100: fatNut ? +fatNut.value.toFixed(1) : 0,
    });
    if (results.length >= 10) break;
  }
  return results;
}

// ---------- Image compression ----------
async function compressImage(file, maxDim = 900, quality = 0.7) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  try {
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- Onboarding ----------
function initOnboarding() {
  const $ = id => document.getElementById(id);
  let tdeeComputed = null;

  const renderFeedback = () => {
    const p = readOnboardForm();
    const target = +$('ob-target').value;
    const weeks = +$('ob-weeks').value;
    const fb = $('ob-feedback');
    if (!target || !weeks || weeks < 1) {
      fb.innerHTML = '';
      return;
    }
    const profile = {
      ...p,
      tdee: tdeeComputed,
      targetWeight: target,
      targetDate: weeksFromNow(weeks),
    };
    const plan = planFromGoal(profile);
    const q = planQuality(profile, plan);
    const rate = +plan.weeklyRate.toFixed(2);
    const direction = rate > 0 ? 'giảm' : rate < 0 ? 'tăng' : '';
    const protein = Math.round(p.weight * 1.6);
    fb.className = 'goal-feedback ' + q.kind;
    fb.innerHTML = `
      <div class="fb-row"><span>${t('fb_budget')}</span><b>${plan.baseBudget} kcal/${t('day')}</b></div>
      <div class="fb-row"><span>${t('fb_deficit')}</span><b>${plan.dailyDeficit > 0 ? '−' : '+'}${Math.abs(plan.dailyDeficit)} kcal</b></div>
      <div class="fb-row"><span>${t('fb_rate')}</span><b>${Math.abs(rate)} ${t('kg_per_week')} ${currentLang() === 'vi' ? direction : (rate > 0 ? 'loss' : rate < 0 ? 'gain' : '')}</b></div>
      <div class="fb-row"><span>${t('fb_protein')}</span><b>${protein}g</b></div>
      <div class="fb-note">${t(q.key)}</div>
    `;
  };

  $('ob-calc').onclick = () => {
    const p = readOnboardForm();
    tdeeComputed = calcTDEE(p);
    $('ob-tdee').textContent = tdeeComputed;
    // Prefill target = current - 5kg as starting suggestion
    if (!$('ob-target').value) $('ob-target').value = Math.max(40, p.weight - 5);
    $('ob-result').classList.remove('hidden');
    renderFeedback();
  };

  ['ob-target', 'ob-weeks'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderFeedback);
  });

  $('ob-save').onclick = () => {
    const p = readOnboardForm();
    const target = +$('ob-target').value;
    const weeks = +$('ob-weeks').value;
    if (!target || !weeks || weeks < 1) return;
    state.profile = {
      ...p,
      tdee: tdeeComputed || calcTDEE(p),
      targetWeight: target,
      targetDate: weeksFromNow(weeks),
      proteinTarget: null, // use default (1.6 × weight)
    };
    applyGoalToProfile(state.profile);
    state.lastOpenDate = todayKey();
    saveState();
    showApp();
  };
}
function readOnboardForm() {
  return {
    gender: document.getElementById('ob-gender').value,
    age: +document.getElementById('ob-age').value,
    height: +document.getElementById('ob-height').value,
    weight: +document.getElementById('ob-weight').value,
    activity: +document.getElementById('ob-activity').value,
  };
}

// ---------- Main UI ----------
function showApp() {
  document.getElementById('onboarding').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  rollover();
  render();
}
function showOnboarding() {
  document.getElementById('onboarding').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

function render() {
  const key = todayKey();
  const day = ensureDay(key);
  const consumed = dayConsumed(day);
  const burned = dayBurned(day);
  const budget = dayBudget(day);
  const remaining = budget - (consumed - burned);

  document.getElementById('today-label').textContent = fmtDate(key);
  document.getElementById('streak-label').textContent = computeStreakLabel();
  document.getElementById('sum-consumed').textContent = consumed;
  document.getElementById('sum-burned').textContent = burned;
  document.getElementById('sum-budget').textContent = budget;
  document.getElementById('kcal-remaining').textContent = remaining;

  // Macros
  const macros = dayMacros(day);
  const proTarget = proteinTarget();
  const proNow = Math.round(macros.protein);
  document.getElementById('pro-current').textContent = proNow;
  document.getElementById('pro-target').textContent = proTarget;
  const proPct = Math.min(100, Math.round((proNow / proTarget) * 100));
  const proFill = document.getElementById('pro-fill');
  proFill.style.width = proPct + '%';
  proFill.classList.toggle('met', proNow >= proTarget);
  document.getElementById('macro-c').textContent = Math.round(macros.carbs) + 'g';
  document.getElementById('macro-f').textContent = Math.round(macros.fat) + 'g';

  // Ring
  const pct = Math.max(0, Math.min(1, (consumed - burned) / Math.max(budget, 1)));
  const ring = document.getElementById('ring-fg');
  const c = 2 * Math.PI * 52;
  ring.style.strokeDasharray = c;
  ring.style.strokeDashoffset = c * (1 - pct);
  ring.classList.toggle('over', remaining < 0);

  // Penalty info
  const penaltyEl = document.getElementById('penalty-box');
  const parts = [];
  if (day.carryDebt > 0) parts.push(`${t('debt')}: −${day.carryDebt}`);
  if (day.skipPenalty > 0) parts.push(`${t('skipped')}: −${day.skipPenalty}`);
  if (day.weeklyPenalty > 0) parts.push(`${t('weekly')}: −${day.weeklyPenalty}`);
  if (isBudgetFloored(day)) {
    parts.push(t('bmr_floor', { raw: rawBudget(day), floor: Math.round(budgetFloor()) }));
  }
  if (parts.length) {
    penaltyEl.classList.remove('hidden');
    penaltyEl.innerHTML = parts.map(p => `<div>${p}</div>`).join('');
  } else {
    penaltyEl.classList.add('hidden');
  }

  renderMeals(day);
  renderWorkouts(day);
  renderPlan(day);
  renderHistory();
  renderWeightTrend();
  renderHeatmap();
  renderPhotoGallery();
}

function computeStreakLabel() {
  let streak = 0;
  let k = addDays(todayKey(), -1);
  while (state.days[k] && !state.days[k].autoFilled && state.days[k].meals.length > 0) {
    streak++;
    k = addDays(k, -1);
  }
  if (streak === 0) return t('streak_start');
  return `🔥 ${t('streak_n', { n: streak })}`;
}

// ---------- Renderers ----------
function isLocked(item) {
  if (item.locked) return true;
  return (Date.now() - item.time) > LOCK_HOURS * 3600 * 1000;
}

function renderMeals(day) {
  const el = document.getElementById('meal-list');
  el.innerHTML = '';
  if (day.meals.length === 0) {
    el.innerHTML = `<div class="empty">${t('no_meals')}</div>`;
    return;
  }
  day.meals.forEach(m => {
    const locked = isLocked(m);
    const div = document.createElement('div');
    div.className = 'item';
    const hasMacros = (m.protein || m.carbs || m.fat);
    const macros = hasMacros
      ? `<span class="macro-pill p">${Math.round(m.protein || 0)}P</span>`
        + `<span class="macro-pill c">${Math.round(m.carbs || 0)}C</span>`
        + `<span class="macro-pill f">${Math.round(m.fat || 0)}F</span>`
      : '';
    div.innerHTML = `
      <div>
        <div class="item-name">${escapeHtml(m.name)}</div>
        <div class="item-meta">${timeHHMM(m.time)} ${locked ? '🔒' : ''} ${macros}</div>
      </div>
      <div class="item-right">
        <div class="item-kcal">${m.kcal} kcal</div>
        ${locked ? '' : `<button class="x" data-id="${m.id}">×</button>`}
      </div>
    `;
    const btn = div.querySelector('button.x');
    if (btn) btn.onclick = () => { day.meals = day.meals.filter(x => x.id !== m.id); saveState(); render(); };
    el.appendChild(div);
  });
}

function renderWorkouts(day) {
  const el = document.getElementById('workout-list');
  el.innerHTML = '';
  if (day.workouts.length === 0) {
    el.innerHTML = `<div class="empty">${t('no_workouts')}</div>`;
    return;
  }
  day.workouts.forEach(w => {
    const locked = isLocked(w);
    const div = document.createElement('div');
    div.className = 'item workout-item';
    const isGym = w.type === 'gym';
    const title = isGym ? w.sessionName : w.name;
    const totalSets = isGym ? w.exercises.reduce((s, e) => s + e.sets.length, 0) : 0;
    const metaCardio = `${w.minutes} ${t('minutes')} · ${intensityLabel(w.intensity)}`;
    const metaGym = t('session_summary', { n: w.exercises.length, sets: totalSets, min: w.duration });
    const meta = isGym ? metaGym : metaCardio;
    div.innerHTML = `
      <div class="wi-main">
        <div class="wi-head">
          <div>
            <div class="item-name">${isGym ? '🏋️ ' : '🏃 '}${escapeHtml(title)}</div>
            <div class="item-meta">${meta} · ${timeHHMM(w.time)} ${locked ? '🔒' : ''}</div>
          </div>
          <div class="item-right">
            <div class="item-kcal">−${w.kcal} kcal</div>
            ${locked ? '' : `<button class="x" data-act="del">×</button>`}
          </div>
        </div>
        ${isGym ? `<button type="button" class="wi-expand" data-act="toggle">▸</button>` : ''}
        ${isGym ? `<div class="wi-details hidden">
          ${w.exercises.map(ex => `
            <div class="wi-ex">
              <div class="wi-ex-name">${escapeHtml(ex.name)}</div>
              <div class="wi-sets">${ex.sets.map(s => `<span class="set-chip">${s.reps}×${s.kg}</span>`).join('')}</div>
            </div>
          `).join('')}
        </div>` : ''}
      </div>
    `;
    const del = div.querySelector('[data-act="del"]');
    if (del) del.onclick = () => { day.workouts = day.workouts.filter(x => x.id !== w.id); saveState(); render(); };
    const toggle = div.querySelector('[data-act="toggle"]');
    if (toggle) {
      toggle.onclick = () => {
        const det = div.querySelector('.wi-details');
        det.classList.toggle('hidden');
        toggle.textContent = det.classList.contains('hidden') ? '▸' : '▾';
      };
    }
    el.appendChild(div);
  });
}

function renderPlan(day) {
  const el = document.getElementById('plan-list');
  el.innerHTML = '';
  if (!day.plan || day.plan.length === 0) {
    el.innerHTML = `<div class="empty tiny">${t('plan_note', { p: SKIP_PENALTY })}</div>`;
    return;
  }
  day.plan.forEach(p => {
    const div = document.createElement('div');
    div.className = 'item' + (p.completed ? ' plan-done' : '');
    div.innerHTML = `
      <div>
        <div class="item-name">${p.completed ? '✓ ' : ''}${escapeHtml(p.name)}</div>
        <div class="item-meta">${p.completed ? t('completed') : t('planned_not_done', { p: SKIP_PENALTY })}</div>
      </div>
      <div class="item-right">
        ${p.completed
          ? `<button class="ghost small" data-id="${p.id}" data-action="uncheck">${t('uncheck')}</button>`
          : `<button class="primary small" data-id="${p.id}" data-action="check">${t('done')}</button>`
        }
        <button class="x" data-id="${p.id}" data-action="del">×</button>
      </div>
    `;
    div.querySelectorAll('button[data-id]').forEach(b => {
      b.onclick = () => {
        const id = b.dataset.id, act = b.dataset.action;
        if (act === 'check') {
          const pp = day.plan.find(x => x.id === id);
          pp.completed = true;
        } else if (act === 'uncheck') {
          const pp = day.plan.find(x => x.id === id);
          pp.completed = false;
        } else {
          day.plan = day.plan.filter(x => x.id !== id);
        }
        saveState(); render();
      };
    });
    el.appendChild(div);
  });
}

function renderWeightTrend() {
  const el = document.getElementById('weight-trend');
  if (!el) return;
  const ws = state.weights;
  if (ws.length === 0) {
    el.innerHTML = `<div class="muted tiny">${t('weight_empty')}</div>`;
    return;
  }
  const latest = ws[ws.length - 1];
  const first = ws[0];
  const delta = +(latest.kg - first.kg).toFixed(1);
  const days = diffDays(first.date, latest.date);
  const sign = delta > 0 ? '+' : '';
  const cls = delta < 0 ? 'under' : delta > 0 ? 'over' : '';
  const deltaText = ws.length >= 2
    ? `<span class="${cls}">${sign}${delta}kg</span> / ${days} ${currentLang() === 'en' ? 'days' : 'ngày'}`
    : `<span class="muted">${t('trend_need_more')}</span>`;

  // Mini sparkline from last 30 weigh-ins
  const recent = ws.slice(-30);
  const min = Math.min(...recent.map(w => w.kg));
  const max = Math.max(...recent.map(w => w.kg));
  const range = Math.max(max - min, 0.5);
  const W = 300, H = 50, P = 4;
  const pts = recent.map((w, i) => {
    const x = P + (recent.length === 1 ? W/2 : (i / (recent.length - 1)) * (W - 2 * P));
    const y = P + (1 - (w.kg - min) / range) * (H - 2 * P);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const spark = recent.length >= 2
    ? `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2"/></svg>`
    : '';

  el.innerHTML = `
    <div class="trend-top">
      <div>
        <div class="trend-kg">${latest.kg}kg</div>
        <div class="trend-delta">${deltaText}</div>
      </div>
      ${spark}
    </div>
  `;
}

function renderHeatmap() {
  const wrap = document.getElementById('heatmap-wrap');
  if (!wrap) return;
  const active = document.querySelector('.htab.active');
  const mode = active ? active.dataset.heat : 'track';

  // Build last 365 days
  const today = todayKey();
  const cells = [];
  for (let i = 364; i >= 0; i--) {
    const k = addDays(today, -i);
    const day = state.days[k];
    let level = 0;
    if (day) {
      if (mode === 'track') {
        // Count meals logged (ignore autoFilled)
        if (!day.autoFilled) {
          const n = day.meals.length;
          level = n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n === 3 ? 3 : 4;
        }
      } else {
        const n = day.workouts.length;
        level = n === 0 ? 0 : n === 1 ? 2 : n === 2 ? 3 : 4;
      }
    }
    cells.push({ key: k, level });
  }

  // Group into weeks (columns). Start from the Sunday before oldest cell.
  const [y0, m0, d0] = cells[0].key.split('-').map(Number);
  const firstDt = new Date(y0, m0 - 1, d0);
  const firstDow = firstDt.getDay(); // 0=Sun
  // Pad front with empty cells so first column aligns
  const padded = [];
  for (let i = 0; i < firstDow; i++) padded.push(null);
  padded.push(...cells);

  const weeks = [];
  for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7));

  const COL = 12, GAP = 2;
  const W = weeks.length * (COL + GAP);
  const H = 7 * (COL + GAP);

  let totalActive = 0;
  cells.forEach(c => { if (c.level > 0) totalActive++; });

  const svg = [`<svg class="heatmap" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet">`];
  weeks.forEach((week, wi) => {
    week.forEach((c, di) => {
      if (!c) return;
      const x = wi * (COL + GAP);
      const y = di * (COL + GAP);
      svg.push(`<rect x="${x}" y="${y}" width="${COL}" height="${COL}" rx="2" class="hm lv${c.level}"><title>${c.key}</title></rect>`);
    });
  });
  svg.push('</svg>');

  const modeLabel = mode === 'track' ? t('heat_track') : t('heat_workout');
  wrap.innerHTML = `
    <div class="heatmap-stats">${t('heat_summary', { n: totalActive, mode: modeLabel })}</div>
    <div class="heatmap-scroll">${svg.join('')}</div>
  `;
}

function renderPhotoGallery() {
  const el = document.getElementById('photo-gallery');
  if (!el) return;
  const photos = state.weights.filter(w => w.photo).reverse();
  if (photos.length === 0) {
    el.innerHTML = `<div class="muted tiny">${t('photos_empty')}</div>`;
    return;
  }
  el.innerHTML = photos.slice(0, 24).map(w => `
    <div class="photo-cell" data-date="${w.date}">
      <img src="${w.photo}" alt="${w.date}" loading="lazy" />
      <div class="photo-meta"><span>${w.date.slice(5)}</span><span>${w.kg}kg</span></div>
    </div>
  `).join('');
  el.querySelectorAll('.photo-cell').forEach(c => {
    c.onclick = () => {
      const w = state.weights.find(x => x.date === c.dataset.date);
      if (!w) return;
      openPhotoViewer(w);
    };
  });
}

function openPhotoViewer(w) {
  openDialog(`${fmtDate(w.date)} — ${w.kg}kg`, `
    <img src="${w.photo}" style="width:100%;border-radius:10px" />
    <button id="del-photo" class="ghost full" style="margin-top:12px">${t('delete_photo')}</button>
  `, null, { hideOk: true, cancelLabel: t('close') });
  document.getElementById('del-photo').onclick = () => {
    if (!confirm(t('confirm_delete_photo'))) return;
    const idx = state.weights.findIndex(x => x.date === w.date);
    if (idx >= 0) {
      delete state.weights[idx].photo;
      saveState();
    }
    closeDialog();
    render();
  };
}

function renderHistory() {
  const el = document.getElementById('history-list');
  el.innerHTML = '';
  const keys = Object.keys(state.days).sort().reverse().slice(0, 30);
  if (keys.length === 0) {
    el.innerHTML = `<div class="empty">${t('history_empty')}</div>`;
    return;
  }
  keys.forEach(k => {
    const d = state.days[k];
    const consumed = dayConsumed(d);
    const burned = dayBurned(d);
    const budget = dayBudget(d);
    const net = consumed - burned;
    const diff = net - budget;
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div>
        <div class="item-name">${fmtDate(k)} ${d.autoFilled ? '⚠' : ''}</div>
        <div class="item-meta">${net}/${budget} kcal</div>
      </div>
      <div class="item-right">
        <div class="item-kcal ${diff > 0 ? 'over' : 'under'}">${diff > 0 ? '+' : ''}${diff}</div>
      </div>
    `;
    el.appendChild(div);
  });
}

// ---------- Dialog ----------
function openDialog(title, bodyHtml, onOk, opts = {}) {
  const dlg = document.getElementById('dialog');
  document.getElementById('dialog-title').textContent = title;
  document.getElementById('dialog-body').innerHTML = bodyHtml;
  const okBtn = document.getElementById('dialog-ok');
  const cancelBtn = document.getElementById('dialog-cancel');
  okBtn.style.display = opts.hideOk ? 'none' : '';
  cancelBtn.textContent = opts.cancelLabel || t('cancel');
  dlg.classList.remove('hidden');
  cancelBtn.onclick = () => dlg.classList.add('hidden');
  okBtn.onclick = async () => {
    if (!onOk) { dlg.classList.add('hidden'); return; }
    okBtn.disabled = true;
    try {
      const r = await onOk();
      if (r !== false) dlg.classList.add('hidden');
    } finally {
      okBtn.disabled = false;
    }
  };
}
function closeDialog() { document.getElementById('dialog').classList.add('hidden'); }

function addMealDialog(preset = null) {
  const favs = state.favorites.foods;
  const chipsHtml = favs.length
    ? `<div class="chips" id="fav-chips">
         ${favs.slice(-12).reverse().map((f, i) =>
           `<button class="chip" type="button" data-i="${favs.length - 1 - i}"><span>${escapeHtml(f.name)}</span><small>${f.kcal}</small></button>`
         ).join('')}
       </div>`
    : '';
  const hasPreset = !!preset;
  openDialog(t('add_meal_title'), `
    <div class="search-row">
      <input id="d-search" data-i18n-placeholder="search_placeholder" placeholder="${t('search_placeholder')}" />
      <button type="button" id="d-search-btn" class="chip-btn">${t('search')}</button>
    </div>
    <div id="d-search-results" class="search-results"></div>

    ${chipsHtml}

    <details class="disclosure" ${hasPreset ? 'open' : ''}>
      <summary>${t('manual_entry')} <span class="chev">▸</span></summary>
      <div class="disclosure-body">
        <label><span>${t('food_name')}</span><input id="d-name" value="${preset ? escapeHtml(preset.name) : ''}" /></label>
        <div class="row">
          <label><span>${t('kcal')}</span><input id="d-kcal" type="number" inputmode="numeric" value="${preset ? preset.kcal : ''}" /></label>
          <label><span>${t('grams')}</span><input id="d-grams" type="number" inputmode="numeric" placeholder="—" /></label>
        </div>
        <div class="muted tiny" id="d-kcal-hint"></div>
        <details class="disclosure sub">
          <summary>${t('show_macros')} <span class="chev">▸</span></summary>
          <div class="macro-row">
            <label><span>P</span><input id="d-protein" type="number" inputmode="decimal" step="0.1" placeholder="0" /></label>
            <label><span>C</span><input id="d-carbs" type="number" inputmode="decimal" step="0.1" placeholder="0" /></label>
            <label><span>F</span><input id="d-fat" type="number" inputmode="decimal" step="0.1" placeholder="0" /></label>
          </div>
        </details>
        <label class="check"><input type="checkbox" id="d-fav" /> ${t('save_as_fav')}</label>
      </div>
    </details>
  `, () => {
    const name = document.getElementById('d-name').value.trim();
    const kcal = +document.getElementById('d-kcal').value;
    if (!name || !kcal || kcal <= 0) return false;
    const protein = +document.getElementById('d-protein').value || 0;
    const carbs = +document.getElementById('d-carbs').value || 0;
    const fat = +document.getElementById('d-fat').value || 0;
    const day = ensureDay(todayKey());
    day.meals.push({ id: genId(), name, kcal, protein, carbs, fat, time: Date.now() });
    if (document.getElementById('d-fav').checked) {
      if (!state.favorites.foods.find(f => f.name === name)) {
        const entry = { name, kcal, protein, carbs, fat };
        if (lastKcal100) {
          entry.kcal100 = lastKcal100;
          entry.protein100 = lastMacros100.protein;
          entry.carbs100 = lastMacros100.carbs;
          entry.fat100 = lastMacros100.fat;
        }
        state.favorites.foods.push(entry);
      }
    }
    saveState(); render();
  });

  let lastKcal100 = null;
  let lastMacros100 = { protein: 0, carbs: 0, fat: 0 };

  const expandManual = () => {
    document.querySelectorAll('.disclosure').forEach(d => { if (!d.classList.contains('sub')) d.open = true; });
  };
  const expandMacros = () => {
    document.querySelectorAll('.disclosure.sub').forEach(d => { d.open = true; });
  };
  const setMacros = (p, c, f) => {
    document.getElementById('d-protein').value = p || '';
    document.getElementById('d-carbs').value = c || '';
    document.getElementById('d-fat').value = f || '';
    if (p || c || f) expandMacros();
  };

  document.querySelectorAll('#fav-chips .chip').forEach(b => {
    b.onclick = () => {
      const f = favs[+b.dataset.i];
      expandManual();
      document.getElementById('d-name').value = f.name;
      document.getElementById('d-kcal').value = f.kcal;
      setMacros(f.protein, f.carbs, f.fat);
      if (f.kcal100) {
        lastKcal100 = f.kcal100;
        lastMacros100 = {
          protein: f.protein100 || 0,
          carbs: f.carbs100 || 0,
          fat: f.fat100 || 0,
        };
        document.getElementById('d-grams').value = 100;
        document.getElementById('d-kcal-hint').textContent = t('per_100g', { k: f.kcal100 });
      } else {
        lastKcal100 = null;
        lastMacros100 = { protein: 0, carbs: 0, fat: 0 };
        document.getElementById('d-grams').value = '';
        document.getElementById('d-kcal-hint').textContent = '';
      }
    };
  });

  // Search handler
  const doSearch = async () => {
    const q = document.getElementById('d-search').value.trim();
    if (!q) return;
    const box = document.getElementById('d-search-results');
    box.innerHTML = `<div class="muted tiny">${t('searching')}</div>`;
    try {
      const results = await searchFoodDB(q);
      if (results.length === 0) {
        box.innerHTML = `<div class="muted tiny">${t('search_no_results')}</div>`;
        return;
      }
      box.innerHTML = results.map((r, i) => {
        const already = state.favorites.foods.some(f => f.name === r.name);
        return `<div class="search-hit" data-i="${i}">
          <button type="button" class="sh-body" data-i="${i}">
            <div class="sh-name">${escapeHtml(r.name)}</div>
            <div class="sh-kcal">${r.kcal100} / 100g</div>
          </button>
          <button type="button" class="sh-star ${already ? 'saved' : ''}" data-i="${i}" aria-label="${t('save_to_favs_aria')}" title="${t('save_to_favs_aria')}">★</button>
        </div>`;
      }).join('');
      box.querySelectorAll('.sh-body').forEach(btn => {
        btn.onclick = () => {
          const r = results[+btn.dataset.i];
          lastKcal100 = r.kcal100;
          lastMacros100 = { protein: r.protein100, carbs: r.carbs100, fat: r.fat100 };
          expandManual();
          document.getElementById('d-name').value = r.name;
          document.getElementById('d-grams').value = 100;
          document.getElementById('d-kcal').value = r.kcal100;
          setMacros(r.protein100, r.carbs100, r.fat100);
          document.getElementById('d-kcal-hint').textContent = t('per_100g', { k: r.kcal100 });
          box.innerHTML = '';
          document.getElementById('d-search').value = '';
        };
      });
      box.querySelectorAll('.sh-star').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const r = results[+btn.dataset.i];
          if (state.favorites.foods.some(f => f.name === r.name)) {
            alert(t('already_in_favs'));
            return;
          }
          state.favorites.foods.push({
            name: r.name,
            kcal: r.kcal100,
            protein: r.protein100,
            carbs: r.carbs100,
            fat: r.fat100,
            kcal100: r.kcal100,
            protein100: r.protein100,
            carbs100: r.carbs100,
            fat100: r.fat100,
          });
          saveState();
          btn.classList.add('saved');
          btn.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.3)' }, { transform: 'scale(1)' }], { duration: 300 });
        };
      });
    } catch (e) {
      const msg = (e && e.message) || 'network';
      const key = msg === 'rate_limit' ? 'search_rate_limit' : 'search_error';
      box.innerHTML = `<div class="muted tiny">${t(key, { code: msg })}</div>`;
    }
  };
  document.getElementById('d-search-btn').onclick = doSearch;
  document.getElementById('d-search').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
  });

  // Auto-recompute kcal + macros when grams change (if we have per-100g values)
  document.getElementById('d-grams').addEventListener('input', () => {
    const g = +document.getElementById('d-grams').value;
    if (lastKcal100 && g > 0) {
      const scale = g / 100;
      document.getElementById('d-kcal').value = Math.round(lastKcal100 * scale);
      setMacros(
        +(lastMacros100.protein * scale).toFixed(1),
        +(lastMacros100.carbs * scale).toFixed(1),
        +(lastMacros100.fat * scale).toFixed(1)
      );
    }
  });
}

function addWorkoutDialog() {
  const weight = state.profile.weight;
  openDialog(t('add_workout_title'), `
    <div class="type-toggle">
      <button type="button" class="wtype active" data-wt="cardio">${t('type_cardio')}</button>
      <button type="button" class="wtype" data-wt="gym">${t('type_gym')}</button>
    </div>
    <div id="wt-body"></div>
  `, () => submitWorkoutDialog(weight));

  // Type toggle
  document.querySelectorAll('.wtype').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('.wtype').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      renderWorkoutDialogBody(b.dataset.wt, weight);
    };
  });
  renderWorkoutDialogBody('cardio', weight);
}

function renderWorkoutDialogBody(type, weight) {
  const body = document.getElementById('wt-body');
  if (type === 'cardio') renderCardioBody(body, weight);
  else renderGymBody(body, weight);
}

function renderCardioBody(body, weight) {
  const favs = state.favorites.exercises;
  const chipsHtml = favs.length
    ? `<div class="chips-label">${t('favorites')}</div>
       <div class="chips" id="fav-chips">
         ${favs.slice(-12).reverse().map((f, i) =>
           `<button class="chip" type="button" data-i="${favs.length - 1 - i}"><span>${escapeHtml(f.name)}</span><small>MET ${f.met}</small></button>`
         ).join('')}
       </div>`
    : '';
  body.innerHTML = `
    ${chipsHtml}
    <label><span>${t('exercise_name')}</span><input id="d-name" /></label>
    <div class="row">
      <label><span>${t('duration_min')}</span><input id="d-min" type="number" inputmode="numeric" value="30" /></label>
      <label><span>${t('intensity')}</span>
        <select id="d-int">
          <option value="low">${t('low')}</option>
          <option value="med" selected>${t('medium')}</option>
          <option value="high">${t('high')}</option>
        </select>
      </label>
    </div>
    <div class="muted tiny" id="d-met-hint">—</div>
    <div class="muted tiny" id="d-preview">≈ 0 kcal</div>
    <label class="check"><input type="checkbox" id="d-fav" /> ${t('save_as_fav')}</label>
  `;

  let currentMET = null;

  const updatePreview = () => {
    const name = document.getElementById('d-name').value.trim();
    const met = currentMET || lookupMET(name) || 5;
    const min = +document.getElementById('d-min').value || 0;
    const intensity = document.getElementById('d-int').value;
    document.getElementById('d-met-hint').textContent = t('met_auto', { m: met });
    document.getElementById('d-preview').textContent = `≈ ${exCalories(met, min, intensity, weight)} kcal`;
  };

  body.querySelectorAll('#fav-chips .chip').forEach(b => {
    b.onclick = () => {
      const f = favs[+b.dataset.i];
      document.getElementById('d-name').value = f.name;
      currentMET = f.met;
      updatePreview();
    };
  });

  document.getElementById('d-name').addEventListener('input', () => { currentMET = null; updatePreview(); });
  document.getElementById('d-min').addEventListener('input', updatePreview);
  document.getElementById('d-int').addEventListener('change', updatePreview);
  updatePreview();
}

function renderGymBody(body, weight) {
  const sessions = state.favorites.gymSessions || [];
  const chipsHtml = sessions.length
    ? `<div class="chips-label">${t('session_favorites')}</div>
       <div class="chips" id="sess-chips">
         ${sessions.slice(-10).reverse().map((s, i) =>
           `<button class="chip" type="button" data-i="${sessions.length - 1 - i}"><span>${escapeHtml(s.name)}</span><small>${s.exercises.length}</small></button>`
         ).join('')}
       </div>`
    : '';
  body.innerHTML = `
    ${chipsHtml}
    <label><span>${t('session_name')}</span><input id="g-name" data-i18n-placeholder="session_placeholder" placeholder="${t('session_placeholder')}" /></label>
    <label><span>${t('total_duration_optional')}</span><input id="g-min" type="number" inputmode="numeric" placeholder="—" /></label>

    <div class="chips-label" style="margin-top:14px">${t('exercises')}</div>
    <div id="g-ex-list" class="gym-ex-list"></div>
    <button type="button" id="g-add-ex" class="chip-btn">${t('add_exercise')}</button>

    <div class="muted tiny" id="g-preview" style="margin-top:12px">—</div>
    <label class="check"><input type="checkbox" id="d-fav" /> ${t('save_session')}</label>
  `;

  // Mutable state for gym dialog
  const dlgState = { exercises: [] };

  const renderExList = () => {
    const el = document.getElementById('g-ex-list');
    if (dlgState.exercises.length === 0) {
      el.innerHTML = `<div class="muted tiny empty">${t('no_exercises')}</div>`;
      updatePreview();
      return;
    }
    el.innerHTML = dlgState.exercises.map((ex, ei) => `
      <div class="gym-ex" data-ei="${ei}">
        <div class="gym-ex-head">
          <input class="gym-ex-name" data-ei="${ei}" value="${escapeHtml(ex.name)}" placeholder="${t('exercise_placeholder')}" />
          <button type="button" class="x" data-ei="${ei}" data-act="del-ex">×</button>
        </div>
        <div class="gym-sets">
          ${ex.sets.map((s, si) => `
            <div class="gym-set">
              <span class="set-label">${t('set_n', { n: si + 1 })}</span>
              <input type="number" inputmode="numeric" class="set-reps" data-ei="${ei}" data-si="${si}" value="${s.reps}" placeholder="${t('reps')}" />
              <span class="mul">×</span>
              <input type="number" inputmode="decimal" step="0.5" class="set-kg" data-ei="${ei}" data-si="${si}" value="${s.kg}" placeholder="${t('kg')}" />
              <button type="button" class="x" data-ei="${ei}" data-si="${si}" data-act="del-set">×</button>
            </div>
          `).join('')}
          <button type="button" class="chip-btn small" data-ei="${ei}" data-act="add-set">${t('add_set')}</button>
        </div>
      </div>
    `).join('');
    wireExListEvents();
    updatePreview();
  };

  const wireExListEvents = () => {
    document.querySelectorAll('.gym-ex-name').forEach(i => {
      i.oninput = () => { dlgState.exercises[+i.dataset.ei].name = i.value; };
    });
    document.querySelectorAll('.set-reps').forEach(i => {
      i.oninput = () => {
        dlgState.exercises[+i.dataset.ei].sets[+i.dataset.si].reps = +i.value;
        updatePreview();
      };
    });
    document.querySelectorAll('.set-kg').forEach(i => {
      i.oninput = () => {
        dlgState.exercises[+i.dataset.ei].sets[+i.dataset.si].kg = +i.value;
        updatePreview();
      };
    });
    document.querySelectorAll('[data-act="del-ex"]').forEach(b => {
      b.onclick = () => { dlgState.exercises.splice(+b.dataset.ei, 1); renderExList(); };
    });
    document.querySelectorAll('[data-act="del-set"]').forEach(b => {
      b.onclick = () => {
        dlgState.exercises[+b.dataset.ei].sets.splice(+b.dataset.si, 1);
        renderExList();
      };
    });
    document.querySelectorAll('[data-act="add-set"]').forEach(b => {
      b.onclick = () => {
        const ex = dlgState.exercises[+b.dataset.ei];
        const last = ex.sets[ex.sets.length - 1] || { reps: 10, kg: 20 };
        ex.sets.push({ reps: last.reps, kg: last.kg });
        renderExList();
      };
    });
  };

  const updatePreview = () => {
    const kcal = gymCalories(dlgState.exercises, weight);
    const totalVolume = dlgState.exercises.reduce((s, e) =>
      s + e.sets.reduce((a, x) => a + (x.reps || 0) * (x.kg || 0), 0), 0
    );
    document.getElementById('g-preview').textContent = t('gym_kcal_note', {
      k: kcal, v: Math.round(totalVolume)
    });
  };

  document.getElementById('g-add-ex').onclick = () => {
    dlgState.exercises.push({ name: '', sets: [{ reps: 10, kg: 20 }] });
    renderExList();
  };

  document.getElementById('g-min').addEventListener('input', updatePreview);

  // Session chips → load template
  body.querySelectorAll('#sess-chips .chip').forEach(b => {
    b.onclick = () => {
      const s = sessions[+b.dataset.i];
      document.getElementById('g-name').value = s.name;
      dlgState.exercises = s.exercises.map(e => ({
        name: e.name,
        sets: e.lastSets ? e.lastSets.map(s => ({ ...s })) : [{ reps: 10, kg: 20 }],
      }));
      renderExList();
    };
  });

  // Expose state for submit
  body.__gymState = dlgState;
  renderExList();
}

function submitWorkoutDialog(weight) {
  const activeType = document.querySelector('.wtype.active').dataset.wt;
  const day = ensureDay(todayKey());

  if (activeType === 'cardio') {
    const name = document.getElementById('d-name').value.trim();
    const min = +document.getElementById('d-min').value;
    const intensity = document.getElementById('d-int').value;
    if (!name || !min) return false;
    const met = lookupMET(name) || 5;
    const kcal = exCalories(met, min, intensity, weight);
    day.workouts.push({ id: genId(), type: 'cardio', name, met, minutes: min, intensity, kcal, time: Date.now() });
    if (document.getElementById('d-fav').checked) {
      if (!state.favorites.exercises.find(e => e.name === name)) state.favorites.exercises.push({ name, met });
    }
  } else {
    const name = document.getElementById('g-name').value.trim();
    const min = +document.getElementById('g-min').value || 0;
    const dlgState = document.getElementById('wt-body').__gymState;
    if (!name || dlgState.exercises.length === 0) return false;
    const exercises = dlgState.exercises
      .filter(e => e.name.trim() && e.sets.length > 0)
      .map(e => ({
        name: e.name.trim(),
        sets: e.sets.filter(s => s.reps > 0).map(s => ({ reps: s.reps, kg: s.kg || 0 })),
      }))
      .filter(e => e.sets.length > 0);
    if (exercises.length === 0) return false;
    const kcal = gymCalories(exercises, weight);
    day.workouts.push({
      id: genId(),
      type: 'gym',
      sessionName: name,
      duration: min,
      exercises,
      kcal,
      time: Date.now(),
    });
    if (document.getElementById('d-fav').checked) {
      state.favorites.gymSessions = state.favorites.gymSessions || [];
      // Save template with last-used sets so next time we pre-fill
      const template = {
        name,
        exercises: exercises.map(e => ({ name: e.name, lastSets: e.sets })),
      };
      const existing = state.favorites.gymSessions.findIndex(s => s.name === name);
      if (existing >= 0) state.favorites.gymSessions[existing] = template;
      else state.favorites.gymSessions.push(template);
    }
  }
  saveState(); render();
}

function weighInDialog() {
  const latest = currentWeight();
  openDialog(t('weigh_title'), `
    <label><span>${t('weight_kg')}</span><input id="d-kg" type="number" inputmode="decimal" step="0.1" value="${latest}" /></label>
    <label><span>${t('photo_optional')}</span><input id="d-photo" type="file" accept="image/*" capture="environment" /></label>
    <div id="d-photo-preview" class="muted tiny"></div>
  `, async () => {
    const kg = +document.getElementById('d-kg').value;
    if (!kg || kg < 20 || kg > 300) return false;
    const fileInput = document.getElementById('d-photo');
    let dataUrl = null;
    if (fileInput.files && fileInput.files[0]) {
      try {
        dataUrl = await compressImage(fileInput.files[0]);
      } catch (e) {
        alert(t('photo_read_error'));
      }
    }
    const prevKg = currentWeight();
    const { oldTdee, newTdee } = logWeight(kg, dataUrl);
    const delta = Math.abs(kg - prevKg);
    if (delta >= 2) {
      alert(t('weight_changed_alert', { from: prevKg, to: kg, oldT: oldTdee, newT: newTdee }));
    }
    render();
  });
  document.getElementById('d-photo').addEventListener('change', e => {
    const f = e.target.files[0];
    document.getElementById('d-photo-preview').textContent = f ? t('photo_selected', { name: f.name }) : '';
  });
}

function addPlanDialog() {
  openDialog(t('plan_workout_title'), `
    <label><span>${t('exercise_name')}</span><input id="d-name" /></label>
    <p class="muted tiny">${t('plan_note', { p: SKIP_PENALTY })}</p>
  `, () => {
    const name = document.getElementById('d-name').value.trim();
    if (!name) return false;
    const day = ensureDay(todayKey());
    day.plan = day.plan || [];
    day.plan.push({ id: genId(), name, completed: false });
    saveState(); render();
  });
}

// Favorites are now inline chips inside addMealDialog/addWorkoutDialog.

// ---------- Settings ----------
function openSettings() {
  const p = state.profile;
  document.getElementById('set-weight').value = p.weight;
  document.getElementById('set-age').value = p.age;
  document.getElementById('set-height').value = p.height;
  document.getElementById('set-activity').value = p.activity;
  document.getElementById('set-gender').value = p.gender;
  document.getElementById('set-target').value = p.targetWeight || '';
  const weeksLeft = p.targetDate ? Math.max(1, Math.round(diffDays(todayKey(), p.targetDate) / 7)) : 12;
  document.getElementById('set-weeks').value = weeksLeft;
  document.getElementById('set-protein').value = proteinTarget();
  document.getElementById('set-usda-key').value = p.usdaKey || '';
  renderSettingsFeedback();
  renderFavLists();
  renderResetHistory();
  document.getElementById('settings-modal').classList.remove('hidden');
}

function renderSettingsFeedback() {
  const fb = document.getElementById('set-feedback');
  const profile = {
    gender: document.getElementById('set-gender').value,
    age: +document.getElementById('set-age').value,
    height: +document.getElementById('set-height').value,
    weight: +document.getElementById('set-weight').value,
    activity: +document.getElementById('set-activity').value,
    targetWeight: +document.getElementById('set-target').value,
    targetDate: weeksFromNow(+document.getElementById('set-weeks').value || 12),
  };
  if (!profile.weight || !profile.targetWeight) { fb.innerHTML = ''; return; }
  profile.tdee = calcTDEE(profile);
  const plan = planFromGoal(profile);
  const q = planQuality(profile, plan);
  const rate = +plan.weeklyRate.toFixed(2);
  fb.className = 'goal-feedback ' + q.kind;
  fb.innerHTML = `
    <div class="fb-row"><span>${t('fb_budget')}</span><b>${plan.baseBudget} kcal</b></div>
    <div class="fb-row"><span>${t('fb_rate')}</span><b>${Math.abs(rate)} ${t('kg_per_week')}</b></div>
    <div class="fb-note">${t(q.key)}</div>
  `;
}
function renderResetHistory() {
  const el = document.getElementById('reset-history');
  if (!el) return;
  if (!state.resets || state.resets.length === 0) {
    el.textContent = t('reset_history_empty');
    return;
  }
  const count = state.resets.length;
  const totalErased = state.resets.reduce((s, r) => s + r.debtErased, 0);
  const lines = state.resets.slice(-5).reverse().map(r =>
    '· ' + t('reset_entry', { date: fmtDate(r.date), k: r.debtErased })
  ).join('<br>');
  el.innerHTML = `<b>${t('reset_history_summary', { n: count, total: totalErased })}</b><br>${lines}`;
}

function doDebtReset() {
  const today = todayKey();
  const day = ensureDay(today);
  const erased = day.carryDebt || 0;
  if (erased === 0) { alert(t('reset_no_debt')); return; }
  if (!confirm(t('reset_confirm_1', { k: erased }))) return;
  const typed = prompt(t('reset_confirm_2'));
  if (typed !== 'RESET') { alert(t('reset_mismatch')); return; }
  day.carryDebt = 0;
  state.resets.push({ date: today, debtErased: erased, at: Date.now() });
  saveState(); render(); renderResetHistory();
  alert(t('reset_success', { k: erased }));
}

function renderFavLists() {
  const foodEl = document.getElementById('fav-food-list');
  foodEl.innerHTML = '';
  state.favorites.foods.forEach((f, i) => {
    const div = document.createElement('div');
    div.className = 'fav-row';
    div.innerHTML = `<span>${escapeHtml(f.name)} · ${f.kcal} kcal</span><button class="x" data-i="${i}">×</button>`;
    div.querySelector('button').onclick = () => { state.favorites.foods.splice(i, 1); saveState(); renderFavLists(); };
    foodEl.appendChild(div);
  });
  const exEl = document.getElementById('fav-ex-list');
  exEl.innerHTML = '';
  state.favorites.exercises.forEach((e, i) => {
    const div = document.createElement('div');
    div.className = 'fav-row';
    div.innerHTML = `<span>${escapeHtml(e.name)} · MET ${e.met}</span><button class="x" data-i="${i}">×</button>`;
    div.querySelector('button').onclick = () => { state.favorites.exercises.splice(i, 1); saveState(); renderFavLists(); };
    exEl.appendChild(div);
  });
}

// ---------- Utils ----------
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function timeHHMM(t) { const d = new Date(t); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function intensityLabel(i) { return i === 'low' ? t('low') : i === 'high' ? t('high') : t('medium'); }

// ---------- Wire up ----------
function wire() {
  document.getElementById('add-meal').onclick = () => addMealDialog();
  document.getElementById('add-workout').onclick = () => addWorkoutDialog();
  document.getElementById('add-plan').onclick = addPlanDialog;
  document.getElementById('open-settings').onclick = openSettings;
  document.getElementById('quick-weigh').onclick = weighInDialog;

  // Settings tabs
  document.querySelectorAll('.set-tab').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('.set-tab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      document.querySelectorAll('.set-panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.stab));
    };
  });

  document.querySelectorAll('.htab').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('.htab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      renderHeatmap();
    };
  });
  document.getElementById('close-settings').onclick = () => document.getElementById('settings-modal').classList.add('hidden');

  document.getElementById('set-save').onclick = () => {
    const p = state.profile;
    p.weight = +document.getElementById('set-weight').value;
    p.age = +document.getElementById('set-age').value;
    p.height = +document.getElementById('set-height').value;
    p.activity = +document.getElementById('set-activity').value;
    p.gender = document.getElementById('set-gender').value;
    const target = +document.getElementById('set-target').value;
    const weeks = +document.getElementById('set-weeks').value || 12;
    if (target > 0) {
      p.targetWeight = target;
      p.targetDate = weeksFromNow(weeks);
    }
    const pt = +document.getElementById('set-protein').value;
    p.proteinTarget = pt > 0 ? pt : null;
    p.usdaKey = document.getElementById('set-usda-key').value.trim();
    if (p.targetWeight && p.targetDate) {
      applyGoalToProfile(p);
    } else {
      // Legacy profile without goal — keep manual deficit
      p.tdee = calcTDEE(p);
      p.baseBudget = p.tdee - (p.dailyDeficit || 0);
    }
    saveState(); render();
    alert(t('profile_saved_budget', { b: p.baseBudget }));
  };

  // Live feedback in settings
  ['set-weight', 'set-age', 'set-height', 'set-activity', 'set-gender', 'set-target', 'set-weeks'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderSettingsFeedback);
  });

  document.getElementById('fav-food-add').onclick = () => {
    const name = document.getElementById('fav-food-name').value.trim();
    const kcal = +document.getElementById('fav-food-kcal').value;
    if (!name || !kcal) return;
    state.favorites.foods.push({ name, kcal });
    document.getElementById('fav-food-name').value = '';
    document.getElementById('fav-food-kcal').value = '';
    saveState(); renderFavLists();
  };
  document.getElementById('fav-ex-add').onclick = () => {
    const name = document.getElementById('fav-ex-name').value.trim();
    const met = +document.getElementById('fav-ex-met').value;
    if (!name || !met) return;
    state.favorites.exercises.push({ name, met });
    document.getElementById('fav-ex-name').value = '';
    document.getElementById('fav-ex-met').value = '';
    saveState(); renderFavLists();
  };

  document.getElementById('reset-debt').onclick = doDebtReset;

  document.getElementById('reset-data').onclick = () => {
    if (!confirm(t('wipe_confirm'))) return;
    localStorage.removeItem(LS_KEY);
    location.reload();
  };

  // Language toggle
  document.querySelectorAll('.lang-btn').forEach(b => {
    b.onclick = () => {
      state.lang = b.dataset.lang;
      saveState();
      applyI18n();
      markActiveLang();
      render();
      renderResetHistory();
    };
  });

  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      document.getElementById('tab-' + tab.dataset.tab).classList.remove('hidden');
    };
  });
}

function markActiveLang() {
  const cur = currentLang();
  document.querySelectorAll('.lang-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === cur);
  });
}

// ---------- Boot ----------
function boot() {
  applyI18n();
  markActiveLang();
  initOnboarding();
  wire();
  if (!state.profile) {
    showOnboarding();
  } else {
    showApp();
  }
  // re-render when day changes (user keeps app open across midnight)
  setInterval(() => {
    if (state.profile && state.lastOpenDate !== todayKey()) {
      rollover(); render();
    }
  }, 60000);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () =>
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {})
  );
}

boot();
