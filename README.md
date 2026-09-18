<p align="center">
  <img src="caronte.jpg" alt="Caronte, il traghettatore" width="260">
</p>

<h1 align="center">Caronte</h1>

<p align="center"><i>Traghetta gli annunci da una parte all'altra. La decisione resta a chi sta a bordo.</i></p>

---

Caronte è il pannello locale con cui cerco lavoro. Gira sul mio computer, si apre
nel browser su `localhost`, e fa cinque cose in fila: trova gli annunci, li fa
valutare, legge per intero quelli che passano, prepara CV e lettera su misura, e
apre il form già compilato.

**L'ultimo clic è sempre mio.** Caronte non invia niente, mai: apre il modulo in
un browser vero con i campi riempiti e si ferma lì.

## Il percorso

Un annuncio sta in **una fase sola** — quella del lavoro che gli manca — e passa
alla successiva quando quel lavoro è fatto. All'inizio le ultime tre fasi sono
vuote, ed è giusto così: si riempiono man mano.

| | Fase | Cosa fa | Costo |
|---|---|---|---|
| **01** | **Cerca** | Interroga 13 bacheche e 11 pagine carriere, e se vuoi anche il web. Scarica il testo degli annunci. | zero token |
| **02** | **Valuta** | Dà un voto da 1 a 5 e scrive la riga di riepilogo da mettere in cima al CV. | una richiesta per gruppo |
| **03** | **Analizza** | Rilegge un annuncio per intero: cosa chiede alla lettera, quanto ci sei vicino, cosa può dire la lettera di vero. | una richiesta per annuncio |
| **04** | **Documenti** | Genera CV e lettera di presentazione in PDF, su misura per quell'annuncio. | zero token |
| **05** | **Compila** | Apre l'annuncio in un browser vero e riempie i campi per cui esiste una fonte. | zero token |

Ogni annuncio porta il pulsante della sua fase, quindi scegli tu quale far
avanzare e quale lasciare dov'è. Il pulsante grande in alto le fa tutte insieme,
quando non hai voglia di scegliere.

Valutato sotto 3 un annuncio resta in **Valuta** col suo voto: puoi ancora
leggerlo di tua iniziativa, ma non ti si infila da solo fra quelli buoni. Quelli
che ignori, e quelli che hai già inviato, finiscono nell'archivio in fondo alla
loro schermata.

## Come si avvia

**Serve:** Node 22.5 o più recente, Claude Code installato (`claude --version`
deve rispondere), e Chromium di Playwright.

```bash
npm install
npx playwright install chromium

cp candidate-brief.example.md candidate-brief.md    # chi sei, e cosa non puoi dichiarare
cp config/profile.example.yml config/profile.yml    # recapiti, per riempire i form
cp templates/portals.example.yml portals.yml        # dove cercare
cp cv-variants.example.yml cv-variants.yml          # quale CV base per ogni tipo di ruolo
cp cover-base.example.json cover-base.json          # i fatti veri per la lettera

npm run ui                                          # http://localhost:4176
```

Non serve ricordarsi questa lista: se manca un file la pagina te lo dice, con il
comando da incollare.

## Cosa NON fa

- **Non invia candidature.** Compila e si ferma. Il tasto Invia lo premi tu. <!-- hitl: absolute guarantee. Non aggiungere "di solito", "normalmente", "automaticamente", "da solo" o "senza il tuo permesso": qui la regola è assoluta, non una impostazione predefinita. -->
- **Non inventa.** Se un fatto non è nel tuo CV o nel tuo brief, non finisce nel
  CV generato né nella lettera. Riformula, non fabbrica.
- **Non manda in giro i tuoi dati.** CV, brief, tracker, annunci e analisi
  restano nella cartella e sono ignorati da git. Al modello arrivano solo il tuo
  brief e il testo dell'annuncio.
- **Non decide per te.** Il voto è un filtro per non perdere tempo, non un
  verdetto: sotto 4 su 5 il sistema sconsiglia esplicitamente di candidarsi.

## Sotto il cofano

**I modelli.** La valutazione di gruppo gira su Sonnet: è classificazione con la
griglia già scritta, ed è lì che finisce quasi tutto l'input. La lettura a fondo
gira su Opus, perché deve citare alla lettera e deve essere disposta a dire «non
ci arrivi» su un lavoro che vuoi. La ricerca web gira su **Opus 5, effort
medium**: deve distinguere un annuncio singolo da una pagina di risultati, e un
modello più piccolo sbaglia abbastanza da riempire la coda di spazzatura.

**Le richieste sono chiuse a chiave.** Ogni chiamata parte senza strumenti
(`--tools ''`), senza server MCP e senza lasciare trascrizione. Gli annunci
arrivano dal web aperto: sono dati, mai istruzioni, e il prompt lo dice a chiare
lettere. L'unica eccezione è la ricerca web, che può cercare sul web e
nient'altro.

**Niente parte senza conferma.** Ogni fase, prima di muoversi, dice cosa farà, su
quali file, quanto costa e quanto è rischioso. La coda viene salvata prima di
ogni scrittura: «Ripristina» riporta tutto com'era.

**Il pannello è un file solo** (`apply-ui.html`) servito da un piccolo server
Node (`apply-ui.mjs`). Nessun framework, nessuna build, e i caratteri sono
serviti dal pannello stesso: funziona anche senza rete, e nessuno fuori di qui sa
che lo stai aprendo.

## Da dove viene

Caronte è un fork di **[career-ops](https://github.com/santifer/career-ops)** di
[Santiago Fernández de Valderrama](https://santifer.io), rilasciato con licenza
MIT. Il motore è suo: la valutazione a blocchi A–H, la scansione dei portali, la
generazione dei PDF, il tracker con follow-up e statistiche. Suo è anche il
manifesto [CareerOps](https://career-ops.org/manifesto), di cui career-ops è la
prima implementazione.

Quello che c'è in più qui è il pannello, il percorso a stati e la potatura: da
questa copia sono state tolte le altre CLI, i mercati linguistici che non uso e
il vecchio valutatore via API Gemini, perché un file che nessuno apre è un file
che ogni lettore deve scartare. Restano Claude Code e il mercato italiano.

L'aggiornamento automatico da monte è disattivato (marcatore `.caronte-fork`):
upstream si integra a mano con `git merge`, e la suite decide se l'innesto entra.

La documentazione del motore sta in [`docs/`](docs/) e in
[`AGENTS.md`](AGENTS.md).

## Licenza

MIT, come il progetto da cui viene. Vedi [LICENSE](LICENSE) e
[TRADEMARK.md](TRADEMARK.md).
