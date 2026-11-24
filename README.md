# Webhook Relay

## Part 1 · Accept an event and deliver it reliably

A payment app submits one event. The relay records it before responding, then a worker sends it to the configured enrollment receiver. The local demo receiver returns 503 twice and accepts the third request. Every delivery carries the same X-Event-Id so a receiver can use that ID to deduplicate its own side effects.

### Run the local demo

Use Node 24. From this directory run `npm ci`, then `npm run demo`. The API binds to localhost and prints a temporary bearer key. In a second PowerShell window:

```powershell
$key = Read-Host 'Paste the local demo bearer key'
$headers = @{ Authorization = "Bearer $key"; 'Idempotency-Key' = 'payment-001' }
Invoke-RestMethod -Method Post -Uri http://localhost:4100/events -Headers $headers -ContentType 'application/json' -Body '{"type":"payment.succeeded","data":{"course":"mern-101"}}'
Start-Sleep -Seconds 5
Invoke-RestMethod http://localhost:4100/events/payment-001 -Headers $headers | ConvertTo-Json -Depth 5
```

Expect status `delivered` and HTTP codes 503, 503, 204. Repeating the same submission returns the existing event. Reusing its key with different serialized content returns 409. The demo stores data in memory for the lifetime of the process.

### MongoDB mode

Set MONGODB_URI (including database name) and RELAY_API_KEY for the API and run `npm start`. Run `npm run worker` in a separate terminal with the same MONGODB_URI plus REDIS_URL, SIGNING_SECRET and RECEIVER_URL. Use a random signing secret shared only with the receiver. The worker accepts HTTPS destinations and loopback HTTP for local tests. To run the example enrollment receiver, set its MONGODB_URI and SIGNING_SECRET, run `npm run receiver`, and point the worker at http://127.0.0.1:4101/enroll. Set RECEIVER_PORT to override 4101.

BullMQ schedules a pending-event scan every second. Each scan claims up to 20 due MongoDB records sequentially. An API request can succeed while Redis or the worker is offline because the pending event is durable in MongoDB. This version supports one workspace, producer key and destination. Keep the destination fixed while events are pending.

The event document holds the pending delivery and its payload together. A worker atomically claims a due event with a 30-second lease. A crash leaves work eligible after the lease expires. Completion checks the lease token to prevent a stale worker overwriting a newer result. A receiver can still see a duplicate when it accepts a request and the worker crashes before saving the response. History records completed attempts; a crash can leave an outgoing request unrecorded.

Timeouts, network failures, 408, 429 and 5xx responses are retryable. The worker schedules delays of 1, 2, 4 and 8 seconds before the fifth completed attempt. Other non-success codes end delivery immediately. Redirects are disabled. Requests time out after five seconds.

### Checkpoint and remaining parts

Run `npm test` for the standalone tests. To reproduce the Part 2 crash test with Docker Desktop running, use these commands in PowerShell from this directory:

```powershell
docker run --rm -d --name relay-part2-mongo -p 127.0.0.1:27127:27017 mongo:8
docker run --rm -d --name relay-part2-redis -p 127.0.0.1:16387:6379 redis:7-alpine
$env:RELAY_INTEGRATION='1'
npm test
Remove-Item Env:RELAY_INTEGRATION
docker stop relay-part2-mongo relay-part2-redis
```

The integration test starts a worker after intake, holds the receiver response after the enrollment insert, kills the worker, then starts a fresh worker. It waits for the real 30-second lease to expire. Two signed HTTP requests must produce one enrollment and a delivered event. Each run creates a unique test database and queue and removes them afterward.

The HMAC-SHA256 signature covers the timestamp, event ID and exact request bytes. The receiver checks the signature and a five-minute timestamp window, then inserts the enrollment using the event ID as its unique key. This example handles payment.succeeded with a string data.course field.

| Part | Deliverable | Completion check |
| --- | --- | --- |
| 1 · Intake and delivery | Express API, MongoDB adapter, local receiver, retry history | Local HTTP recovery test passes |
| 2 · Durable worker | Real MongoDB integration tests, separate BullMQ worker, recovery of persisted events awaiting enqueue, signed requests, deduplicating receiver | Restart after receiver acceptance and verify one enrollment |
| 3 · Workspace access | Users, rotating sessions, scoped producer keys, viewer/operator roles, limits and audited replay | Cross-workspace read and unauthorized replay are denied |
| 4 · React console | Paginated delivery list, attempt timeline, replay and reconnect recovery | An operator can diagnose and replay a failed event from the browser |
| 5 · Render release | Web and worker configuration, CI, seeded demo and measured failure scenario | Fresh deployment completes the documented end-to-end demo |

## Part 3 · Workspace access and replay

The API enables workspace mode when JWT_SECRET is set. Existing installations using only RELAY_API_KEY keep their single-workspace routes and event IDs. Workspace mode uses independent producer keys and member sessions. Old single-workspace events stay in the legacy namespace. The worker and signing secret still serve one configured receiver per installation.

1. Configure the API with MONGODB_URI (include a dedicated project database name) and a random JWT_SECRET of at least 32 bytes. A project-local .env is gitignored. Run `npm run check:mongo` for a read-only connectivity check.
2. Set RELAY_MEMBER_PASSWORD privately in your shell, then run `npm run member -- campus adarsh operator`. Repeat with a distinct password and role viewer for read-only access. Clear the password variable after provisioning. Workspace and member names use lowercase letters, digits, hyphens and underscores.
3. Run `npm start`. POST /auth/login with workspace, username and password as JSON. Use the returned accessToken as a Bearer credential. The HttpOnly refresh cookie rotates on POST /auth/refresh. POST /auth/logout ends the session. Use HTTPS; for local browser testing over HTTP, set RELAY_LOCAL_HTTP=1. Production always uses Secure cookies.
4. An operator calls POST /keys and saves the returned producer key and key ID. Use that key only for POST /events. Revoke it with DELETE /keys/:id. Viewers and operators read GET /events/:id. The same producer idempotency key can be used independently in two workspaces.
5. An operator can POST /events/:id/replay for a failed delivery. A successful replay request returns 202 and records the actor and time on the event atomically. Other states return 409. Attempts stay visible across replays, and each replay gets its own retry budget.

Access tokens expire after ten minutes. Sessions expire seven days from login. Rate limits apply per API process: 30 authentication requests per IP per minute and 180 authenticated event requests per workspace per minute. For multiple API replicas, use a shared limiter store. Access tests run with the existing RELAY_INTEGRATION switch.

## Part 4 · React delivery console

Run `npm run demo`, open http://localhost:4100, choose **Use local demo key**, and paste the temporary key printed by the demo. Select **sample-enrollment** to inspect its delivery attempts. Restarting the demo resets its data. The demo key grants read access to the console. Operator replay is available in workspace mode.

For workspace mode, run `npm run build` and then start the API and worker as described above. Open the API root and sign in with a provisioned workspace account. The console keeps access tokens in memory and restores the session with the refresh cookie on reload. Viewers inspect attempts and replay history; operators may replay failed deliveries.

GET /events accepts an exclusive `after` event ID and a `limit` between 1 and 50 (default 25). Results use ascending event ID order within the caller's workspace and return a next cursor. The console polls the current page and selected event every five seconds and refetches on reconnect. A newly inserted ID that sorts before the current cursor appears on an earlier page.

With the Part 2 MongoDB test container running, use `npm run build` followed by `npm run test:browser`. The Playwright test uses Edge by default (override RELAY_BROWSER to select another installed channel), provisions isolated accounts, and checks pagination, replay, viewer updates and session restoration.

## Part 5 · Release

The default Render Blueprint hosts the read-only demo on a free web service. On startup the relay submits a sample enrollment to its loopback receiver. Open the delivery in the console to see two 503 responses and the successful 204. State resets when the service restarts. Run this configuration locally with npm run build followed by npm run demo:public. The health endpoint is GET /healthz.

GitHub Actions builds the React client and runs the API, worker crash-recovery and browser suites with temporary MongoDB and Redis services. The workflow expects this project at the repository root.

For the persistent workspace edition, render.production.yaml defines separate paid web, worker and Key Value services in Singapore. Supply the dedicated MongoDB URI, trusted HTTPS receiver URL and its shared signing secret in Render. Provision an operator as described in Part 3. These are independent deployment configurations.

