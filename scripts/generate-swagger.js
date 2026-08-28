import swaggerAutogen from 'swagger-autogen';

const document = {
  info: {
    title: 'Nexport ERP API',
    version: '1.0.0',
    description: 'Automatically generated from all Express routes in the Nexport ERP backend.',
  },
  servers: [{ url: '/', description: 'Current server' }],
  components: {
    securitySchemes: {
      AdminBearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Administrator session token returned by the authentication API.',
      },
      CronSecret: {
        type: 'http',
        scheme: 'bearer',
        description: 'The CRON_SECRET environment variable.',
      },
    },
  },
};

await swaggerAutogen({ openapi: '3.0.3', autoHeaders: true })(
  './src/swagger-output.json',
  ['./src/app.js'],
  document,
);
