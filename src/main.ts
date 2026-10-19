import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { verifierSecretsProduction } from './partage/secrets-production';

async function bootstrap(): Promise<void> {
  verifierSecretsProduction({
    jetonInterne: true,
    urlsAvecMotDePasse: ['DATABASE_URL', 'REDIS_URL'],
  });
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: false });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Chatvardage Message Service')
    .setDescription(
      'API des messages privés et de salon de Chatvardage. Les événements ' +
        'Socket.IO (namespace /messages) sont décrits dans la documentation Infra.',
    )
    .setVersion('1.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  await app.listen(Number(process.env.PORT ?? 3004), '0.0.0.0');
}
void bootstrap();
