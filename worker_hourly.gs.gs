/**
 * Worker horaire: traite AU PLUS un audio par exécution.
 * - prend le plus ancien audio dans le dossier source (cfgDriveFolderId_)
 * - transcrit (avec retries déjà présents dans transcribeAudio_)
 * - crée le Doc de transcription préfixé par la date de l'audio
 * - archive l'audio dans le dossier archive (cfgArchiveAudioFolderId_)
 * - en cas d'erreur => alerte email cfgHourlyAlertEmail_()
 */

function hourlyTranscriptionWorker() {
  if (!HOURLY_TRIGGER_ENABLED) {
    Logger.log('Hourly worker désactivé (HOURLY_TRIGGER_ENABLED=false).');
    return;
  }

  const sourceId = cfgDriveFolderId_();
  const archiveId = cfgArchiveAudioFolderId_();
  const transId = cfgTranscriptionFolderId_();
  const alertTo = cfgHourlyAlertEmail_();

  Logger.log('--- HOURLY WORKER start ---');
  Logger.log(`IDs utilisés | source=${sourceId} | trans=${transId} | archive=${archiveId}`);

  try {
    // 1) Récupère les audios à traiter (FIFO: plus ancien d’abord)
    const candidates = listAudioFilesInFolderSortedOldestFirst_(sourceId, AUDIO_MIME_TYPES);
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
      sendEmail_(alertTo, 'Hourly worker - audio trop volumineux', msg);
      return; // on laisse le fichier en place pour action manuelle
    }

    // 3) Transcription
    Logger.log(`Transcription de: ${file.getName()} (${sizeMB.toFixed(2)} MB)`);
    const text = transcribeAudio_(file); // retries déjà en place

    // 4) Création du Doc de transcription
    const dYMD = formatFileDateYMD_(file); // yyyy-MM-dd (basé sur date du fichier)
    const tHM  = formatFileTimeHM_(file);  // HHmm        (basé sur date du fichier)
    const safeAudioName = sanitizeForTitle_(file.getName());
    const baseDocName   = `${dYMD}-${tHM}__${safeAudioName}`;
    const docName       = truncateMiddle_(baseDocName, 140);

    createTranscriptionDoc_(docName, file.getName(), text, transId);
    Logger.log(`Doc de transcription créé: ${docName}`);

    // 5) Archive l'audio
    moveFileBetweenFolders_(file, sourceId, archiveId);
    Logger.log(`Audio archivé: ${file.getName()}`);

  } catch (e) {
    const err = (e && e.message) ? e.message : String(e);
    Logger.log('ERREUR Hourly worker: ' + err);
    sendEmail_(alertTo || cfgEmailDestination_(), 'Hourly worker - transcription FAILED', err);
  }
  Logger.log('--- HOURLY WORKER end ---');
}
