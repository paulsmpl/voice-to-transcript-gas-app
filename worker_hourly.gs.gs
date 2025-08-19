/**
 * Worker horaire: traite AU PLUS un audio par exécution.
 * - prend le plus ancien audio dans DRIVE_FOLDER_ID
 * - transcrit (avec retries déjà présents dans transcribeAudio_)
 * - crée le Doc de transcription préfixé par la date de l'audio
 * - archive l'audio dans ARCHIVE_AUDIO_FOLDER_ID
 * - en cas d'erreur => alerte email HOURLY_ALERT_EMAIL
 */

function hourlyTranscriptionWorker() {
  if (!HOURLY_TRIGGER_ENABLED) {
    Logger.log('Hourly worker désactivé (HOURLY_TRIGGER_ENABLED=false).');
    return;
  }

  Logger.log('--- HOURLY WORKER start ---');
  try {
    // 1) Récupère les audios à traiter (FIFO: plus ancien d’abord)
    const candidates = listAudioFilesInFolderSortedOldestFirst_(DRIVE_FOLDER_ID, AUDIO_MIME_TYPES);
    if (!candidates.length) {
      Logger.log('Aucun nouvel audio à traiter.');
      return;
    }
    const file = candidates[0];

    // 2) Garde-fou taille (Whisper ~25MB)
    const sizeMB = file.getSize() / (1024 * 1024);
    if (MAX_AUDIO_MB && sizeMB > MAX_AUDIO_MB) {
      const msg = `Audio trop volumineux (${sizeMB.toFixed(2)} MB > ${MAX_AUDIO_MB} MB) : ${file.getName()}`;
      Logger.log(msg);
      sendEmail_(HOURLY_ALERT_EMAIL, 'Hourly worker - audio trop volumineux', msg);
      return; // on laisse le fichier en place pour action manuelle
    }

    // 3) Transcription
    Logger.log(`Transcription de: ${file.getName()} (${sizeMB.toFixed(2)} MB)`);
    const text = transcribeAudio_(file); // retries déjà en place

    // 4) Création du Doc de transcription
    //    Nom = date/heure du fichier + "__" + nom de l'audio nettoyé, tronqué si trop long
    const dYMD = formatFileDateYMD_(file); // yyyy-MM-dd (basé sur date du fichier)
    const tHM  = formatFileTimeHM_(file);  // HHmm        (basé sur date du fichier)
    const safeAudioName = sanitizeForTitle_(file.getName());
    const baseDocName   = `${dYMD}-${tHM}__${safeAudioName}`; // ex: "2025-08-18-0739__meeting-marketing.mp3"
    const docName       = truncateMiddle_(baseDocName, 140);

    createTranscriptionDoc_(docName, file.getName(), text, TRANSCRIPTION_STORAGE_FOLDER_ID);
    Logger.log(`Doc de transcription créé: ${docName}`);

    // 5) Archive l'audio
    moveFileBetweenFolders_(file, DRIVE_FOLDER_ID, ARCHIVE_AUDIO_FOLDER_ID);
    Logger.log(`Audio archivé: ${file.getName()}`);

  } catch (e) {
    const err = (e && e.message) ? e.message : String(e);
    Logger.log('ERREUR Hourly worker: ' + err);
    sendEmail_(HOURLY_ALERT_EMAIL, 'Hourly worker - transcription FAILED', err);
    // pas de rethrow: on veut que les runs suivants continuent.
  }
  Logger.log('--- HOURLY WORKER end ---');
}
