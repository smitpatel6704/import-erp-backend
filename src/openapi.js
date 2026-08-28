import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Nexport ERP API',
    version: '1.0.0',
    description: 'Automatic API documentation. Restart the backend after adding a route to regenerate it.',
  },
  paths: {},
};

try {
  const generated = require('./swagger-output.json');
  Object.assign(openApiDocument, generated);
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND') throw error;
  console.warn('Swagger output is missing. Run npm run docs:generate.');
}

export { openApiDocument };
