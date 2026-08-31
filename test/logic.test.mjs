// The date/streak math, exercised through getState() with an explicit reference day.
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

describe('daily habits', () => {
  test('done_now follows the check-in for the day asked about', () => {
    addHabit(db, { name: 'Read', checked: [SAT] });
    assert.equal(only(SAT).done_now, true);
    assert.equal(only(SUN).done_now, false);
  });

  test('the streak walks back from the reference day', () => {
    addHabit(db, { name: 'Read', checked: [THU, FRI, SAT, SUN] });
    assert.equal(only(SUN).streak, 4);
  });

  test('an unchecked today keeps yesterday-ending streaks alive', () => {
    addHabit(db, { name: 'Read', checked: [FRI, SAT] });
    const h = only(SUN);
    assert.equal(h.done_now, false);
    assert.equal(h.streak, 2, 'today is still open, so the streak is not broken yet');
  });

  test('a gap ends the streak but not the longest', () => {
    addHabit(db, { name: 'Read', checked: [MON, TUE, WED, FRI, SAT, SUN] });
    const h = only(SUN);
    assert.equal(h.streak, 3);
    assert.equal(h.longest, 3);
    assert.equal(h.total, 6);
  });

  test('skips bridge a streak without counting toward the total', () => {
    addHabit(db, { name: 'Read', checked: [FRI, SUN], skipped: [SAT] });
    const h = only(SUN);
    assert.equal(h.streak, 3);
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

  test('the streak counts periods, not days', () => {
    addHabit(db, {
      name: 'Running', mode: 'any', days: WEEKDAYS,
      checked: ['2026-08-11', '2026-08-18', MON]   // three consecutive Mon–Fri weeks
    });
    const h = only(FRI);
    assert.equal(h.streak, 3);
    assert.equal(h.longest, 3);
    assert.equal(h.total, 3);
  });

  test('the longest run counts across week boundaries', () => {
    // One period per week, so consecutive weeks have to come out adjacent.
    addHabit(db, { name: 'Gym', mode: 'any', days: WEEKEND, checked: ['2026-08-15', '2026-08-22', '2026-08-29'] });
    assert.equal(only(SUN).longest, 3, 'three consecutive weekends');
  });

  test('the longest run stops at a missed period', () => {
    addHabit(db, { name: 'Gym', mode: 'any', days: WEEKEND, checked: ['2026-08-01', '2026-08-15', '2026-08-22'] });
    assert.equal(only(SUN).longest, 2, 'the weekend of the 8th was missed');
  });

  test('a missed week breaks the period streak', () => {
    addHabit(db, { name: 'Running', mode: 'any', days: WEEKDAYS, checked: ['2026-08-11', MON] });
    assert.equal(only(FRI).streak, 1, 'the week of the 17th was missed');
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

  test('the streak bridges over days that are not scheduled', () => {
    addHabit(db, { name: 'Log Worklog', mode: 'all', days: WEEKDAYS, checked: [THU, FRI] });
    assert.equal(only(SUN).streak, 2, 'the weekend is not scheduled, so it does not break Thu–Fri');
  });

  test('a missed scheduled day ends the streak', () => {
    addHabit(db, { name: 'Log Worklog', mode: 'all', days: WEEKDAYS, checked: [MON, WED, THU, FRI] });
    assert.equal(only(FRI).streak, 3, 'Tuesday was missed');
    assert.equal(only(FRI).longest, 3);
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
