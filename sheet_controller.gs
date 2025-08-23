/** ───────────── Sheet Controller: clé/valeurs en A/B, init Drive & Docs ───────────── **/

/** Clés supportées en Col A (labels lisibles pour utilisateur) */
const VNA_ROWS = [
  ['Root Folder',                'ROOT_FOLDER_ID'],
  ['Source Audio Folder',        'DRIVE_FOLDER_ID'],
  ['Transcriptions Folder',      'TRANSCRIPTION_STORAGE_FOLDER_ID'],
  ['Audio Archive Folder',       'ARCHIVE_AUDIO_FOLDER_ID'],
  ['Daily Summaries Folder',     'DAILY_SUMMARY_FOLDER_ID'],
  ['Weekly Summaries Folder',    'WEEKLY_SUMMARY_FOLDER_ID'],
  ['Monthly Summaries Folder',   'MONTHLY_SUMMARY_FOLDER_ID'],
  ['Prompts Folder (EN)',        'PROMPTS_EN_FOLDER_ID'],
  ['Daily Prompt Doc (EN)',      'PROMPT_DOC_ID'],
  ['Weekly Prompt Doc (EN)',     'PROMPT_WEEKLY_DOC_ID'],
  ['Monthly Prompt Doc (EN)',    'PROMPT_MONTHLY_DOC_ID'],
  ['Email Destination (Summaries)', 'EMAIL_DESTINATION'],
  ['Hourly Alert Email',         'HOURLY_ALERT_EMAIL'],
  ['OpenAI API Key',             'OPENAI_API_KEY']
];

function vnaGetSheet_() {
  return SpreadsheetApp.getActiveSheet(); // la feuille active sert de contrôleur
}

function vnaEnsureRows_() {
  const sh = vnaGetSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < VNA_ROWS.length) {
    const range = sh.getRange(1,1,VNA_ROWS.length,2);
    const values = VNA_ROWS.map(([label]) => [label, '']);
    range.setValues(values);
  } else {
    // Assure que col A contient nos labels (idempotent)
    const labels = sh.getRange(1,1,VNA_ROWS.length,1).getValues().map(r => r[0]);
    VNA_ROWS.forEach((row, i) => { if (labels[i] !== row[0]) sh.getRange(i+1,1).setValue(row[0]); });
  }
}

function vnaSetValue_(keyLabel, value) {
  const sh = vnaGetSheet_();
  const data = sh.getRange(1,1,Math.max(VNA_ROWS.length, sh.getLastRow()),2).getValues();
  for (let i=0;i<data.length;i++) {
    if (String(data[i][0]).trim() === keyLabel) {
      sh.getRange(i+1,2).setValue(value || '');
      return;
    }
  }
  throw new Error('Label not found in column A: ' + keyLabel);
}

function vnaGetValue_(keyLabel) {
  const sh = vnaGetSheet_();
  const data = sh.getRange(1,1,Math.max(VNA_ROWS.length, sh.getLastRow()),2).getValues();
  for (let i=0;i<data.length;i++) {
    if (String(data[i][0]).trim() === keyLabel) {
      return (data[i][1] || '').toString().trim();
    }
  }
  return '';
}

function vnaSyncPropsFromSheet() {
  vnaEnsureRows_();
  const props = PropertiesService.getScriptProperties();

  VNA_ROWS.forEach(([label, propKey]) => {
    const v = vnaGetValue_(label);
    if (!v) return;

    let store = v;
    // si c'est un *_FOLDER_ID ou *_DOC_ID, normaliser en ID
    if (/_FOLDER_ID$/.test(propKey)) {
      store = vnaExtractDriveId_(v, 'folder');
    } else if (/PROMPT_.*_DOC_ID$/.test(propKey) || /_DOC_ID$/.test(propKey)) {
      store = vnaExtractDriveId_(v, 'doc');
    }
    props.setProperty(propKey, store);
  });

  SpreadsheetApp.getActive().toast('Synced Sheet → Script Properties (IDs normalized)');
}

/** Sync Script Properties → B (utile quand on réinstalle) */
function vnaSyncSheetFromProps() {
  vnaEnsureRows_();
  const props = PropertiesService.getScriptProperties().getProperties();
  VNA_ROWS.forEach(([label, propKey]) => {
    if (props[propKey]) vnaSetValue_(label, props[propKey]);
  });
  SpreadsheetApp.getActive().toast('Synced Script Properties → Sheet');
}

/** Crée un dossier sous un parent, ou retourne l’existant (par nom) */
function vnaGetOrCreateFolder_(parentFolder, name) {
  const it = parentFolder.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parentFolder.createFolder(name);
}

/** Create an EN prompt from a FR template (copy + FR→EN translate). */
function vnaCreatePromptEnFromTemplate_(templateIdOrUrl, newName, destFolder) {
  const ui = SpreadsheetApp.getUi();
  const tid = vnaExtractDriveId_(templateIdOrUrl, 'doc');

  let templateFile;
  try {
    templateFile = DriveApp.getFileById(tid);
  } catch (e) {
    ui.alert('Cannot access template Doc ID: ' + tid + '\n' +
             'Original value: ' + templateIdOrUrl + '\n' +
             'Make sure this Google Doc exists and is accessible to this account.\n\n' +
             'Error: ' + (e && e.message ? e.message : e));
    throw e;
  }

  // Copy into destination folder
  const copy = templateFile.makeCopy(newName, destFolder);

  // Translate content FR -> EN inside the copy
  try {
    const doc = DocumentApp.openById(copy.getId());
    const body = doc.getBody();
    const fr = body.getText();
    const en = LanguageApp.translate(fr, 'fr', 'en');
    body.clear();
    body.appendParagraph(en);
    doc.saveAndClose();
  } catch (e) {
    ui.alert('Copy created but failed to translate content for: ' + newName + '\n' +
             'Doc ID: ' + copy.getId() + '\nError: ' + (e && e.message ? e.message : e));
    throw e;
  }

  return copy; // Drive File
}


/** Construit une URL Drive/Doc depuis un ID */
function vnaFolderUrl_(id) { return 'https://drive.google.com/drive/folders/' + id; }
function vnaDocUrl_(id)    { return 'https://docs.google.com/document/d/' + id + '/edit'; }

/** Action MENU : Initialize project (folders + EN prompts) */
function vnaInitProjectFromSheet() {
  vnaEnsureRows_();

  // 1) Racine "Voice Note App" (à la racine de Drive)
  const root = vnaGetOrCreateFolder_(DriveApp.getRootFolder(), 'Voice Note App');

  // 2) Sous-dossiers
  const fAudio     = vnaGetOrCreateFolder_(root, '01 - Source Audio');
  const fTransc    = vnaGetOrCreateFolder_(root, '02 - Transcriptions');
  const fArchive   = vnaGetOrCreateFolder_(root, '03 - Audio Archive');
  const fSummaries = vnaGetOrCreateFolder_(root, '10 - Summaries');
  const fDaily     = vnaGetOrCreateFolder_(fSummaries, 'Daily');
  const fWeekly    = vnaGetOrCreateFolder_(fSummaries, 'Weekly');
  const fMonthly   = vnaGetOrCreateFolder_(fSummaries, 'Monthly');
  const fPromptsEn = vnaGetOrCreateFolder_(root, '09 - Prompts (EN)');

  // 3) Prompts EN à partir de templates FR (IDs hardcodés dans config.gs)
  if (!TEMPLATE_DAILY_PROMPT_FR_ID || !TEMPLATE_WEEKLY_PROMPT_FR_ID || !TEMPLATE_MONTHLY_PROMPT_FR_ID) {
    SpreadsheetApp.getUi().alert('Missing TEMPLATE_* IDs in config.gs');
    return;
  }
  const pDaily   = vnaCreatePromptEnFromTemplate_(TEMPLATE_DAILY_PROMPT_FR_ID,  'Daily Prompt (EN)',   fPromptsEn);
  const pWeekly  = vnaCreatePromptEnFromTemplate_(TEMPLATE_WEEKLY_PROMPT_FR_ID, 'Weekly Prompt (EN)',  fPromptsEn);
  const pMonthly = vnaCreatePromptEnFromTemplate_(TEMPLATE_MONTHLY_PROMPT_FR_ID,'Monthly Prompt (EN)', fPromptsEn);

  // 4) Ecrit les URLs en colonne B et push dans Script Properties
  vnaSetValue_('Root Folder',              vnaFolderUrl_(root.getId()));
  vnaSetValue_('Source Audio Folder',      vnaFolderUrl_(fAudio.getId()));
  vnaSetValue_('Transcriptions Folder',    vnaFolderUrl_(fTransc.getId()));
  vnaSetValue_('Audio Archive Folder',     vnaFolderUrl_(fArchive.getId()));
  vnaSetValue_('Daily Summaries Folder',   vnaFolderUrl_(fDaily.getId()));
  vnaSetValue_('Weekly Summaries Folder',  vnaFolderUrl_(fWeekly.getId()));
  vnaSetValue_('Monthly Summaries Folder', vnaFolderUrl_(fMonthly.getId()));
  vnaSetValue_('Prompts Folder (EN)',      vnaFolderUrl_(fPromptsEn.getId()));
  vnaSetValue_('Daily Prompt Doc (EN)',    vnaDocUrl_(pDaily.getId()));
  vnaSetValue_('Weekly Prompt Doc (EN)',   vnaDocUrl_(pWeekly.getId()));
  vnaSetValue_('Monthly Prompt Doc (EN)',  vnaDocUrl_(pMonthly.getId()));

  // Met aussi les IDs (et pas que les URLs) dans Script Properties pour le runtime
  const props = PropertiesService.getScriptProperties();
  props.setProperty('ROOT_FOLDER_ID',                  root.getId());
  props.setProperty('DRIVE_FOLDER_ID',                 fAudio.getId());
  props.setProperty('TRANSCRIPTION_STORAGE_FOLDER_ID', fTransc.getId());
  props.setProperty('ARCHIVE_AUDIO_FOLDER_ID',         fArchive.getId());
  props.setProperty('DAILY_SUMMARY_FOLDER_ID',         fDaily.getId());
  props.setProperty('WEEKLY_SUMMARY_FOLDER_ID',        fWeekly.getId());
  props.setProperty('MONTHLY_SUMMARY_FOLDER_ID',       fMonthly.getId());
  props.setProperty('PROMPTS_EN_FOLDER_ID',            fPromptsEn.getId());
  props.setProperty('PROMPT_DOC_ID',                   pDaily.getId());
  props.setProperty('PROMPT_WEEKLY_DOC_ID',            pWeekly.getId());
  props.setProperty('PROMPT_MONTHLY_DOC_ID',           pMonthly.getId());

  SpreadsheetApp.getActive().toast('Initialization done. Values written to column B and Script Properties.');
}

/** Action MENU : Test minimal de la clé OpenAI (ping court) */
function vnaTestOpenAIKey() {
  try {
    const keyFromSheet = vnaGetValue_('OpenAI API Key');
    if (keyFromSheet) {
      PropertiesService.getScriptProperties().setProperty('OPENAI_API_KEY', keyFromSheet);
    }
    // mini prompt pour limiter la conso
    const payload = {
      model: 'gpt-4o-mini',
      messages: [{ role:'user', content: 'Reply with: OK' }]
    };
    const resp = UrlFetchApp.fetch(OPENAI_CHAT_API_URL, {
      method: 'post',
      headers: { Authorization: 'Bearer ' + getOpenAIKey_(), 'Content-Type': 'application/json' },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const code = resp.getResponseCode();
    if (code !== 200) throw new Error(resp.getContentText());
    const txt = JSON.parse(resp.getContentText()).choices[0].message.content || '';
    SpreadsheetApp.getUi().alert('OpenAI OK (HTTP '+code+'): ' + txt.substring(0,120));
  } catch (e) {
    SpreadsheetApp.getUi().alert('OpenAI test FAILED: ' + (e && e.message ? e.message : e));
  }
}

/** Actions MENU : Open folders (ouvre un petit dialogue avec lien cliquable) */
function vnaOpenLink_(url, title) {
  const html = HtmlService.createHtmlOutput('<a target="_blank" href="'+url+'">Open '+title+'</a>').setWidth(240).setHeight(60);
  SpreadsheetApp.getUi().showModalDialog(html, title);
}
function vnaOpenRootFolder()  { const id = PropertiesService.getScriptProperties().getProperty('ROOT_FOLDER_ID'); if (id) vnaOpenLink_(vnaFolderUrl_(id),'Root'); }
function vnaOpenSourceAudio() { vnaOpenLink_(vnaGetValue_('Source Audio Folder'),'Source Audio'); }
function vnaOpenTranscriptions() { vnaOpenLink_(vnaGetValue_('Transcriptions Folder'),'Transcriptions'); }
function vnaOpenArchive()     { vnaOpenLink_(vnaGetValue_('Audio Archive Folder'),'Archive'); }
function vnaOpenDaily()       { vnaOpenLink_(vnaGetValue_('Daily Summaries Folder'),'Daily Summaries'); }
function vnaOpenWeekly()      { vnaOpenLink_(vnaGetValue_('Weekly Summaries Folder'),'Weekly Summaries'); }
function vnaOpenMonthly()     { vnaOpenLink_(vnaGetValue_('Monthly Summaries Folder'),'Monthly Summaries'); }
function vnaOpenPromptsEn()   { vnaOpenLink_(vnaGetValue_('Prompts Folder (EN)'),'Prompts (EN)'); }

/** Extract a Drive ID from an ID or URL. kind: 'doc' | 'folder' | 'any' */
function vnaExtractDriveId_(input, kind) {
  const s = String(input || '').trim();
  if (!s) return '';
  // Plain ID?
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;

  // Try URL patterns
  const patterns = [
    /\/document\/d\/([A-Za-z0-9_-]+)/, // Docs
    /\/folders\/([A-Za-z0-9_-]+)/,     // Folders
    /\/file\/d\/([A-Za-z0-9_-]+)/      // Generic file
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && m[1]) return m[1];
  }
  if (kind === 'doc') throw new Error('Invalid Google Doc ID/URL: ' + s);
  if (kind === 'folder') throw new Error('Invalid Google Drive folder ID/URL: ' + s);
  throw new Error('Invalid Drive ID/URL: ' + s);
}

/** Quick Drive scope poke to trigger auth if needed */
function vnaEnsureDriveAuth_() {
  const root = DriveApp.getRootFolder();
  // no-op, just to ensure OAuth prompt
  if (!root) throw new Error('Drive root not accessible (auth?)');
}

