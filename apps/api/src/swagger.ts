import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Homglai Service Core API',
      version: '1.0.0',
      description: 'API documentation for the Coffee Machine Repair Tracking System',
    },
    // Relative: "Try it out" calls the same host the docs were opened from (local or Railway)
    servers: [{ url: '/', description: 'This server' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  apis: ['./src/routes/*.ts', './src/index.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
