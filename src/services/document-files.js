import fs from 'fs';
import path from 'path';
import { pool } from '../db.js';

let ensured = false;

export async function ensureDocumentFileStore() {
  if (ensured)
    return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "DocumentFile" (
      "fileUrl" TEXT PRIMARY KEY,
      "fileName" TEXT NOT NULL,
      "fileType" TEXT NOT NULL,
      "fileSize" INTEGER NOT NULL,
      "fileData" BYTEA NOT NULL,
      "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ensured = true;
}

export async function storeDocumentBuffer({ fileUrl, fileName, fileType, buffer }) {
  await ensureDocumentFileStore();
  await pool.query(`
    INSERT INTO "DocumentFile" ("fileUrl", "fileName", "fileType", "fileSize", "fileData", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
    ON CONFLICT ("fileUrl") DO UPDATE SET
      "fileName" = EXCLUDED."fileName",
      "fileType" = EXCLUDED."fileType",
      "fileSize" = EXCLUDED."fileSize",
      "fileData" = EXCLUDED."fileData",
      "updatedAt" = NOW()
  `, [fileUrl, fileName, fileType, buffer.length, buffer]);
}

export async function storeUploadedDocumentFile(file, fileUrl) {
  const buffer = fs.readFileSync(file.path);
  await storeDocumentBuffer({
    fileUrl,
    fileName: path.basename(fileUrl),
    fileType: file.mimetype || 'application/octet-stream',
    buffer,
  });
}

export async function readStoredDocumentFile(fileUrl) {
  await ensureDocumentFileStore();
  const { rows: [file] } = await pool.query(`
    SELECT "fileUrl", "fileName", "fileType", "fileSize", "fileData"
    FROM "DocumentFile"
    WHERE "fileUrl" = $1
  `, [fileUrl]);
  return file || null;
}

export async function readDocumentFileBuffer(fileUrl) {
  const relativePath = String(fileUrl || '').replace(/^\/+/, '');
  const filePath = path.resolve(process.cwd(), relativePath);
  const uploadsRoot = path.resolve(process.cwd(), 'uploads');
  if (filePath.startsWith(`${uploadsRoot}${path.sep}`) && fs.existsSync(filePath)) {
    return fs.readFileSync(filePath);
  }
  const stored = await readStoredDocumentFile(fileUrl);
  return stored?.fileData || null;
}

export async function sendStoredDocumentFile(req, res, next) {
  try {
    const filename = path.basename(req.params.filename || '');
    if (!filename || filename !== req.params.filename)
      return res.status(400).send('Invalid file name');
    const fileUrl = `/uploads/${filename}`;
    const file = await readStoredDocumentFile(fileUrl);
    if (!file)
      return next();
    res.setHeader('Content-Type', file.fileType || 'application/octet-stream');
    res.setHeader('Content-Length', String(file.fileSize || file.fileData.length));
    res.setHeader('Content-Disposition', `inline; filename="${file.fileName || filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.send(file.fileData);
  }
  catch (error) {
    return next(error);
  }
}
