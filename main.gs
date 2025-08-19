function main() {
  Logger.log('--- DAILY start ---');
  try {
  // NOTE:
  // La transcription des audios est désormais gérée par hourlyWorker.gs.
  // Ici, on ne fait que consommer les Docs de transcription créés la veille.

  // 2) NEW: au lieu d'utiliser la date de création, on repart du préfixe de nom "yyyy-MM-dd"
  const yesterdayTranscriptionDocs = getTranscriptionDocsByNamePrefixYesterday_(TRANSCRIPTION_STORAGE_FOLDER_ID);
  if (!yesterdayTranscriptionDocs.length) {
    Logger.log('Aucune transcription (Google Doc) trouvée avec le préfixe de date d’hier.');
    return;
  }
  const transcriptionDocIds = yesterdayTranscriptionDocs.map(f => f.getId());


    // 3) Générer le résumé Daily en HTML et créer le Doc Daily dans le dossier Daily summaries
    const datePrefix = getYesterdayDateString_();
    const summaryRaw = summarizeAsHTMLFromDocs_(PROMPT_DOC_ID, transcriptionDocIds); // HTML attendu
    const htmlDoc = ensureHtmlDocument_(summaryRaw);
    const dailyDocName = `${datePrefix} - Daily Summary`;
    const { docUrl } = createDocFromHtmlInFolder_(dailyDocName, htmlDoc, DAILY_SUMMARY_FOLDER_ID);

    // 4) Envoyer uniquement le lien
    sendEmailWithLink_(EMAIL_DESTINATION, `Résumé quotidien ${datePrefix}`, docUrl);

  } catch (e) {
    Logger.log('Erreur DAILY : ' + (e && e.message ? e.message : e));
    throw e;
  }
  Logger.log('--- DAILY end ---');
}


function weeklyMain() {
  Logger.log('--- WEEKLY start ---');
  try {
    const dailyFiles = getLast7DailySummaries_();
    if (!dailyFiles.length) {
      Logger.log('Aucun daily summary trouvé pour la période.');
      return;
    }
    const dailyDocIds = dailyFiles.map(f => f.getId());
    const weeklyRaw = summarizeAsHTMLFromDocs_(PROMPT_WEEKLY_DOC_ID, dailyDocIds);
    const weeklyHtml = ensureHtmlDocument_(weeklyRaw);

    const endDate = getYesterdayDateString_();
    const weeklyDocName = `${endDate} - Weekly Summary (7d)`;
    const { docUrl } = createDocFromHtmlInFolder_(weeklyDocName, weeklyHtml, WEEKLY_SUMMARY_FOLDER_ID);
    sendEmailWithLink_(EMAIL_DESTINATION, `Résumé hebdo ${endDate}`, docUrl);

    const today = new Date();
    if (isFirstWeekdayOfMonth_(today, MONTHLY_ANCHOR_WEEKDAY_NAME)) {
      monthlyMain_();
    }
  } catch (e) {
    Logger.log('Erreur WEEKLY : ' + (e && e.message ? e.message : e));
    throw e;
  }
  Logger.log('--- WEEKLY end ---');
}

function monthlyMain_() {
  Logger.log('--- MONTHLY start ---');
  try {
    const weeklyFiles = getLast5WeeklySummaries_();
    if (!weeklyFiles.length) {
      Logger.log('Aucun weekly summary récent.');
      return;
    }
    const weeklyDocIds = weeklyFiles.map(f => f.getId());
    const monthlyRaw = summarizeAsHTMLFromDocs_(PROMPT_MONTHLY_DOC_ID, weeklyDocIds);
    const monthlyHtml = ensureHtmlDocument_(monthlyRaw);

    const label = getPrevMonthLabel_();
    const monthlyDocName = `${label} - Monthly Summary`;
    const { docUrl } = createDocFromHtmlInFolder_(monthlyDocName, monthlyHtml, MONTHLY_SUMMARY_FOLDER_ID);
    sendEmailWithLink_(EMAIL_DESTINATION, `Résumé mensuel ${label}`, docUrl);

  } catch (e) {
    Logger.log('Erreur MONTHLY : ' + (e && e.message ? e.message : e));
    throw e;
  }
  Logger.log('--- MONTHLY end ---');
}
