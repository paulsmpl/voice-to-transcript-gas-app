# Voice-to-Transcript (Google Apps Script)

A production‑ready Google Apps Script (GAS) workflow that **transcribes audio files from Google Drive** and produces **Daily / Weekly / Monthly summaries** as nicely formatted Google Docs (HTML → Doc conversion). It also sends **email notifications with links** to the created summary documents.

This README is a full **install & usage guide** for anyone cloning the repository.

---

## Table of Contents

- [What this project does](#what-this-project-does)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
  - [1) Create Drive folders](#1-create-drive-folders)
  - [2) Create prompt Docs](#2-create-prompt-docs)
  - [3) Create the Apps Script project](#3-create-the-apps-script-project)
  - [4) Configure Script Properties](#4-configure-script-properties)
  - [5) Update configuration constants](#5-update-configuration-constants)
  - [6) Enable Advanced Drive Service + Drive API](#6-enable-advanced-drive-service--drive-api)
  - [7) Manifest scopes (appsscriptjson)](#7-manifest-scopes-appsscriptjson)
  - [8) First run & basic tests](#8-first-run--basic-tests)
  - [9) Create triggers](#9-create-triggers)
- [How it works](#how-it-works)
  - [Client workflow](#client-workflow)
  - [Server workflow (hourly transcription worker)](#server-workflow-hourly-transcription-worker)
  - [Daily / Weekly / Monthly summaries](#daily--weekly--monthly-summaries)
  - [Naming conventions](#naming-conventions)
- [ASCII Diagrams](#ascii-diagrams)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Security & privacy](#security--privacy)
- [Notes on models & limits](#notes-on-models--limits)
- [Development tips](#development-tips)
- [License](#license)

---

## What this project does

1. **Hourly transcription worker**  
   Runs every hour, picks **only one** oldest audio file from a Drive **Source** folder, **transcribes** it using OpenAI Whisper, creates a **transcript Google Doc**, then **archives the audio** to a separate folder.  
   - Robust **retry** logic for transient API errors (429/5xx).  
   - Sends an **alert email** if transcription fails or the audio is too large.

2. **Daily summary (once per day)**  
   Gathers **yesterday’s transcript Docs** (by filename prefix `YYYY-MM-DD`) and generates a **Daily Summary** Doc using a **Daily prompt Doc**. Email contains **only the link** to the generated Google Doc.

3. **Weekly summary (once per week)**  
   Combines the **last 7 Daily summaries**, generates a **Weekly Summary** Doc using a **Weekly prompt Doc**, emails the link.  
   - If the run day is the **first \<weekday\> of the month** (configurable), it also triggers the **Monthly** summary.

4. **Monthly summary (auto on first \<weekday\> of month)**  
   Combines the **last 5 Weekly summaries** using a **Monthly prompt Doc**, creates a Monthly Summary Doc, and emails the link.

5. **HTML → Google Doc conversion**  
   Summaries are produced as **semantic HTML** by the model and converted to Google Docs through the **Advanced Drive Service** for clean headings, lists, emphasis, code blocks, etc.  
   If the model returns Markdown, a lightweight Markdown→HTML fallback runs.

---

## Repository layout

```
.
├─ config.gs                 # Global constants, time helpers, key access, date utilities
├─ drive_docs.gs            # Drive/Docs utilities (list, create, move, email, HTML conversion)
├─ ai.gs                    # OpenAI calls: Whisper transcription + HTML summary generation
├─ main.gs                  # Orchestration: daily(), weeklyMain(), monthlyMain_()
├─ worker_hourly.gs         # hourlyTranscriptionWorker(): 1 audio/run, archive, alert on failure
├─ triggers.gs              # Helpers to create hourly/daily/weekly triggers
├─ tests.gs                 # Manual tests for sanity checks
└─ appsscript.json          # Manifest (scopes + Advanced Drive Service)
```

---

## Prerequisites

- A Google Workspace or Gmail account with **Google Drive** and **Google Docs** access.
- Permissions to create Apps Script projects and enable Advanced Services.
- An **OpenAI API key** with access to:
  - **Whisper (`whisper-1`)** for audio transcription,
  - **gpt-4o-mini** (or similar) for summary generation.
- Audio files are synced from your smartphone to a specific **Drive Source folder** (e.g. using Google Drive app or any sync app).

> **Timezone:** The script is designed for a project timezone of **Europe/Paris** (set in `appsscript.json`).

---

## Setup

### 1) Create Drive folders

Create the following folders in Google Drive and note down their **IDs** (the long string in the URL):

- **Source Audio Folder**: where your smartphone uploads audio files.
- **Archive Audio Folder**: where processed audio files are moved.
- **Transcriptions Folder**: generated transcript Docs are stored here.
- **Daily Summaries Folder**
- **Weekly Summaries Folder**
- **Monthly Summaries Folder**

**How to find a Drive ID:**  
Open the folder, copy the URL, and take the ID between `/folders/` and the next slash/end.

```
https://drive.google.com/drive/folders/<THIS_IS_THE_ID>
```

### 2) Create prompt Docs

Create three Google Docs and write your instructions/prompt in natural language.  
We strongly recommend **HTML output** from the model:

At the top of each prompt Doc (Daily/Weekly/Monthly), add something like:

```
[FORMAT] Return a complete, valid, self-contained HTML fragment using only semantic tags:
<h1..h3>, <p>, <ul>/<ol>/<li>, <strong>, <em>, <blockquote>, <pre><code>, <a>.
No Markdown. No scripts. Start with a single <h1>.
```

Note each prompt Doc’s **ID** from its URL:

```
https://docs.google.com/document/d/<THIS_IS_THE_ID>/edit
```

### 3) Create the Apps Script project

- In Google Drive, click **New → More → Google Apps Script**.  
- Add one file per source (`config.gs`, `drive_docs.gs`, `ai.gs`, `main.gs`, `worker_hourly.gs`, `triggers.gs`, `tests.gs`) and paste the code from this repo.

### 4) Configure Script Properties

Go to **File → Project properties → Script properties** and add:

- `OPENAI_API_KEY = <your OpenAI key>`

### 5) Update configuration constants

Open `config.gs` and set:

- **Drive & Docs IDs**
  - `DRIVE_FOLDER_ID` — Source Audio folder ID.
  - `ARCHIVE_AUDIO_FOLDER_ID` — Archive folder ID (processed audios).
  - `TRANSCRIPTION_STORAGE_FOLDER_ID` — Transcriptions folder ID.
  - `DAILY_SUMMARY_FOLDER_ID` — Daily summaries folder ID.
  - `WEEKLY_SUMMARY_FOLDER_ID` — Weekly summaries folder ID.
  - `MONTHLY_SUMMARY_FOLDER_ID` — Monthly summaries folder ID.
  - `PROMPT_DOC_ID` — Daily prompt Doc ID.
  - `PROMPT_WEEKLY_DOC_ID` — Weekly prompt Doc ID.
  - `PROMPT_MONTHLY_DOC_ID` — Monthly prompt Doc ID.

- **Emails**
  - `EMAIL_DESTINATION` — Where to receive **links** to Daily/Weekly/Monthly Docs.
  - `HOURLY_ALERT_EMAIL` — Where to receive **alert emails** on hourly failures.

- **Schedules**
  - `HOURLY_TRIGGER_ENABLED = true`
  - `DAILY_TRIGGER_HOUR = 7` (0–23)
  - `WEEKLY_TRIGGER_HOUR = 7`
  - `WEEKLY_ANCHOR_WEEKDAY_NAME = 'MONDAY'` (one of: `SUNDAY`..`SATURDAY`)  
    The **Monthly** summary runs automatically from the weekly job if the day is the **first** of that weekday in the month.

- **Audio handling**
  - `AUDIO_MIME_TYPES` — Acceptable input types (mp3/m4a/wav/webm/ogg…).
  - `MAX_AUDIO_MB = 25` — Guardrail for Whisper’s typical size limit.

> **Tip:** All IDs are taken from Drive/Docs URLs as shown above.

### 6) Enable Advanced Drive Service + Drive API

1. In the Apps Script editor: **Services** (puzzle icon) → **Advanced Google services** → enable **Drive API (v2)**.  
2. Click the link to open the **Google Cloud Console** and enable **Drive API** there too if prompted.

### 7) Manifest scopes (`appsscript.json`)

Your manifest should include at least:

```json
{
  "timeZone": "Europe/Paris",
  "exceptionLogging": "STACKDRIVER",
  "oauthScopes": [
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/script.send_mail"
  ],
  "advancedServices": [
    { "userSymbol": "Drive", "serviceId": "drive", "version": "v2" }
  ]
}
```

### 8) First run & basic tests

- Run `demanderPermissionsDrive()` once to grant Drive scopes.  
- In **tests.gs**, you can run:
  - `testConfig_()` — checks that your API key is present.
  - `testDates_()` — sanity check for date formatting.
  - `testHtmlCreation_()` — verifies HTML → Doc conversion works.
  - `testMarkdownFallback_()` — verifies Markdown→HTML fallback and Doc creation.

### 9) Create triggers

In **triggers.gs**, run:

- `createHourlyWorkerTrigger()` — runs `hourlyTranscriptionWorker()` **every hour**.
- `createDailyTrigger()` — runs the **daily** summary once per day at `DAILY_TRIGGER_HOUR`.
- `createWeeklyTrigger()` — runs the **weekly** summary on `WEEKLY_ANCHOR_WEEKDAY_NAME` at `WEEKLY_TRIGGER_HOUR`.

Or just call `createAllTriggers()` to create all three.

---

## How it works

### Client workflow

1. User records **voice memos** on their smartphone.
2. Audio files are automatically **synced to Google Drive** into the **Source Audio** folder.

### Server workflow (hourly transcription worker)

Every hour (if enabled):

1. `hourlyTranscriptionWorker()` lists audios in the **Source Audio** folder, **sorted oldest first**.
2. It picks **one audio only** (to stay far below the 6‑minute Apps Script execution limit).
3. It **checks size** (`MAX_AUDIO_MB`, default 25 MB). If too large, sends an alert and skips.
4. It **transcribes** the audio via OpenAI Whisper (`transcribeAudio_`) with **exponential backoff retries** on 429/5xx/502, etc.
5. It creates a **transcript Google Doc** in the **Transcriptions** folder.  
   - Doc title: `YYYY-MM-DD-HHMM__<original-audio-filename>` (sanitized & truncated if needed).  
   - The original audio filename is also written inside the Doc body.
6. It **moves the audio to the Archive** folder.
7. If any error occurs (API/network/timeout), it sends an **alert email** to `HOURLY_ALERT_EMAIL`.

### Daily / Weekly / Monthly summaries

- **Daily (`main()`):**  
  Finds all transcript Docs in the **Transcriptions** folder whose **name starts with yesterday’s date** `YYYY-MM-DD`.  
  It prompts the model to return **semantic HTML**, then converts it to a Google Doc via the **Advanced Drive Service**.  
  The **Daily Summary Doc** is saved in the **Daily Summaries** folder, and an email is sent with the **Doc link**.

- **Weekly (`weeklyMain()`):**  
  Loads the **last 7 Daily Summary Docs**, produces a **Weekly Summary** HTML, converts it to a Doc in the **Weekly Summaries** folder, and emails the **Doc link**.  
  If today is the **first** `WEEKLY_ANCHOR_WEEKDAY_NAME` **of the month**, it immediately calls the **Monthly** job.

- **Monthly (`monthlyMain_()`):**  
  Loads the **last 5 Weekly Summary Docs**, produces the **Monthly Summary** HTML, converts it to a Doc in the **Monthly Summaries** folder, and emails the **Doc link**.  
  The Monthly title uses the **previous month label** `YYYY-MM`.

### Naming conventions

- Transcript Docs (hourly):  
  `YYYY-MM-DD-HHMM__original-file-name.ext`
- Daily Summary:  
  `YYYY-MM-DD - Daily Summary`
- Weekly Summary:  
  `YYYY-MM-DD - Weekly Summary (7d)`  (date is the week end date = “yesterday” of the run)
- Monthly Summary:  
  `YYYY-MM - Monthly Summary`  (label of the **previous** month)

---

## ASCII Diagrams

### 1) End-to-end overview

```
+--------------------------+       +-----------------------------+
|  Client (Smartphone)     |       |  Google Drive               |
|  - Record voice memos    |       |  - Source Audio folder      |
|  - Auto-sync to Drive    +------>+  - Transcriptions folder    |
+--------------------------+       |  - Archive folder           |
                                   |  - Daily/Weekly/Monthly     |
                                   +--------------+--------------+
                                                  |
                                                  v  (hourly)
                                        +---------------------------+
                                        | Apps Script: HOURLY       |
                                        | - pick 1 oldest audio     |
                                        | - transcribe (retries)    |
                                        | - create transcript Doc   |
                                        | - move audio to archive   |
                                        | - email alert on failure  |
                                        +--------------+------------+
                                                       |
                                                       v
                                         +---------------------------+
                                         | Apps Script: Summaries    |
                                         | - DAILY (yesterday)       |
                                         | - WEEKLY (7 dailies)      |
                                         | - MONTHLY (5 weeklies)    |
                                         | -> HTML -> Google Doc     |
                                         | -> email doc link         |
                                         +---------------------------+
```

### 2) Hourly worker (detailed)

```
(Every hour via trigger)
        |
        v
+-------------------------------+
| List audios (oldest first)    |
+---------------+---------------+
                |
          [none]|----> exit
                v
        +------------------+
        | oldest audio     |
        +------------------+
                |
                v
     Size > MAX_AUDIO_MB ? ---- yes ----> [Send alert email] -> exit
                |
               no
                v
       +-------------------+
       | Transcribe (API)  |
       | retry on 429/5xx  |
       +---------+---------+
                 |
          success|----> +-------------------------------+
                 v      | Create transcript Doc         |
                        | name: YYYY-MM-DD-HHMM__audio  |
                        +---------------+---------------+
                                        |
                                        v
                              +--------------------------+
                              | Move audio to Archive    |
                              +--------------------------+

          failure
             |
             v
    [Send alert email with error]
```

### 3) Summary pipeline

```
DAILY:
  - Find transcript Docs where name starts with yesterday's "YYYY-MM-DD"
  - Summarize (HTML) -> convert to Google Doc
  - Save to Daily Summaries -> email link

WEEKLY:
  - Take 7 most recent Daily Summary Docs
  - Summarize (HTML) -> convert to Google Doc
  - Save to Weekly Summaries -> email link
  - If first <weekday> of month -> run MONTHLY

MONTHLY:
  - Take 5 most recent Weekly Summary Docs
  - Summarize (HTML) -> convert to Google Doc
  - Save to Monthly Summaries -> email link
```

---

## Configuration reference

Key constants from `config.gs`:

- **Folder & Doc IDs**
  - `DRIVE_FOLDER_ID` — Source audio folder (incoming)
  - `ARCHIVE_AUDIO_FOLDER_ID` — Destination for processed audios
  - `TRANSCRIPTION_STORAGE_FOLDER_ID` — Destination for transcript Docs
  - `DAILY_SUMMARY_FOLDER_ID`, `WEEKLY_SUMMARY_FOLDER_ID`, `MONTHLY_SUMMARY_FOLDER_ID`
  - `PROMPT_DOC_ID`, `PROMPT_WEEKLY_DOC_ID`, `PROMPT_MONTHLY_DOC_ID`

- **Emails**
  - `EMAIL_DESTINATION` — Recipient of summary **links**
  - `HOURLY_ALERT_EMAIL` — Recipient of **alert** emails

- **Schedules**
  - `HOURLY_TRIGGER_ENABLED`
  - `DAILY_TRIGGER_HOUR`, `WEEKLY_TRIGGER_HOUR`
  - `WEEKLY_ANCHOR_WEEKDAY_NAME` (controls Monthly)

- **API endpoints & models**
  - `OPENAI_API_URL = 'https://api.openai.com/v1/audio/transcriptions'`
  - `OPENAI_CHAT_API_URL = 'https://api.openai.com/v1/chat/completions'`
  - `AUDIO_MIME_TYPES`, `MAX_AUDIO_MB`

- **Retry config for Whisper**
  - `TRANSCRIBE_MAX_ATTEMPTS` (default 4)
  - `TRANSCRIBE_BACKOFF_MS` (default 1500 ms)

**How to get IDs:** open the item in Drive/Docs and copy the ID from the URL.

---

## Troubleshooting

- **Transcription 502/5xx/429**  
  The worker has **retries with exponential backoff**. Check execution logs. If it still fails:
  - Verify file **size** (`MAX_AUDIO_MB` guardrail).
  - Try re-running the worker.  
  - Check your OpenAI key and account limits.

- **Exceeded 6-minute limit**  
  The worker processes **one audio per run** to avoid this. If you still hit the limit, your audio might be too long or network slow. Consider:
  - Reducing input types,
  - Splitting long audios,
  - Increasing hourly frequency (e.g., every 30 min) but still 1 file per run.

- **Summaries not created**  
  - Ensure **Daily** finds transcripts by **name prefix** (yesterday `YYYY-MM-DD`).
  - Ensure **Weekly** has 7 dailies available, and **Monthly** has 5 weeklies.

- **HTML not rendering**  
  - Ensure **Advanced Drive Service** is enabled; summaries are created via HTML→Doc conversion.
  - Check prompts explicitly ask for **semantic HTML**.

- **No emails received**  
  - Confirm `EMAIL_DESTINATION` / `HOURLY_ALERT_EMAIL`.
  - Check **Gmail send limits** and ensure scopes include `script.send_mail`.

- **Wrong timezone**  
  - Manifest should be `Europe/Paris`. If your Drive items look off, check both Apps Script project timezone and your prompt logic.

---

## Security & privacy

- **Do not commit your OpenAI API key.** Store it in **Script Properties**.
- Audio and transcripts may contain sensitive information. Restrict Drive folder sharing appropriately.
- Email notifications only include **links**, not the full content.

---

## Notes on models & limits

- **Whisper (`whisper-1`)**: typical size limit around **25 MB** per request. Guardrail enforced by `MAX_AUDIO_MB`.
- **Summary model**: `gpt-4o-mini` by default; you can swap if you have access to another model.
- OpenAI APIs may occasionally return transient errors; the worker’s retry logic handles most cases.

---

## Development tips

- You can test end‑to‑end by dropping a small `.mp3` into the **Source Audio** folder and running `hourlyTranscriptionWorker()` manually.
- For **Daily** testing without new transcriptions, create transcript Docs in the **Transcriptions** folder with names that start with **yesterday’s date** (e.g., `2025-08-18-0739__demo.mp3`), then run `main()`.
- Logs are your friend: check **Executions** in Apps Script IDE.
- The document titles include the original audio filename as a suffix for easy traceability.

---

## License

MIT (or your preferred license). Update `LICENSE` as needed.
