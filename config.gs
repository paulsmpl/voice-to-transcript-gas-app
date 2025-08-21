/**
 * Centralize common configurations and utilities.
 * Store your OpenAI key in Script Properties: OPENAI_API_KEY
 */

/** ---- Folder/Doc IDs ---- **/
// Folder for audio files
const DRIVE_FOLDER_ID = 'YOUR_DRIVE_FOLDER_ID_HERE';
// Folder to store transcription Docs
const TRANSCRIPTION_STORAGE_FOLDER_ID = 'YOUR_TRANSCRIPTION_STORAGE_FOLDER_ID_HERE';

// Prompts
const PROMPT_DOC_ID = 'YOUR_PROMPT_DOC_ID_HERE'; // Daily
const PROMPT_WEEKLY_DOC_ID = 'YOUR_PROMPT_WEEKLY_DOC_ID_HERE'; // Weekly
const PROMPT_MONTHLY_DOC_ID = 'YOUR_PROMPT_MONTHLY_DOC_ID_HERE'; // Monthly

// Output folders for summaries
const DAILY_SUMMARY_FOLDER_ID = 'YOUR_DAILY_SUMMARY_FOLDER_ID_HERE';
const WEEKLY_SUMMARY_FOLDER_ID = 'YOUR_WEEKLY_SUMMARY_FOLDER_ID_HERE';
const MONTHLY_SUMMARY_FOLDER_ID = 'YOUR_MONTHLY_SUMMARY_FOLDER_ID_HERE';

/** ---- Archive folder for audios after transcription ---- **/
const ARCHIVE_AUDIO_FOLDER_ID = 'YOUR_ARCHIVE_AUDIO_FOLDER_ID_HERE';

// Notification email (now only sends the link of the created Doc)
const EMAIL_DESTINATION = 'YOUR_EMAIL_HERE';

/** ---- Email d'alerte pour le worker horaire ---- **/
const HOURLY_ALERT_EMAIL = 'YOUR_EMAIL_HERE';

// OpenAI
const OPENAI_API_KEY = 'YOUR_OPENAI_API_KEY_HERE';
const OPENAI_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_CHAT_API_URL = 'https://api.openai.com/v1/chat/completions';
const AUDIO_MIME_TYPE = 'audio/mpeg';


/** ---- Triggers (heures locales du projet) ---- **/
const DAILY_TRIGGER_HOUR  = 7;                 // exécute le daily
const WEEKLY_TRIGGER_HOUR = 7;                 // exécute le weekly
// Jour d’ancrage hebdo (pour le trigger + check "premier X du mois")
const WEEKLY_ANCHOR_WEEKDAY_NAME = 'SUNDAY';   // 'SUNDAY'...'SATURDAY'
// Pour le check mensuel, on utilise le même jour d’ancrage que le weekly
const MONTHLY_ANCHOR_WEEKDAY_NAME = WEEKLY_ANCHOR_WEEKDAY_NAME;

/** ---- Format de sortie des résumés ---- **/
const SUMMARY_OUTPUT_FORMAT = 'HTML'; // 'HTML' recommandé ; fallback Markdown -> HTML si besoin

/** ---- Retries API Whisper ---- **/
const TRANSCRIBE_MAX_ATTEMPTS = 4;   // nombre d’essais (ex: 4 = 1er + 3 retries)
const TRANSCRIBE_BACKOFF_MS   = 1500; // backoff initial (ms) -> 1500, 3000, 6000...





/** ---- Types audio acceptés par le worker (tu peux ajuster) ---- **/
const AUDIO_MIME_TYPES = [
  'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav',
  'audio/webm', 'audio/ogg'
];

/** ---- Taille max (sécurité) : si >25 MB on alerte et on skip ---- **/
const MAX_AUDIO_MB = 25;

/** ---- Trigger horaire ---- **/
const HOURLY_TRIGGER_ENABLED = true; // mets false si tu veux le couper


/** ---- Accès sécurisé à la clé ---- **/
function getOpenAIKey_() {
  const key = OPENAI_API_KEY ;
  if (!key) throw new Error('OPENAI_API_KEY manquante. Va dans Fichier > Propriétés du projet > Propriétés du script.');
  return key;
}
/** Enveloppe un fragment HTML dans un document HTML minimal (UTF-8) */
function wrapHtmlDocument_(innerHtml) {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    // Un style léger pour les tableaux/code (facultatif)
    '<style>',
    'body{font-family:Arial,Helvetica,sans-serif;line-height:1.45;}',
    'h1,h2,h3{margin:0.4em 0 0.2em;}',
    'p,li{margin:0.2em 0;}',
    'pre{padding:8px;overflow:auto;border:1px solid #ddd;border-radius:4px;background:#f7f7f7;}',
    'code{font-family:Consolas,Menlo,Monaco,monospace;}',
    'table{border-collapse:collapse;} th,td{border:1px solid #ddd;padding:6px;}',
    '</style></head><body>',
    innerHtml,
    '</body></html>'
  ].join('');
}


/** ---- Dates & formats ---- **/
function getYesterdayWindow_() {
  const tz = Session.getScriptTimeZone();
  const startToday = new Date();
  startToday.setHours(0,0,0,0);
  const startYesterday = new Date(startToday.getTime() - 24*60*60*1000);
  return { startYesterday, startToday, tz };
}
function getYesterdayDateString_() {
  const { tz } = getYesterdayWindow_();
  const d = new Date();
  d.setDate(d.getDate()-1);
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}
function formatISODate_(d) {
  const tz = Session.getScriptTimeZone();
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}
function getDateNDaysBefore_(n) {
  const d = new Date();
  d.setDate(d.getDate()-n);
  return d;
}
function getLastNDatesFromYesterdayStrings_(n) {
  const arr = [];
  for (let i=1; i<=n; i++) {
    arr.push(formatISODate_(getDateNDaysBefore_(i)));
  }
  return arr; // ex: [yyyy-mm-dd (hier), yyyy-mm-dd (J-2), ...]
}
function getPrevMonthLabel_() {
  const tz = Session.getScriptTimeZone();
  const d = new Date();
  d.setMonth(d.getMonth()-1);
  return Utilities.formatDate(d, tz, 'yyyy-MM'); // pour nommage du monthly
}

/** ---- Semaine/Jour ---- **/
function getWeekDayIndexFromName_(name) {
  const map = {SUNDAY:0, MONDAY:1, TUESDAY:2, WEDNESDAY:3, THURSDAY:4, FRIDAY:5, SATURDAY:6};
  const k = String(name||'').toUpperCase();
  if (!(k in map)) throw new Error('WEEKLY_ANCHOR_WEEKDAY_NAME invalide: '+name);
  return map[k];
}
function getScriptWeekDayFromName_(name) {
  return ScriptApp.WeekDay[String(name||'').toUpperCase()];
}
/** Vrai si "date" est le premier <weekdayName> du mois */
function isFirstWeekdayOfMonth_(date, weekdayName) {
  const want = getWeekDayIndexFromName_(weekdayName);
  const d = new Date(date.getTime());
  d.setDate(1); // 1er du mois courant
  // Trouve le premier "want" de ce mois
  while (d.getDay() !== want) d.setDate(d.getDate()+1);
  // Compare au jour "date"
  return (formatISODate_(d) === formatISODate_(date));
}