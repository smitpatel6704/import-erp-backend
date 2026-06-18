# NEXPORT ERP Backend

## Gmail SMTP

Copy the SMTP keys from `.env.example` into `.env` and set:

```env
SMTP_USER=your-account@gmail.com
SMTP_PASS=your-google-app-password
SMTP_FROM=NEXPORT ERP <your-account@gmail.com>
NOTIFICATION_EMAIL_TO=operations@example.com
```

Use a Google App Password, not the Gmail account password. On startup the API
adds missing feature columns/tables and runs ETA and pending-document reminder
checks every hour.

For Gmail, enable 2-Step Verification on the Google account, create an App
Password, and put that 16-character value in `SMTP_PASS`. The notification
screen can verify the SMTP connection and send or retry individual emails.

## Added APIs

- `GET /api/dashboard` - stage totals, monthly/yearly value trends, supplier/port/country data
- `POST /api/shipments` - supports nested `containers`, `shipmentItems`, and `requiredDocumentIds`
- `GET|POST|PUT|DELETE /api/shipment-items` - container-wise goods
- `GET /api/shipment-documents/pending` - pending documents by shipment
- `POST /api/shipment-documents/shipment/:id/merge` - merge PDFs in `documentIds` order
- `POST /api/notifications/run-reminders` - run ETA/document reminder scan
- `POST /api/notifications/:id/send-email` - send or retry a notification email
- `GET /api/notifications/email/status` - SMTP configuration status
- `POST /api/notifications/email/test` - verify the Gmail SMTP connection
- `GET /api/reports/export.xlsx` and `GET /api/reports/export.pdf`
- `GET|POST|PUT|DELETE /api/settings/users` - user and role administration
- `GET /api/maersk/status` - Maersk API configuration status without exposing credentials
- `GET /api/maersk/vessels` - official Maersk active-vessel reference data
- `GET /api/maersk/locations` - official Maersk ports, terminals, cities, and location reference data
- Evergreen ShipmentLink container/B/L tracking is supported through `POST /api/shipments/tracking/lookup`

## Maersk API

Set `MAERSK_CONSUMER_KEY` for the Vessels and Locations APIs. Shipment tracking
also requires `MAERSK_CONSUMER_SECRET` and approval for the **Ocean Track &
Trace** product in the Maersk Developer Portal. The backend obtains and caches
the OAuth client-credentials token automatically.

Do not expose either credential in the frontend or commit them to source
control. The optional browser-scraping fallback is disabled by default.
