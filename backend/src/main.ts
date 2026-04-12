import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const configService = app.get(ConfigService);

  // P2-7: Validate TIMEZONE env var at startup — fail fast on invalid IANA zone.
  const timezone = configService.get<string>('TIMEZONE', 'UTC');
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  } catch (e) {
    if (e instanceof RangeError) {
      throw new Error(
        `Invalid TIMEZONE env var "${timezone}". Must be a valid IANA timezone (e.g. "America/New_York", "UTC").`,
      );
    }
    throw e;
  }

  app.enableCors({
    origin: configService.get<string>('FRONTEND_URL', 'http://localhost:3000'),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Wagile API')
    .setDescription(
      'REST API for Wagile — Jira DORA metrics and sprint planning accuracy.',
    )
    .setVersion('1.0')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api-docs', app, document);

  const port = configService.get<number>('PORT', 3001);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
