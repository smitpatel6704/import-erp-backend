import { pool } from '../db.js';

const statements = [
  `ALTER TABLE "ExporterCompany" ADD COLUMN IF NOT EXISTS "contactPerson" TEXT`,
  `ALTER TABLE "ExporterCompany" ADD COLUMN IF NOT EXISTS "mobile" TEXT`,
  `ALTER TABLE "ExporterCompany" ADD COLUMN IF NOT EXISTS "email" TEXT`,
  `ALTER TABLE "ExporterCompany" ADD COLUMN IF NOT EXISTS "address" TEXT`,
  `ALTER TABLE "ExporterCompany" ADD COLUMN IF NOT EXISTS "country" TEXT`,
  `ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "companyType" VARCHAR(30) NOT NULL DEFAULT 'importer'`,
  `ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "taxNumber" VARCHAR(255)`,
  `ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "bankDetails" TEXT`,
  `ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "customFields" JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "goodsDescription" TEXT`,
  `ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "notes" TEXT`,
  `ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "notificationUserIds" JSONB NOT NULL DEFAULT '[]'::jsonb`,
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
  `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordSetupTokenHash" TEXT`,
  `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordSetupExpiresAt" TIMESTAMP`,
  `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordSetAt" TIMESTAMP`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "User_passwordSetupTokenHash_key" ON "User" ("passwordSetupTokenHash") WHERE "passwordSetupTokenHash" IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS "UserInvitation" (
    "tokenHash" TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
    "expiresAt" TIMESTAMP NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS "UserInvitation_userId_idx" ON "UserInvitation" ("userId")`,
  `CREATE TABLE IF NOT EXISTS "LoginOtp" (
    "id" TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP NOT NULL,
    "consumedAt" TIMESTAMP,
    "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS "LoginOtp_userId_idx" ON "LoginOtp" ("userId", "expiresAt")`,
  `DELETE FROM "LoginOtp" WHERE "expiresAt" < NOW() - INTERVAL '1 day'`,
  `INSERT INTO "UserInvitation" ("tokenHash", "userId", "expiresAt")
    SELECT "passwordSetupTokenHash", "id", "passwordSetupExpiresAt"
    FROM "User"
    WHERE "passwordSetupTokenHash" IS NOT NULL
      AND "passwordSetupExpiresAt" IS NOT NULL
    ON CONFLICT ("tokenHash") DO NOTHING`,
  `DELETE FROM "UserInvitation" WHERE "expiresAt" < NOW()`,
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
  `CREATE TABLE IF NOT EXISTS "DocumentFile" (
    "fileUrl" TEXT PRIMARY KEY,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "fileData" BYTEA NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `INSERT INTO "SettingOption" ("id", "category", "value", "label", "isActive")
    SELECT 'default-shipping-line-evergreen', 'shipping_line', 'Evergreen', 'Evergreen', TRUE
    WHERE NOT EXISTS (
      SELECT 1 FROM "SettingOption"
      WHERE "category" = 'shipping_line' AND LOWER("value") = 'evergreen'
    )`,
];

export async function ensureFeatureSchema() {
  for (const statement of statements) {
    await pool.query(statement);
  }
}
