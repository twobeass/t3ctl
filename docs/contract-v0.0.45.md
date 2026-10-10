# T3 Code v0.0.45 control contract

Stand: 2026-10-03. Referenz: offizieller Tag
[v0.0.45](https://github.com/pingdotgg/t3code/tree/v0.0.45), Commit
`6c8fed35dded9ff71c5b46807125457acbb76be6`. Die unveränderte Quellreferenz liegt
lokal unter `.reference/t3code-0.0.45/` (ignoriert). Laufender Server meldet über
`GET /.well-known/t3/environment` **0.0.45**, Protokoll **1**.

## VERIFIED IN v0.0.45

### Discovery und Auth

- CLI `t3 auth session issue --base-dir DIR --ttl 10m --label LABEL --json`
  ist ausdrücklich für Headless-Clients vorgesehen. **Achtung:** Der CLI-Handler
  verwendet `AuthAdministrativeScopes`; ein `--scope`-Flag existiert nicht.
  `t3 auth session revoke SESSION_ID --base-dir DIR` widerruft gezielt diese Session.
  Quelle: `apps/server/src/cli/auth.ts:159`, `cliAuthFormat.ts:107`.
- Das offizielle Laufzeitmanifest ist `DIR/userdata/server-runtime.json`;
  `version: 1` darin ist die Manifestversion, NICHT die Serverversion.
  `origin`, `pid`, `host`, `port` zeigen die laufende Instanz.
- `GET /api/auth/session` beschreibt Auth-Policy, Cookie/Bearer/DPoP und Scopes.
  Auf diesem Host: `remote-reachable`, unauthentifizierter Zugriff ist gesperrt.
- Scopes: `orchestration:read`, `orchestration:operate`, `terminal:operate`,
  `review:write`, `access:read`, `access:write`, `relay:read`, `relay:write`.
  Für den Controller reichen read bzw. zusätzlich operate. Autorisierte Clients
  mit `access:write` können über `POST /api/auth/pairing-token` Scopes delegieren;
  `POST /oauth/token` tauscht einen Bootstrap-Token gegen einen Bearer.
  Token-Exchange nutzt Form-Encoding und die Konstanten aus
  `packages/contracts/src/auth.ts:125-225`; keine Passwort-/Token-Sonderwege.
- `POST /api/auth/websocket-ticket` mit `Authorization: Bearer …` liefert
  `{ticket, expiresAt}`. `GET /ws?wsTicket=…&orchestrationProtocol=1` authentifiziert
  damit die WebSocket-Verbindung. Ticket-TTL: 5 Minuten; kein Bearer im URL.
  Quellen: `environmentHttp.ts:441`, `auth/EnvironmentAuth.ts:1055-1101`,
  `auth/SessionStore.ts:424,843-914`, `apps/server/src/ws.ts:4112`.

### HTTP und RPC

- Vorhandene HTTP-Leseflächen: `GET /api/orchestration/shell` für Projekte und
  Thread-Metadaten; `GET /api/orchestration/threads/:threadId` für den vollständigen
  Thread; optional `turnLimit`/`beforeCursor`. `/snapshot` liefert das Command-
  Read-Model (ohne hydratisierte Thread-Bodies) und ist hierfür unnötig.
  Quelle: `packages/contracts/src/environmentHttp.ts:508-539`.
- `POST /api/orchestration/dispatch` existiert ebenfalls, leitet jedoch direkt
  an den Engine-Dispatcher weiter und durchläuft **nicht** den Bootstrap-Handler
  der WebSocket-Fläche. Für einen neuen Project Thread ist deshalb der offizielle
  Web-/Mobile-WebSocket-Flow erforderlich; HTTP und WS sind hier nicht austauschbar.
  Quelle: `apps/server/src/orchestration/http.ts:97-135` vs. `ws.ts:1917-1925`.
- Modell-/Providerkatalog: RPC **`server.getConfig`**, Payload `{}`. Antwort:
  `environment.serverVersion`, `providers[]`. Jede Instanz enthält `instanceId`,
  `driver`, `enabled`, `installed`, `status`, `auth`, `availability`, `models[]`.
  Modelle enthalten `slug`, `name`, optionale `aliases`, `capabilities`.
  IDs werden aus diesen Antworten aufgelöst. Es gibt keine separate notwendige
  `models.list`-Methode. Quellen: `contracts/src/server.ts:71,207,578`, `rpc.ts:481`.
- WebSocket ist **Effect RPC mit JSON**, nicht JSON-RPC 2.0. v0.0.45 bindet
  `RpcSerialization.layerJson` (Effect `4.0.0-rc.115` mit offiziellen T3-Patches).
  Request: `{_tag:"Request",id:"1",tag:"server.getConfig",payload:{},headers:[]}`.
  Antwort: `{_tag:"Exit",requestId:"1",exit:{_tag:"Success",value:…}}`, Fehler
  `{_tag:"Failure",cause:[{_tag:"Fail",error:…}]}`. Einzelobjekt oder Array pro
  WebSocket-Frame. `Ping`/`Pong`; Streams liefern `Chunk` mit `Ack`.
  Quellen: `ws.ts:4143-4151`, Effect `RpcMessage.ts:60-320`,
  `RpcSerialization.ts:118-137`. Der kleine Client benötigt nur unary RPC.

### Nativer Start und Workspace

- RPC **`orchestration.dispatchCommand`** nimmt das Command direkt als Payload.
  Neuer Thread: `type:"thread.turn.start"`, `commandId`, `threadId`,
  `message:{messageId,role:"user",text,attachments:[]}`, `modelSelection`,
  `runtimeMode`, `interactionMode`, `createdAt` und `bootstrap.createThread`.
- `ModelSelection` ist `{instanceId,model,options?:[{id,value}]}`. `model` ist der
  tatsächliche Katalog-Slug; `instanceId` ist die konfigurierte Routingidentität,
  nicht der Driver. Optionen werden über Modell-`optionDescriptors` validiert.
  Quellen: `contracts/src/orchestration.ts:61-126`, `model.ts:6-94`.
- `bootstrap.createThread` enthält `projectId,title,modelSelection,runtimeMode,
  interactionMode,branch,worktreePath,createdAt`. Root: `worktreePath:null`;
  Projekt-`workspaceRoot` ist der Provider-CWD. Branch stammt aus dem echten VCS.
- **Hypothese teilweise bestätigt:** Ein einzelner nativer RPC-Aufruf erstellt
  Thread und startet den ersten Turn. **Keine atomare Gesamttransaktion:**
  `dispatchBootstrapTurnStart` führt getrennte `thread.create`,
  `thread.message.user.append` und schließlich `thread.turn.start` aus, mit
  kompensierendem Cleanup bei Fehlern. Vor Providerstart bindet T3 den Workspace.
  Quellen: `apps/mobile/src/lib/projectThreadStartTurn.ts:42-99`,
  `apps/web/src/components/ChatView.tsx:8340-8370`,
  `apps/server/src/ws.ts:1082-1781` (insbesondere 1448-1490,1600-1630).
- Ergebnis des Dispatch: **`{sequence}`**, keine `runId`. T3s native
  `latestTurn.turnId` wird asynchron erzeugt; der Controller kann sie als
  `runId` aliasieren, muss `null` zulassen, solange noch nicht zugewiesen.
  Quellen: `orchestration.ts:681-690,2267-2270`.
- T3 verwaltet Worktrees mit `bootstrap.prepareWorktree:{projectCwd,baseBranch,
  branch?,startFromOrigin?,requireWorktree?}`; `runSetupScript` ist optional.
  **`requireWorktree:true`** verhindert stillen Root-Fallback. T3 setzt Branch und
  WorktreePath vor dem Agentstart. Existierende Worktree-Pfade sind im Create-
  Vertrag darstellbar. Der Controller unterstützt sie über `--existing-worktree`
  ohne `prepareWorktree`: absoluter Pfad, verknüpfte `.git`-Datei, identisches
  Git-Common-Dir zum Projekt, T3-`vcs.refreshStatus` mit echter Branch und keine
  gleichzeitig laufende T3-Arbeit im selben Pfad werden vor Dispatch geprüft.
- RPC **`vcs.refreshStatus`** und **`vcs.listRefs`** liefern echte Branch-/Worktreeinfos;
  Create-Worktree erfolgt innerhalb T3, nicht durch einen Prompt.

### Folgeaktionen und Recovery

- `thread.turn.start` ohne Bootstrap sendet eine Folgemeldung. `thread.turn.interrupt`
  (optional `turnId`) unterbricht einen Turn; `thread.session.stop` stoppt die
  Provider-Session. Der Thread samt Verlauf bleibt gespeichert.
  Quellen: `orchestration.ts:1341-1370,1500`,
  `orchestration/decider.ts:1568,1844`, `Layers/ProviderCommandReactor.ts:1531,1721`.
- Lesen: HTTP-Threadantwort mit `thread`, `session`, `latestTurn`, `messages`,
  `activities`; Live-Clients nutzen `orchestration.subscribeShell` und
  `orchestration.subscribeThread`. Provider-Lauf startet über T3s eigenen Reactor.
- Der Engine-Receipt dedupliziert Commands nach `commandId` und Aggregate;
  dieselbe ID für ein anderes Aggregate ist ein Konflikt. **Bootstrap liegt
  außerhalb dieser Gesamt-Deduplizierung** und erzeugt interne neue Command-IDs.
  Ein Bootstrap-Replay ist daher keine sichere Retry-Strategie.
  Quellen: `OrchestrationEngine.ts:145-175,274-315`, `ws.ts:1917-1925`.
- Controller schreibt vor Dispatch einen lokalen Request-Beleg mit IDs und
  Prompt-Hash. Unklare Antworten werden durch Thread-/Message-ID-Lesen
  rekonstruiert; kein automatischer neuer Thread oder Bootstrap-Retry.

## UPSTREAM-ONLY / NEWER

Keine Funktion aus `main` oder Preview-Releases übernommen. `main` wurde für
diesen Vertrag nicht benötigt. Aussagen gelten ausschließlich für den Tag oben.

## UNKNOWN

- Verhalten nicht getesteter Provider-/Modellkombinationen und Relay-/DPoP-Flows.
- Echte native iOS-/Android-App-Abnahme (ein mobiles Webviewport ersetzt sie nicht).
- Garantiertes exactly-once Bootstrap nach Prozessabbruch/Serverneustart:
  v0.0.45 bietet keine belegte globale Bootstrap-Receipt-Transaktion.
- Öffentlich zugesicherte API-Stabilität über v0.0.45 hinaus: Version Guard bleibt
  geschlossen, bis ein neuer Vertrag geprüft wurde.

## Controller-Auth-Entscheidung

Lokale Auto-Auth verwendet ausschließlich die offizielle CLI, kurzlebig (10m),
im Speicher, mit gezieltem Widerruf am Ende. Sie erbt die administrativen CLI-
Scopes; der Controller begrenzt seine Methoden selbst und zeigt Scopes offen an.
Keine Ausgabe/Dateispeicherung des Tokens, kein Lesen von SQLite oder T3-Secrets.
Ein bereits bereitgestellter Bearer mit engeren Scopes kann über `T3CTL_TOKEN`
oder eine private Token-Datei verwendet werden. Auto-Auth wird nur für die lokal
erkannte Instanz erlaubt; für einen anderen URL muss Auth explizit vorhanden sein.
Auth-Session-Ausgabe/Widerruf sind die einzigen Verwaltungsänderungen bei den
Read-only-Befehlen; Projekte, Threads, Provider und Einstellungen bleiben unverändert.
