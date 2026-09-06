// The date, period and strength math, exercised through getState() with an explicit
// reference day.
// The week used throughout is Mon 2026-08-24 … Sun 2026-08-30.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadServer, reset, addHabit, daysBefore } from './helpers.mjs';

const MON = '2026-08-24', TUE = '2026-08-25', WED = '2026-08-26', THU = '2026-08-27';
const FRI = '2026-08-28', SAT = '2026-08-29', SUN = '2026-08-30';
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [6, 0];

let srv, db, getState;
before(async () => {
  srv = await loadServer();
  db = srv.mod.db;
  getState = srv.mod.getState;
});
after(() => srv.cleanup());
beforeEach(() => { reset(db); srv.mod.invalidateState(); });

const only = (t) => getState(t).habits[0];
const doneCount = (t) => getState(t).habits.filter(h => h.done_now).length;
// What the ring reads: only the habits scheduled for the day count, on either side.
const ring = (t) => {
  const due = getState(t).habits.filter(h => h.due_now);
  return due.filter(h => h.done_now).length + '/' + due.length;
};

describe('daily habits', () => {
  test('done_now follows the check-in for the day asked about', () => {
    addHabit(db, { name: 'Read', checked: [SAT] });
    assert.equal(only(SAT).done_now, true);
    assert.equal(only(SUN).done_now, false);
  });

  test('the total counts every check-in, gaps and all', () => {
    addHabit(db, { name: 'Read', checked: [MON, TUE, WED, FRI, SAT, SUN] });
    assert.equal(only(SUN).total, 6);
  });

  test('a skip does not count toward the total', () => {
    addHabit(db, { name: 'Read', checked: [FRI, SUN], skipped: [SAT] });
    const h = only(SUN);
    assert.equal(h.total, 2, 'a skip is not a check-in');
  });
});

describe('any-of-weekday habits', () => {
  test('a day the habit is not scheduled for counts as done', () => {
    // The reported bug: an unmet Mon–Fri habit dragged the Sunday count down, on a day
    // its cells cannot even be tapped.
    addHabit(db, { name: 'Running', mode: 'any', days: WEEKDAYS });
    assert.equal(only(SUN).done_now, true, 'not due on Sunday, so nothing is outstanding');
    assert.equal(only(SAT).done_now, true, 'nor on Saturday');
  });

  test('an unmet period is still outstanding on the days it is scheduled', () => {
    addHabit(db, { name: 'Running', mode: 'any', days: WEEKDAYS });
    for (const d of [MON, TUE, WED, THU, FRI]) {
      assert.equal(only(d).done_now, false, d + ' is a scheduled day and the period is unmet');
    }
  });

  test('one hit satisfies the whole period', () => {
    addHabit(db, { name: 'Running', mode: 'any', days: WEEKDAYS, checked: [MON] });
    assert.equal(only(WED).done_now, true, 'Monday already satisfied this Mon–Fri period');
    assert.equal(only(FRI).done_now, true);
    assert.equal(only(SUN).done_now, true);
  });

  test('one hit removes the remaining weekdays from the current targets', () => {
    addHabit(db, { name: 'Running', mode: 'any', days: WEEKDAYS, checked: [MON] });
    assert.equal(only(TUE).due_now, false, 'Monday already fulfilled this weekly target');
    assert.equal(only(FRI).due_now, false);
  });

  test('the next period starts outstanding again', () => {
    addHabit(db, { name: 'Running', mode: 'any', days: WEEKDAYS, checked: [MON] });
    assert.equal(only('2026-08-31').done_now, false, 'a new Mon–Fri week, nothing done in it yet');
  });

  test('Saturday and Sunday form one wrap-around period', () => {
    const { weekRuns } = srv.mod;
    assert.deepEqual(weekRuns(WEEKEND), [[6, 7]], 'Sat+Sun is a single run, not two');
    addHabit(db, { name: 'Gym', mode: 'any', days: WEEKEND, checked: [SAT] });
    assert.equal(only(SAT).done_now, true);
    assert.equal(only(SUN).done_now, true, 'Saturday covers the same weekend period');
  });

  test('one check-in a week keeps the whole week scoring', () => {
    addHabit(db, {
      name: 'Running', mode: 'any', days: WEEKDAYS,
      checked: ['2026-08-11', '2026-08-18', MON]   // three consecutive Mon–Fri weeks
    });
    const h = only(FRI);
    assert.equal(h.total, 3);
    assert.ok(h.score > 0, 'three periods in a row is a rising score: ' + h.score);
  });

  test('a missed week costs, without wiping out the weeks before it', () => {
    const three = ['2026-08-15', '2026-08-22', '2026-08-29'];
    addHabit(db, { name: 'Gym', mode: 'any', days: WEEKEND, checked: three });
    const kept = only(SUN).score;
    reset(db); srv.mod.invalidateState();
    // The weekend of the 8th instead of the 22nd: same three check-ins, one gap.
    addHabit(db, { name: 'Gym', mode: 'any', days: WEEKEND, checked: ['2026-08-01', '2026-08-08', '2026-08-29'] });
    const gapped = only(SUN).score;
    assert.ok(gapped < kept, 'the gap costs: ' + gapped + ' vs ' + kept);
    assert.ok(gapped > 0, 'but the earlier weekends still count');
  });
});

describe('all-of-weekday habits', () => {
  test('a day the habit is not scheduled for counts as done', () => {
    addHabit(db, { name: 'Log Worklog', mode: 'all', days: WEEKDAYS });
    assert.equal(only(SUN).done_now, true);
  });

  test('every scheduled day has to be checked', () => {
    addHabit(db, { name: 'Log Worklog', mode: 'all', days: WEEKDAYS, checked: [MON] });
    assert.equal(only(MON).done_now, true);
    assert.equal(only(TUE).done_now, false);
  });

  test('the weekend costs nothing on a weekdays-only habit', () => {
    addHabit(db, { name: 'Log Worklog', mode: 'all', days: WEEKDAYS, checked: [THU, FRI] });
    assert.equal(only(FRI).score, only(SUN).score, 'the unscheduled weekend leaves it where Friday did');
  });

  test('a missed scheduled day costs', () => {
    addHabit(db, { name: 'Log Worklog', mode: 'all', days: WEEKDAYS, checked: [MON, TUE, WED, THU, FRI] });
    const kept = only(FRI).score;
    reset(db); srv.mod.invalidateState();
    addHabit(db, { name: 'Log Worklog', mode: 'all', days: WEEKDAYS, checked: [MON, WED, THU, FRI] });
    const missed = only(FRI).score;
    assert.ok(missed < kept, 'Tuesday was missed: ' + missed + ' vs ' + kept);
  });
});

describe('the reported board', () => {
  // Rebuilds the screenshot that started this: Sunday 2026-08-30, with every habit that
  // was actually due that day checked off. The ring read 7/8.
  beforeEach(() => {
    const weekSoFar = [MON, TUE, WED, THU, SAT, SUN];
    for (const n of ['Launch Ableton Live', 'Launch App for Podcast', 'Launch Kindle', "Launch O'reilly"]) {
      addHabit(db, { name: n, checked: weekSoFar });
    }
    addHabit(db, { name: 'Running', mode: 'any', days: WEEKDAYS });
    addHabit(db, { name: 'Dont eat snack', mode: 'all', days: WEEKDAYS, checked: [MON, TUE] });
    addHabit(db, { name: 'Log Worklog', mode: 'all', days: WEEKDAYS, checked: [MON, THU] });
    addHabit(db, { name: 'Mustle Training', mode: 'any', days: WEEKEND, checked: [SUN] });
  });

  test('everything due on the Sunday is done, so the ring is full', () => {
    const st = getState(SUN);
    assert.equal(st.habits.length, 8);
    assert.equal(doneCount(SUN), 8, st.habits.filter(h => !h.done_now).map(h => h.name).join(', ') + ' still counted as outstanding');
  });

  test('the weekday habits are outstanding again on the Monday', () => {
    const outstanding = getState('2026-08-31').habits.filter(h => !h.done_now).map(h => h.name);
    assert.deepEqual(outstanding.sort(), ['Dont eat snack', 'Launch Ableton Live', 'Launch App for Podcast',
      'Launch Kindle', "Launch O'reilly", 'Log Worklog', 'Running']);
  });

  test('only the habits scheduled for the day are due', () => {
    const sunday = getState(SUN).habits.filter(h => h.due_now).map(h => h.name);
    assert.deepEqual(sunday.sort(), ['Launch Ableton Live', 'Launch App for Podcast', 'Launch Kindle',
      'Mustle Training', "Launch O'reilly"].sort(), 'the Mon-Fri habits are not targets on a Sunday');

    const monday = getState('2026-08-31').habits.filter(h => h.due_now).map(h => h.name);
    assert.deepEqual(monday.sort(), ['Dont eat snack', 'Launch Ableton Live', 'Launch App for Podcast',
      'Launch Kindle', "Launch O'reilly", 'Log Worklog', 'Running'], 'the weekend habit is not a target on a Monday');
  });

  test('the ring counts the day\'s targets, not every habit', () => {
    // The reported bug: 8 habits on the board, only 7 of them targets on the Monday,
    // and the ring still read out of 8 - counting a weekend habit as both due and done.
    assert.equal(getState('2026-08-31').habits.length, 8);
    assert.equal(ring('2026-08-31'), '0/7');
    assert.equal(ring(SUN), '5/5', 'everything due on the Sunday is done');
  });
});

// The strength is the app's one number for how well a habit is being kept. The
// reference values are uhabits' own — a perfectly kept daily habit is at 80% after a
// month, 96% after two, 99% after three.
describe('habit strength', () => {
  // `n` days ending on (and including) SUN.
  const run = (n, endOffset = 0) => {
    const out = [];
    for (let i = n - 1 + endOffset; i >= endOffset; i--) out.push(daysBefore(SUN, i));
    return out;
  };
  const weekdaysIn = (dates) => dates.filter(d => WEEKDAYS.includes(new Date(d + 'T12:00:00').getDay()));

  test('a perfectly kept daily habit follows the uhabits curve', () => {
    addHabit(db, { name: '30d', checked: run(30) });
    assert.equal(only(SUN).score, 80);
    reset(db); srv.mod.invalidateState();
    addHabit(db, { name: '60d', checked: run(60) });
    assert.equal(only(SUN).score, 96);
    reset(db); srv.mod.invalidateState();
    addHabit(db, { name: '90d', checked: run(90) });
    assert.equal(only(SUN).score, 99);
  });

  test('a habit with no history scores 0', () => {
    addHabit(db, { name: 'New' });
    const h = only(SUN);
    assert.equal(h.score, 0);
    assert.deepEqual(h.score_history, [], 'nothing to draw yet');
  });

  test('a run of misses dents the score instead of erasing it', () => {
    // Kept for 30 days, then missed the last three.
    addHabit(db, { name: 'Read', checked: run(30, 3) });
    const h = only(SUN);
    assert.ok(h.score > 60, 'the strength keeps most of the month it earned: ' + h.score);
    assert.ok(h.score < 80, 'but it is below where it stood: ' + h.score);
  });

  test('a skipped day leaves the score exactly where it was', () => {
    // 27 kept days, then three skipped ones: a skip neither earns nor costs.
    addHabit(db, { name: 'Read', checked: run(27, 3), skipped: run(3) });
    assert.equal(only(SUN).score, only(daysBefore(SUN, 3)).score);
  });

  test('an unchecked today does not drop the score yet', () => {
    addHabit(db, { name: 'Read', checked: run(30, 1) });
    const h = only(SUN);
    assert.equal(h.done_now, false);
    assert.equal(h.score, only(daysBefore(SUN, 1)).score, 'still open, so nothing is deducted');
  });

  test('the history is one score per day, ending on the reference day', () => {
    addHabit(db, { name: 'Read', checked: run(45) });
    const h = only(SUN);
    assert.equal(h.score_history.length, 45, 'one per day since the first check-in');
    assert.equal(h.score_history[44], h.score, 'the last entry is today');
    assert.equal(h.score_history[43], only(daysBefore(SUN, 1)).score, 'the one before it is yesterday');
    assert.ok(h.score_history[0] < h.score_history[44], 'a kept habit climbs');
  });

  test('an all-of-weekday habit is not penalized for its off days', () => {
    addHabit(db, { name: 'Gym', mode: 'all', days: WEEKDAYS, checked: weekdaysIn(run(28)) });
    const kept = only(SUN);
    assert.ok(kept.score > 60, 'four perfect weeks of weekdays: ' + kept.score);
    reset(db); srv.mod.invalidateState();
    // Same four weeks with one weekday missed.
    const missed = weekdaysIn(run(28)).filter(d => d !== daysBefore(SUN, 9));
    addHabit(db, { name: 'Gym', mode: 'all', days: WEEKDAYS, checked: missed });
    assert.ok(only(SUN).score < kept.score, 'a missed weekday costs something');
  });

  test('an any-of-weekday habit scores per period, not per day', () => {
    // One Wednesday a week for four weeks satisfies every weekday period.
    const weds = run(28).filter(d => new Date(d + 'T12:00:00').getDay() === 3);
    addHabit(db, { name: 'Run', mode: 'any', days: WEEKDAYS, checked: weds });
    const kept = only(SUN);
    assert.ok(kept.score > 0);
    reset(db); srv.mod.invalidateState();
    addHabit(db, { name: 'Run', mode: 'any', days: WEEKDAYS, checked: weds.slice(0, -1) });
    const skippedWeek = only(SUN);
    assert.ok(skippedWeek.score < kept.score, 'a missed period costs something');
    assert.ok(skippedWeek.score > 0, 'but the earlier weeks still count');
  });
});

describe('state shape', () => {
  test('sliceState clips the date arrays but keeps the totals', () => {
    const t = srv.mod.today();
    addHabit(db, { name: 'Read', checked: [daysBefore(t, 1), daysBefore(t, 400)] });
    const full = getState(t);
    assert.equal(full.habits[0].days.length, 2);
    const sliced = srv.mod.sliceState(full, 180);
    assert.deepEqual(sliced.habits[0].days, [daysBefore(t, 1)]);
    assert.equal(sliced.habits[0].total, 2, 'the total is over the full history either way');
    assert.equal(sliced.habits[0].score, full.habits[0].score, 'so is the score');
  });

  test('the score history is capped at the board window and clipped with it', () => {
    const t = srv.mod.today();
    addHabit(db, { name: 'Read', checked: [daysBefore(t, 1), daysBefore(t, 400)] });
    const full = getState(t);
    assert.equal(full.habits[0].score_history.length, 180, 'a year of history, one board window shipped');
    const sliced = srv.mod.sliceState(full, 30);
    const h = sliced.habits[0];
    assert.equal(h.score_history.length, 31, 'the last 30 days plus today');
    assert.equal(h.score_history[30], h.score, 'still ends on the reference day');
  });

  test('archived habits drop out of the state', () => {
    const id = addHabit(db, { name: 'Read' });
    db.prepare('UPDATE habits SET archived=1 WHERE id=?').run(id);
    assert.equal(getState(SUN).habits.length, 0);
  });

  test('parseAnyDays keeps weekday numbers and rejects everything else', () => {
    const { parseAnyDays } = srv.mod;
    assert.deepEqual(parseAnyDays([1, 2, 3]), [1, 2, 3]);
    assert.deepEqual(parseAnyDays([0, 6]), [0, 6]);
    assert.equal(parseAnyDays([]), null);
    assert.equal(parseAnyDays([7, -1, 'x', 1.5]), null);
    assert.equal(parseAnyDays(null), null);
    assert.equal(parseAnyDays('1,2'), null);
  });
});
