// הגדרות המערכת. ערכים רגישים (סיסמאות, טוקן) מגיעים ממשתני סביבה בלבד.
module.exports = {
  PORT: process.env.PORT || 3000,
  DB_PATH: process.env.DB_PATH || './data/shadchan.db',
  ADMIN_KEY: process.env.ADMIN_KEY || 'change-me',

  // טוקן ימות המשיח לצינתוקים: מספר_מערכת:סיסמה. בלי טוקן - הצינתוקים רק נרשמים בלוג.
  YEMOT_TOKEN: process.env.YEMOT_TOKEN || '',

  // שלוחה בימות המשיח לשמירת ההקלטות
  RECORD_FOLDER: process.env.RECORD_FOLDER || '/9',

  // כמה ימים דיווח נשאר פעיל
  EXPIRE_DAYS: Number(process.env.EXPIRE_DAYS || 45),

  // בדיקת מיקום האוטובוסים (דקות) לצורך צינתוק "האוטובוס בעיר שלך"
  TRACK_EVERY_MIN: Number(process.env.TRACK_EVERY_MIN || 3),
  MAX_ALERTS_PER_REPORT: 5,

  // חלון זמן (דקות) סביב השעה שהמתקשר הקיש, לאיתור הרכבים שנסעו בקו
  BUS_WINDOW_MIN: 10,

  OPEN_BUS_API: 'https://open-bus-stride-api.hasadna.org.il',

  // ערים: מקש -> שם העיר כפי שמופיע במאגר התחבורה הציבורית. מקש 9 = עיר אחרת (בלי סינון)
  CITIES: {
    1: 'ירושלים',
    2: 'בני ברק',
    3: 'בית שמש',
    4: 'מודיעין עילית',
    5: 'ביתר עילית',
    6: 'אלעד',
    7: 'אשדוד',
    8: 'צפת',
    9: 'עיר אחרת',
  },

  // קטגוריות לדיווח ברחוב / במקום אחר
  CATEGORIES: {
    1: 'ארנק או כסף',
    2: 'טלפון',
    3: 'מפתחות',
    4: 'תיק',
    5: 'ביגוד',
    6: 'מסמכים או כרטיסים',
    7: 'ספרים או תשמישי קדושה',
    8: 'פריטי ילדים',
    9: 'אחר',
  },
};
