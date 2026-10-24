// Prompt texts for the writer and the independent reviewer, in each locale
// of the runner: 'en' (provider- and project-neutral) and 'pl' (the original
// texts, byte for byte). The module has no imports: the core passes the
// locale, task mode and writer model already validated, together with the
// analysis contract constants it enforces, so the texts here cannot diverge
// from the checks in the core. Profiles cannot override prompts (deliberately,
// for safety); they only choose the locale.

export const SOL_PHASE_OWNERSHIP_CONTRACT = `KONTRAKT WŁASNOŚCI FAZ:
- Sol implementuje zaakceptowany zakres, reprodukuje wszystkie przekazane findings i może wykonywać dostępne kontrole celowane.
- W pierwszej rundzie Sol zaczyna od całego pierwotnego zadania, sekcji „Pliki startowe”, jeżeli istnieje, oraz bezpośrednio istotnych zależności, testów i kontraktów. „Pliki startowe” są punktem startowym odczytów, nie twardą allowlistą.
- W rundzie korekcyjnej Sol zaczyna od przekazanych findings, ich file i anchorów oraz bezpośrednich testów i kontraktów. Ponowny pełny odczyt całego zakresu nie jest domyślny.
- Szerszy odczyt repo jest dozwolony wyłącznie dla konkretnej regresji, bezpieczeństwa albo kontraktu. Sol zapisuje wtedy w summary krótkie uzasadnienie wraz ze ścieżką lub obszarem odczytu; nie wykonuje ogólnego inventory ani audytu repo.
- Jedna zgoda na ukończenie zadania obejmuje wykonanie, konieczne poprawki i odbiór tego samego zaakceptowanego rezultatu. Zgody już udzielone obowiązują; Sol nie pyta ponownie bez nowej nierozstrzygniętej decyzji.
- „Dozwolony obszar zmian” jest instrukcyjną granicą zapisów, a nie ograniczeniem odczytów. Lista plików nie unieważnia zgody na konieczne korekty testu, fixture, dokumentacji ani bezpośredniej technicznej zależności potrzebnej do tego samego rezultatu. Sol kontynuuje takie korekty bez kolejnego pytania; dodatkowe ścieżki, powód, wpływ i wykonane kontrole zapisuje w raporcie. Cały finalny diff trafia do niezależnego reviewera, gdy review jest wymagane.
- Wyraźne wykluczenia, reguły danych, HR/prawo, niezatwierdzona nowa funkcjonalność, decyzje bezpieczeństwa/kosztowe/produkcyjne, zależności produkcyjne i publikacja pozostają granicami fail-closed. Zgoda na ukończenie nie nadaje automatycznie prawa do push/merge, kosztów Actions ani osłabienia zabezpieczeń. Zapis poza zaakceptowanym rezultatem lub wyraźnymi granicami zatrzymuje edycje i wymaga statusu NEEDS_HUMAN_DECISION z dokładną ścieżką, powodem, wpływem i proponowanym rozszerzeniem zakresu.
- Sol uruchamia testy celowane właściwe dla zmiany. Nie powtarza domyślnie pełnych gates runnera, w tym pnpm check, pnpm docs:check ani git diff --check. Pełna gate jest dozwolona tylko jako konieczny reproducer bez sensownej kontroli celowanej; Sol zapisuje powód w raporcie.
- Po SOL PASS nadrzędny runner wykonuje w zaufanym środowisku wszystkie polecenia z sekcji „Wymagane kontrole”.
- Sol nie uruchamia reviewera ani innego agenta. Niezależny reviewer jest uruchamiany wyłącznie przez runner na snapshotcie tylko do odczytu.
- EPERM albo EACCES przy dostępie wewnętrznego sandboxu Sola do lokalnego portu PostgreSQL lub HTTP nie jest samo w sobie NEEDS_HUMAN, jeżeli dana kontrola należy do gates runnera. Sol zapisuje ograniczenie w raporcie i po poprawnej implementacji kończy swoją fazę; runner nadal wykona gate niezależnie.
- Sol nie może deklarować niedostępnej albo niewykonanej kontroli jako PASS. Rzeczywiste niepowodzenie gate runnera nadal zatrzymuje workflow fail-closed.
- Rzeczywisty problem implementacji, niejednoznaczne wymaganie albo decyzja bezpieczeństwa, biznesowa, kadrowa lub prawna nadal mogą wymagać NEEDS_HUMAN. Nie klasyfikuj innych błędów jako środowiskowych wyłącznie na podstawie luźnego podobieństwa tekstu.`;
export const ANALYSIS_SOL_PHASE_OWNERSHIP_CONTRACT = `KONTRAKT WŁASNOŚCI FAZ — ANALYSIS:
- Sol wykonuje pełną analizę zaakceptowanego zakresu read-only, reprodukuje wszystkie przekazane findings analityczne i nie zapisuje working tree.
- W pierwszej rundzie Sol zaczyna od całego pierwotnego zadania, dokładnej sekcji „Pliki review” i bezpośrednio istotnych kontraktów. Nie wykonuje ogólnego inventory ani audytu repo.
- W rundzie korekcyjnej Sol zaczyna od findings, ich logicznego file, anchorów sekcji i bieżącego artefaktu, po czym zwraca ponownie całą poprawioną analizę.
- Szerszy odczyt jest dozwolony wyłącznie dla konkretnej regresji, bezpieczeństwa albo kontraktu i wymaga krótkiego uzasadnienia ścieżki lub obszaru w summary.
- Runner, nie Sol, zapisuje osobny artefakt w prywatnym katalogu run ID. Każda wykryta próba zapisu Sola do produktu zatrzymuje workflow fail-closed.
- Sol może wykonywać wyłącznie niedestrukcyjne kontrole odczytowe potrzebne do analizy. Nie uruchamia pełnych gates aplikacji; runner egzekwuje wewnętrzne kontrole integralności zamiast command gates.
- Sol nie uruchamia reviewera ani innego agenta. Niezależny reviewer jest uruchamiany wyłącznie przez runner na minimalnym snapshotcie tylko do odczytu.
- Sol nie może deklarować niedostępnej albo niewykonanej kontroli jako PASS.
- Rzeczywista niejednoznaczność wymagania albo decyzja bezpieczeństwa, biznesowa, kadrowa lub prawna nadal może wymagać NEEDS_HUMAN. Nie klasyfikuj innych błędów jako środowiskowych na podstawie luźnego podobieństwa tekstu.`;

// The phase ownership contracts in the 'en' locale; same rules as the Polish
// ones above.
const WRITER_PHASE_OWNERSHIP_CONTRACT_EN = `PHASE OWNERSHIP CONTRACT:
- The writer implements the accepted scope, reproduces every finding passed to it and may run the targeted checks available to it.
- In the first round the writer starts from the whole original task, the "Starting files" section if present, and the directly relevant dependencies, tests and contracts. "Starting files" are a starting point for reads, not a hard allowlist.
- In a correction round the writer starts from the findings passed to it, their file and anchors, and the direct tests and contracts. A new full read of the whole scope is not the default.
- A wider read of the repository is allowed only for a specific regression, security issue or contract. The writer then records in the summary a short justification with the path or area read; it does not run a general inventory or audit of the repository.
- One approval to complete the task covers the implementation, the necessary fixes and the acceptance of the same accepted result. Approvals already given stay valid; the writer does not ask again without a new unresolved decision.
- "Allowed change area" is an instructional boundary for writes, not a limit on reads. The file list does not void the approval for necessary corrections to a test, a fixture, documentation or a direct technical dependency needed for the same result. The writer continues such corrections without asking again; it records the additional paths, the reason, the impact and the checks run in the report. The whole final diff goes to the independent reviewer when review is required.
- Explicit exclusions, data rules, legal and regulatory constraints, unapproved new functionality, security, cost and production decisions, production dependencies and publication remain fail-closed boundaries. Approval to complete does not automatically grant the right to push or merge, to incur CI costs or to weaken safeguards. A write outside the accepted result or the explicit boundaries stops editing and requires the status NEEDS_HUMAN_DECISION with the exact path, the reason, the impact and the proposed scope extension.
- The writer runs the targeted tests appropriate to the change. By default it does not repeat the full gates of the runner, including the commands of the "Required checks" section. A full gate is allowed only as a necessary reproducer when no meaningful targeted check exists; the writer records the reason in the report.
- After the writer's round passes, the parent runner runs every command of the "Required checks" section in a trusted environment.
- The writer does not start the reviewer or any other agent. The independent reviewer is started only by the runner, on a read-only snapshot.
- EPERM or EACCES when the writer's internal sandbox accesses a local database or HTTP port is not by itself NEEDS_HUMAN when that check belongs to the gates of the runner. The writer records the limitation in the report and, after a correct implementation, ends its phase; the runner still runs the gate independently.
- The writer must not report an unavailable or unexecuted check as PASS. A real failure of a runner gate still stops the workflow fail-closed.
- A real implementation problem, an ambiguous requirement, or a security, business or legal decision may still require NEEDS_HUMAN. Do not classify other errors as environmental based only on a loose textual similarity.`;
const ANALYSIS_WRITER_PHASE_OWNERSHIP_CONTRACT_EN = `PHASE OWNERSHIP CONTRACT — ANALYSIS:
- The writer performs a full read-only analysis of the accepted scope, reproduces every analysis finding passed to it and does not write to the working tree.
- In the first round the writer starts from the whole original task, the exact "Review files" section and the directly relevant contracts. It does not run a general inventory or audit of the repository.
- In a correction round the writer starts from the findings, their logical file, the section anchors and the current artifact, and then returns the whole corrected analysis again.
- A wider read is allowed only for a specific regression, security issue or contract and requires a short justification of the path or area in the summary.
- The runner, not the writer, saves a separate artifact in the private directory of the run ID. Any detected attempt by the writer to write to the product stops the workflow fail-closed.
- The writer may run only the non-destructive read checks needed for the analysis. It does not run the full application gates; the runner enforces internal integrity checks instead of command gates.
- The writer does not start the reviewer or any other agent. The independent reviewer is started only by the runner, on a minimal read-only snapshot.
- The writer must not report an unavailable or unexecuted check as PASS.
- A real ambiguity of a requirement, or a security, business or legal decision may still require NEEDS_HUMAN. Do not classify other errors as environmental based on a loose textual similarity.`;

// The locale, taskMode and codexModel (the implementer's model) must already
// be resolved by the core.
export function buildCodexPrompt({ locale, ...options }) {
  return promptBuilder(locale, buildCodexPromptEn, buildCodexPromptPl)(options);
}

// The locale and taskMode must already be resolved by the core.
export function buildClaudePrompt({ locale, ...options }) {
  return promptBuilder(locale, buildClaudePromptEn, buildClaudePromptPl)(options);
}

function promptBuilder(locale, en, pl) {
  if (locale === 'en') return en;
  if (locale === 'pl') return pl;
  throw new TypeError(`Unknown prompt locale ${String(locale)}.`);
}

function buildCodexPromptEn({
  task,
  round,
  findings,
  taskMode,
  codexModel,
  maxAnalysisArtifactBytes,
  analysisCompletenessSentinel,
}) {
  const roundFocus =
    round === 1
      ? taskMode === 'analysis'
        ? 'FIRST ROUND — TASK-FIRST: first read the whole ORIGINAL TASK. Then read the exact "Review files" and only the directly relevant contracts needed for the full analysis. Do not run an unjustified general inventory or audit of the repository. The findingResponses field must be an empty array, because you have not received any findings yet.'
        : 'FIRST ROUND — TASK-FIRST: first read the whole ORIGINAL TASK. Start exploring from the "Starting files" section, if present, and the directly relevant dependencies, tests and contracts. If the section is absent, start from the files named in the scope and the criteria. Do not run an unjustified general inventory or audit of the repository. The findingResponses field must be an empty array, because you have not received any findings yet.'
      : `CORRECTION ROUND — FINDINGS-FIRST: start from the unresolved reviewer findings below, their file, anchors, the places they point to and the direct tests and contracts. Do not reread the whole scope or the repository without a specific need related to a regression, security or a contract. The original task still sets the boundaries. Analyze every finding regardless of severity and return exactly one findingResponses entry for each findingId. Each response must contain exactly all the fields: findingId, status, analysis, evidence, fix, regressionTest, checks and question. Each checks entry must be a short, trimmed, single line of textual attestation; do not put output field names, JSON fragments, truncation markers or the content of the full artifact there. CONFIRMED requires a reproduction described in non-empty analysis and evidence, a minimal fix described in fix, a non-empty regressionTest (a test or a technical justification for its absence) and a non-empty checks list; question must be an empty string. REJECTED requires non-empty analysis and evidence with a reproduction attempt, proof or a specific justification; fix, regressionTest and question must be empty strings, and checks may be an empty array; do not change code only to satisfy the reviewer. NEEDS_HUMAN requires a non-empty question and stops the workflow; analysis, evidence, fix and regressionTest must be empty strings, and checks an empty array. Do not respond to other identifiers.${taskMode === 'analysis' ? ' Return the whole corrected analysis again, not a patch or only the changed section.' : ''}\n${JSON.stringify(findings, null, 2)}`;
  const modeContract =
    taskMode === 'analysis'
      ? `TASK MODE: analysis (explicit read-only mode). Do not write, create, delete or modify any file of the working tree. Any such change stops the run. Read only the task, the "Review files" section and the directly necessary context consistent with the task; do not run an unbounded inventory. The changes field must be an empty array.

The structured result must contain the fullAnalysis field with the full, self-contained Markdown analysis. Limit: 512 KiB (${maxAnalysisArtifactBytes} bytes of UTF-8). Use semantic, unique Markdown headings so that findings can point to a stable section. Do not use truncation markers. The exact sentinel ${analysisCompletenessSentinel} must appear once, as the last characters of fullAnalysis, without a trailing newline. Do not add the sentinel to the summary. The runner saves the validated content as a separate artifact; do not create the artifact in the working tree.`
      : 'TASK MODE: implementation. Keep the existing contract for the implementation, the targeted tests and the report.';
  const workspaceContract =
    taskMode === 'analysis'
      ? "You may read only the files needed under the focused-context contract and run local, non-destructive read checks. Do not edit the working tree. Preserve the user's existing changes. Do not start the reviewer."
      : "You may read the files needed under the focused-context contract, edit the files covered by the task and make the necessary local corrections of the same accepted result under the phase ownership contract, and run local, non-destructive checks. Preserve the user's existing changes. Do not start the reviewer.";
  const executionContract =
    taskMode === 'analysis'
      ? 'Do not run the full application gates of the "Required checks" section. Run only the targeted read checks needed for the analysis. The runner runs the internal integrity checks, saves the artifact and starts the independent review. A missing network alone is not a reason for the BLOCKED status when local tools and data are sufficient. A real need for the network or a missing required local dependency still requires the safe BLOCKED status.'
      : 'Run the targeted tests appropriate to the change. By default, do not run the full gates of the "Required checks" section and do not repeat them after further edits; the runner runs each of them exactly once after your round. Run a full gate only as a necessary reproducer when no meaningful targeted check exists, and record the reason in the report. The pinned pnpm is available offline through an isolated cache. A missing network alone is not a reason for the BLOCKED status when local tools, dependencies and the cache are sufficient. A real need for the network or a missing required local dependency still requires the safe BLOCKED status. Do not skip targeted tests.';
  return `Write the final report in a terse, compressed style. The compression applies only to the final report; the quality of the implementation, tests and documentation stays full.

The writer uses model ${codexModel}. Some identifiers passed by the runner (such as the analysis sentinel) keep historical names; they are compatibility identifiers only. Use them exactly as given.

You work in the real working tree of the repository. ${roundFocus}
${taskMode === 'analysis' ? 'The original scope below remains the only scope and must not be extended.' : 'The original accepted result and the explicit exclusions remain the boundaries of the task. Necessary local corrections of the same result are covered by the approval to complete, also when they need an additional path; they do not mean approval of new functionality or of a new unresolved decision.'}

${modeContract}

FORBIDDEN: git add, staging, commit, push, pull, fetch, PR, merge, rebase, force push, switch/checkout, reset, restore, clean, deleting branches, remote and destructive operations. Do not ask to bypass the sandbox. Do not make business or legal decisions or new security decisions. When such a decision or a new permission is needed, stop and return the appropriate structured status.

${workspaceContract}

${taskMode === 'analysis' ? ANALYSIS_WRITER_PHASE_OWNERSHIP_CONTRACT_EN : WRITER_PHASE_OWNERSHIP_CONTRACT_EN}

${executionContract}

${task.quality?.docs ? `TASK CLASS: ${task.taskClass}. The writer checks the description against its sources; docs-minor does not change semantics. For this class the following rule refines the general phase contract: the writer verifies the documentation sources; corrections require only the docs gates and the explicit additional gates: ${task.checks.join(', ')}. Do not add application tests or a full gate unless the task explicitly requires them. Independent review: ${task.quality.independentReviewRequired ? 'required, also findings-first after a contract correction' : 'NOT_REQUIRED under the approved policy'}.` : ''}

FORBIDDEN during the round: installing, updating, adding or removing dependencies; pnpm install/add/remove/update and their aliases; changing the lockfile, packageManager or a workspace configuration that requires a reinstall; using npm, npx, yarn, yarnpkg, bun or bunx, also to run scripts; bypassing any wrapper through Corepack or a direct or absolute path to package manager binaries. If the accepted task requires a change to dependency inputs, ${taskMode === 'analysis' ? 'write nothing and return BLOCKED' : 'keep the needed changes in the working tree, install nothing and return BLOCKED'} stating that a human must make the decision and do the installation.

ORIGINAL TASK (${task.path}):
---
${task.markdown}
---

JSON report: status, changes made, checks run, deferred items, a short summary, findingResponses${taskMode === 'analysis' ? ' and the full fullAnalysis' : ''}.`;
}

function buildClaudePromptEn({
  task,
  taskMode,
  instructionsPath,
  diffPath,
  gatesPath,
  correctionContextPath,
  originalTaskPath,
  manifestPath,
  analysisArtifactPath,
  integrityPath,
  expectedConfirmation,
  analysisFindingFile,
}) {
  const correctionContext = correctionContextPath
    ? `This is a follow-up review. The previous findings with verified findingId values, stable technical fields and the writer's formal responses are in ${correctionContextPath}. Reuse an earlier findingId only when the file, anchor and category fields match. Leave a new problem without findingId; the runner assigns it from those fields.`
    : "This is the first, independent review. You do not receive the writer's reasoning, self-assessments or justifications.";
  if (taskMode === 'analysis') {
    return `Perform an independent, substantive and strictly read-only review of the writer's full analysis. This is not a code review or a review of an empty diff.

Do not edit. Do not create an implementation plan. Do not ask for approval of edits. Do not start the writer or any subagents. The snapshot is a minimal, physically read-only package; do not try to read anything outside it and do not run an inventory.

Read in this exact order:
1. the original task: ${originalTaskPath};
2. the package manifest with SHA-256 hashes: ${manifestPath};
3. the full analysis artifact: ${analysisArtifactPath};
4. the trusted repository instructions: ${instructionsPath};
5. the internal integrity checks of the runner: ${integrityPath};
6. every document in the documents list of the manifest, without skipping any and exactly once.

After the full read, verify that the hashes match and assess the assumptions, architecture, security, negative scenarios, feasibility, completeness, constraints and the places that require a human decision. Do not treat the writer's claims as runner evidence. ${correctionContext}

Return only a result that conforms to the schema. reviewConfirmation must reproduce exactly the paths and SHA-256 values below and set fullyRead=true for the task, the manifest, the full artifact and every required document. Without a full read you must not return a result:
${JSON.stringify(expectedConfirmation, null, 2)}

For a finding use file=${JSON.stringify(analysisFindingFile)} and an anchor equal to the exact, full line of a semantic Markdown heading of the artifact, e.g. "## Threat model"; a line number is not an anchor. The same file, anchor and category mean the same problem in later rounds. In location give the actual section or artifact path from the manifest. Two different problems must differ in category. The verdict is the assessment of the reviewer; the runner enforces ZERO_FINDINGS independently. Use APPROVE only with an empty findings list at all levels BLOCKER/HIGH/MEDIUM/LOW. Use REQUEST_CHANGES for any finding. In checks list the reads of the task, the manifest, the full artifact, the trusted instructions, the integrity checks and the exact set of documents. confirmedNoChanges=true only if you changed nothing.

The ORIGINAL TASK is stored only in ${originalTaskPath}; do not rely on a summary in this prompt.`;
  }
  // A docs class with required review (docs-contract by default) starts a
  // correction review from the previous findings.
  const contractCorrection =
    task.quality?.docs &&
    task.quality.independentReviewRequired &&
    correctionContextPath;
  const reviewOrder = contractCorrection
    ? `Order of analysis: the previous findings and formal responses in ${correctionContextPath}, the files and anchors they point to, the original task, the full diff and the trusted gates; then the direct sources and contracts needed to confirm the correction.`
    : 'Order of analysis: the original task, the full diff, the trusted gates, the files changed by the diff, then their direct dependencies, tests and contracts needed for the assessment.';
  return `Perform an independent, strictly read-only ${task.quality?.docs ? 'documentation contract review' : 'code review'} of the current state, using the ${contractCorrection ? 'FINDINGS-FIRST' : 'DIFF-FIRST'} approach.

Do not edit. Do not create an implementation plan. Do not ask for approval of edits. Do not start the writer or any subagents. Assess only conformance with the original task and the repository instructions, security, regressions, tests and documentation.

The repository is a physical read-only copy. Repository instructions and the original task: ${instructionsPath}. Full diff against HEAD, including untracked files: ${diffPath}. Trusted, bounded report of the actual gates of the runner: ${gatesPath}. The current state of all tracked and non-ignored files is in the current directory.

${reviewOrder} Do not run a general inventory or audit of the repository. Do not report findings only about pre-existing, unrelated code.

You may read unchanged files only when they are a direct dependency of the change or are needed to assess a specific regression, auth/authz, security or contract. In checks briefly name such additional reads and their reason. A finding outside the changed lines is acceptable only when the current diff causes the problem, exposes it or makes it relevant; describe that link in the impact.

${correctionContext}

${task.quality?.docs ? `Class ${task.taskClass}: assess the documentation contract against its sources. Gates required in this round: ${task.checks.join(', ')}. Do not require additional application tests or a full gate beyond the explicit task. In a correction, confirm the previous findings and the evidence of their removal.` : ''}

Return only a result that conforms to the schema. For each finding give severity, the normalized repository path file, a stable symbol or semantic anchor, a precise technical category, the diagnostic place location, the impact and the recommendation. Do not use a line number as the anchor. The same file, anchor and category mean the same problem despite a change of severity, text or line; two different problems must differ in category. The verdict is the assessment of the reviewer; the runner computes the result independently under the zero findings policy. Use APPROVE only with an empty findings list at all levels BLOCKER/HIGH/MEDIUM/LOW. Use REQUEST_CHANGES for any finding regardless of severity. In checks give the reads and checks you performed, without presenting the writer's claims as runner results. confirmedNoChanges=true only if you changed nothing.

ORIGINAL TASK:
---
${task.markdown}
---`;
}

// The original Polish texts ('pl'), byte for byte as before the 'en' locale.
function buildCodexPromptPl({
  task,
  round,
  findings,
  taskMode,
  codexModel,
  maxAnalysisArtifactBytes,
  analysisCompletenessSentinel,
}) {
  const roundFocus =
    round === 1
      ? taskMode === 'analysis'
        ? 'PIERWSZA RUNDA — TASK-FIRST: najpierw przeczytaj całe ORYGINALNE ZADANIE. Następnie przeczytaj dokładne „Pliki review” oraz wyłącznie bezpośrednio istotne kontrakty potrzebne do pełnej analizy. Nie wykonuj bezpodstawnego ogólnego inventory ani audytu repo. Pole findingResponses musi być pustą tablicą, ponieważ nie otrzymałeś jeszcze findings.'
        : 'PIERWSZA RUNDA — TASK-FIRST: najpierw przeczytaj całe ORYGINALNE ZADANIE. Zacznij eksplorację od sekcji „Pliki startowe”, jeżeli istnieje, oraz bezpośrednio istotnych zależności, testów i kontraktów. Jeżeli sekcji nie ma, zacznij od plików wskazanych w zakresie i kryteriach. Nie wykonuj bezpodstawnego ogólnego inventory ani audytu repo. Pole findingResponses musi być pustą tablicą, ponieważ nie otrzymałeś jeszcze findings.'
      : `RUNDA KOREKCYJNA — FINDINGS-FIRST: zacznij od poniższych nierozstrzygniętych findings reviewera, ich file, anchorów, wskazanych miejsc oraz bezpośrednich testów i kontraktów. Nie czytaj ponownie całego zakresu ani repo bez konkretnej potrzeby regresji, bezpieczeństwa lub kontraktu. Pierwotne zadanie nadal wyznacza granice. Przeanalizuj każdy finding niezależnie od severity i zwróć dokładnie jedną odpowiedź findingResponses dla każdego findingId. Każda odpowiedź musi zawierać dokładnie wszystkie pola: findingId, status, analysis, evidence, fix, regressionTest, checks i question. Każdy wpis checks musi być krótką, przyciętą, pojedynczą linią tekstowej atestacji; nie umieszczaj tam nazw pól wyniku, fragmentów JSON, markerów ucięcia ani treści pełnego artefaktu. CONFIRMED wymaga reprodukcji opisanej w niepustych analysis i evidence, minimalnej poprawki opisanej w fix, niepustego regressionTest (test albo techniczne uzasadnienie jego braku) i niepustej listy checks; question musi być pustym stringiem. REJECTED wymaga niepustych analysis oraz evidence z próbą reprodukcji, dowodem albo konkretnym uzasadnieniem; fix, regressionTest i question muszą być pustymi stringami, a checks może być pustą tablicą; nie zmieniaj kodu wyłącznie dla zadowolenia reviewera. NEEDS_HUMAN wymaga niepustego question i zatrzymuje workflow; analysis, evidence, fix i regressionTest muszą być pustymi stringami, a checks pustą tablicą. Nie odpowiadaj na inne identyfikatory.${taskMode === 'analysis' ? ' Zwróć ponownie całą poprawioną analizę, nie patch ani samą zmienioną sekcję.' : ''}\n${JSON.stringify(findings, null, 2)}`;
  const modeContract =
    taskMode === 'analysis'
      ? `TRYB ZADANIA: analysis (jawny tryb read-only). Nie zapisuj, nie twórz, nie usuwaj ani nie zmieniaj żadnego pliku working tree. Każda taka zmiana zatrzyma run. Czytaj wyłącznie zadanie, sekcję „Pliki review” oraz bezpośrednio konieczny kontekst zgodny z zadaniem; nie wykonuj nieograniczonego inventory. Pole changes musi być pustą tablicą.

Wynik strukturalny musi zawierać pole fullAnalysis z pełną, samodzielną analizą Markdown. Limit: 512 KiB (${maxAnalysisArtifactBytes} bajtów UTF-8). Użyj semantycznych, unikalnych nagłówków Markdown, aby findings mogły wskazać stabilną sekcję. Nie używaj markerów ucięcia. Dokładny sentinel ${analysisCompletenessSentinel} musi wystąpić jeden raz, jako ostatnie znaki fullAnalysis, bez końcowego znaku nowej linii. Nie dopisuj sentinela do summary. Runner zapisze zwalidowaną treść jako osobny artefakt; Ty nie twórz artefaktu w working tree.`
      : 'TRYB ZADANIA: implementation. Zachowaj dotychczasowy kontrakt implementacji, testów celowanych i raportu.';
  const workspaceContract =
    taskMode === 'analysis'
      ? 'Możesz czytać wyłącznie pliki potrzebne według kontraktu skupionego kontekstu i uruchamiać lokalne, niedestrukcyjne kontrole odczytowe. Nie edytuj working tree. Zachowaj istniejące zmiany użytkownika. Nie uruchamiaj reviewera.'
      : 'Możesz czytać pliki potrzebne według kontraktu skupionego kontekstu, edytować pliki objęte zadaniem oraz konieczne lokalne korekty tego samego zaakceptowanego rezultatu zgodnie z kontraktem własności faz i uruchamiać lokalne, niedestrukcyjne kontrole. Zachowaj istniejące zmiany użytkownika. Nie uruchamiaj reviewera.';
  const executionContract =
    taskMode === 'analysis'
      ? 'Nie uruchamiaj pełnych gates aplikacji z sekcji „Wymagane kontrole”. Wykonuj tylko celowane kontrole odczytowe potrzebne do analizy. Runner wykona wewnętrzne kontrole integralności, zapis artefaktu i niezależne review. Sam brak sieci nie jest powodem statusu BLOCKED, jeżeli wystarczają lokalne narzędzia i dane. Rzeczywista potrzeba sieci albo brak wymaganej lokalnej zależności nadal wymaga bezpiecznego statusu BLOCKED.'
      : 'Uruchom testy celowane właściwe dla zmiany. Nie uruchamiaj domyślnie pełnych gates z sekcji „Wymagane kontrole” ani nie powtarzaj ich po kolejnych edycjach; runner wykona każdą z nich dokładnie raz po Twojej rundzie. Pełną gate uruchom tylko jako konieczny reproducer, gdy nie istnieje sensowna kontrola celowana, i zapisz powód w raporcie. Przypięty pnpm jest dostępny offline przez izolowany cache. Sam brak sieci nie jest powodem statusu BLOCKED, jeżeli lokalne narzędzia, zależności i cache wystarczają. Rzeczywista potrzeba sieci albo brak wymaganej lokalnej zależności nadal wymaga bezpiecznego statusu BLOCKED. Nie pomijaj testów celowanych.';
  return `/caveman ultra

Kompresja dotyczy wyłącznie raportu końcowego. Jakość implementacji, testów i dokumentacji pozostaje pełna.

Bieżący wykonawca używa modelu ${codexModel}. Nazwy Sol/SOL/sol i powiązane identyfikatory są historycznymi nazwami kompatybilności tego wykonawcy.

Pracujesz w rzeczywistym working tree repozytorium. ${roundFocus}
${taskMode === 'analysis' ? 'Pierwotny zakres poniżej pozostaje jedynym zakresem i nie może być rozszerzony.' : 'Pierwotny zaakceptowany rezultat i wyraźne wykluczenia pozostają granicami zadania. Konieczne lokalne korekty tego samego rezultatu są objęte zgodą na ukończenie, także gdy wymagają dodatkowej ścieżki; nie oznaczają zgody na nową funkcjonalność ani nową nierozstrzygniętą decyzję.'}

${modeContract}

ZABRONIONE: git add, staging, commit, push, pull, fetch, PR, merge, rebase, force push, switch/checkout, reset, restore, clean, usuwanie gałęzi, operacje zdalne i destrukcyjne. Nie proś o obejście sandboxa. Nie podejmuj decyzji biznesowych, kadrowych, prawnych ani nowych decyzji bezpieczeństwa. Gdy potrzebna jest taka decyzja albo nowe uprawnienie, przerwij i zwróć właściwy status strukturalny.

${workspaceContract}

${taskMode === 'analysis' ? ANALYSIS_SOL_PHASE_OWNERSHIP_CONTRACT : SOL_PHASE_OWNERSHIP_CONTRACT}

${executionContract}

${task.quality?.docs ? `KLASA ZADANIA: ${task.taskClass}. Executor sprawdza opis ze źródłami; docs-minor nie zmienia semantyki. Dla tej klasy poniższa reguła uszczegóławia ogólny kontrakt faz: executor weryfikuje źródła dokumentacji; korekty wymagają wyłącznie gates docs i jawnych dodatkowych gates: ${task.checks.join(', ')}. Nie dodawaj testów aplikacji ani pełnej gate bez jawnego wymagania zadania. Niezależne review: ${task.quality.independentReviewRequired ? 'wymagane, także findings-first po korekcie kontraktu' : 'NOT_REQUIRED według zatwierdzonej polityki'}.` : ''}

ZABRONIONE podczas rundy: instalowanie, aktualizowanie, dodawanie albo usuwanie zależności; pnpm install/add/remove/update i ich aliasy; zmiana lockfile, packageManager lub konfiguracji workspace wymagającej ponownej instalacji; używanie npm, npx, yarn, yarnpkg, bun lub bunx, w tym do uruchamiania skryptów; obchodzenie któregokolwiek wrappera przez Corepack albo bezpośrednią/absolutną ścieżkę do binariów package managerów. Jeżeli zaakceptowane zadanie wymaga zmiany wejść zależności, ${taskMode === 'analysis' ? 'nie zapisuj niczego i zwróć BLOCKED' : 'zachowaj potrzebne zmiany w working tree, nie instaluj niczego i zwróć BLOCKED'} z informacją, że decyzję oraz instalację musi wykonać człowiek.

ORYGINALNE ZADANIE (${task.path}):
---
${task.markdown}
---

Raport JSON: status, wykonane zmiany, uruchomione kontrole, elementy odłożone, krótkie podsumowanie, findingResponses${taskMode === 'analysis' ? ' oraz pełne fullAnalysis' : ''}.`;
}

function buildClaudePromptPl({
  task,
  taskMode,
  instructionsPath,
  diffPath,
  gatesPath,
  correctionContextPath,
  originalTaskPath,
  manifestPath,
  analysisArtifactPath,
  integrityPath,
  expectedConfirmation,
  analysisFindingFile,
}) {
  const correctionContext = correctionContextPath
    ? `To jest kolejne review. Poprzednie findings ze zweryfikowanymi findingId, stabilnymi polami technicznymi oraz formalne odpowiedzi wykonawcy znajdują się w ${correctionContextPath}. Użyj wcześniejszego findingId tylko przy zgodnych polach file, anchor i category. Nowy problem pozostaw bez findingId; runner nada go z tych pól.`
    : 'To jest pierwsze, niezależne review. Nie otrzymujesz reasoning, samoocen ani uzasadnień wykonawcy.';
  if (taskMode === 'analysis') {
    return `Wykonaj niezależne, merytoryczne i wyłącznie read-only review pełnej analizy Sola. To nie jest code review ani review pustego diffu.

Nie edytuj. Nie twórz planu implementacji. Nie proś o zatwierdzenie edycji. Nie uruchamiaj wykonawcy ani subagentów. Snapshot jest minimalnym, fizycznie read-only pakietem; nie próbuj czytać niczego poza nim i nie wykonuj inventory.

Czytaj w dokładnej kolejności:
1. oryginalne zadanie: ${originalTaskPath};
2. manifest pakietu z hashami SHA-256: ${manifestPath};
3. pełny artefakt analizy: ${analysisArtifactPath};
4. zaufane instrukcje repozytorium: ${instructionsPath};
5. wewnętrzne kontrole integralności runnera: ${integrityPath};
6. każdy dokument z listy documents manifestu, bez pomijania i dokładnie raz.

Po pełnym odczycie sprawdź zgodność hashy i oceń założenia, architekturę, bezpieczeństwo, scenariusze negatywne, wykonalność, kompletność, ograniczenia oraz miejsca wymagające decyzji człowieka. Nie traktuj deklaracji Sola jako dowodu runnera. ${correctionContext}

Zwróć wyłącznie wynik zgodny ze schematem. reviewConfirmation musi dokładnie odtworzyć poniższe ścieżki i SHA-256 oraz ustawić fullyRead=true dla zadania, manifestu, pełnego artefaktu i każdego wymaganego dokumentu. Brak pełnego odczytu oznacza, że nie wolno zwrócić wyniku:
${JSON.stringify(expectedConfirmation, null, 2)}

Dla findingu użyj file=${JSON.stringify(analysisFindingFile)} oraz anchor równego dokładnej, pełnej linii semantycznego nagłówka Markdown z artefaktu, np. „## Model zagrożeń”; numer linii nie jest anchorem. Te same file, anchor i category oznaczają ten sam problem w kolejnych rundach. W location podaj rzeczywistą sekcję lub ścieżkę artefaktu z manifestu. Dwa różne problemy muszą różnić się category. Verdict jest oceną reviewera; runner niezależnie egzekwuje ZERO_FINDINGS. APPROVE stosuj wyłącznie przy pustej liście findings wszystkich poziomów BLOCKER/HIGH/MEDIUM/LOW. REQUEST_CHANGES stosuj przy każdym findingu. W checks wymień odczyt zadania, manifestu, pełnego artefaktu, zaufanych instrukcji, kontroli integralności i dokładnego zestawu dokumentów. confirmedNoChanges=true tylko jeśli niczego nie zmieniłeś.

ORYGINALNE ZADANIE jest zapisane wyłącznie w ${originalTaskPath}; nie polegaj na skrócie w tym promptcie.`;
  }
  // A docs class with required review (docs-contract by default) starts a
  // correction review from the previous findings.
  const contractCorrection =
    task.quality?.docs &&
    task.quality.independentReviewRequired &&
    correctionContextPath;
  const reviewOrder = contractCorrection
    ? `Kolejność analizy: poprzednie findings i formalne odpowiedzi z ${correctionContextPath}, wskazane pliki i anchory, pierwotne zadanie, pełny diff i zaufane gates; następnie bezpośrednie źródła i kontrakty potrzebne do potwierdzenia korekty.`
    : 'Kolejność analizy: pierwotne zadanie, pełny diff, zaufane gates, pliki zmienione przez diff, następnie ich bezpośrednie zależności, testy i kontrakty potrzebne do oceny.';
  return `Wykonaj niezależny, wyłącznie read-only ${task.quality?.docs ? 'review kontraktu dokumentacji' : 'code review'} aktualnego stanu, stosując podejście ${contractCorrection ? 'FINDINGS-FIRST' : 'DIFF-FIRST'}.

Nie edytuj. Nie twórz planu implementacji. Nie proś o zatwierdzenie edycji. Nie uruchamiaj wykonawcy ani subagentów. Oceń wyłącznie zgodność z pierwotnym zadaniem, instrukcjami repo, bezpieczeństwo, regresje, testy i dokumentację.

Repozytorium jest fizyczną kopią tylko do odczytu. Instrukcje repo i oryginalne zadanie: ${instructionsPath}. Pełny diff względem HEAD, wraz z plikami nieśledzonymi: ${diffPath}. Zaufany, ograniczony raport rzeczywistych gates runnera: ${gatesPath}. Aktualny stan wszystkich śledzonych i nieignorowanych plików znajduje się w bieżącym katalogu.

${reviewOrder} Nie wykonuj ogólnego inventory ani audytu repo. Nie zgłaszaj findings wyłącznie o zastanym, niezwiązanym kodzie.

Możesz czytać niezmienione pliki tylko wtedy, gdy są bezpośrednią zależnością zmiany albo są potrzebne do oceny konkretnej regresji, auth/authz, bezpieczeństwa lub kontraktu. W checks krótko wskaż takie dodatkowe odczyty i ich powód. Finding poza zmienionymi liniami jest dopuszczalny tylko wtedy, gdy bieżący diff powoduje problem, ujawnia go albo czyni go istotnym; opisz ten związek w skutku.

${correctionContext}

${task.quality?.docs ? `Klasa ${task.taskClass}: oceń kontrakt dokumentacji ze źródłami. Gates wymagane w tej rundzie: ${task.checks.join(', ')}. Nie wymagaj dodatkowych testów aplikacji ani pełnej gate poza jawnym zadaniem. W korekcie potwierdź poprzednie findings i dowody ich usunięcia.` : ''}

Zwróć wyłącznie wynik zgodny ze schematem. Dla każdego findingu podaj severity, znormalizowaną ścieżkę repo file, stabilny symbol lub semantyczny anchor, precyzyjną techniczną category, miejsce diagnostyczne location, skutek i rekomendację. Nie używaj numeru linii jako anchoru. Te same file, anchor i category oznaczają ten sam problem mimo zmiany severity, tekstu lub linii; dwa różne problemy muszą różnić się category. Verdict jest oceną reviewera; runner niezależnie obliczy wynik według polityki zero findings. APPROVE stosuj wyłącznie przy pustej liście findings wszystkich poziomów BLOCKER/HIGH/MEDIUM/LOW. REQUEST_CHANGES stosuj przy każdym findingu niezależnie od severity. W checks podaj wykonane odczyty/kontrole, bez przedstawiania deklaracji wykonawcy jako wyniku runnera. confirmedNoChanges=true tylko jeśli niczego nie zmieniłeś.

ORYGINALNE ZADANIE:
---
${task.markdown}
---`;
}
