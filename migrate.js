const fs = require('fs');
const path = require('path');

const srcApiDir = path.join(__dirname, '../frontend/src/app/api');
const destRoutesDir = path.join(__dirname, 'src/routes');

if (!fs.existsSync(destRoutesDir)) {
  fs.mkdirSync(destRoutesDir, { recursive: true });
}

const routes = [];

function processDir(currentPath, routePath) {
  const entries = fs.readdirSync(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      processDir(path.join(currentPath, entry.name), routePath ? `${routePath}/${entry.name}` : entry.name);
    } else if (entry.name === 'route.ts') {
      const fullPath = path.join(currentPath, entry.name);
      let content = fs.readFileSync(fullPath, 'utf8');
      
      // Convert Next.js to Express
      content = content.replace(/import\s+{\s*NextResponse\s*}\s+from\s+['"]next\/server['"];?\n?/g, '');
      content = content.replace(/import\s+{\s*db\s*}\s+from\s+['"]@\/lib\/db['"];?/g, "import { db } from '../db';\nimport { Router } from 'express';\n\nconst router = Router();\n");
      
      // Replace GET, POST, PUT, DELETE
      const methods = ['GET', 'POST', 'PUT', 'DELETE'];
      for (const method of methods) {
        // Match `export async function GET(request: Request, { params }: { params: Promise<{ id: string }> })`
        // Or `export async function GET(request: Request)`
        const regexParams = new RegExp(`export\\s+async\\s+function\\s+${method}\\s*\\(\\s*request:\\s*Request\\s*,\\s*\\{\\s*params\\s*\\}\\s*:\\s*\\{\\s*params:\\s*Promise<\\{\\s*id:\\s*string\\s*\\}>\\s*\\}\\s*\\)\\s*\\{`, 'g');
        content = content.replace(regexParams, `router.${method.toLowerCase()}('/:id', async (req, res) => {\n  const { id } = req.params;`);
        
        const regexParamsNoPromise = new RegExp(`export\\s+async\\s+function\\s+${method}\\s*\\(\\s*request:\\s*Request\\s*,\\s*\\{\\s*params\\s*\\}\\s*:\\s*\\{\\s*params:\\s*\\{\\s*id:\\s*string\\s*\\}\\s*\\}\\s*\\)\\s*\\{`, 'g');
        content = content.replace(regexParamsNoPromise, `router.${method.toLowerCase()}('/:id', async (req, res) => {\n  const { id } = req.params;`);
        
        const regexNoParams = new RegExp(`export\\s+async\\s+function\\s+${method}\\s*\\(\\s*request:\\s*Request\\s*\\)\\s*\\{`, 'g');
        content = content.replace(regexNoParams, `router.${method.toLowerCase()}('/', async (req, res) => {`);
      }

      // Replace NextResponse.json(...) with res.json(...)
      content = content.replace(/return\s+NextResponse\.json\(([^,]+)(,\s*\{\s*status:\s*(\d+)\s*\}\s*)?\);?/g, (match, data, p2, status) => {
        if (status) {
          return `return res.status(${status}).json(${data});`;
        }
        return `return res.json(${data});`;
      });

      // Replace request.json() with req.body
      content = content.replace(/await\s+request\.json\(\)/g, 'req.body');
      
      // Replace new URL(request.url) with req
      content = content.replace(/const\s+\{\s*searchParams\s*\}\s*=\s*new\s+URL\(request\.url\);?/g, 'const searchParams = { get: (key) => req.query[key] };');
      
      // Replace `const { id } = await params;` with `` since we already have it from `req.params`
      content = content.replace(/const\s+\{\s*id\s*\}\s*=\s*await\s+params;?/g, '');

      // Append `export default router;`
      content += '\nexport default router;\n';

      const routeName = routePath.replace(/\[id\]/g, ':id');
      const filename = routePath.replace(/\/\[id\]/g, '_id').replace(/\//g, '_');
      
      const destPath = path.join(destRoutesDir, `${filename || 'index'}.ts`);
      
      // If we are merging routes from [id]/route.ts into the main route file, we should combine them.
      const mainRouteName = routePath.split('/')[0];
      const mainDestPath = path.join(destRoutesDir, `${mainRouteName || 'index'}.ts`);
      
      if (fs.existsSync(mainDestPath)) {
        let existing = fs.readFileSync(mainDestPath, 'utf8');
        // remove `export default router;` from existing
        existing = existing.replace(/export\s+default\s+router;?\s*$/g, '');
        // remove imports from content
        content = content.replace(/import.*\n/g, '');
        // remove `const router = Router();`
        content = content.replace(/const\s+router\s*=\s*Router\(\);?\n?/g, '');
        fs.writeFileSync(mainDestPath, existing + '\n' + content);
      } else {
        fs.writeFileSync(mainDestPath, content);
      }
      
      if (!routes.includes(mainRouteName)) routes.push(mainRouteName);
    }
  }
}

processDir(srcApiDir, '');

console.log('Routes generated:', routes);

// Generate index.ts
const indexContent = `import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

${routes.filter(r => r).map(r => `import ${r}Router from './routes/${r}';`).join('\n')}

${routes.filter(r => r).map(r => `app.use('/api/${r}', ${r}Router);`).join('\n')}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(\`Server running on port \${PORT}\`);
});
`;

fs.writeFileSync(path.join(__dirname, 'src/index.ts'), indexContent);

// Generate db.ts
const dbContent = `import { PrismaClient } from '@prisma/client';\n\nexport const db = new PrismaClient();\n`;
fs.writeFileSync(path.join(__dirname, 'src/db.ts'), dbContent);

console.log('Done!');
