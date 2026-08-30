import fs from 'node:fs';
import path from 'node:path';
import { del, get, put } from '@vercel/blob';

const BLOB_HOST_SUFFIX = '.blob.vercel-storage.com';

export const isBlobConfigured = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

export const isBlobUrl = (value) => {
  try {
    return new URL(String(value)).hostname.endsWith(BLOB_HOST_SUFFIX);
  } catch {
    return false;
  }
};

const safePathPart = (value, fallback = 'file') => String(value || fallback)
  .replace(/[^a-zA-Z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '') || fallback;

export async function storeFileBuffer({ buffer, fileName, contentType, folder = 'documents' }) {
  if (!isBlobConfigured()) throw new Error('BLOB_READ_WRITE_TOKEN is not configured');
  return put(`${safePathPart(folder)}/${Date.now()}-${safePathPart(fileName)}`, buffer, {
    access: 'private',
    addRandomSuffix: true,
    contentType: contentType || 'application/octet-stream',
  });
}

export async function storeUploadedDocumentFile(file) {
  const buffer = file.buffer || (file.path ? fs.readFileSync(file.path) : null);
  if (!buffer) throw new Error('Uploaded file data is unavailable');
  return storeFileBuffer({ buffer, fileName: file.originalname || file.filename, contentType: file.mimetype, folder: 'shipment-documents' });
}

export async function readDocumentFileBuffer(fileUrl) {
  if (isBlobUrl(fileUrl)) {
    const result = await get(fileUrl, { access: 'private' });
    if (!result || result.statusCode !== 200) return null;
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }
  // Compatibility for files uploaded before Blob storage was enabled.
  const relativePath = String(fileUrl || '').replace(/^\/+/, '');
  if (relativePath.includes('..')) {
    throw new Error('Invalid file path');
  }
  const filePath = path.resolve(process.cwd(), relativePath);
  const uploadsRoot = path.resolve(process.cwd(), 'uploads');
  if (filePath.startsWith(`${uploadsRoot}${path.sep}`) && fs.existsSync(filePath)) {
    return fs.readFileSync(filePath);
  }
  return null;
}

export async function deleteStoredFile(fileUrl) {
  if (isBlobUrl(fileUrl) && isBlobConfigured()) await del(fileUrl);
}

export async function sendStoredDocumentFile(req, res, next) {
  try {
    const filename = path.basename(req.params.filename || '');
    if (!filename || filename !== req.params.filename)
      return res.status(400).send('Invalid file name');
    
    const uploadsRoot = path.resolve(process.cwd(), 'uploads');
    const filePath = path.resolve(uploadsRoot, filename);
    
    if (filePath.startsWith(`${uploadsRoot}${path.sep}`) && fs.existsSync(filePath)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.sendFile(filePath);
    }
    return next();
  }
  catch (error) {
    return next(error);
  }
}
