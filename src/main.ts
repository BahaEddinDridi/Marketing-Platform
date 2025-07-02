import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import * as cookieParser from 'cookie-parser';
import * as session from 'express-session';
import * as bodyParser from 'body-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { abortOnError: false });

  app.use(
    session({
      secret: 'your-session-secret', // Replace with a secure secret
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false }, // Set to true in production with HTTPS
    }),
  );
  app.use(cookieParser());
  app.use(bodyParser.json({ limit: '2mb' }));

  // Increase multipart/form-data payload limit to 2MB
  app.use(bodyParser.urlencoded({ limit: '2mb', extended: true }));
  app.enableCors({
    origin: 'http://localhost:3000',
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      exceptionFactory: (errors) => {
        const messages = errors.map((error) => {
          const constraints = error.constraints || {};
          return Object.values(constraints)[0]; 
        });
        return new BadRequestException(messages); 
      },
    }),
  );


  
  await app.listen(process.env.PORT ?? 5000);
}
bootstrap();
