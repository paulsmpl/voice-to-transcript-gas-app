/**
 * Triggers: daily (chaque jour à DAILY_TRIGGER_HOUR) + weekly
 * (chaque semaine, jour WEEKLY_ANCHOR_WEEKDAY_NAME à WEEKLY_TRIGGER_HOUR).
 * Le monthly est déclenché automatiquement depuis weeklyMain() si
 * c’est le premier <weekday> du mois (paramétrable).
 */

function createDailyTrigger() {
  deleteTriggersForHandler_('main');
  ScriptApp.newTrigger('main')
    .timeBased()
    .atHour(DAILY_TRIGGER_HOUR)
    .everyDays(1)
    .create();
  Logger.log('Daily trigger créé à ' + DAILY_TRIGGER_HOUR + 'h');
}

function createWeeklyTrigger() {
  deleteTriggersForHandler_('weeklyMain');
  const weekDay = getScriptWeekDayFromName_(WEEKLY_ANCHOR_WEEKDAY_NAME);
  ScriptApp.newTrigger('weeklyMain')
    .timeBased()
    .atHour(WEEKLY_TRIGGER_HOUR)
    .onWeekDay(weekDay)
    .create();
  Logger.log('Weekly trigger créé: ' + WEEKLY_ANCHOR_WEEKDAY_NAME + ' à ' + WEEKLY_TRIGGER_HOUR + 'h');
}

function createAllTriggers() {
  createDailyTrigger();
  createWeeklyTrigger();
}

function deleteTriggersForHandler_(handlerName) {
  const all = ScriptApp.getProjectTriggers();
  all.forEach(t => { if (t.getHandlerFunction() === handlerName) ScriptApp.deleteTrigger(t); });
}

function listProjectTriggers() {
  const all = ScriptApp.getProjectTriggers();
  all.forEach(t => Logger.log(`${t.getUniqueId()} - ${t.getHandlerFunction()} - ${t.getEventType()}`));
}

/** Trigger horaire pour le worker de transcription */
function createHourlyWorkerTrigger() {
  deleteTriggersForHandler_('hourlyTranscriptionWorker');
  ScriptApp.newTrigger('hourlyTranscriptionWorker')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('Hourly worker trigger créé (every hour).');
}

/** Option pratique pour créer tous les triggers */
function createAllTriggers() {
  createDailyTrigger();
  createWeeklyTrigger();
  createHourlyWorkerTrigger(); // <-- ajouté
}

