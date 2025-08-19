/**
 * Fonctions d’appel OpenAI: transcription (Whisper) et synthèse (chat).
 */

function transcribeAudio_(file) {
  const blob = file.getBlob();
  const formData = { 'file': blob, 'model': 'whisper-1' };
  const baseOptions = {
    method: 'post',
    headers: { Authorization: `Bearer ${getOpenAIKey_()}` },
    payload: formData,
    muteHttpExceptions: true
  };

  const maxAttempts = TRANSCRIBE_MAX_ATTEMPTS || 4;
  const backoffBase = TRANSCRIBE_BACKOFF_MS || 1500;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = UrlFetchApp.fetch(OPENAI_API_URL, baseOptions);
      const code = response.getResponseCode();
      const body = response.getContentText();

      // Succès
      if (code === 200) {
        const json = JSON.parse(body);
        return json.text;
      }

      // Si code transitoire, on retente (429 + 5xx)
      if (shouldRetryStatus_(code) && attempt < maxAttempts) {
        const delay = computeBackoffWithJitter_(backoffBase, attempt);
        Logger.log(`Whisper: tentative ${attempt}/${maxAttempts} échouée (HTTP ${code}). Retry dans ${delay} ms.`);
        Utilities.sleep(delay);
        continue;
      }

      // Sinon, on lève l’erreur telle quelle
      throw new Error(`Erreur API transcription : ${body}`);

    } catch (err) {
      // Exceptions réseau/transport -> retry si on a encore des essais
      if (attempt < maxAttempts) {
        const delay = computeBackoffWithJitter_(backoffBase, attempt);
        Logger.log(`Whisper: tentative ${attempt}/${maxAttempts} exception (${err && err.message}). Retry dans ${delay} ms.`);
        Utilities.sleep(delay);
        continue;
      }
      throw new Error(`Erreur API transcription : ${err && err.message ? err.message : err}`);
    }
  }
  // Défensif (ne doit pas être atteint)
  throw new Error('Erreur API transcription : épuisement des retries');
}

/** Codes HTTP considérés comme transitoires pour retry. */
function shouldRetryStatus_(code) {
  return code === 429 || code === 408 || (code >= 500 && code <= 599);
}

/** Exponential backoff + jitter (0..300ms) */
function computeBackoffWithJitter_(baseMs, attempt) {
  const jitter = Math.floor(Math.random() * 300);
  return Math.floor(baseMs * Math.pow(2, attempt - 1)) + jitter;
}


function summarizeWithGPT_(prompt) {
  const payload = {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }]
  };
  const options = {
    method: 'post',
    headers: {
      Authorization: `Bearer ${getOpenAIKey_()}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  const response = UrlFetchApp.fetch(OPENAI_CHAT_API_URL, options);
  if (response.getResponseCode() !== 200) {
    throw new Error("Erreur API synthèse : " + response.getContentText());
  }
  const json = JSON.parse(response.getContentText());
  return json.choices[0].message.content;
}

/**
 * Concatène le prompt (Doc) + le texte de tous les Docs de transcription,
 * puis appelle summarizeWithGPT_().
 * => Correspond à “génération d’un résumé à partir de ces transcriptions Google Docs + le prompt qui est dans un Google Docs”.
 */
function generateSummaryFromDocs_(promptDocId, transcriptionDocIds) {
  const promptText = getDocContent_(promptDocId);
  const parts = [promptText];
  transcriptionDocIds.forEach(id => {
    const text = getDocContent_(id);
    parts.push(text);
  });
  const combinedPrompt = parts.join("\n\n");
  return summarizeWithGPT_(combinedPrompt);
}

/**
 * Force une sortie HTML en ajoutant une instruction "system".
 * Si le modèle ne respecte pas complètement, on gèrera un fallback côté drive_docs.gs.
 */
function summarizeAsHTMLFromDocs_(promptDocId, transcriptionDocIds) {
  const promptText = getDocContent_(promptDocId);
  const parts = [promptText];
  transcriptionDocIds.forEach(id => parts.push(getDocContent_(id)));
  const userText = parts.join("\n\n");

  const systemInstruction =
    "FORMAT: Return a complete, valid, self-contained HTML fragment using only semantic tags " +
    "(<h1..h3>, <p>, <ul>/<ol>/<li>, <strong>, <em>, <blockquote>, <pre><code>, <a>). " +
    "No Markdown. Do not include scripts or external resources. Start with a single <h1>.";

  const payload = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userText }
    ]
  };

  const options = {
    method: 'post',
    headers: {
      Authorization: `Bearer ${getOpenAIKey_()}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(OPENAI_CHAT_API_URL, options);
  if (response.getResponseCode() !== 200) {
    throw new Error("Erreur API synthèse (HTML) : " + response.getContentText());
  }
  const json = JSON.parse(response.getContentText());
  return json.choices[0].message.content;
}

