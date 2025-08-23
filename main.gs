/**
 * main.gs
 * - DAILY: ne transcrit plus d'audio ; agrège les Docs de transcription dont le nom commence par "YYYY-MM-DD"
 * - WEEKLY: résume les 7 dailies les plus récents (fonction helper existante)
 * - MONTHLY: résume les 5 weekly les plus récents (fonction helper existante)
 * - Orchestrator (optionnel): appelle Daily tous les jours, et Weekly le bon jour; Weekly appelle Monthly si "premier <weekday> du mois".
 *
 * IMPORTANT:
 *   - Ce fichier lit les IDs/emails via les getters cfg*() définis dans config.gs (shim CFG).
 *   - Il suppose l’existence des helpers suivants (déjà présents dans ton projet):
 *       summarizeAsHTMLFromDocs_(promptDocId, docIds)
 *       ensureHtmlDocument_(htmlOrMarkdownString)
 *       createDocFromHtmlInFolder_(docName, htmlDocument, folderId)
 *       sendEmailWithLink_(to, subject, docUrl)
 *       getYesterdayDateString_()
 *       getLast7DailySummaries_()          // (drive_docs.gs)
 *       getLast5WeeklySummaries_()         // (drive_docs.gs)
 *   - Si tu avais encore un bloc qui scannait les audios d’hier => il a été supprimé ici.
 */

/** DAILY: construit le résumé de la veille à partir des Docs de transcription (par préfixe de nom "YYYY-MM-DD") */
function main() {
  Logger.log('--- DAILY start ---');
  try {
    const datePrefix = getYesterdayDateString_();                  // "YYYY-MM-DD"
    const transcriptionsFolderId = cfgTranscriptionFolderId_();    // dossier Docs de transcription
    const dailyOutFolderId = cfgDailySummaryFolderId_();           // dossier des dailies
    const emailTo = cfgEmailDestination_();

    // 1) Récupère tous les Google Docs de transcription dont le NOM commence par "YYYY-MM-DD"
    const transcriptionDocs = (function listByNamePrefix_(folderId, prefix) {
      const folder = DriveApp.getFolderById(folderId);
      const it = folder.getFiles();
      const out = [];
      while (it.hasNext()) {
        const f = it.next();
        if (f.isTrashed()) continue;
        if (f.getMimeType() !== MimeType.GOOGLE_DOCS) continue;
        if (f.getName().startsWith(prefix)) out.push(f);
      }
      // tri par nom pour avoir -HHMM / -nn dans l'ordre
      out.sort((a,b) => a.getName().localeCompare(b.getName()));
      return out;
    })(transcriptionsFolderId, datePrefix);

    if (!transcriptionDocs.length) {
      Logger.log('Daily: aucune transcription (Google Doc) trouvée avec le préfixe de date d’hier: ' + datePrefix);
      return;
    }

    // 2) IDs des Docs de transcription à résumer
    const transcriptionDocIds = transcriptionDocs.map(f => f.getId());

    // 3) Demande un résumé HTML et crée un Doc Daily depuis ce HTML
    const summaryRawHtml = summarizeAsHTMLFromDocs_(cfgPromptDailyId_(), transcriptionDocIds); // attendu HTML
    const htmlDocument = ensureHtmlDocument_(summaryRawHtml); // fallback si markdown
    const dailyDocName = `${datePrefix} - Daily Summary`;

    const { docUrl } = createDocFromHtmlInFolder_(dailyDocName, htmlDocument, dailyOutFolderId);

    // 4) Email: lien uniquement
    sendEmailWithLink_(emailTo, `Résumé quotidien ${datePrefix}`, docUrl);

  } catch (e) {
    Logger.log('Erreur DAILY : ' + (e && e.message ? e.message : e));
    throw e;
  }
  Logger.log('--- DAILY end ---');
}

/** Compat ancien nom si un trigger existait déjà */
function mainFunction() { return main(); }

/** WEEKLY: combine les 7 derniers Daily summaries */
function weeklyMain() {
  Logger.log('--- WEEKLY start ---');
  try {
    const dailyFiles = getLast7DailySummaries_(); // helper existant, retourne des fichiers Drive triés desc
    if (!dailyFiles || !dailyFiles.length) {
      Logger.log('Weekly: aucun daily summary récent.');
      return;
    }
    const dailyDocIds = dailyFiles.map(f => f.getId());

    const weeklyRawHtml = summarizeAsHTMLFromDocs_(cfgPromptWeeklyId_(), dailyDocIds);
    const weeklyHtmlDoc = ensureHtmlDocument_(weeklyRawHtml);

    const endDate = getYesterdayDateString_(); // semaine se terminant la veille
    const weeklyDocName = `${endDate} - Weekly Summary (7d)`;

    const { docUrl } = createDocFromHtmlInFolder_(weeklyDocName, weeklyHtmlDoc, cfgWeeklySummaryFolderId_());
    sendEmailWithLink_(cfgEmailDestination_(), `Résumé hebdo ${endDate}`, docUrl);

    // Monthly auto depuis Weekly si premier <weekday> du mois
    const today = new Date();
    if (isFirstWeekdayOfMonth_(today, MONTHLY_ANCHOR_WEEKDAY_NAME)) {
      Logger.log('Premier ' + MONTHLY_ANCHOR_WEEKDAY_NAME + ' du mois -> monthly');
      monthlyMain_();
    } else {
      Logger.log('Pas premier ' + MONTHLY_ANCHOR_WEEKDAY_NAME + ' du mois; pas de monthly.');
    }

  } catch (e) {
    Logger.log('Erreur WEEKLY : ' + (e && e.message ? e.message : e));
    throw e;
  }
  Logger.log('--- WEEKLY end ---');
}

/** MONTHLY: combine les 5 derniers Weekly summaries */
function monthlyMain_() {
  Logger.log('--- MONTHLY start ---');
  try {
    const weeklyFiles = getLast5WeeklySummaries_(); // helper existant
    if (!weeklyFiles || !weeklyFiles.length) {
      Logger.log('Monthly: aucun weekly summary récent.');
      return;
    }
    const weeklyDocIds = weeklyFiles.map(f => f.getId());

    const monthlyRawHtml = summarizeAsHTMLFromDocs_(cfgPromptMonthlyId_(), weeklyDocIds);
    const monthlyHtmlDoc = ensureHtmlDocument_(monthlyRawHtml);

    const label = getPrevMonthLabel_(); // "YYYY-MM" du mois précédent
    const monthlyDocName = `${label} - Monthly Summary`;

    const { docUrl } = createDocFromHtmlInFolder_(monthlyDocName, monthlyHtmlDoc, cfgMonthlySummaryFolderId_());
    sendEmailWithLink_(cfgEmailDestination_(), `Résumé mensuel ${label}`, docUrl);

  } catch (e) {
    Logger.log('Erreur MONTHLY : ' + (e && e.message ? e.message : e));
    throw e;
  }
  Logger.log('--- MONTHLY end ---');
}

/**
 * Orchestrator (optionnel):
 *  - à déclencher 1x/jour: fait toujours le DAILY
 *  - si on est le <weekday> d’ancrage, fait aussi le WEEKLY (qui fait le MONTHLY si c’est le premier <weekday> du mois)
 */
function orchestrateSummaries() {
  main();
  const today = new Date();
  const anchorIdx = getWeekDayIndexFromName_(WEEKLY_ANCHOR_WEEKDAY_NAME); // e.g. 'MONDAY' -> 1
  if (today.getDay() === anchorIdx) {
    weeklyMain();
  }
}

/** Helper permissions (inchangé) */
function demanderPermissionsDrive() {
  const folder = DriveApp.getRootFolder();
  Logger.log('Nom du dossier racine : ' + folder.getName());
}
