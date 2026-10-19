import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';

@Catch()
export class ExceptionsWsFilter extends BaseWsExceptionFilter {
  private readonly journal = new Logger(ExceptionsWsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (!(exception instanceof HttpException)) {
      super.catch(exception, host);
      return;
    }
    if (exception.getStatus() >= 500) {
      this.journal.error(
        `${host.switchToWs().getPattern()} : ${exception.getStatus()} ${exception.message}`,
      );
    }
    const reponse = exception.getResponse();
    const message =
      typeof reponse === 'object' && reponse !== null && 'message' in reponse
        ? reponse.message
        : exception.message;
    super.catch(
      new WsException({
        status: 'error',
        statusCode: exception.getStatus(),
        message,
      }),
      host,
    );
  }
}
