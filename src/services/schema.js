import { pool } from '../db.js';

const statements = [
  `ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "companyType" VARCHAR(30) NOT NULL DEFAULT 'importer'`,
  `ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "taxNumber" VARCHAR(255)`,
  `ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "bankDetails" TEXT`,
  `ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "customFields" JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "goodsDescription" TEXT`,
  `ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "notes" TEXT`,
  `ALTER TABLE "Container" ADD COLUMN IF NOT EXISTS "goodsDescription" TEXT`,
  `ALTER TABLE "ShipmentItem" ADD COLUMN IF NOT EXISTS "containerId" TEXT`,
  `ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "priority" VARCHAR(20) NOT NULL DEFAULT 'normal'`,
  `ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "emailEnabled" BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "emailStatus" VARCHAR(20) NOT NULL DEFAULT 'not_requested'`,
  `ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "emailSentAt" TIMESTAMP`,
  `ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "emailRecipients" TEXT`,
  `ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "emailError" TEXT`,
  `ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "dedupeKey" VARCHAR(255)`,
  `ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()`,
  `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "permissions" JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Notification_dedupeKey_key" ON "Notification" ("dedupeKey") WHERE "dedupeKey" IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS "ShipmentItem_containerId_idx" ON "ShipmentItem" ("containerId")`,
  `CREATE TABLE IF NOT EXISTS "DocumentBundle" (
    "id" TEXT PRIMARY KEY,
    "shipmentId" TEXT NOT NULL REFERENCES "Shipment"("id") ON DELETE CASCADE,
    "name" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "documentIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS "DocumentBundle_shipmentId_idx" ON "DocumentBundle" ("shipmentId")`,
];

export async function ensureFeatureSchema() {
  for (const statement of statements) {
    await pool.query(statement);
  }
}
