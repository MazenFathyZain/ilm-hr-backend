import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePeriodStats } from '../src/services/periodStats.js';
import { weekday } from '../src/utils/time.js';

const isWorkingDay = (date, schedule, holidays) =>
  !schedule.weekend_days.includes(weekday(date)) && !holidays.has(date);

test('period statistics stay separate for each employee and respect attendance rules', () => {
  const period = calculatePeriodStats({
    from: '2026-10-19', to: '2026-10-26', today: '2026-10-26',
    users: [
      { id: 1, name: 'First', employee_code: 'E001', team_name: 'Design', avatar_url: null, hire_date: '2026-10-19' },
      { id: 2, name: 'Second', employee_code: 'E002', team_name: 'Finance', avatar_url: null, hire_date: '2026-10-25' },
    ],
    records: [
      { id: 11, user_id: 1, work_date: '2026-10-19', check_in_at: '2026-10-19T09:00:00Z', check_out_at: '2026-10-19T17:00:00Z', late_minutes: 0 },
      { id: 12, user_id: 1, work_date: '2026-10-20', check_in_at: '2026-10-20T09:30:00Z', check_out_at: null, late_minutes: 30 },
      { id: 13, user_id: 1, work_date: '2026-10-23', check_in_at: '2026-10-23T09:00:00Z', check_out_at: '2026-10-23T17:00:00Z', late_minutes: 0 },
      { id: 14, user_id: 2, work_date: '2026-10-25', check_in_at: '2026-10-25T09:00:00Z', check_out_at: '2026-10-25T17:00:00Z', late_minutes: 0 },
    ],
    breaks: [{ attendance_id: 11, seconds_away: 2400 }],
    leave: [{ user_id: 1, start_date: '2026-10-21', end_date: '2026-10-21' }],
    holidays: new Set(['2026-10-22']),
    scheduleForUser: () => ({ weekend_days: [5, 6] }),
    isWorkingDay,
  });

  assert.deepEqual(period, {
    from: '2026-10-19', to: '2026-10-26', employees: [
      {
        user_id: 1, name: 'First', employee_code: 'E001', team_name: 'Design', avatar_url: null,
        worked_hours: 15.3, average_hours_per_day: 7.7, worked_minutes: 920, average_minutes_per_day: 460,
        attendance_days: 3, absent_days: 1, late_days: 1, excused_days: 1, attendance_rate: 67,
      },
      {
        user_id: 2, name: 'Second', employee_code: 'E002', team_name: 'Finance', avatar_url: null,
        worked_hours: 8, average_hours_per_day: 8, worked_minutes: 480, average_minutes_per_day: 480,
        attendance_days: 1, absent_days: 0, late_days: 0, excused_days: 0, attendance_rate: 100,
      },
    ],
  });
});

test('average hours are zero when an employee has no completed workday', () => {
  const period = calculatePeriodStats({
    from: '2026-10-26', to: '2026-10-26', today: '2026-10-26',
    users: [{ id: 3, name: 'Third', hire_date: '2026-10-26' }],
    records: [{ id: 15, user_id: 3, work_date: '2026-10-26', check_in_at: '2026-10-26T09:00:00Z', check_out_at: null, late_minutes: 0 }],
    breaks: [], leave: [], holidays: new Set(),
    scheduleForUser: () => ({ weekend_days: [5, 6] }), isWorkingDay,
  });
  assert.equal(period.employees[0].attendance_days, 1);
  assert.equal(period.employees[0].average_hours_per_day, 0);
  assert.equal(period.employees[0].average_minutes_per_day, 0);
});

test('empty scope returns no employee rows', () => {
  const period = calculatePeriodStats({
    from: '2026-10-01', to: '2026-10-26', today: '2026-10-26',
    users: [], records: [], breaks: [], leave: [], holidays: new Set(),
    scheduleForUser: () => ({ weekend_days: [5, 6] }), isWorkingDay,
  });
  assert.deepEqual(period, { from: '2026-10-01', to: '2026-10-26', employees: [] });
});
