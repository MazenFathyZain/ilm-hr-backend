// Demo data. Runs automatically on an empty database; `npm run seed` wipes and re-seeds.
import { pathToFileURL } from 'node:url';
import { db, run, tx } from './index.js';
import { createAdjustment } from '../services/adjustments.js';
import { lateMinutesFor } from '../services/attendance.js';
import { isWorkingDay, holidaySet } from '../services/calendar.js';
import { savePayslip, suggestPayslip } from '../services/payroll.js';
import { createRequest, reviewRequest } from '../services/requests.js';
import { getSettings, upsertHoliday } from '../services/settings.js';
import { createLocation } from '../services/locations.js';
import { createTeam } from '../services/teams.js';
import { createUser } from '../services/users.js';
import { addDays, zonedParts, zonedToUtcIso } from '../utils/time.js';

export const DEMO_PASSWORD = 'password123';

export function seed() {
  const settings = getSettings();
  const today = zonedParts(new Date(), settings.timezone).date;

  tx(() => {
    upsertHoliday({ date: `${today.slice(0, 4)}-10-06`, name: 'Armed Forces Day' });

    const hq = createLocation({ name: 'Cairo HQ – Nasr City', address: 'Abbas El Akkad St, Nasr City, Cairo', latitude: 30.0561, longitude: 31.3301, radius_meters: 150 });
    const giza = createLocation({ name: 'Giza Branch – Dokki', address: 'Tahrir St, Dokki, Giza', latitude: 30.0384, longitude: 31.2108, radius_meters: 150 });
    const village = createLocation({ name: 'Smart Village Office', address: 'Smart Village, 6th of October', latitude: 30.0717, longitude: 31.017, radius_meters: 250 });

    const mk = (u) => createUser({ password: DEMO_PASSWORD, branch: 'فرع القاهرة', hire_date: '2023-01-15', ...u });
    const manager = mk({ name: 'خالد عبد الحميد', email: 'manager@meshkatnour.test', role: 'manager', job_title: 'مدير الموارد البشرية', national_id: '28509011234567', phone: '+201000000900', basic_salary: 35000, location_ids: [hq.id, giza.id, village.id] });
    const leader1 = mk({ name: 'أحمد سمير', email: 'leader@meshkatnour.test', role: 'team_leader', job_title: 'قائد فريق التصميم', national_id: '29002021234567', phone: '+201000000500', basic_salary: 26000, location_ids: [hq.id, village.id] });
    const leader2 = mk({ name: 'منى حسن', email: 'mona@meshkatnour.test', role: 'team_leader', job_title: 'رئيس قسم الحسابات', branch: 'فرع الجيزة', national_id: '28811051234567', phone: '+201000000600', basic_salary: 25000, location_ids: [giza.id] });
    const mohamed = mk({ name: 'محمد عبد الرحمن', email: 'employee@meshkatnour.test', job_title: 'مصمم تجربة المستخدم وواجهة المستخدم', national_id: '29801011234567', phone: '+201000000141', basic_salary: 20000, location_ids: [hq.id, village.id] });
    const youssef = mk({ name: 'يوسف إبراهيم', email: 'youssef@meshkatnour.test', job_title: 'مصمم جرافيك', national_id: '29905051234567', basic_salary: 15000, location_ids: [hq.id] });
    const sara = mk({ name: 'سارة محمود', email: 'sara@meshkatnour.test', job_title: 'محاسبة رواتب', branch: 'فرع الجيزة', national_id: '29903121234567', basic_salary: 16000, location_ids: [giza.id] });
    const omar = mk({ name: 'عمر خالد', email: 'omar@meshkatnour.test', job_title: 'محاسب', branch: 'فرع الجيزة', national_id: '29707071234567', basic_salary: 14000, location_ids: [giza.id, hq.id] });

    createTeam({ name: 'Design', description: 'Product & UX design', leader_id: leader1.id, member_ids: [leader1.id, mohamed.id, youssef.id] });
    createTeam({ name: 'Finance', description: 'Accounting & payroll', leader_id: leader2.id, member_ids: [leader2.id, sara.id, omar.id] });

    // ~4 weeks of attendance history.
    const holidays = holidaySet(addDays(today, -40), today);
    const people = [manager, leader1, leader2, mohamed, youssef, sara, omar];
    let seedN = 7;
    const rand = () => ((seedN = (seedN * 9301 + 49297) % 233280) / 233280);
    for (let i = 28; i >= 1; i--) {
      const date = addDays(today, -i);
      if (!isWorkingDay(date, settings, holidays)) continue;
      for (const p of people) {
        const r = rand();
        if (r < 0.06) continue; // absent
        const loc = p.locations[Math.floor(rand() * p.locations.length)];
        const inMin = 8 * 60 + 40 + Math.floor(r < 0.25 ? 40 + rand() * 50 : rand() * 30);
        const outMin = 17 * 60 + Math.floor(rand() * 45);
        const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        run(
          `INSERT INTO attendance (user_id, work_date, check_in_at, check_in_location_id, check_out_at, check_out_location_id, late_minutes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          p.id, date, zonedToUtcIso(date, hhmm(inMin), settings.timezone), loc.id,
          zonedToUtcIso(date, hhmm(outMin), settings.timezone), loc.id, lateMinutesFor(inMin, settings),
        );
      }
    }

    // Requests in various states.
    const nextWorkday = (from) => { let d = from; while (!isWorkingDay(d, settings, holidays)) d = addDays(d, 1); return d; };
    const soon = nextWorkday(addDays(today, 7));
    createRequest(mohamed.id, { type: 'leave', leave_type: 'annual', start_date: soon, end_date: addDays(soon, 2), reason: 'إجازة عائلية' });
    createRequest(youssef.id, { type: 'overtime', start_date: addDays(today, -3), hours: 3, reason: 'تسليم مشروع' });
    createRequest(sara.id, { type: 'early_leave', start_date: nextWorkday(addDays(today, 1)), start_time: '14:00', reason: 'موعد طبي' });
    createRequest(omar.id, { type: 'allowance', amount: 450, reason: 'بدل انتقال لزيارة عميل' });
    createRequest(leader1.id, { type: 'leave', leave_type: 'casual', start_date: nextWorkday(addDays(today, 3)), end_date: nextWorkday(addDays(today, 3)), reason: 'ظرف طارئ' });

    const past = nextWorkday(addDays(today, -20));
    const a = createRequest(mohamed.id, { type: 'mission', start_date: past, end_date: past, destination: 'Alexandria client office', reason: 'ورشة عمل' });
    reviewRequest(leader1, a.id, 'approved', 'Good luck');
    const b = createRequest(sara.id, { type: 'leave', leave_type: 'annual', start_date: nextWorkday(addDays(today, -14)), end_date: nextWorkday(addDays(today, -14)), reason: 'شأن خاص' });
    reviewRequest(leader2, b.id, 'approved');
    const c = createRequest(youssef.id, { type: 'leave', leave_type: 'casual', start_date: nextWorkday(addDays(today, 14)), end_date: nextWorkday(addDays(today, 14)) });
    reviewRequest(leader1, c.id, 'rejected', 'Release week – please pick another day');
    createRequest(omar.id, { type: 'complaint', reason: 'التكييف في مكتب الجيزة لا يعمل' });

    createAdjustment(manager, { user_id: mohamed.id, kind: 'reward', amount: 1000, reason: 'Excellent delivery of the mobile redesign', date: addDays(today, -10) });
    createAdjustment(manager, { user_id: omar.id, kind: 'penalty', amount: 200, reason: 'Repeated late arrivals', date: addDays(today, -5) });

    // Published payslip for last month for everyone.
    const lastMonth = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
    for (const p of people) {
      const s = suggestPayslip(p.id, lastMonth);
      savePayslip({
        ...s,
        earnings: { ...s.earnings, transport_allowance: 500, living_allowance: 300 },
        deductions: { ...s.deductions, monthly_tax: Math.round(p.basic_salary * 0.1), social_insurance: Math.round(p.basic_salary * 0.11), health_insurance: 150 },
        status: 'published',
      });
    }
    run("UPDATE documents SET status = 'approved' WHERE title IN ('National ID copy', 'Birth certificate')");
  });
}

function reset() {
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['notifications', 'documents', 'payslips', 'adjustments', 'requests', 'attendance', 'user_locations', 'locations', 'users', 'teams', 'holidays']) {
    db.exec(`DELETE FROM ${t}`);
  }
  db.exec('PRAGMA foreign_keys = ON');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--reset')) reset();
  seed();
  console.log(`Seeded demo data. All demo accounts use the password "${DEMO_PASSWORD}".`);
}
