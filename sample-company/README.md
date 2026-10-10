# Sample Company

This directory is a complete customer-owned system outside the Digital
Workforce trust boundary. It is intentionally not deployed by `make cluster-up`
or `make deploy-apps`, and it has no access to platform databases, Kubernetes
ServiceAccounts, OpenBao, or internal platform services.

## Architecture

```text
Customer traffic
      |
      v
Checkout API ---- private network ----> Inventory API
      |
      v
Prometheus ----> Alertmanager ----> Incident API
                                      ^
                                      |
                          authenticated integration edge
                                      |
                              Digital Workforce

Invoice PDFs ---- read-only mount ----> Invoice MCP
                                 ^
                                 |
                         authenticated integration edge
```

Checkout exposes a controlled dependency failure when Inventory is unavailable.
Prometheus observes that failure through standard metrics, Alertmanager sends an
authenticated webhook, and the customer-owned Incident API records both firing
and resolved states.

## Ownership Boundary

The customer owns and operates every container in this Compose project:

- `checkout-api`: public business API and Prometheus metric producer.
- `inventory-api`: private dependency with no host-published port.
- `prometheus`: customer telemetry and alert evaluation.
- `alertmanager`: customer alert routing.
- `incident-api`: authenticated customer incident system.
- `invoice-mcp`: authenticated, read-only invoice document tools.

The `sample-company-internal` network is internal to Docker. Only deliberate
integration surfaces join `sample-company-integration-edge`. Local ports bind to
loopback so this example does not expose services beyond the developer machine.

The current external contracts are:

| Contract | Local endpoint | Authentication |
| --- | --- | --- |
| Checkout health/orders | `http://127.0.0.1:4100` | Demo business API |
| Incident reading | `GET http://127.0.0.1:4102/v1/incidents` | Bearer token |
| Invoice MCP | `POST http://127.0.0.1:4103/mcp` | Bearer token |
| Prometheus API | `http://127.0.0.1:9090` | Local demo only |
| Alertmanager API | `http://127.0.0.1:9093` | Local demo only |

## AgentID Employee Principal Demo

Sample Company can authenticate the deployed employee as its own principal
instead of treating it as the human tenant owner. AgentID proves the external
agent identity; Sample Company maps the approved inbox to customer roles and
issues its own ten-minute access token for `sample-company-operations`.

The registered AgentID application must allow this exact callback:

```text
http://localhost:3002/v1/agentid/callback
```

Put local values in the repository-root `.env` file, which is ignored by Git:

```dotenv
AGENTID_CLIENT_ID=860c1ca5-800a-4e13-81a1-f998d5997f5a
AGENTID_CLIENT_SECRET=<registered-client-secret>
AGENTID_ALLOWED_EMAIL=<dedicated-agentmail-inbox>
AGENTID_AGENT_ROLES=incident_reader
AGENT_ACCESS_TOKEN_SIGNING_SECRET=<local-random-value>
```

Start Sample Company and provision the reusable tenant demo:

```sh
make sample-company-setup
```

From the tenant portal:

1. Sign in and select **Sample Company**.
2. Open **Connections** and choose **Connect AgentID** under Sample Company.
3. Approve `employeeagent@agentmail.to` in the Chrome popup.
4. Open **Workflows**, select **Daily incident review**, and choose **Run now**.

The callback sends the ten-minute customer token directly to the originating
portal window. The portal rotates the `sample-company-production` connection;
the control plane stores the credential in the tenant secret store, and the
employee pod never receives it.

The portal deliberately shows three distinct identities:

- **Portal requester** is the human Keycloak subject that clicked **Run now**.
- **Executing employee** is the Digital Workforce employee deployment ID.
- **AgentID principal** is the external AgentID subject and AgentMail inbox
      recorded on the Sample Company connection and seen by the customer API.

These identifiers should not match; they identify different actors at
different trust boundaries.

Use `make sample-company-outage` before **Run now** when the demo should show a
live incident. Use `make sample-company-recover` afterward.

Run **Daily incident review** from the Workflows page. Sample Company's own
audit endpoint shows the employee principal and RBAC decision:

```sh
curl -s -H 'authorization: Bearer sample-company-incident-reader' \
      http://localhost:4102/v1/access-audit | jq .
```

For command-line verification only, the default `incident_reader` role permits
incident access while runbook access is denied independently of the human owner:

```sh
token="$(cat /tmp/sample-company-agent-token)"
curl -i -H "authorization: Bearer ${token}" \
      http://localhost:4102/v1/runbooks/checkout-api
```

The customer token is intentionally short-lived and has no refresh token.
Repeat AgentID sign-in and update the connection when it expires. The demo does
not put the AgentID client secret, customer token, or AgentMail API key in an
employee pod.

Digital Workforce integration must use these edge contracts through a
tenant-configured credential and connector. It must not join the private
network or call Inventory directly.

## Invoice MCP

The customer-owned invoice service mounts `external_data/PDF_Invoice_Folder`
read-only and exposes four read-only MCP tools:

- `invoice.list`: bounded pagination with an optional customer filter.
- `invoice.get`: document metadata without returning the source PDF.
- `invoice.extract`: normalized invoice fields plus source SHA-256 evidence.
- `invoice.validate`: required-field and arithmetic checks with either `valid`
      or `review_required` status.

Start just this service with:

```sh
docker compose -f examples/external-services/sample-company/compose.yaml up -d --build invoice-mcp
curl -s http://127.0.0.1:4103/health
```

Override the local-only bearer token with `INVOICE_MCP_TOKEN`. The default is
`sample-company-invoice-reader` and must not be used outside this demo.

The supplied dataset contains 1,007 PDFs. Verification normalizes and validates
992 complete invoices. The remaining 15 PDFs contain an empty template with no
invoice number, customer, line item, or order ID; `invoice.validate` routes them
to `review_required` instead of inventing fields. No tool modifies source PDFs
or creates an accounts-payable record.

## Persistent Development Environment

Use the persistent fixture for continuous portal and feature testing:

```sh
make sample-company-setup
```

The setup is idempotent. It keeps this Compose project running, creates the
`Sample Company` Keycloak organization with tenant ID `sample-company`, adds
the existing `owner` demo user as an organization owner, and reconciles one
deployed `Sample Company SRE` with the three brokered read tools. The customer
credential remains in OpenBao and is not added to the employee Pod. Setup also
reconciles one reusable `Daily incident review` workflow and pins an assignment
to the employee. Repeated setup runs do not create duplicate definitions or
assignments.

After the first setup, sign out of the portal and sign back in as `owner` so
the refreshed token contains the new organization. Select **Sample Company**
in the tenant picker to see the persistent employee.

The environment starts healthy, so its incident list is initially empty. Run
`make sample-company-outage` before testing incident investigation; the command
waits until monitoring has opened an incident before it returns.

Open **Workflows**, select **Daily incident review**, and choose **Run now** to
list current incidents through `sample-company.incidents.list`. The resulting
run stores its tool manifest, trace, tool result, and response for later
inspection.

The workflow also runs every day at 09:00 UTC. Override the customer schedule
when running setup with `SAMPLE_COMPANY_WORKFLOW_CRON` and
`SAMPLE_COMPANY_WORKFLOW_TIMEZONE`; the timezone must be an IANA timezone. Each
occurrence creates the same ordinary employee-context run as **Run now**, with
a deterministic occurrence key and durable trace.

Use these commands to exercise the environment without deleting tenant state:

```sh
make sample-company-status
make sample-company-outage
make sample-company-recover
make sample-company-stop
```

`sample-company-stop` stops only the customer-owned Compose services. Run
`make sample-company-setup` again to restart them and reconcile the employee.

The integration smoke below is intentionally different: it creates an
isolated `sample-company-smoke` tenant and removes it after each acceptance
run.

After deploying the platform connector and credential broker, prove that a
real employee can investigate across this boundary:

```sh
make smoke-sample-company-integration
```

That smoke stores the customer bearer token in the tenant secret boundary,
grants three exact read operations, and requires incident, metric, and runbook
MCP evidence in the completed employee trace. The customer credential must not
appear in the employee Pod or chat result.

## Run the Independent Proof

```sh
make smoke-sample-company
```

The smoke test:

1. Starts only the sample company's Compose project.
2. Confirms a checkout succeeds.
3. Stops Inventory.
4. Confirms Checkout returns HTTP `503`.
5. Waits for an open customer incident created through Alertmanager.
6. Restarts Inventory and confirms Checkout recovers.
7. Waits for the same incident to resolve.
8. Removes the Compose project.

Set `KEEP_SAMPLE_COMPANY=1` to leave the project running for manual integration
work. The local demo credentials are intentionally fixed and must not be used
outside this isolated example.