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

## Added APIs

- `GET /api/dashboard` - stage totals, monthly/yearly value trends, supplier/port/country data
- `POST /api/shipments` - supports nested `containers`, `shipmentItems`, and `requiredDocumentIds`
- `GET|POST|PUT|DELETE /api/shipment-items` - container-wise goods
- `GET /api/shipment-documents/pending` - pending documents by shipment
- `POST /api/shipment-documents/shipment/:id/merge` - merge PDFs in `documentIds` order
- `POST /api/notifications/run-reminders` - run ETA/document reminder scan
- `POST /api/notifications/:id/send-email` - send or retry a notification email
- `GET /api/notifications/email/status` - SMTP configuration status
- `GET /api/reports/export.xlsx` and `GET /api/reports/export.pdf`
- `GET|POST|PUT|DELETE /api/settings/users` - user and role administration
