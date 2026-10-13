// Notification texts in Arabic and English. Each template receives the raw values and returns
// { title, body } in the recipient's language (users.locale, reported by the app when it registers).

const REQUEST_TYPES = {
  en: { leave: 'leave', allowance: 'allowance', mission: 'mission', early_leave: 'early leave', overtime: 'overtime', complaint: 'complaint' },
  ar: { leave: 'إجازة', allowance: 'بدل', mission: 'مأمورية', early_leave: 'إذن انصراف', overtime: 'وقت إضافي', complaint: 'شكوى' },
};
const DOC_STATUS = {
  en: { approved: 'approved', rejected: 'rejected' },
  ar: { approved: 'تم اعتماد', rejected: 'تم رفض' },
};
const withNote = (text, note, lang) => (note ? `${text}${lang === 'ar' ? ' – ' : ': '}${note}` : text);

export const MESSAGES = {
  request_submitted: {
    en: (v) => ({ title: `New ${REQUEST_TYPES.en[v.type]} request`, body: `${v.name} submitted request #${v.id}.` }),
    ar: (v) => ({ title: `طلب ${REQUEST_TYPES.ar[v.type]} جديد`, body: `قدّم ${v.name} الطلب رقم ${v.id}.` }),
  },
  request_decided: {
    en: (v) => ({
      title: `Your ${REQUEST_TYPES.en[v.type]} request was ${v.decision}`,
      body: withNote(`Request #${v.id} was ${v.decision} by ${v.reviewer}.`, v.note, 'en'),
    }),
    ar: (v) => ({
      title: v.decision === 'approved' ? `تمت الموافقة على طلب ${REQUEST_TYPES.ar[v.type]}` : `تم رفض طلب ${REQUEST_TYPES.ar[v.type]}`,
      body: withNote(`${v.decision === 'approved' ? 'وافق' : 'رفض'} ${v.reviewer} على الطلب رقم ${v.id}.`, v.note, 'ar'),
    }),
  },
  payslip_published: {
    en: (v) => ({ title: 'Payslip available', body: `Your payslip for ${v.month} has been published.` }),
    ar: (v) => ({ title: 'قسيمة الراتب متاحة', body: `تم نشر قسيمة راتبك لشهر ${v.month}.` }),
  },
  reward: {
    en: (v) => ({ title: 'You received a reward', body: v.reason }),
    ar: (v) => ({ title: 'حصلت على مكافأة', body: v.reason }),
  },
  penalty: {
    en: (v) => ({ title: 'A penalty was recorded', body: v.reason }),
    ar: (v) => ({ title: 'تم تسجيل جزاء', body: v.reason }),
  },
  document_reviewed: {
    en: (v) => ({ title: `Document ${DOC_STATUS.en[v.status]}`, body: withNote(v.title, v.note, 'en') }),
    ar: (v) => ({ title: `${DOC_STATUS.ar[v.status]} المستند`, body: withNote(v.title, v.note, 'ar') }),
  },
  auto_checkout: {
    en: (v) => ({ title: 'Checked out automatically', body: `You left ${v.location ?? 'your work location'} at ${v.time}. Check in again when you are back.` }),
    ar: (v) => ({ title: 'تم تسجيل انصرافك تلقائياً', body: `غادرت ${v.location ?? 'موقع العمل'} الساعة ${v.time}. سجّل حضورك مرة أخرى عند عودتك.` }),
  },
  team_member_left: {
    en: (v) => ({ title: 'Employee left work location', body: `${v.name} left their work location at ${v.time} and was checked out automatically.` }),
    ar: (v) => ({ title: 'موظف غادر موقع العمل', body: `غادر ${v.name} موقع العمل الساعة ${v.time} وتم تسجيل انصرافه تلقائياً.` }),
  },
};

export const LOCALES = ['ar', 'en'];

export function renderMessage(type, vars, locale) {
  const template = MESSAGES[type];
  if (!template) throw new Error(`Unknown notification type: ${type}`);
  return (template[locale] ?? template.ar)(vars);
}
