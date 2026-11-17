# Documento per l'assistente: app "Nanna" (versione 1.1.0)

Questo documento serve a te, assistente AI, per modificare l'app senza doverla ricostruire da zero. Leggilo tutto prima di rispondere. L'utente allegherà i file attuali dell'app (o l'ultimo ZIP): lavora su quelli, non reinventarli.

## 1. Chi è l'utente e come aiutarlo

- Progetto **personale e familiare**: tracker del sonno di un bambino di circa 5 mesi all'avvio del progetto, usato da due genitori. Nessun collegamento con account di lavoro.
- L'utente **non sa programmare**. Servono procedure passo passo, in italiano, con indicazioni precise su dove cliccare (GitHub e Firebase da browser, non da riga di comando).
- **Budget zero**: solo strumenti gratuiti (GitHub Pages, Firebase piano Spark, nessuna libreria a pagamento).
- Entrambi i genitori usano **Android**, quasi sempre da **telefono**. L'app è una PWA installata dalla home. Interfaccia pensata per il pollice, anche al buio.
- Stile: **scuro**, sobrio. Di notte, quando c'è una notte in corso, l'app si attenua ancora (classe `body.night`) per non svegliare il bambino.
- **Privacy**: sono dati di un minore. Accesso solo con email e password per le due email autorizzate. Nell'app compare solo il nome del bambino, mai il cognome o altri dati identificativi. Non proporre di rendere pubblici i dati.
- Preferenze di risposta: dare **file completi** pronti da caricare (mai frammenti da incollare a mano), consegnare uno **ZIP** scaricabile, rispondere in modo diretto e senza giri di parole.

## 2. Regole di aggiornamento (da rispettare sempre)

1. Ad **ogni modifica** aumenta `VERSION` in `app.js` (1.1.0 → 1.1.1 per correzioni, 1.2.0 per nuove funzioni) e aggiungi **in cima** all'array `NOTES` una voce con le novità. Le release note sono visibili nell'app in *Altro → Novità*.
2. **Aggiorna questo documento** (`assistente.md`) se cambiano funzioni, dati, regole o file. Aggiorna anche la sezione "Storico versioni" in fondo e il numero di versione nel titolo.
3. Se cambi qualunque file in cache, incrementa `CACHE` in `sw.js` (es. `nanna-v2` → `nanna-v3`) così i telefoni scaricano la versione nuova. Se aggiungi un file all'app, inseriscilo anche in `SHELL`.
4. **Non toccare mai `config.js`**: contiene le chiavi Firebase dell'utente. Non includerlo nello ZIP degli aggiornamenti, oppure includilo identico e avvisa di non sovrascriverlo.
5. Non toccare `firestore.rules` se non serve. Se serve, spiega esattamente dove incollare le nuove regole in Firebase.
6. Non cambiare la struttura dei dati in modo incompatibile. Se serve, scrivi una migrazione che legga anche il formato vecchio. I dati già inseriti dai genitori non devono andare persi.
7. Prima di consegnare, **verifica** che `app.js` abbia sintassi corretta (`node --check`) e, se possibile, prova l'app in modalità prova (vedi sezione 9).
8. Alla fine di ogni aggiornamento indica all'utente: cosa è cambiato, quali file sostituire su GitHub, se serve fare altro (di solito niente).

## 3. Struttura dei file

| File | Ruolo |
|---|---|
| `index.html` | Pagina unica: contenitori `#app`, `#login`, `#modal`, `#toast`, `#boot`. Carica `app.js` come modulo. |
| `app.js` | Tutta la logica e l'interfaccia (vedi sezione 6). Nessun framework, JavaScript puro. |
| `style.css` | Stile scuro, variabili CSS in `:root`, variante notte in `body.night`. |
| `config.js` | Configurazione Firebase dell'utente. **Non modificare.** Se contiene `INCOLLA_QUI` l'app parte in modalità prova. |
| `manifest.json` | Dati PWA (nome, icone, colori). |
| `sw.js` | Service worker: rete prima, cache come riserva offline. |
| `firestore.rules` | Regole di sicurezza da incollare in Firebase (solo le due email famiglia). |
| `assistente.md` | Questo documento. L'app lo legge e lo mostra in *Altro → Documento per l'assistente*. |
| `icon-*.png` | Icone dell'app (luna su fondo blu notte). |

## 4. Tecnologie e hosting

- Hosting: **GitHub Pages** (repository pubblico con nome neutro; il codice non contiene dati personali).
- Database e login: **Firebase** (Authentication email/password + Cloud Firestore), SDK caricato da `https://www.gstatic.com/firebasejs/10.14.1/` con import dinamici (versione in `FIREBASE_VERSION`). Cache offline di Firestore attiva (`persistentLocalCache`).
- Nessun build, nessun npm: i file vanno caricati così come sono.
- **Modalità prova**: se `config.js` non è compilato, i dati stanno in `localStorage` (chiave `nanna_demo_v1`) e l'app mostra il badge "modalità prova". Il codice usa lo stesso oggetto `api` in entrambe le modalità.

## 5. Modello dati (Firestore)

Tutti i timestamp sono **millisecondi Unix** (`Date.now()`), nel fuso del telefono.

**`sleeps`** (un documento per ogni pisolino o notte)
- `type`: `"nap"` | `"night"`
- `start`: numero. Quando si addormenta.
- `end`: numero oppure `null` se sta ancora dormendo. Può esistere **un solo** sonno con `end == null` alla volta (è quello "attivo").
- `wakes` (solo `night`): array di `{ start, end, fed }`. Risvegli notturni. `end` è `null` mentre è sveglio. `fed` è vero/falso: allattato al seno in quel risveglio.
- `by`: email di chi ha creato la voce.

**`events`** (contatori istantanei)
- `kind`: `"breast"` (allattamento) | `"meal"` (pasto generico) | `"poop"` (cacca)
- `ts`: numero. `by`: email.

**`notes`** (una nota per giorno)
- ID del documento = data `AAAA-MM-GG`. Campi: `text`, `by`, `updated`. Se il testo viene svuotato il documento è eliminato.

**`settings/main`**: `{ childName }`.

## 6. Mappa di `app.js`

- **Utilità**: formattazione date e durate (`fmtT`, `fmtDur`, `fmtClock`), `ymd`, `dayStart`, `addDays`, `mondayOf`.
- **Layer dati**: `makeDemoApi()` (localStorage) e `initFirebase()`; entrambi espongono `api.add / set / update / remove / saveSettings`. Con Firebase ci sono `onSnapshot` su `sleeps`, `events`, `notes`, `settings/main`, quindi i due telefoni restano allineati in tempo reale.
- **Logica sonno**: `activeSleep()`, `sleepIntervals()` (trasforma una notte in tratti di sonno effettivo, togliendo i risvegli), `nightDay()`, `dayStats(d)` (statistiche di un giorno).
- **Suggerimento pisolino**: `history()`, `suggestion()`, `suggestionHTML()`.
- **Azioni** (oggetto `A`): sono richiamate dagli attributi `data-act="..."` nell'HTML tramite un unico listener `click`. Per aggiungere un pulsante: crea il metodo in `A` e usa `data-act` nel template.
- **Render**: `render()` ridisegna intestazione, navigazione e schermata. `setHTML()` evita di sostituire il DOM se l'HTML è identico. `render()` non fa nulla mentre l'utente scrive in un campo di testo.
- **Schermate**: `todayHTML`, `daysHTML`, `weekHTML`, `moreHTML`; componenti: `heroHTML`, `countersHTML`, `recapHTML`, `timelineHTML`, `noteCardHTML`, `barHTML`.
- **Modali**: `openSleepModal`, `openEventModal`, `openChooser`, gestiti da `openModal/closeModal` e dagli attributi `data-m`.
- **Login**: `showLogin()`. **Avvio**: `boot()`.

## 7. Funzioni e regole decise con l'utente

**Notte (pulsante unico a stato)**: l'utente sceglie lui quando inizia e finisce la notte (coincidono con addormentamento e risveglio del mattino). Il pulsante grande cambia: *Inizia notte* → *Si è svegliato* → *Si è riaddormentato* → … → *Fine notte*. A ogni risveglio c'è l'interruttore **Allattato sì/no** (solo allattamento al seno, niente durata né quantità). L'app calcola da sola sonno effettivo, numero risvegli e tempo sveglio. "Fine notte" mentre è sveglio chiude la notte all'inizio di quel risveglio.

**Pisolini**: circa 3 al giorno. Pulsante di inizio e di fine, con timer.

**Contatori (con ora)**: `Allattamento` e `Pasto` (due scelte distinte, per l'inizio dello svezzamento; cosa mangia il bambino viene tracciato altrove), `Cacca`. Solo contatori: nessuna quantità, nessuna nota per voce. Pulsante "−" per togliere l'ultimo; dopo ogni azione compare **ANNULLA** per 7 secondi.

**Correzioni**: ogni voce della cronologia si tocca per modificare (orari, tipo, risvegli, allattato) o eliminare. In *Giorni → Aggiungi a mano* si inserisce quello che ci si è dimenticati di segnare.

**Notte conteggiata nel giorno del risveglio**: `nightDay(s) = data(start + 12h)`. Una notte 20:00–07:00 compare nel recap del giorno dopo.

**Recap giornaliero**: sonno totale (notte + pisolini), barra di 24 ore con le fasce di sonno e i marcatori di allattamento/pasto/cacca, risvegli notturni e tempo sveglio, allattamenti notturni, tratto di sonno più lungo, pisolino più lungo, allattamenti diurni, pasti, cacche, orario di buonanotte e sveglia, cronologia.

**Recap settimanale** (settimana da lunedì): medie giornaliere con confronto con la settimana precedente (oggi escluso se la settimana è in corso), grafico a barre del sonno, grafici di risvegli, allattamenti (giorno + notte) e cacche, tabella, note della settimana. Toccando un giorno si apre.

**Note del giorno**: campo di testo libero per ogni giorno (es. primi denti, vaccino, cambiamenti). Salvataggio automatico dopo 1,2 secondi senza digitare e all'uscita dal campo. Sono visibili in *Oggi*, in *Giorni* e nel riepilogo settimanale.

**Suggerimento pisolino** (indicativo, **mai bloccante**, nessuna notifica push): usa gli ultimi 7 giorni completi con almeno 2 pisolini; servono almeno 3 giorni, altrimenti mostra un avviso discreto. Calcola con la **mediana**:
- se è sveglio e mancano pisolini rispetto al numero tipico: finestra di veglia tipica prima del pisolino n. K (con intervallo interquartile, o minimo–massimo se i dati sono pochi) → "verso le HH:MM";
- se i pisolini tipici sono finiti: tempo tipico dall'ultimo pisolino alla buonanotte e orario tipico di buonanotte;
- durante un pisolino: durata tipica e orario di sveglia probabile;
- di notte: nessun suggerimento.
Si disattiva in *Altro* (preferenza salvata solo sul telefono, chiave `nanna_sugg_off`). In *Oggi* viene mostrato anche "Sveglio da …" con timer.

**Altro**: nome del bambino, interruttore suggerimenti, account/esci, questo documento (copia/leggi), backup JSON di tutti i dati, release note.

## 8. Regole di sicurezza (Firestore)

`firestore.rules` consente lettura e scrittura solo se `request.auth.token.email` è una delle due email della famiglia (in minuscolo). Le regole valgono per tutte le raccolte, quindi nuove raccolte sono già protette. Non usare mai regole aperte (`allow read, write: if true`). Gli utenti sono creati a mano nella console Firebase (nessuna registrazione dall'app).

## 9. Come provare le modifiche

- Senza Firebase: aprire `index.html` da un piccolo server locale (es. `python -m http.server`) e usare la modalità prova. Per riempire dati di prova si può scrivere in `localStorage['nanna_demo_v1']` un oggetto `{ sleeps: {id: {...}}, events: {...}, notes: {...}, settings: {...} }` con la struttura della sezione 5.
- Controllo sintassi: `node --check app.js` (copiando prima il file con estensione `.mjs`).
- Verificare sempre: notte con più risvegli, pisolino aperto, giorno senza dati, settimana senza dati, nota vuota, tema notturno.

## 10. Idee in coda (non ancora fatte)

- Collegamenti rapidi dall'icona dell'app (pressione prolungata: *Inizia pisolino*, *Inizia notte*).
- Pulsante "Condividi recap" (testo del giorno o della settimana, per il pediatra).
- Andamento mensile e grafico dei ritmi nel tempo.
- Indicazione di chi ha registrato ogni voce (campo `by` già salvato).
- Diario dello svezzamento (alimenti introdotti) e, in seguito, peso e altezza.
- Notifiche vere (richiedono più infrastruttura: valutare prima se servono davvero).

## 11. Storico versioni

- **1.1.0**: note del giorno; suggerimento non vincolante sul prossimo pisolino; "Sveglio da…" in Oggi; documento per l'assistente integrato nell'app.
- **1.0.0**: prima versione: pisolini, notte con risvegli e allattamento, contatori allattamento/pasto/cacche, recap giornaliero e settimanale, modifica manuale, login famiglia, modalità prova, backup.
