import { addDays, eachDay } from '../utils/time.js';

/** Calculate a separate set of period statistics for each already scoped employee. */
export function calculatePeriodStats({ from, to, today, users, records, breaks, leave, holidays, scheduleForUser, isWorkingDay }) {
  const employees = users.map((user) => ({
    user_id: user.id,
    name: user.name,
    employee_code: user.employee_code,
    team_name: user.team_name,
    avatar_url: user.avatar_url,
    worked_hours: 0,
    average_hours_per_day: 0,
    worked_minutes: 0,
    average_minutes_per_day: 0,
    attendance_days: 0,
    absent_days: 0,
    late_days: 0,
    excused_days: 0,
    attendance_rate: 0,
  }));
  const byUser = new Map(employees.map((employee) => [employee.user_id, employee]));
  const attended = new Set();
  const awayByRecord = new Map(breaks.map((b) => [b.attendance_id, Number(b.seconds_away)]));
  const workedSeconds = new Map();
  const completedDays = new Map();
  for (const record of records) {
    const employee = byUser.get(record.user_id);
    if (!employee) continue;
    attended.add(`${record.user_id}:${record.work_date}`);
    employee.attendance_days++;
    if (record.late_minutes > 0) employee.late_days++;
    if (record.check_out_at) {
      const duration = (Date.parse(record.check_out_at) - Date.parse(record.check_in_at)) / 1000;
      workedSeconds.set(record.user_id, (workedSeconds.get(record.user_id) ?? 0) + Math.max(0, duration - (awayByRecord.get(record.id) ?? 0)));
      completedDays.set(record.user_id, (completedDays.get(record.user_id) ?? 0) + 1);
    }
  }
  for (const employee of employees) {
    const seconds = workedSeconds.get(employee.user_id) ?? 0;
    const days = completedDays.get(employee.user_id) ?? 0;
    employee.worked_minutes = Math.round(seconds / 60);
    employee.average_minutes_per_day = days ? Math.round(seconds / days / 60) : 0;
    employee.worked_hours = Math.round(seconds / 360) / 10;
    employee.average_hours_per_day = days ? Math.round(seconds / days / 360) / 10 : 0;
  }

  const excused = new Set();
  for (const request of leave) {
    const start = request.start_date > from ? request.start_date : from;
    const end = request.end_date < to ? request.end_date : to;
    for (const date of eachDay(start, end)) excused.add(`${request.user_id}:${date}`);
  }

  const lastFinishedDay = addDays(today, -1);
  const countTo = to < lastFinishedDay ? to : lastFinishedDay;
  for (const user of users) {
    const employee = byUser.get(user.id);
    const start = user.hire_date ?? user.created_at?.slice(0, 10) ?? from;
    const countFrom = from > start ? from : start;
    const schedule = scheduleForUser(user);
    let expectedDays = 0;
    let attendedWorkdays = 0;
    for (const date of eachDay(countFrom, countTo)) {
      if (!isWorkingDay(date, schedule, holidays)) continue;
      const key = `${user.id}:${date}`;
      if (attended.has(key)) { expectedDays++; attendedWorkdays++; }
      else if (excused.has(key)) employee.excused_days++;
      else { expectedDays++; employee.absent_days++; }
    }
    employee.attendance_rate = expectedDays ? Math.round((attendedWorkdays / expectedDays) * 100) : 0;
  }
  return { from, to, employees };
}
