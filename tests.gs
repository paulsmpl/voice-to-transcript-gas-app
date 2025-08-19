/**
 * Tests rapides. Lancement manuel recommandé.
 */

function assert_(cond, msg) { if (!cond) throw new Error(msg || 'Assertion'); }

function testConfig() {
  assert_(!!getOpenAIKey_(), 'OPENAI_API_KEY absente');
  Logger.log('OK: OPENAI_API_KEY');
}

function testDates_() {
  const s = getYesterdayDateString_();
  assert_(/^\d{4}-\d{2}-\d{2}$/.test(s), 'Format yyyy-MM-dd invalide');
  Logger.log('OK: yesterday = ' + s);
}

function testFindDaily7() {
  const files = getLast7DailySummaries_();
  Logger.log('Daily summaries trouvés: ' + files.length);
  files.forEach(f => Logger.log(f.getName()));
}

function testWeeklyBuild() {
  const dailyFiles = getLast7DailySummaries_();
  if (!dailyFiles.length) { Logger.log('Pas assez de daily pour test.'); return; }
  const ids = dailyFiles.map(f => f.getId());
  const out = generateSummaryFromDocs_(PROMPT_WEEKLY_DOC_ID, ids);
  assert_(out && out.length > 0, 'Résumé weekly vide');
  Logger.log('OK: weekly preview: ' + out.substring(0,120) + '...');
}

function testMonthlyCheck_() {
  const today = new Date();
  const res = isFirstWeekdayOfMonth_(today, MONTHLY_ANCHOR_WEEKDAY_NAME);
  Logger.log(`isFirstWeekdayOfMonth_(${MONTHLY_ANCHOR_WEEKDAY_NAME}) -> ${res}`);
}

function testMonthlyBuild_() {
  const w = getLast5WeeklySummaries_();
  if (!w.length) { Logger.log('Pas assez de weekly pour test.'); return; }
  const ids = w.map(f => f.getId());
  const out = generateSummaryFromDocs_(PROMPT_MONTHLY_DOC_ID, ids);
  assert_(out && out.length > 0, 'Résumé monthly vide');
  Logger.log('OK: monthly preview: ' + out.substring(0,120) + '...');
}
