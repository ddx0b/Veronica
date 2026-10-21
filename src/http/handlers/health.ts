import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteDatabase } from '../../persistence/db.js';
import type { DeliveryJobRepository } from '../../persistence/repositories/delivery-job.repo.js';
import type { WhatsAppAdapter } from '../../adapters/whatsapp/interface.js';
import type { EmailAdapter } from '../../adapters/email/interface.js';
import type { MetricsRegistry } from '../../observability/metrics.js';

export interface HealthHandlerDeps {
  db: SqliteDatabase;
  deliveryJobs: DeliveryJobRepository;
  whatsappAdapter: WhatsAppAdapter;
  emailAdapter: EmailAdapter;
  metrics: MetricsRegistry;
  whatsappEnabled: boolean;
}

export class HealthHandlers {
  private readonly deps: HealthHandlerDeps;

  constructor(deps: HealthHandlerDeps) {
    this.deps = deps;
  }

  public handleLive(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
      })
    );
  }

  public handleReady(_req: IncomingMessage, res: ServerResponse): void {
    const dbOk = this.deps.db.ping();
    const emailHealthy = this.deps.emailAdapter.isHealthy();
    const whatsappState = this.deps.whatsappEnabled
      ? this.deps.whatsappAdapter.getConnectionState()
      : 'disabled';

    const whatsappReady =
      !this.deps.whatsappEnabled || whatsappState === 'connected';

    const isReady = dbOk && emailHealthy && whatsappReady;

    const queueCounts = dbOk
      ? this.deps.deliveryJobs.getCountsByStatus()
      : {
          pending: 0,
          processing: 0,
          submitted: 0,
          delivered: 0,
          failed: 0,
          dead_letter: 0,
          unknown: 0,
        };

    const statusCode = isReady ? 200 : 503;

    const payload = {
      status: isReady ? 'ready' : 'unhealthy',
      timestamp: new Date().toISOString(),
      checks: {
        database: dbOk ? 'ok' : 'failed',
        whatsapp: whatsappState,
        emailProvider: emailHealthy ? 'ok' : 'unhealthy',
      },
      queue: {
        depth: queueCounts.pending + queueCounts.processing + queueCounts.failed,
        byStatus: queueCounts,
      },
      metrics: this.deps.metrics.snapshot(),
    };

    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  }
}
