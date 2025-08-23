/** Envoi d'email simple (utilisé par le worker horaire) */
function sendEmail_(to, subject, body) {
  MailApp.sendEmail(to, subject, body);
}

/** Nettoie un texte pour un titre de Doc (pas d'accents spéciaux/bizarres) */
function sanitizeForTitle_(s) {
  return String(s)
    .replace(/[^\w\-. ]/g, '_')  // remplace tout ce qui n'est pas lettre/chiffre/._-espace
    .replace(/_+/g, '_')         // compresse les underscores
    .trim();
}

/** Tronque au milieu si le titre est trop long (ex: 140 chars) */
function truncateMiddle_(s, maxLen) {
  if (!maxLen || s.length <= maxLen) return s;
  const keep = Math.floor((maxLen - 3) / 2);
  return s.slice(0, keep) + '...' + s.slice(-keep);
}

/** Extract a Drive ID from an ID or URL. kind: 'doc' | 'folder' | 'any' */
function vnaExtractDriveId_(input, kind) {
  const s = String(input || '').trim();
  if (!s) return '';
  // déjà un ID ?
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;

  const patterns = [
    /\/document\/d\/([A-Za-z0-9_-]+)/, // Docs
    /\/folders\/([A-Za-z0-9_-]+)/,     // Folders
    /\/file\/d\/([A-Za-z0-9_-]+)/      // File
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && m[1]) return m[1];
  }
  if (kind === 'doc')    throw new Error('Invalid Google Doc ID/URL: ' + s);
  if (kind === 'folder') throw new Error('Invalid Google Drive folder ID/URL: ' + s);
  throw new Error('Invalid Drive ID/URL: ' + s);
}
