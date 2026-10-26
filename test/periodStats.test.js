import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePeriodStats } from '../src/services/periodStats.js';
import { weekday } from '../src/utils/time.js';

const isWorkingDay = (date, schedule, holidays) =>
  !schedule.weekend_days.includes(weekday(date)) && !holidays.has(date);

test('period totals respect completed shifts, breaks, leave, holidays, hire dates and weekends', () => {
  const totals = calculatePeriodStats({
    from: '2026-10-19', to: '2026-10-26', today: '2026-10-26',
    users: [
      { id: 1, hire_date: '2026-10-19' },
      { id: 2, hire_date: '2026-10-25' },
    ],
    records: [
      { id: 11, user_id: 1, work_date: '2026-10-19', check_in_at: '2026-10-19T09:00:00Z', check_out_at: '2026-10-19T17:00:00Z', late_minutes: 0 },
      { id: 12, user_id: 1, work_date: '2026-10-20', check_in_at: '2026-10-20T09:30:00Z', check_out_at: null, late_minutes: 30 },
      { id: 13, user_id: 1, work_date: '2026-10-23', check_in_at: '2026-10-23T09:00:00Z', check_out_at: '2026-10-23T17:00:00Z', late_minutes: 0 },
      { id: 14, user_id: 2, work_date: '2026-10-25', check_in_at: '2026-10-25T09:00:00Z', check_out_at: '2026-10-25T17:00:00Z', late_minutes: 0 },
    ],
    breaks: [{ attendance_id: 11, seconds_away: 3600 }],
    leave: [{ user_id: 1, start_date: '2026-10-21', end_date: '2026-10-21' }],
    holidays: new Set(['2026-10-22']),
    scheduleForUser: () => ({ weekend_days: [5, 6] }),
    isWorkingDay,
  });

  assert.deepEqual(totals, {
    from: '2026-10-19', to: '2026-10-26', worked_hours: 23,
    attendance_days: 4, absent_days: 1, late_days: 1, excused_days: 1, attendance_rate: 75,
  });
});

test('empty scope returns zero totals', () => {
  const totals = calculatePeriodStats({
    from: '2026-10-01', to: '2026-10-26', today: '2026-10-26',
    users: [], records: [], breaks: [], leave: [], holidays: new Set(),
    scheduleForUser: () => ({ weekend_days: [5, 6] }), isWorkingDay,
  });
  assert.equal(totals.worked_hours, 0);
  assert.equal(totals.absent_days, 0);
  assert.equal(totals.attendance_rate, 0);
});
