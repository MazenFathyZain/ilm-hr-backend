// Create a user from the command line – e.g. the first manager on a fresh server.
//   npm run create-user -- --name "Khaled" --email khaled@ilm.sa --password 'S3cret!' --role manager
import { parseArgs } from 'node:util';
import { createUser, ROLES } from '../services/users.js';
import { closeDb, initDb } from './index.js';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    email: { type: 'string' },
    password: { type: 'string' },
    role: { type: 'string', default: 'manager' },
    'job-title': { type: 'string' },
    phone: { type: 'string' },
  },
});

if (!values.name || !values.email || !values.password) {
  console.error('Usage: npm run create-user -- --name "Full Name" --email user@example.com --password "secret" [--role manager|team_leader|employee] [--job-title "..."] [--phone "..."]');
  process.exit(1);
}
if (!ROLES.includes(values.role)) {
  console.error(`--role must be one of: ${ROLES.join(', ')}`);
  process.exit(1);
}

try {
  await initDb();
  const user = await createUser({
    name: values.name, email: values.email, password: values.password, role: values.role,
    job_title: values['job-title'], phone: values.phone,
  });
  console.log(`Created ${user.role} "${user.name}" <${user.email}> (id ${user.id}, code ${user.employee_code}).`);
} catch (err) {
  console.error(`Could not create user: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
