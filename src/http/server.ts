import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import type { HealthHandlers } from './handlers/health.js';

export interface BridgeHttpServerOptions {
  host: string;
  port: number;
  healthHandlers: HealthHandlers;
  logger: Logger;
}

export class BridgeHttpServer {
  private readonly options: BridgeHttpServerOptions;
  private readonly logger: Logger;
  private server: http.Server | null = null;

  constructor(options: BridgeHttpServerOptions) {
    this.options = options;
    this.logger = options.logger.child({ component: 'http-server' });
  }

  public async start(): Promise<{ host: string; port: number }> {
    if (this.server) {
      throw new Error('HTTP server is already running');
    }

    const srv = http.createServer((req, res) => {
      void this.routeRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(this.options.port, this.options.host, () => {
        srv.removeListener('error', reject);
        resolve();
      });
    });

    this.server = srv;
    const addr = srv.address() as AddressInfo;
    const bound = {
      host: addr?.address ?? this.options.host,
      port: addr?.port ?? this.options.port,
    };

    this.logger.info(bound, 'HTTP server listening');
    return bound;
  }

  public getPort(): number | null {
    if (!this.server) {
      return null;
    }
    const addr = this.server.address() as AddressInfo | null;
    return addr?.port ?? null;
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
    this.logger.info('HTTP server stopped');
  }

  private async routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method?.toUpperCase() ?? 'GET';
    const rawUrl = req.url ?? '/';
    const pathname = rawUrl.split('?')[0] ?? '/';

    try {
      if (method === 'GET' && pathname === '/health/live') {
        this.options.healthHandlers.handleLive(req, res);
        return;
      }

      if (method === 'GET' && pathname === '/health/ready') {
        this.options.healthHandlers.handleReady(req, res);
        return;
      }

      res.writeHead(404, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'Endpoint not found' }));
    } catch (err) {
      this.logger.error(
        { err: (err as Error).message, method, pathname },
        'Unhandled HTTP request error'
      );
      if (!res.headersSent) {
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ error: 'INTERNAL_ERROR', message: 'Internal server error' }));
      }
    }
  }
}
