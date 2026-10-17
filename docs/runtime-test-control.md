# Runtime Test Control

ACPilot can expose a loopback-only control endpoint for Extension Host smoke
tests. It is disabled unless `ACPILOT_TEST_CONTROL=1` is set and requires a
random bearer token of at least 16 characters.

The repository smoke runner starts a clean VS Code Extension Host with:

```bash
npm run test:runtime
```

The runner creates temporary user data, extensions, workspace, and control
descriptor directories. It waits for `control.json`, then sends authenticated
requests to the loopback endpoint and shuts the host down. Cleanup is
best-effort: the runner attempts to remove the temporary runtime directory
after the process exits, but VS Code file handles (especially on Windows) may
keep it alive. When removal fails, the runner prints the remaining path.

The executable can be selected with `VSCODE_BIN` (or
`VSCODE_INSIDERS_BIN`); otherwise the runner checks common stable and Insiders
install locations and finally falls back to `code-insiders` on `PATH`.

For direct embedding, set `ACPILOT_TEST_CONTROL_PORT` to choose a port
(`0`/unset asks the OS for an available port) and
`ACPILOT_TEST_CONTROL_FILE` to receive the `{ host, port }` descriptor.

The endpoint has an authenticated `GET /health` and an authenticated
`POST /execute` operation. Every request, including health checks, must carry
`Authorization: Bearer <token>`. The token is supplied to the Extension Host
through `ACPILOT_TEST_CONTROL_TOKEN`; it is not written to `control.json`.
`/execute` accepts a JSON body containing a JavaScript `code` string. The code
runs in a deliberately small VM surface and can only access the frozen `api`
object. This endpoint is a local test harness, not a security sandbox; do not
bind it beyond loopback or use it with untrusted scripts. The
available operations are:

```text
snapshot()
inspectBackend(backendId)
inspectSession(backendId, sessionId)
listModels(backendId)
listAcpTargets()
selectAcpTarget(targetId)
startBackend(backendId)
stopBackend(backendId)
createSession(backendId)
listSessions(backendId)
startPrompt(backendId, sessionId, text, options?)
getPrompt(operationId)
waitPrompt(operationId, timeoutMs?)
cancelPrompt(operationId)
startTurn(backendId, sessionId?, text, options?)
getTurn(operationId)
waitTurn(operationId, timeoutMs?)
cancelTurn(operationId)
listLanguageModels(backendId)
generateTitle(backendId, prompt)
startModelRequest(backendId, modelId, text, options?)
getModelRequest(operationId)
waitModelRequest(operationId, timeoutMs?)
cancelModelRequest(operationId)
refreshModels()
shutdownHost()
```

`startPrompt` opens the backend event stream, invokes the backend's
`ensureStarted` hook, and only then submits the prompt. It does not create a
session or SSS record and assumes the supplied session/backend is usable; use
`startBackend` first when the backend is stopped. It returns an operation
snapshot.
`getPrompt` and `waitPrompt` expose a bounded
summary of the observed backend events, including event type, session id,
part type, tool call id, and status. Raw SDK events, VS Code objects, and SSS/
SSP instances are not exposed through the control API.

`cancelPrompt` and `cancelTurn` mark an active operation as cancelling, abort
the backend session when one is available, and close its event stream. The
operation finishes as `cancelled` after its in-flight work unwinds. A timed-out
`waitPrompt` or `waitTurn` performs the same cancellation before waiting for a
terminal snapshot.

`startTurn` is the end-to-end operation. It starts the backend when needed,
creates a backend session when `sessionId` is omitted, initializes the real SSS,
opens the session event stream, binds the backend pipeline, starts pipeline event
consumption before calling the backend prompt operation, and waits for the pipeline result. `getTurn` and
`waitTurn` return the operation state together with the session path, a safe
summary of serialized SSP records, and safe summaries of calls made to the
virtual response stream. A turn is completed only when both prompt admission
and the backend pipeline complete successfully. `startPrompt` remains an
event-level diagnostic operation and does not create SSS records.

`listLanguageModels` starts the backend when necessary, refreshes the model
catalog, then queries the real VS Code LM registry for the backend's single
vendor and returns only that vendor's serializable model information. If a
backend is unavailable or unconfigured, it returns an empty array.
`generateTitle` invokes the same VS Code language-model title path used by a
live participant request and returns the selected models plus their
`canSendRequest` state. Enable this diagnostic in the smoke runner with
`ACPILOT_RUNTIME_TITLE_GENERATION=1`.
`startModelRequest` selects one of those canonical model ids. Static backends
use `vendor/provider/model` (for example `opencode/<provider>/<model>`).
Dynamic ACP targets append the encoded backend instance key as a fourth
component (for example `acp/<provider>/<model>/acp%3Atarget-a`), preventing an
old target's model handle from being rebound after a target switch. It then calls
`LanguageModelChat.sendRequest`, so the request traverses the registered native
provider and its backend model provider. `getModelRequest` and
`waitModelRequest` return bounded response-stream part summaries. Runtime smoke
does not make an LLM request by default; set `ACPILOT_RUNTIME_MODEL_REQUEST=1`
to enable an actual request when a model is available.
The smoke runner waits up to 15 seconds for the OpenCode model catalog to
contain at least one model (the server can become reachable before provider
discovery finishes). Override this bounded check with
`ACPILOT_RUNTIME_MODEL_READINESS_TIMEOUT_MS` and
`ACPILOT_RUNTIME_MODEL_READINESS_POLL_MS` when diagnosing a slower host.
`cancelModelRequest` cancels the underlying VS Code request token; a timed-out
`waitModelRequest` performs the same cancellation before returning.

This endpoint is intended for local automated tests only. It binds to
`127.0.0.1`, uses constant-time bearer-token comparison, caps request bodies at
64 KiB, and limits each script to 45 seconds (including the bounded 30-second
wait APIs). `ACPILOT_TEST_CONTROL=1` is required before the server is exposed;
the token must contain at least 16 characters.
