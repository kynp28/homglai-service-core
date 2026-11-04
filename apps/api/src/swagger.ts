import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Homglai Service Core API',
      version: '1.0.0',
      description: 'API documentation for the Coffee Machine Repair Tracking System',
    },
    servers: [
      {
        url: 'http://localhost:4000',
        description: 'Development Server',
      },
    ],
  },
  apis: ['./src/routes/*.ts', './src/index.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
