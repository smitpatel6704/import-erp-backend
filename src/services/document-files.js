import fs from 'fs';
import path from 'path';

export async function storeUploadedDocumentFile(file, fileUrl) {
  // Multer already saves the file to disk in the 'uploads' directory.
  // We no longer store a duplicate in the database to save storage.
}

export async function readDocumentFileBuffer(fileUrl) {
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

