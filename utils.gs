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
