import { addDays, eachDay } from '../utils/time.js';

/** Calculate employee-day totals from the already scoped attendance and schedule data. */
export function calculatePeriodStats({ from, to, today, users, records, breaks, leave, holidays, scheduleForUser, isWorkingDay }) {
  const totals = { from, to, worked_hours: 0, attendance_days: 0, absent_days: 0, late_days: 0, excused_days: 0, attendance_rate: 0 };
  const attended = new Set();
  const awayByRecord = new Map(breaks.map((b) => [b.attendance_id, Number(b.seconds_away)]));
  let workedSeconds = 0;
  for (const record of records) {
    attended.add(`${record.user_id}:${record.work_date}`);
    totals.attendance_days++;
    if (record.late_minutes > 0) totals.late_days++;
    if (record.check_out_at) {
      const duration = (Date.parse(record.check_out_at) - Date.parse(record.check_in_at)) / 1000;
      workedSeconds += Math.max(0, duration - (awayByRecord.get(record.id) ?? 0));
    }
  }
  totals.worked_hours = Math.round(workedSeconds / 360) / 10;

  const excused = new Set();
  for (const request of leave) {
    const start = request.start_date > from ? request.start_date : from;
    const end = request.end_date < to ? request.end_date : to;
    for (const date of eachDay(start, end)) excused.add(`${request.user_id}:${date}`);
  }

  const lastFinishedDay = addDays(today, -1);
  const countTo = to < lastFinishedDay ? to : lastFinishedDay;
  let expectedDays = 0;
  let attendedWorkdays = 0;
  for (const user of users) {
    const start = user.hire_date ?? user.created_at?.slice(0, 10) ?? from;
    const countFrom = from > start ? from : start;
    const schedule = scheduleForUser(user);
    for (const date of eachDay(countFrom, countTo)) {
      if (!isWorkingDay(date, schedule, holidays)) continue;
      const key = `${user.id}:${date}`;
      if (attended.has(key)) { expectedDays++; attendedWorkdays++; }
      else if (excused.has(key)) totals.excused_days++;
      else { expectedDays++; totals.absent_days++; }
    }
  }
  totals.attendance_rate = expectedDays ? Math.round((attendedWorkdays / expectedDays) * 100) : 0;
  return totals;
}
