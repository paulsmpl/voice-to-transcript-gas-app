/**
 * Drive/Docs helpers: lister fichiers d’hier, créer/ranger des Docs,
 * lire un Doc, trouver des Docs par préfixe, envoyer un email avec un lien.
 */

// === EXISTANT (inchangé) ===
function getFilesFromYesterday_(folderId) {
  const { startYesterday, startToday } = getYesterdayWindow_();
  const query = `'${folderId}' in parents and mimeType = '${AUDIO_MIME_TYPE}' and trashed = false`;
  const it = DriveApp.searchFiles(query);
  const out = [];
  while (it.hasNext()) {
    const file = it.next();
    const created = file.getDateCreated();
    if (created >= startYesterday && created < startToday) out.push(file);
  }
  return out;
}

function createTranscriptionDoc_(docName, sourceFileName, transcriptionText, targetFolderId) {
  const doc = DocumentApp.create(docName);
  const body = doc.getBody();
  body.appendParagraph(`Transcription de ${sourceFileName}`);
  body.appendParagraph(transcriptionText);
  doc.saveAndClose();

  const targetFolder = DriveApp.getFolderById(targetFolderId);
  const docFile = DriveApp.getFileById(doc.getId());
  targetFolder.addFile(docFile);
  DriveApp.getRootFolder().removeFile(docFile);
  return { docId: doc.getId(), docUrl: doc.getUrl(), name: docName };
}

function getDocContent_(docId) {
  return DocumentApp.openById(docId).getBody().getText();
}

// === NOUVEAU ===

/** Crée un Doc nommé avec un contenu simple, et le range dans folderId. */
function createNamedDocInFolder_(docName, content, folderId) {
  const doc = DocumentApp.create(docName);
  doc.getBody().appendParagraph(content);
  doc.saveAndClose();

  const folder = DriveApp.getFolderById(folderId);
  const file = DriveApp.getFileById(doc.getId());
  folder.addFile(file);
  DriveApp.getRootFolder().removeFile(file);

  return { docId: doc.getId(), docUrl: doc.getUrl(), name: docName };
}

/** Retourne le premier Doc dans folderId dont le nom commence par prefix (ou null). */
function findDocByNamePrefixInFolder_(folderId, prefix) {
  const folder = DriveApp.getFolderById(folderId);
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed() && f.getName().startsWith(prefix)) return f;
  }
  return null;
}

/** Liste tous les fichiers (non corbeille) d’un dossier, triés par date de création DESC. */
function listFilesInFolderSortedByCreatedDesc_(folderId) {
  const folder = DriveApp.getFolderById(folderId);
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed()) files.push(f);
  }
  files.sort((a,b)=> b.getDateCreated().getTime() - a.getDateCreated().getTime());
  return files;
}

/** Récupère les 7 derniers daily (par préfixe de date 'yyyy-MM-dd - Daily Summary') à partir d’hier. */
function getLast7DailySummaries_() {
  const dates = getLastNDatesFromYesterdayStrings_(7); // [J-1,...,J-7]
  const out = [];
  for (const ds of dates) {
    const prefix = `${ds} - Daily Summary`;
    const f = findDocByNamePrefixInFolder_(DAILY_SUMMARY_FOLDER_ID, prefix);
    if (f) out.push(f);
  }
  return out; // tableau de File (ordre J-1 -> J-7)
}

/** Récupère les 5 derniers weekly (par nom contenant 'Weekly Summary'), triés DESC. */
function getLast5WeeklySummaries_() {
  const all = listFilesInFolderSortedByCreatedDesc_(WEEKLY_SUMMARY_FOLDER_ID);
  const filtered = all.filter(f => f.getName().indexOf('Weekly Summary') !== -1);
  return filtered.slice(0,5);
}

/** Envoie un email ne contenant que le lien du Doc créé. */
function sendEmailWithLink_(to, subject, docUrl) {
  const body = `Résumé créé : ${docUrl}`;
  MailApp.sendEmail(to, subject, body);
}

/**
 * Conversion HTML -> Google Doc en un seul appel via Advanced Drive Service (v2).
 * Nécessite l’Advanced Drive Service "Drive" activé.
 */
function createDocFromHtmlInFolder_(docName, html, folderId) {
  const blob = Utilities.newBlob(html, 'text/html', docName + '.html');
  const resource = {
    title: docName,
    mimeType: 'application/vnd.google-apps.document',
    parents: [{ id: folderId }]
  };
  const file = Drive.Files.insert(resource, blob, { convert: true });
  return { docId: file.id, docUrl: 'https://docs.google.com/document/d/' + file.id + '/edit', name: docName };
}

/** Détection très simple : a-t-on déjà des balises HTML sémantiques ? */
function looksLikeHtml_(s) {
  return /<\/?(h1|h2|h3|p|ul|ol|li|strong|em|blockquote|pre|code|a)\b/i.test(s);
}

/** Fallback minimal Markdown -> HTML (titres, gras/italique, listes, code, liens, blockquotes) */
function markdownToHtmlBasic_(md) {
  // Échappement brut pour les blocs code triple backticks
  md = md.replace(/```([\s\S]*?)```/g, function(_, code) {
    const escaped = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return '\n<pre><code>' + escaped + '</code></pre>\n';
  });

  // Titres
  md = md.replace(/^######\s+(.*)$/gm, '<h6>$1</h6>');
  md = md.replace(/^#####\s+(.*)$/gm, '<h5>$1</h5>');
  md = md.replace(/^####\s+(.*)$/gm, '<h4>$1</h4>');
  md = md.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
  md = md.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>');
  md = md.replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');

  // Blockquotes
  md = md.replace(/^\>\s+(.*)$/gm, '<blockquote>$1</blockquote>');

  // Listes ordonnées
  // Transforme groupes de lignes en <ol>...</ol>
  md = md.replace(/(^\d+\.\s+.*(?:\n\d+\.\s+.*)*)/gm, function(block){
    const items = block.trim().split(/\n/).map(l => l.replace(/^\d+\.\s+/, '').trim());
    return '<ol><li>' + items.join('</li><li>') + '</li></ol>';
  });

  // Listes non ordonnées
  md = md.replace(/(^[-*+]\s+.*(?:\n[-*+]\s+.*)*)/gm, function(block){
    const items = block.trim().split(/\n/).map(l => l.replace(/^[-*+]\s+/, '').trim());
    return '<ul><li>' + items.join('</li><li>') + '</li></ul>';
  });

  // Liens [texte](url)
  md = md.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  // Gras / Italique (simple)
  md = md.replace(/\*\*\s*(.*?)\s*\*\*/g, '<strong>$1</strong>');
  md = md.replace(/__\s*(.*?)\s*__/g, '<strong>$1</strong>');
  md = md.replace(/(^|[^\*])\*\s*(.*?)\s*\*(?!\*)/g, '$1<em>$2</em>');
  md = md.replace(/(^|[^_])_\s*(.*?)\s*_(?!_)/g, '$1<em>$2</em>');

  // Code inline `code`
  md = md.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Paragraphes (insère <p> pour lignes isolées qui ne sont pas déjà balisées)
  md = md.replace(/^(?!\s*<)([^\n]+)\n?(?=\n|$)/gm, '<p>$1</p>');

  return md;
}

/** Garantit un HTML prêt à convertir (wrap + fallback Markdown si besoin) */
function ensureHtmlDocument_(s) {
  let htmlFragment = s;
  if (!looksLikeHtml_(s)) {
    htmlFragment = markdownToHtmlBasic_(s);
  }
  return wrapHtmlDocument_(htmlFragment);
}

/** Retourne tous les Google Docs créés entre start (inclus) et end (exclu) dans un dossier. */
function listDocsCreatedBetweenInFolder_(folderId, start, end) {
  const folder = DriveApp.getFolderById(folderId);
  const it = folder.getFiles();
  const out = [];
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    if (f.getMimeType() !== MimeType.GOOGLE_DOCS) continue;
    const created = f.getDateCreated();
    if (created >= start && created < end) out.push(f);
  }
  // Tri par date de création croissante (du plus ancien au plus récent d'hier)
  out.sort((a, b) => a.getDateCreated().getTime() - b.getDateCreated().getTime());
  return out;
}

/** Raccourci : tous les Docs créés "hier" dans un dossier donné. */
/** Retourne tous les Google Docs du dossier dont le nom commence par la date d’hier (yyyy-MM-dd). */
function getTranscriptionDocsByNamePrefixYesterday_(folderId) {
  const prefix = getYesterdayDateString_(); // ex: "2025-08-16"
  const folder = DriveApp.getFolderById(folderId);
  const it = folder.getFiles();
  const out = [];
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    if (f.getMimeType() !== MimeType.GOOGLE_DOCS) continue;
    if (f.getName().startsWith(prefix)) out.push(f);
  }
  // Tri par nom (ex: -01, -02, …)
  out.sort((a, b) => a.getName().localeCompare(b.getName()));
  return out;
}

/** Renvoie la liste des audios d'un dossier triés par date de création ASC (plus ancien en 1er). */
function listAudioFilesInFolderSortedOldestFirst_(folderId, mimeTypes) {
  const it = DriveApp.getFolderById(folderId).getFiles();
  const out = [];
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    if (!mimeTypes || mimeTypes.indexOf(f.getMimeType()) !== -1) {
      out.push(f);
    }
  }
  out.sort((a,b) => a.getDateCreated().getTime() - b.getDateCreated().getTime());
  return out;
}

/** Déplace un fichier d'un dossier source vers un dossier cible (archive). */
function moveFileBetweenFolders_(file, fromFolderId, toFolderId) {
  const from = DriveApp.getFolderById(fromFolderId);
  const to = DriveApp.getFolderById(toFolderId);
  to.addFile(file);
  from.removeFile(file);
}

/** Formate la date (Europe/Paris) d'un fichier en 'yyyy-MM-dd' */
function formatFileDateYMD_(file) {
  const tz = Session.getScriptTimeZone();
  const d = file.getDateCreated();
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

/** Formate l'heure (Europe/Paris) d'un fichier en 'HHmm' */
function formatFileTimeHM_(file) {
  const tz = Session.getScriptTimeZone();
  const d = file.getDateCreated();
  return Utilities.formatDate(d, tz, 'HHmm');
}


