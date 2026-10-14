// Arabic versions of every error message the API returns. The service code throws English messages;
// the error handler picks the language from the request's Accept-Language header (sent by the app and
// the dashboard) and translates here, so translations live in one place.

const FIELDS = {
  name: 'الاسم', email: 'البريد الإلكتروني', password: 'كلمة المرور', current_password: 'كلمة المرور الحالية',
  type: 'نوع الطلب', leave_type: 'نوع الإجازة', start_date: 'تاريخ البداية', end_date: 'تاريخ النهاية',
  start_time: 'الوقت', hours: 'عدد الساعات', amount: 'المبلغ', destination: 'جهة المأمورية', reason: 'السبب',
  latitude: 'خط العرض', longitude: 'خط الطول', radius_meters: 'نطاق الموقع', month: 'الشهر', date: 'التاريخ',
  work_date: 'تاريخ اليوم', check_in_time: 'وقت الحضور', check_out_time: 'وقت الانصراف', user_id: 'الموظف',
  hire_date: 'تاريخ التعيين', basic_salary: 'الراتب الأساسي', annual_leave_balance: 'رصيد الإجازات الاعتيادية',
  casual_leave_balance: 'رصيد الإجازات العارضة', role: 'الدور', title: 'العنوان', token: 'رمز الجهاز',
  platform: 'نوع الجهاز', locale: 'اللغة', status: 'الحالة', decision: 'القرار', kind: 'النوع', id: 'المعرّف',
  from: 'من تاريخ', to: 'إلى تاريخ', work_start: 'بداية العمل', work_end: 'نهاية العمل',
  late_grace_minutes: 'فترة السماح', default_annual_leave: 'الإجازات الاعتيادية الافتراضية',
  default_casual_leave: 'الإجازات العارضة الافتراضية', timezone: 'المنطقة الزمنية', currency: 'العملة',
};
const field = (f) => FIELDS[f] ?? f;
const fields = (list) => list.split(',').map((f) => field(f.trim())).join('، ');

const RESOURCES = {
  Employee: 'الموظف', Team: 'الفريق', Request: 'الطلب', Location: 'الموقع', File: 'الملف', Document: 'المستند',
  Payslip: 'قسيمة الراتب', 'Penalty/reward': 'الجزاء أو المكافأة', Resource: 'العنصر', Endpoint: 'الرابط',
};

const STATUS_AR = { approved: 'تمت الموافقة عليه', rejected: 'تم رفضه', cancelled: 'تم إلغاؤه', pending: 'قيد المراجعة' };

/** [pattern, Arabic text or function(match) → Arabic text] — first match wins. */
const PATTERNS = [
  // Authentication & access
  [/^Invalid email or password$/, 'البريد الإلكتروني أو كلمة المرور غير صحيحة'],
  [/^Authentication required$/, 'يجب تسجيل الدخول أولاً'],
  [/^Session expired or invalid, please log in again$/, 'انتهت الجلسة، يرجى تسجيل الدخول مرة أخرى'],
  [/^Account is disabled$/, 'تم إيقاف هذا الحساب، تواصل مع الإدارة'],
  [/^This account cannot sign in as a manager$/, 'هذا الحساب لا يملك صلاحية الدخول كمدير'],
  [/^The dashboard is only available to managers and team leaders$/, 'لوحة التحكم متاحة للمديرين وقادة الفرق فقط'],
  [/^You do not have permission to do this$/, 'ليس لديك صلاحية للقيام بهذا الإجراء'],
  [/^You do not lead this team$/, 'أنت لست قائد هذا الفريق'],
  [/^This employee is not in your team$/, 'هذا الموظف ليس ضمن فريقك'],
  [/^You cannot review your own request$/, 'لا يمكنك مراجعة طلبك بنفسك'],
  [/^Current password is incorrect$/, 'كلمة المرور الحالية غير صحيحة'],
  [/^Password must be at least 6 characters$/, 'يجب ألا تقل كلمة المرور عن 6 أحرف'],
  [/^Password confirmation does not match$/, 'تأكيد كلمة المرور غير مطابق'],

  // Attendance
  [/^You are (\d+) m away from (.+)\. Move within (\d+) m to check in\/out\.$/,
    (m) => `أنت على بعد ${m[1]} متر من ${m[2]}. اقترب لمسافة ${m[3]} متر لتسجيل الحضور أو الانصراف.`],
  [/^You have no check-in locations assigned\. Please contact your manager\.$/, 'لم يتم تحديد مواقع لتسجيل الحضور لك بعد. يرجى التواصل مع مديرك.'],
  [/^Fake GPS location detected\. Disable mock location apps and try again\.$/, 'تم اكتشاف موقع وهمي. أوقف تطبيقات تزييف الموقع ثم حاول مرة أخرى.'],
  [/^You have already checked in today$/, 'لقد سجّلت حضورك اليوم بالفعل'],
  [/^You have not checked in today$/, 'لم تسجّل حضورك اليوم بعد'],
  [/^You have already checked out today$/, 'لقد سجّلت انصرافك اليوم بالفعل'],
  [/^check_out_time must be after check_in_time$/, 'يجب أن يكون وقت الانصراف بعد وقت الحضور'],
  [/^work_end must be after work_start$/, 'يجب أن يكون موعد نهاية العمل بعد موعد بدايته'],
  [/^check_in_time is required when check_out_time is set$/, 'يجب إدخال وقت الحضور عند إدخال وقت الانصراف'],

  // Requests & leave
  [/^Insufficient (annual|casual) leave balance: (\d+) day\(s\) available, (\d+) requested$/,
    (m) => `رصيد الإجازات ${m[1] === 'annual' ? 'الاعتيادية' : 'العارضة'} غير كافٍ: المتاح ${m[2]} يوم والمطلوب ${m[3]} يوم`],
  [/^These dates overlap with request #(\d+)$/, (m) => `هذه التواريخ تتداخل مع الطلب رقم ${m[1]}`],
  [/^The selected period contains no working days$/, 'الفترة المختارة لا تحتوي على أيام عمل'],
  [/^end_date must be on or after start_date$/, 'يجب أن يكون تاريخ النهاية في نفس يوم البداية أو بعده'],
  [/^Only pending requests can be cancelled$/, 'يمكن إلغاء الطلبات قيد المراجعة فقط'],
  [/^This request is already (\w+)$/, (m) => `هذا الطلب ${STATUS_AR[m[1]] ?? m[1]} بالفعل`],

  // Employees, teams, locations
  [/^Email is already used by another employee$/, 'البريد الإلكتروني مستخدم لموظف آخر'],
  [/^email is invalid$/, 'البريد الإلكتروني غير صالح'],
  [/^At least one active manager is required$/, 'يجب أن يبقى مدير نشط واحد على الأقل'],
  [/^You cannot deactivate your own account$/, 'لا يمكنك إيقاف حسابك بنفسك'],
  [/^A team with this name already exists$/, 'يوجد فريق بهذا الاسم بالفعل'],
  [/^The selected leader is deactivated$/, 'القائد المختار حسابه موقوف'],
  [/^Employee (\d+) does not exist$/, (m) => `الموظف رقم ${m[1]} غير موجود`],
  [/^One or more locations do not exist$/, 'موقع أو أكثر غير موجود'],
  [/^location_ids must be a list of ids$/, 'قائمة المواقع غير صحيحة'],
  [/^(team_id|leader_id) does not exist$/, (m) => (m[1] === 'team_id' ? 'الفريق المختار غير موجود' : 'القائد المختار غير موجود')],

  // Documents & files
  [/^This document is already approved$/, 'هذا المستند معتمد بالفعل'],
  [/^This document already exists for the employee$/, 'هذا المستند مطلوب من الموظف بالفعل'],
  [/^Only PDF and image files are allowed$/, 'يُسمح بملفات PDF والصور فقط'],
  [/^Only JPEG, PNG, WebP or HEIC images are allowed$/, 'يُسمح بالصور بصيغة JPEG أو PNG أو WebP أو HEIC فقط'],
  [/^(file|avatar image) is required$/, 'يرجى اختيار ملف'],
  [/^File too large$/, 'حجم الملف أكبر من الحد المسموح'],

  // Settings
  [/^weekend_days must be a list of numbers 0-6$/, 'أيام العطلة غير صحيحة'],
  [/^timezone is not a valid IANA time zone$/, 'المنطقة الزمنية غير صحيحة'],
  [/^required_documents must be a list of names$/, 'قائمة المستندات المطلوبة غير صحيحة'],
  [/^Unknown setting: (.+)$/, (m) => `إعداد غير معروف: ${m[1]}`],
  [/^auto_checkout_on_leave must be true or false$/, 'قيمة الانصراف التلقائي غير صحيحة'],

  // Generic validation
  [/^Missing required field\(s\): (.+)$/, (m) => `يرجى إدخال: ${fields(m[1])}`],
  [/^(\w+) is required$/, (m) => `${field(m[1])} مطلوب`],
  [/^(\w+) must be a date in YYYY-MM-DD format$/, (m) => `${field(m[1])} يجب أن يكون تاريخاً صحيحاً`],
  [/^(\w+) must be a time in HH:MM format$/, (m) => `${field(m[1])} يجب أن يكون وقتاً صحيحاً`],
  [/^(\w+) must be in YYYY-MM format$/, (m) => `${field(m[1])} يجب أن يكون شهراً صحيحاً`],
  [/^(\w+) must be a number between (.+) and (.+)$/, (m) => `${field(m[1])} يجب أن يكون رقماً بين ${m[2].replace('-Infinity', '…')} و${m[3].replace('Infinity', '…')}`],
  [/^(\w+) must be a positive integer$/, (m) => `${field(m[1])} يجب أن يكون رقماً صحيحاً موجباً`],
  [/^(\w+) must be one of: (.+)$/, (m) => `قيمة ${field(m[1])} غير صحيحة`],
  [/^Unknown (\w+) item: (.+)$/, (m) => `بند غير معروف: ${m[2]}`],
  [/^(.+) not found$/, (m) => `${RESOURCES[m[1]] ?? m[1]} غير موجود`],
  [/^Malformed JSON body$/, 'البيانات المرسلة غير صحيحة'],
  [/^Internal server error$/, 'حدث خطأ غير متوقع في الخادم، يرجى المحاولة لاحقاً'],
];

/** Fallback when a message has no translation: never show untranslated English to Arabic users. */
const BY_STATUS = {
  400: 'البيانات المدخلة غير صحيحة', 401: 'يجب تسجيل الدخول أولاً', 403: 'ليس لديك صلاحية للقيام بهذا الإجراء',
  404: 'العنصر المطلوب غير موجود', 409: 'لا يمكن تنفيذ هذا الإجراء حالياً', 413: 'حجم الملف أكبر من الحد المسموح',
  422: 'لا يمكن تنفيذ هذا الإجراء', 500: 'حدث خطأ غير متوقع في الخادم، يرجى المحاولة لاحقاً',
};

/** Language of the response: Accept-Language "ar…" → Arabic, otherwise English. */
export function requestLang(req) {
  const header = String(req.headers['accept-language'] ?? '').toLowerCase().trim();
  return header.startsWith('ar') ? 'ar' : 'en';
}

export function localizeError(message, status, lang) {
  if (lang !== 'ar') return message;
  for (const [pattern, ar] of PATTERNS) {
    const m = pattern.exec(message);
    if (m) return typeof ar === 'function' ? ar(m) : ar;
  }
  return BY_STATUS[status] ?? BY_STATUS[Math.floor(status / 100) * 100] ?? BY_STATUS[500];
}
