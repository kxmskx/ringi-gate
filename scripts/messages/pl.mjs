// Polish messages of the runner (locale: 'pl'). Same keys and {params} as
// en.mjs; the texts are those of the runner before the catalog.
export default Object.freeze({
  'profile.invalid': 'Niepoprawny profil runnera.',
  'provider.roleRules': 'Dostawca nie spełnia reguł ról: {detail}',
  'provider.invalidModule': 'Niepoprawny moduł dostawcy w profilu runnera: {detail}',
  'provider.contractViolation': 'Dostawca {id} ({role}) naruszył kontrakt rdzenia: {reason}.',
  'provider.taskMode': 'Dostawca {id} nie obsługuje trybu {taskMode} w roli {role}.',
  'provider.argvNotStrings': 'argv nie jest listą stringów',
  'provider.forbiddenArgument': 'argument {index} wyłącza zgody, sandbox albo blokadę sieci',
  'provider.environmentChanged': 'środowisko procesu różni się od środowiska rdzenia',

  'log.omitted': '…[log pominięty: przekroczono limit diagnostyczny]…',
  'log.truncated': '…[log obcięty]…',
  'log.noOutput': '[brak wyjścia procesu]',
  'log.saveFailed': 'Nie można zapisać ograniczonego logu diagnostycznego: {detail}',
  'log.solRound': 'SOL runda {round}',
  'log.claudeRound': 'CLAUDE runda {round}',
  'summary.truncated': '…[podsumowanie obcięte]…',

  'process.interrupted': 'Przerwano etap {stage} przez Ctrl+C.',
  'process.defaultStage': 'proces',
  'process.concurrent': 'Próba równoległego uruchomienia procesu została zablokowana.',
  'process.invalidArgs': 'Argumenty procesu muszą być tablicą stringów.',
  'process.exitCode': 'kod zakończenia {code}',
  'process.inputNotRead': 'program zakończył się kodem 0, nie odczytawszy całego wejścia ({error}).',
  'process.stdoutLimit': '{label}: dokładny stdout przekroczył limit {limit} bajtów.',
  'process.timeout': '{label}: przekroczono timeout.',
  'program.notFound': 'Nie znaleziono programu {name} w PATH.',

  'config.unknownReviewProfile': 'Nieznany profil review {profile}.',
  'config.invalidCodexModel':
    'Model Codex musi być pojedynczym identyfikatorem (1–128 znaków ASCII: litery, cyfry, kropka, podkreślenie, myślnik; początek alfanumeryczny).',
  'config.unknownSolEffort': 'Nieznany effort Sola {effort}.',
  'config.invalidTaskMode': 'Tryb zadania musi mieć wartość implementation albo analysis.',
  'config.maxRounds': 'Limit rund musi być liczbą całkowitą od 1 do {max}.',
  'config.modelUnsupported': 'Model {model} nie jest obsługiwany przez dostawcę {provider}.',

  'run.interrupted': 'Workflow przerwany przez Ctrl+C.',
  'run.maxRounds':
    'Wyczerpano limit {maxRounds} rund przy niepustej liście findings. Decyzję przejmuje człowiek.',
  'run.resume':
    'Usuń przyczynę, sprawdź working tree i uruchom zadanie ponownie. Workflow nie cofa zmian Codexa.',
  'cleanup.failed': 'Cleanup nie powiódł się: {detail}',
  'cleanup.unknownResource': 'Odmowa cleanupu nieznanego zasobu.',

  'git.repositoryUnknown': 'Nie można ustalić repozytorium Git',
  'git.wrongRepository': 'Polecenie działa w innym repozytorium: {path}.',
  'git.branchUnreadable': 'Nie można odczytać bieżącej gałęzi',
  'git.detachedHead': 'Detached HEAD jest niedozwolony.',
  'git.headUnreadable': 'Nie można odczytać HEAD',
  'git.stagedUnreadable': 'Nie można sprawdzić staged changes',
  'git.stagedChanges': 'Wykryto staged changes. Workflow zatrzymany.',
  'git.identityChanged': 'Git zmienił gałąź lub HEAD podczas etapu {stage}.',
  'git.protectedBranch': 'Workflow wymaga gałęzi roboczej; {branch} jest zabroniona.',
  'runner.modified': 'Pliki runnera zmieniły się w trakcie przebiegu: {files}. Ich odcisk powstał przy starcie runnera; przebieg zostaje zatrzymany.',
  'runner.unverifiable': 'Nie można policzyć odcisku plików runnera ({detail}); przebieg zostaje zatrzymany.',
  'runner.modifiedResume': 'Sprawdź instalację runnera (zainstaluj go ponownie, najlepiej poza repozytorium) i drzewo robocze, potem uruchom zadanie ponownie.',
  'git.directoryTooLarge': 'Katalog Gita przekracza limit odcisku integralności.',
  'git.objectsTooLarge': 'Baza obiektów Gita przekracza limit odcisku integralności.',
  'git.refsUnreadable': 'Nie można odczytać refów Gita',
  'git.indexFlagsUnreadable': 'Nie można odczytać flag indeksu Gita',
  'git.indexEntriesUnreadable': 'Nie można odczytać wpisów indeksu Gita',
  'git.directoryUnreadable': 'Nie można odczytać katalogu Gita',
  'git.privateIndexBuild': 'Nie można zbudować prywatnego indeksu Gita',
  'git.privateIndexRefresh': 'Nie można odświeżyć prywatnego indeksu Gita',
  'git.privateIndexMissing':
    'Brak prywatnego indeksu Gita; rdzeń nie przechodzi na indeks repozytorium. Workflow zatrzymany.',

  'implementer.gitStateChanged':
    'Implementer zmienił stan Gita poza working tree ({changed}). Workflow zatrzymany przed bramkami.',
  'implementer.gitStateChangedLater':
    'Stan Gita poza working tree zmienił się po rundzie implementera ({changed}), wykryto na etapie {stage}. Workflow zatrzymany.',
  'implementer.processSurvived':
    'Procesy uruchomione przez CLI implementera przeżyły jego zakończenie i nie dały się zakończyć (PID {pids}). Workflow zatrzymany.',
  'implementer.processCheckUnavailable':
    'Nie można sprawdzić, czy procesy CLI implementera przeżyły jego zakończenie (nieczytelna tablica procesów). Workflow zatrzymany.',
  'implementer.processIdentityChanged':
    'Nie można sprawdzić, czy procesy CLI implementera przeżyły jego zakończenie: zarejestrowany PID jest obecny z innym czasem startu (PID {pids}). Workflow zatrzymany.',
  'implementer.layoutSymlink': 'katalog Gita ma dowiązanie symboliczne w {path}',
  'implementer.scratchNotEmpty':
    'Katalog roboczy CLI implementera {path} nie jest pustym katalogiem. Workflow zatrzymany.',
  'implementer.layout': 'Implementer {program} wymaga zwykłego repozytorium Git: {reason}.',
  'implementer.layoutDotGit': '.git nie jest katalogiem (linked worktree albo submoduł)',
  'implementer.layoutGitmodules': 'repozytorium ma plik .gitmodules (submoduły)',
  'implementer.layoutGitDirectory': 'katalog Gita nie jest katalogiem .git repozytorium',
  'implementer.layoutEntries': 'katalog Gita ma wpisy w {name}/',
  'implementer.layoutAlternates': 'baza obiektów ma plik alternates',

  'task.duplicateSection': 'Sekcja „{title}” występuje w pliku zadania więcej niż raz.',
  'task.checksBackticks': 'Sekcja „Wymagane kontrole” musi zawierać polecenia w backtickach.',
  'task.unsupportedCheck':
    'Nieobsługiwana kontrola {command}. Workflow nie wykona tekstu jako polecenia powłoki.',
  'task.reviewFilesRequired': 'Tryb analysis wymaga niepustej sekcji „Pliki review”.',
  'task.reviewFilesBackticks':
    'Sekcja „Pliki review” przyjmuje wyłącznie listę dokładnych ścieżek w backtickach.',
  'task.reviewFilesNonCanonical':
    'Sekcja „Pliki review” zawiera niekanoniczną ścieżkę, glob albo escape.',
  'task.reviewFilesCount': 'Sekcja „Pliki review” musi zawierać od 1 do {max} ścieżek.',
  'task.reviewFilesDuplicate': 'Sekcja „Pliki review” zawiera duplikat ścieżki.',
  'task.reviewFilesSame': 'Sekcja „Pliki review” wskazuje ten sam plik więcej niż raz.',
  'task.reviewFilesTotal': 'Łączny rozmiar plików review przekracza limit 32 MiB.',
  'task.reviewFileMissing': 'Plik review {path} nie istnieje.',
  'task.reviewFileLink': 'Plik review {path} nie może przechodzić przez dowiązanie.',
  'task.reviewFileUnsafe': 'Plik review {path} nie jest bezpiecznym zwykłym plikiem.',
  'task.reviewFileSize': 'Plik review {path} musi być zwykłym plikiem do 8 MiB.',
  'task.reviewFileNonCanonical': 'Plik review {path} nie jest kanoniczną ścieżką repo-relative.',
  'task.tooLarge': 'Plik zadania przekracza limit 256 KiB.',
  'task.classHeading': 'Sekcja „Klasa zadania” musi mieć nagłówek poziomu ##.',
  'task.classInvalid': 'Niepoprawna lub niekompatybilna sekcja „Klasa zadania”.',
  'task.sectionMissing': 'Brak niepustej sekcji „{section}” w pliku zadania.',
  'task.pathMissing': 'Podaj ścieżkę do pliku zadania Markdown.',
  'task.notInRepository': 'Plik zadania musi znajdować się w repozytorium.',
  'task.notRegular': 'Plik zadania musi być zwykłym plikiem, nie dowiązaniem.',
  'task.escapes': 'Plik zadania wychodzi poza repozytorium.',
  'task.analysisPathLength': 'Ścieżka zadania analitycznego przekracza limit 500 znaków.',

  'taskClass.reviewRequiredReason':
    'Klasa wymaga niezależnego review; analysis zachowuje osobny kontrakt.',
  'taskClass.reviewRequiredAssurance':
    'Osobny checkpoint całego zakresu i decyzja człowieka przed publikacją.',
  'taskClass.docsReason':
    'Zatwierdzona polityka docs-minor/docs-descriptive: kontrola executora i gates dokumentacji.',
  'taskClass.docsAssurance':
    'Brak niezależnej recenzji semantyki; klasyfikacja koordynatora, weryfikacja źródeł przez executora i checkpoint przed publikacją.',

  'secret.providerToken': 'token dostawcy',
  'secret.authorizationHeader': 'nagłówek autoryzacyjny',
  'secret.urlCredentials': 'credentials w URL',
  'secret.secretVariable': 'podejrzana zmienna sekretu',
  'secret.suspiciousPath': 'podejrzana ścieżka pliku',
  'secret.defaultPath': 'treść',
  'secret.detected': 'Wykryto podejrzane dane uwierzytelniające w {path}: {labels}.',
  'secret.newFindings':
    'Wykryto nowe podejrzane dane uwierzytelniające ({count}): {summary}. Wartości ukryto.',
  'secret.filesUnreadable': 'Nie można odczytać plików do skanu sekretów',
  'secret.trackedUnreadable': 'Nie można odczytać śledzonych plików do bazowego skanu sekretów',
  'secret.basePathsUnreadable': 'Nie można odczytać bazowych ścieżek do skanu sekretów',
  'secret.baseVersionUnreadable': 'Nie można odczytać bazowej wersji {path}',

  'docker.invalidHost':
    'Nieprawidłowy DOCKER_HOST. Dozwolony jest wyłącznie standardowy lokalny socket Docker unix://.',

  'deps.metadataMissing':
    'Brakuje lokalnych metadanych zależności. Wykonaj ręcznie poza workflow: pnpm install --frozen-lockfile.',
  'deps.metadataSymlink':
    'Chroniona ścieżka metadanych zależności {path} zawiera dowiązanie symboliczne.',
  'deps.metadataNotRegular':
    'Chroniona ścieżka metadanych zależności {path} nie jest zwykłym plikiem w zwykłych katalogach.',
  'deps.metadataFileLimit':
    'Chroniony plik metadanych zależności {path} przekracza limit {limit} B.',
  'deps.metadataFileChanged':
    'Chroniony plik metadanych zależności {path} zmienił się podczas odczytu.',
  'deps.metadataTotalLimit': 'Chronione metadane zależności przekraczają łączny limit {limit} B.',
  'deps.metadataChanged':
    'Lokalne metadane zależności zmieniły się podczas workflow. Nie są automatycznie przywracane; sprawdź node_modules i wykonaj świadomą instalację poza pętlą.',
  'deps.inputSymlink': 'Wejście zależności {path} nie może być dowiązaniem symbolicznym.',
  'deps.inputTotalLimit': 'Wejścia zależności przekraczają łączny limit {limit} B.',
  'deps.inputsChanged':
    'Wejścia zależności zmieniły się podczas workflow. Sprawdź diff, wykonaj świadomie pnpm install --frozen-lockfile poza pętlą, ponownie zatwierdź zakres i uruchom workflow od początku. Zmiany nie zostały cofnięte.',
  'deps.repair':
    '{reason} Wykonaj ręcznie poza workflow: pnpm install --frozen-lockfile. Workflow nie naprawia ani nie kopiuje lockfile.',
  'deps.validationEscape': 'Wejście walidacji zależności wychodzi poza katalog tymczasowy.',
  'deps.lockMismatch':
    'pnpm-lock.yaml i zainstalowany node_modules/.pnpm/lock.yaml nie są bajtowo identyczne.',
  'deps.manifestsUnverifiable': 'Nie można zweryfikować spójności manifestów z pnpm-lock.yaml',
  'deps.manifestsMismatch': 'Manifesty package.json nie są spójne z pnpm-lock.yaml ({detail}).',

  'pnpm.pinExact': 'Pole packageManager musi przypinać dokładną wersję pnpm.',
  'pnpm.pinFormat': 'Pole packageManager musi mieć format pnpm@<dokładna-wersja>.',
  'pnpm.onlyPnpm': 'Workflow obsługuje wyłącznie packageManager pnpm.',
  'pnpm.pinSemver': 'Pole packageManager musi przypinać dokładną wersję semver pnpm.',
  'pnpm.integritySuffix':
    'Sufiks integralności packageManager musi mieć format obsługiwany przez Corepack: sha<algorytm>.<pełny-hash-hex>.',
  'pnpm.packageJsonRegular': 'package.json musi być zwykłym plikiem z przypiętą wersją pnpm.',
  'pnpm.packageJsonInvalid': 'package.json nie jest poprawnym JSON-em.',

  'corepack.homeAbsolute': 'Ścieżka lokalnego cache Corepacka musi być absolutna.',
  'corepack.versionMissing':
    'Dokładna wersja pnpm nie istnieje w lokalnym cache Corepacka albo jest dowiązaniem. Przygotuj ją ręcznie: corepack install -g --cache-only pnpm@<wersja>.',
  'corepack.cacheEntries': 'Cache pnpm przekracza limit {limit} wpisów.',
  'corepack.cacheLink': 'Cache pnpm zawiera niedozwolone dowiązanie: {path}.',
  'corepack.cacheEscape': 'Wpis cache pnpm wychodzi poza katalog dokładnej wersji.',
  'corepack.cacheUnsupported': 'Cache pnpm zawiera nieobsługiwany wpis: {path}.',
  'corepack.cacheBytes': 'Cache pnpm przekracza limit {limit} bajtów.',
  'corepack.cacheChangedRead': 'Cache pnpm zmienił się podczas bezpiecznego odczytu.',
  'corepack.homeMissing': 'Lokalny COREPACK_HOME nie istnieje.',
  'corepack.homeNotDirectory': 'Źródłowy COREPACK_HOME musi być rzeczywistym katalogiem.',
  'corepack.pinnedLink': 'Ścieżka do przypiętej wersji pnpm zawiera niedozwolone dowiązanie.',
  'corepack.pinnedEscape': 'Przypięta wersja pnpm wychodzi poza źródłowy COREPACK_HOME.',
  'corepack.isolatedExists': 'Izolowany cache pnpm już istnieje.',
  'corepack.sourceChanged': 'Źródłowy cache pnpm zmienił się podczas kopiowania.',
  'corepack.integrityMissing':
    'Cache przypiętej wersji pnpm nie zawiera bezpiecznych metadanych integralności.',
  'corepack.integrityInvalid': 'Metadane integralności cache pnpm są nieprawidłowe.',
  'corepack.integrityMismatch': 'Integralność lokalnego cache pnpm nie zgadza się z packageManager.',
  'corepack.checkCacheChanged': 'Izolowany cache pnpm kontroli zmienił się po preflight.',
  'corepack.runPinned': 'Nie można uruchomić przypiętej wersji pnpm w środowisku {label}',
  'corepack.versionMismatch':
    'Izolowany Corepack ({label}) uruchomił pnpm {actual}, oczekiwano {expected}.',
  'corepack.labelWriter': 'Codexa',
  'corepack.labelChecks': 'kontroli',
  'corepack.cacheMissing':
    'Brak lokalnego cache {specification}. Przygotuj go ręcznie przed workflow: corepack install -g --cache-only {specification}.',
  'corepack.copiesUnconfirmed': 'Nie można potwierdzić niezależnych, identycznych kopii cache pnpm.',

  'output.wrongFields': '{label} ma niewłaściwe pola.',
  'output.invalidJson': '{label} zwrócił niepoprawny JSON.',
  'label.findingResponse': 'Odpowiedź {status}',
  'label.writerResult': 'Wynik Codexa',
  'label.reviewerResult': 'Wynik Claude',
  'label.confirmation': 'Potwierdzenie {label}',
  'label.analysisConfirmation': 'Potwierdzenie review analizy',
  'label.readTask': 'oryginalnego zadania',
  'label.readManifest': 'manifestu',
  'label.readArtifact': 'artefaktu',
  'label.readReviewFile': 'pliku review {path}',

  'writer.invalidResponse': 'Codex zwrócił niepoprawną odpowiedź na finding.',
  'writer.confirmedFields':
    'Odpowiedź CONFIRMED wymaga analizy, dowodu, poprawki, regression testu lub uzasadnienia, wykonanych kontroli oraz pustego question.',
  'writer.rejectedFields':
    'Odpowiedź REJECTED wymaga analizy oraz próby reprodukcji, dowodu lub konkretnego uzasadnienia; fix, regressionTest i question muszą być puste.',
  'writer.needsHumanFields':
    'Odpowiedź NEEDS_HUMAN wymaga konkretnego pytania albo opisu konfliktu oraz pustych pozostałych pól.',
  'writer.invalidResponses': 'Codex zwrócił niepoprawną listę odpowiedzi na findings.',
  'writer.analysisMissing': 'Codex nie zwrócił wymaganej pełnej analizy.',
  'writer.invalidResult': 'Codex zwrócił niepoprawny wynik strukturalny.',
  'writer.analysisFieldMissing': 'Codex nie zwrócił wymaganego pola pełnej analizy.',
  'writer.analysisMetadata':
    'Tryb analysis wymaga pustego changes oraz krótkich metadanych bez sentinela artefaktu.',
  'writer.unknownFindingId': 'Codex odpowiedział na nieznany findingId {findingId}.',
  'writer.duplicateResponse': 'Codex zwrócił więcej niż jedną odpowiedź dla {findingId}.',
  'writer.incompleteResponses': 'Codex nie zwrócił pełnego zestawu odpowiedzi na findings: {missing}.',
  'writer.responseCountMismatch': 'niezgodna liczba odpowiedzi',
  'writer.needsHumanConflict': 'Odpowiedź NEEDS_HUMAN jest sprzeczna ze statusem wyniku Codexa.',
  'writer.stopped': 'Codex zatrzymał pracę ze statusem {status}: {summary}',
  'writer.offlineConfig': 'Środowisko Codexa nie ma kompletnej konfiguracji offline pnpm.',
  'writer.sessionId': 'Nie można ustalić session ID Codexa.',
  'writer.roundFailed': 'Codex nie zakończył rundy poprawnie',
  'writer.noResult': 'Codex nie zapisał wyniku strukturalnego.',
  'writer.analysisWrite': 'Sol podjął próbę zapisu do working tree w trybie analysis.',

  'analysis.tooLarge': 'Pełna analiza przekracza limit 512 KiB.',
  'analysis.sentinel':
    'Pełna analiza nie ma pojedynczego sentinela kompletności dokładnie na końcu.',
  'analysis.truncated': 'Pełna analiza zawiera marker ucięcia.',
  'analysis.heading':
    'Pełna analiza wymaga co najmniej jednego unikalnego semantycznego nagłówka Markdown.',

  'reviewer.readUnconfirmed': 'Claude nie potwierdził odczytu {label}.',
  'reviewer.readMismatch': 'Claude zwrócił niezgodne potwierdzenie odczytu {label}.',
  'reviewer.manifestMissing': 'Runner nie ma oczekiwanego manifestu potwierdzeń review analizy.',
  'reviewer.confirmationMissing': 'Claude nie zwrócił potwierdzenia review analizy.',
  'reviewer.filesUnconfirmed': 'Claude nie potwierdził dokładnego zestawu plików review.',
  'reviewer.filesMismatch':
    'Claude zwrócił niepełny, obcy albo zduplikowany zestaw plików review.',
  'reviewer.invalidResult': 'Claude zwrócił niepoprawny wynik strukturalny.',
  'reviewer.verdictConflict': 'Verdict review analizy jest sprzeczny z listą findings.',
  'reviewer.invalidFinding': 'Claude zwrócił niepoprawne finding.',
  'reviewer.findingOutside': 'Claude zwrócił finding ze ścieżką poza repo.',
  'reviewer.analysisFindingTarget':
    'Finding analityczny musi wskazywać logiczny artefakt i dokładny nagłówek jego sekcji.',
  'reviewer.noStructuredOutput': 'Claude nie zwrócił structured_output.',
  'reviewer.findingAmbiguousPath':
    'Claude zwrócił finding ze ścieżką poza repo albo niejednoznaczną ścieżką.',
  'reviewer.findingAmbiguousFields': 'Claude zwrócił niejednoznaczne stabilne pola findingu.',
  'reviewer.findingIdMismatch':
    'Claude podał findingId niezgodny ze stabilnymi polami dla {file}.',
  'reviewer.invalidModel': 'Model reviewera {model} jest niepoprawny.',
  'reviewer.reviewFailed': 'Claude nie zakończył review poprawnie',
  'reviewer.fallbackFailed': 'Fallback Claude nie zakończył review poprawnie.',

  'finding.identityCollision': 'Wykryto kolizję stabilnej tożsamości {findingId}.',
  'finding.identityDuplicate': 'Review zawiera niejednoznacznie zduplikowaną tożsamość {findingId}.',
  'finding.needsHuman': 'Finding {findingId} wymaga decyzji człowieka: {question}',
  'finding.dispute':
    'Claude podtrzymał finding {findingId} odrzucony technicznie przez Codexa. Decyzję przejmuje człowiek niezależnie od severity.',

  'guard.gitBlocked': 'Agent review loop: mutująca lub nieznana operacja Git zablokowana.',
  'guard.pnpmBlocked': 'Agent review loop: mutująca lub nieznana operacja pnpm zablokowana.',
  'guard.corepackBlocked': 'Agent review loop: mutująca lub nieznana operacja Corepack zablokowana.',
  'guard.callBlocked': 'Agent review loop: wywołanie {name} zablokowane.',
  'guard.notInstalled': 'Agent review loop: prawdziwy {name} nie jest zainstalowany.',

  'repo.filesUnreadable': 'Nie można odczytać plików repozytorium',
  'repo.absolutePath': 'Git zwrócił ścieżkę absolutną.',
  'repo.pathEscape': 'Ścieżka repozytorium wychodzi poza root.',
  'repo.linkAbsolute': 'Dowiązanie {path} ma cel absolutny.',
  'repo.linkEscape': 'Dowiązanie {path} wychodzi poza repozytorium.',
  'repo.unsupportedEntry': 'Nieobsługiwany typ wpisu {path}.',
  'repo.fileTooLarge': 'Plik {path} przekracza limit 8 MiB. Podziel zadanie.',
  'repo.stateTooLarge': 'Stan repozytorium przekracza limit kopii 64 MiB. Podziel zadanie.',
  'repo.candidateUnreadable': 'Nie można odczytać całego kandydata',
  'repo.newFilesUnreadable': 'Nie można odczytać nowych plików',
  'repo.headTypeUnreadable': 'Nie można sprawdzić typu pliku HEAD',
  'gates.ruleRequired': 'Zmiana ścieżek objętych regułą profilu wymaga jawnego {check} w zadaniu.',
  'docs.candidateForbidden': 'Kandydat docs zawiera niedozwolony plik lub typ: {path}.',

  'diff.trackedFailed': 'Nie można utworzyć diffu tracked files',
  'diff.untrackedUnreadable': 'Nie można odczytać untracked files',
  'diff.pathFailed': 'Nie można utworzyć diffu {path}',
  'diff.pathFailedDetail': 'Nie można utworzyć diffu {path}: {detail}',
  'diff.tooLarge': 'Pełny diff przekracza limit 16 MiB.',

  'snapshot.unsupportedEntry': 'Snapshot zawiera nieobsługiwany typ wpisu {path}.',
  'snapshot.treeChangedReview': 'Rzeczywisty working tree zmienił się podczas review Claude.',
  'snapshot.changedDuringReview': 'Snapshot review zmienił się podczas review.',
  'snapshot.packagePathEscape': 'Ścieżka pakietu review wychodzi poza root.',
  'snapshot.artifactChanged': 'Artefakt analizy zmienił się podczas tworzenia pakietu review.',
  'snapshot.artifactCopyMismatch':
    'Kopia artefaktu w pakiecie review ma niezgodny hash albo rozmiar.',
  'snapshot.reviewFileChanged': 'Plik review {path} zmienił typ lub treść przed snapshotem.',
  'snapshot.treeChangedAnalysis': 'Working tree zmienił się podczas tworzenia pakietu analizy.',
  'snapshot.analysisPackageTooLarge': 'Minimalny pakiet review analizy przekracza limit 64 MiB.',
  'snapshot.treeChangedCopy': 'Working tree zmienił się podczas tworzenia kopii dla Claude.',

  'artifact.overwrite': 'Odmowa nadpisania istniejącego artefaktu.',
  'artifact.writeFailed': 'Nie można atomowo zapisać artefaktu analizy: {detail}',
  'artifact.metadataMissing': 'Brak metadanych artefaktu analizy.',
  'artifact.missing': 'Artefakt analizy zniknął albo nie jest bezpiecznym zwykłym plikiem.',
  'artifact.changed': 'Artefakt analizy zniknął, zmienił typ, inode, prawa albo rozmiar.',
  'artifact.hashMismatch': 'Hash artefaktu analizy jest niezgodny.',
  'artifact.contract': 'Treść artefaktu analizy nie spełnia zapisanego kontraktu kompletności.',

  'gates.noOutput': 'Brak wyjścia; proces zakończony kodem 0.',
  'gates.reportNotPass':
    'Nie można utworzyć zaufanego raportu: nie wszystkie wymagane gates mają PASS.',
  'gates.reportStructure': 'Zaufany raport gates ma niepoprawną strukturę.',
  'gates.reportEntry': 'Zaufany raport gates ma niepoprawny wpis.',
  'integrity.reportStructure': 'Raport wewnętrznych kontroli analizy ma niepoprawną strukturę.',
  'check.timeout': 'Kontrola {name}: przekroczono timeout.',
  'check.signal': 'Kontrola {name} została przerwana sygnałem {signal}.',
  'check.failed': 'Kontrola {name} nie przeszła: {detail}',
  'check.treeChanged':
    'Kontrola zmieniła working tree. Następna kontrola nie zostanie uruchomiona.',
  'check.treeChangedStop': 'Kontrole zmieniły working tree. Workflow zatrzymany.',

  'preflight.versionUnreadable': 'Nie można uruchomić {command}',
  'preflight.unsupportedVersion':
    'Wersja {program} ({version}) nie jest obsługiwana dla roli implementer.',
  'preflight.unsupportedPlatform':
    'Platforma {platform} nie obsługuje sandboxa poleceń {program} dla roli implementer.',
  'preflight.refused': 'Preflight dostawcy {id} odmówił roli implementer na tym hoście.',

  'stage.preflight': 'Walidacja repozytorium i narzędzi',
  'stage.analysis': 'Analiza read-only',
  'stage.analysisCorrection': 'Korekta analizy',
  'stage.implementation': 'Implementacja',
  'stage.findingsCorrection': 'Korekta findings',
  'stage.analysisChecks': 'Kontrole analizy read-only',
  'stage.analysisPackage': 'Minimalny pakiet analizy read-only',
  'stage.isolatedCopy': 'Izolowana kopia read-only',
  'stage.reviewAttempt': 'Review {profile} · {model} · effort {effort} · próba {attempt}',

  'plan.analysisWriter': 'Codex pełna analiza read-only',
  'plan.analysisIntegrity': 'wewnętrzne kontrole integralności',
  'plan.analysisArtifact': 'osobny artefakt Markdown z SHA-256',
  'plan.analysisPackage': 'minimalny pakiet review read-only',
  'plan.analysisReview': 'Claude review merytoryczne',
  'plan.analysisCorrection': 'korekta pełnej analizy po każdym findingu BLOCKER/HIGH/MEDIUM/LOW',
  'plan.docsWriter': 'Codex dokumentacja i weryfikacja źródeł',
  'plan.checks': 'deterministyczne kontrole',
  'plan.implementationWriter': 'Codex implementacja',
  'plan.isolatedCopy': 'izolowana kopia read-only',
  'plan.implementationReview': 'Claude review diff-first',
  'plan.implementationCorrection': 'korekta Codex po każdym findingu BLOCKER/HIGH/MEDIUM/LOW',
  'plan.noMutations': 'brak',

  'report.docsApproval':
    'APPROVE oznacza wykonanie wymaganych kontroli docs; niezależne review NOT_REQUIRED.',
  'report.analysisApproval':
    'APPROVE oznacza pozytywne review analizy, nie review kodu ani zgodę publikacyjną.',
  'report.nextStep':
    'Człowiek sprawdza wynik. APPROVE nie oznacza zgody na commit, push, PR ani merge.',

  'dashboard.yes': 'tak',
  'dashboard.no': 'nie',
  'dashboard.noDetails': 'Brak szczegółów.',
  'dashboard.defaultResume': 'Usuń przyczynę i uruchom zadanie ponownie.',
  'dashboard.feedRoundStart': 'Runda {round} · START',
  'dashboard.feedWaiting': 'oczekiwanie',
  'dashboard.feedReviewResult': 'CLAUDE · wynik review',
  'dashboard.round': 'runda {round}/{max}',
  'dashboard.beforeReview': 'przed review',
  'dashboard.lastKnownResult': 'ostatni znany wynik',
  'dashboard.reviewResult': 'wynik review',
  'dashboard.waitingForEvent': 'Oczekiwanie na zdarzenie',
  'dashboard.gatesLine': '{gates} · PASS {passed} · aktywna {active}',
  'dashboard.agentLine': 'Model {model} · effort {effort} · próba {attempt}/{limit}{fallback}',
  'dashboard.error': 'Błąd {error}',
  'dashboard.next': 'Dalej {resume}',
  'dashboard.modeLine': 'Tryb {mode} · {round} · gałąź {branch}',
  'dashboard.classLine': 'Klasa {taskClass} · review {review}',
  'dashboard.reviewNotRequired': 'Review NOT_REQUIRED · brak niezależnej recenzji',
  'dashboard.zeroFindings': 'ZERO_FINDINGS · próg B/H/M/L=0 · {result}',
  'dashboard.noReview': '— (brak review)',
  'dashboard.codeLine': 'Kod {code} · {stage}',
  'dashboard.classGates': 'Klasa {taskClass} · gates {gates}',
  'dashboard.reviewCalls': 'Review NOT_REQUIRED · wywołania 0',
  'dashboard.reviewAttempts': 'Review {profile} · próby {attempts}',
  'dashboard.fallbackUsed': 'fallback dozwolony {allowed} · użyty {used}',
  'dashboard.reportPath': 'Raport {path}',
  'dashboard.reviewPlan': 'Review {profile} · próby {attempts} · fallback dozwolony {allowed}',
  'dashboard.recent': 'OSTATNIE PRZEJŚCIA',
  'dashboard.appendPreflight': 'PREFLIGHT  run {runId} · gałąź {branch}',
  'dashboard.appendMode': 'TRYB  {mode}',
  'dashboard.appendClass': 'KLASA  {taskClass} · gates {gates}',
  'dashboard.appendAssurance': 'POZOSTAŁA PEWNOŚĆ  {assurance}',
  'dashboard.appendReview': 'REVIEW  {profile} · próby {attempts} · fallback dozwolony {allowed}',
  'dashboard.appendRound': 'RUNDA {round}/{max}',
  'dashboard.task': 'Zadanie {path} · tryb {mode}',
  'dashboard.diagnostics': 'DIAGNOSTYKA',
  'dashboard.choices': '{list} albo {last}',

  'cli.taskModeOnce': 'Opcję --task-mode można podać tylko raz.',
  'cli.taskModeValue': 'Opcja --task-mode wymaga wartości implementation albo analysis.',
  'cli.missingValue': 'Opcja {option} wymaga wartości.',
  'cli.reviewProfileOnce': 'Opcję --review-profile można podać tylko raz.',
  'cli.reviewProfileValue': 'Opcja --review-profile wymaga wartości {choices}.',
  'cli.codexModelOnce': 'Opcję --codex-model można podać tylko raz.',
  'cli.codexModelValue':
    'Opcja --codex-model wymaga pojedynczego identyfikatora (1–128 znaków ASCII: litery, cyfry, kropka, podkreślenie, myślnik; początek alfanumeryczny).',
  'cli.solEffortValue': 'Opcja --sol-effort wymaga wartości {choices}.',
  'cli.solEffortConflict': 'Opcja --sol-effort ma sprzeczne wartości {first} i {second}.',
  'cli.unknownOption': 'Nieznana opcja: {option}',
  'cli.oneTaskPath': 'Wymagana jest dokładnie jedna ścieżka zadania.',
  'cli.usage':
    'Użycie: pnpm agents:run -- ścieżka/do/task.md [--task-mode {taskModes}] [--codex-model <id>] [--sol-effort {efforts}] [--review-profile {profiles}] [--dry-run] [--verbose] [--no-animation] [--json]',
  'cli.criticalOpus':
    'critical-opus: model {model}; effort {effort}; próby {attempts}; fallback {fallback}.',
  'cli.fallbackAllowed': 'dozwolony',
  'cli.fallbackNone': 'brak',
});
